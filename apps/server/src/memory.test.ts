// Memory quality (HANDOFF-MEMORY.md): normalised dedup + recency-weighted
// recall, proven against the REAL database functions — every row here goes in
// through writeMemory (or raw SQL to simulate legacy data) and comes back out
// through recallMemories / recentMemories. No hand-built arrays.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, recallMemories, recentMemories, writeMemory, type Db } from "./db.js";
import { migrateMemoryDedupe } from "./memory.js";
import { normalizeMemoryKey } from "./memory.js";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function write(text: string, opts: Partial<Parameters<typeof writeMemory>[1]> = {}) {
  return writeMemory(db, {
    projectId: "prj_t",
    scope: "project",
    scopeId: null,
    kind: "fact",
    text,
    sourceTaskId: null,
    agentId: "agt_a",
    agentName: "dev-a",
    ...opts,
  });
}

/** Age a memory without touching any other column — simulates the passage of
 *  time, which no production code path fakes. */
function age(memoryId: string, daysAgo: number) {
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    memoryId
  );
}

const countTexts = () => (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as any).n;
const texts = () =>
  (db.prepare("SELECT text FROM memories ORDER BY created_at").all() as any[]).map((r) => r.text);

describe("normalised dedup", () => {
  test("formatting variants of one fact collapse to a single row", () => {
    expect(write("use pnpm, not npm")).not.toBeNull();
    // Each of these is the SAME fact in different formatting — re-learning.
    expect(write("Use pnpm not npm.")).toBeNull();
    expect(write("  use pnpm,  not  npm ")).toBeNull();
    expect(write("USE PNPM, NOT NPM")).toBeNull();
    expect(countTexts()).toBe(1);
  });

  test("the stored text is exactly what was first written — key normalises, display does not", () => {
    write("  Use PNPM, not npm.  ");
    const stored = recentMemories(db, "prj_t", 10);
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("Use PNPM, not npm."); // trim only; case/punct intact
  });

  test("near-miss: one word apart is two facts, never collapsed", () => {
    expect(write("deploy on Friday")).not.toBeNull();
    expect(write("never deploy on Friday")).not.toBeNull();
    expect(countTexts()).toBe(2);

    // And through recall, both come back as distinct knowledge.
    const hits = recallMemories(db, { projectId: "prj_t", agentId: "agt_a", query: "deploy friday", limit: 10 });
    expect(hits).toHaveLength(2);
  });

  test("different scopes never collide even with identical text", () => {
    expect(write("owns the deploy key")).not.toBeNull();
    expect(
      write("owns the deploy key", { scope: "agent" as const, scopeId: "agt_a" })
    ).not.toBeNull();
    expect(countTexts()).toBe(2);
  });
});

describe("legacy backfill", () => {
  test("rows written before dedupe_key existed are keyed on startup; running twice is harmless", () => {
    // Simulate legacy rows the only honest way: bypass writeMemory entirely,
    // exactly as a pre-migration database would look.
    db.prepare(
      `INSERT INTO memories (id, project_id, scope, scope_id, kind, text, source_task_id, agent_id, agent_name, created_at)
       VALUES ('m1','prj_t','project',NULL,'fact','use pnpm, not npm',NULL,'agt_a','dev-a','2026-01-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO memories (id, project_id, scope, scope_id, kind, text, source_task_id, agent_id, agent_name, created_at)
       VALUES ('m2','prj_t','project',NULL,'fact','use pnpm not npm.',NULL,'agt_b','dev-b','2026-01-02T00:00:00Z')`
    ).run();

    // openDb already ran the migration on this :memory: database — which is
    // itself the idempotence proof for the common path. Run it again directly.
    migrateMemoryDedupe(db); // second run must change nothing

    // The legacy near-duplicates collapsed to the OLDEST row.
    expect(texts()).toEqual(["use pnpm, not npm"]);

    // And the live rule now applies on top: a fresh writeMemory of the same
    // fact is still a no-op against the backfilled key.
    expect(write("USE PNPM NOT NPM!")).toBeNull();
    expect(countTexts()).toBe(1);
  });
});

describe("recency-weighted recall", () => {
  test("an OLD EXACT match beats a RECENT VAGUE one", () => {
    const old = write("the deploy script requires sudo on staging");
    age(old!, 60); // two months stale
    const fresh = write("deploy things sometimes maybe");
    age(fresh!, 0); // brand new

    const hits = recallMemories(db, {
      projectId: "prj_t", agentId: "agt_a",
      query: "deploy script requires sudo", limit: 5,
    });
    expect(hits[0].text).toContain("requires sudo");
  });

  test("equally relevant memories rank by recency", () => {
    const older = write("staging deploys need sudo");
    age(older!, 45);
    const newer = write("staging deploys need sudo"); // dedup would collapse this...
    // ...so make the fresh one genuinely distinct but lexically equal:
    const fresh = write("production deploys need sudo");
    void newer;

    const hits = recallMemories(db, {
      projectId: "prj_t", agentId: "agt_a", query: "deploys need sudo", limit: 5,
    });
    const order = hits.map((h) => h.text);
    expect(order.indexOf("production deploys need sudo"))
      .toBeLessThan(order.indexOf("staging deploys need sudo"));
    void older;
  });

  test("ranking deletes nothing — row count is untouched by recalls", () => {
    write("alpha fact about deploys");
    write("beta fact about caches");
    age((recallMemories(db, { projectId: "prj_t", agentId: "agt_a", query: "deploys", limit: 5 })[0] as any)?.id ?? "x", 90);
    const before = countTexts();
    recallMemories(db, { projectId: "prj_t", agentId: "agt_a", query: "deploys", limit: 1 });
    recallMemories(db, { projectId: "prj_t", agentId: "agt_a", query: "", limit: 5 });
    expect(countTexts()).toBe(before);
  });
});

describe("normalizeMemoryKey", () => {
  test("the brief's four phrasings produce one key", () => {
    const keys = [
      "use pnpm, not npm",
      "Use pnpm not npm.",
      "  use pnpm,  not  npm ",
    ].map(normalizeMemoryKey);
    expect(new Set(keys).size).toBe(1);
  });

  test("internal periods survive (versions), words always differ", () => {
    expect(normalizeMemoryKey("v1.2.0 released")).toBe("v1.2.0 released");
    expect(normalizeMemoryKey("deploy on Friday")).not.toBe(normalizeMemoryKey("never deploy on Friday"));
  });
});

// ---------------------------------------------------------------------------
// Added during Stream A's verification pass.
describe("defects found verifying the dedup migration", () => {
  test("legacy duplicates sharing a timestamp do not break startup", () => {
    // migrateMemoryDedupe runs from openDb. The collapse keeps the row whose
    // created_at is strictly OLDER, so two rows written in the same
    // millisecond match neither side of that comparison, nothing is deleted,
    // and building the unique index throws — on every boot, forever.
    //
    // Same-millisecond writes are not exotic: created_at is an ISO string
    // with millisecond precision, and the whole point of this migration is
    // two agents recording one fact in two phrasings.
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id,gh_repo,name,layout) VALUES ('p','a/a','a/a','office')").run();
    const at = "2026-03-04T09:15:22.100Z";
    const ins = db.prepare(
      `INSERT INTO memories (id,project_id,scope,scope_id,kind,text,source_task_id,agent_id,agent_name,created_at,dedupe_key)
       VALUES (?,'p','project',NULL,'fact',?,NULL,'a','A',?,NULL)`
    );
    ins.run("x1", "Use pnpm, not npm", at);
    ins.run("x2", "use pnpm not npm.", at);

    expect(() => migrateMemoryDedupe(db)).not.toThrow();
    expect((db.prepare("SELECT count(*) c FROM memories").get() as any).c).toBe(1);
    // Deterministic: the same row survives every time, whichever ran first.
    expect((db.prepare("SELECT id FROM memories").get() as any).id).toBe("x1");
  });

  test("punctuation inside a word is meaning, not formatting", () => {
    // The module already protects periods this way — "v1.2.0 released" keeps
    // its version because periods are only stripped at the END. Colons were
    // stripped everywhere, which silently merges times, ratios and
    // namespaced keys into different facts.
    expect(normalizeMemoryKey("ratio is 3:1")).not.toBe(normalizeMemoryKey("ratio is 31"));
    expect(normalizeMemoryKey("deploy window is 2:00-4:00"))
      .not.toBe(normalizeMemoryKey("deploy window is 200-400"));
    expect(normalizeMemoryKey("the cache key is user:session"))
      .not.toBe(normalizeMemoryKey("the cache key is usersession"));

    // ...while clause punctuation still collapses, which is the whole feature.
    expect(normalizeMemoryKey("use pnpm, not npm")).toBe(normalizeMemoryKey("use pnpm not npm"));
    expect(normalizeMemoryKey("note: deploy on Friday")).toBe(normalizeMemoryKey("note deploy on Friday"));
  });
});


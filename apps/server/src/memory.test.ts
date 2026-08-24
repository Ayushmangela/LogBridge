// The shared memory store (MEMORY.md). The claim this feature makes is
// "an agent you spin up starts already knowing how the team works" — which
// is only true if a memory written by one agent is recallable by a
// *different* agent, including one on another machine. That's the property
// most of these tests are about; the rest guard the two things that would
// quietly ruin it (unbounded duplicates, and a query language that throws
// on ordinary text).
import { describe, expect, test } from "vitest";
import { openDb, recallMemories, recentMemories, writeMemory, type Db } from "./db.js";

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_a", "acme/a", "acme/a", "office"
  );
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, ?)").run(
    "prj_b", "acme/b", "acme/b", "office"
  );
}

function write(db: Db, over: Partial<Parameters<typeof writeMemory>[1]> = {}) {
  return writeMemory(db, {
    projectId: "prj_a",
    scope: "project",
    scopeId: null,
    kind: "fact",
    text: "the deploy script needs sudo on linux",
    sourceTaskId: null,
    agentId: "agt_one",
    agentName: "dev-one",
    ...over,
  });
}

function recall(db: Db, query: string, agentId = "agt_two", limit = 5) {
  return recallMemories(db, { projectId: "prj_a", agentId, query, limit });
}

describe("shared memory", () => {
  test("a memory written by one agent is recalled by a different agent", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(write(db, { agentId: "agt_one", agentName: "dev-one" })).toBeTruthy();

    // agt_two has never written anything and has no local state at all
    const hits = recall(db, "how do I deploy");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      text: "the deploy script needs sudo on linux",
      scope: "project",
      agentName: "dev-one", // attribution survives — you can see who learned it
    });
  });

  test("agent-scoped memory is private to that agent; project-scoped is shared", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { scope: "agent", scopeId: "agt_one", agentId: "agt_one", text: "my own scratch note about deploys" });
    write(db, { scope: "project", scopeId: null, agentId: "agt_one", text: "team rule: deploys happen on fridays" });

    const own = recall(db, "deploys", "agt_one").map((m) => m.text);
    const other = recall(db, "deploys", "agt_two").map((m) => m.text);

    expect(own).toContain("my own scratch note about deploys");
    expect(own).toContain("team rule: deploys happen on fridays");
    // the other agent sees the shared rule but never the private note
    expect(other).toContain("team rule: deploys happen on fridays");
    expect(other).not.toContain("my own scratch note about deploys");
  });

  test("memory never leaks across projects", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { projectId: "prj_b", text: "secret from the other room" });
    expect(recall(db, "secret")).toHaveLength(0);
    expect(recallMemories(db, { projectId: "prj_b", agentId: "agt_two", query: "secret", limit: 5 })).toHaveLength(1);
  });

  test("re-learning the same fact is a no-op, not a duplicate row", () => {
    const db = openDb(":memory:");
    seed(db);
    expect(write(db)).toBeTruthy();
    expect(write(db)).toBeNull();            // same text, same scope -> skipped
    expect(write(db)).toBeNull();
    expect(recall(db, "deploy")).toHaveLength(1);

    // ...but the same text at a different scope is genuinely a different memory
    expect(write(db, { scope: "agent", scopeId: "agt_one" })).toBeTruthy();
    expect(recall(db, "deploy", "agt_one")).toHaveLength(2);
  });

  test("results are ranked by relevance, best match first", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { text: "always run the database migration before the deploy" });
    write(db, { text: "the office wifi password rotates monthly" });
    write(db, { text: "deploy deploy deploy is the most deploy-relevant line" });

    const hits = recall(db, "deploy");
    expect(hits[0].text).toContain("most deploy-relevant");
    // the unrelated one shouldn't match a deploy query at all
    expect(hits.map((h) => h.text)).not.toContain("the office wifi password rotates monthly");
  });

  test("FTS query syntax in ordinary text never throws", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { text: "use pnpm not npm" });
    // Every one of these is either FTS5 operator syntax or unbalanced
    // punctuation — raw, they'd be a syntax error inside MATCH.
    for (const q of ['pnpm AND', '"unbalanced', 'a OR OR b', 'NEAR(x', 'col:val', '*', '', '   ', '???', 'pnpm*']) {
      expect(() => recall(db, q), `query ${JSON.stringify(q)} must not throw`).not.toThrow();
    }
    expect(recall(db, "pnpm")).toHaveLength(1);
  });

  test("an unmatchable query still returns recent context rather than nothing", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { text: "we use vitest for tests" });
    // No usable search tokens at all -> fall back to most-recent, because a
    // brand-new agent with no specific question should still inherit context.
    const hits = recall(db, "?!");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("we use vitest for tests");
  });

  test("limit is honoured and recent listing is newest-first", () => {
    const db = openDb(":memory:");
    seed(db);
    for (let i = 0; i < 8; i++) write(db, { text: `deploy note number ${i}` });
    expect(recall(db, "deploy", "agt_two", 3)).toHaveLength(3);

    const recent = recentMemories(db, "prj_a", 50);
    expect(recent).toHaveLength(8);
    expect(new Date(recent[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(recent[recent.length - 1].createdAt).getTime()
    );
  });

  test("the FTS index tracks deletes, so a removed memory stops being recalled", () => {
    const db = openDb(":memory:");
    seed(db);
    write(db, { text: "obsolete: we deploy from jenkins" });
    expect(recall(db, "jenkins")).toHaveLength(1);
    db.prepare("DELETE FROM memories WHERE text LIKE 'obsolete%'").run();
    expect(recall(db, "jenkins")).toHaveLength(0);
  });
});

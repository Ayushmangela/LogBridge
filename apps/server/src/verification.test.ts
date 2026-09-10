// "Done" used to mean "the agent said so" — and for a local agent it did not
// even mean that: watchForCompletion marks a task done after 8 seconds of
// terminal silence. Completion CASCADES (dependents are unblocked and offered
// out), so one unchecked "done" starts the next agent on inputs that were
// never produced.
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, storeArtifact, appendEvent, type Db } from "./db.js";
import { verifyTask, expectedOutputsOf, rejectionMessage, MAX_REJECTIONS } from "./verification.js";
import { gateCompletion, configureCompletionGate, resetCompletionGate } from "./completionGate.js";
import { normalizeArtifacts } from "./hive.js";
import { recordDeclaredArtifacts } from "./artifactIntake.js";
import { setCheck } from "./checks.js";

let tmp = "";
afterEach(() => {
  resetCompletionGate();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function seed(db: Db, expected: string[] | null, folder: string | null = null) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_v", "x/v", "V", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_v", "v", "V", 0);
  db.prepare("INSERT INTO machines (id, owner_id, name, online) VALUES (?,?,?,?)").run("node_v", "usr_v", "m", 1);
  db.prepare(
    `INSERT INTO agents (id, machine_id, owner_id, project_id, name, role, capabilities, concurrency, status, folder, current_task)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run("agt_v", "node_v", "usr_v", "prj_v", "Ada", "developer", "[]", 1, "working", folder, "tsk_v");
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, budget_seconds, budget_usd, cost_usd, created_at, expected_outputs)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run("tsk_v", "prj_v", "Add the callback route", "spec", "usr_v", "agt_v", "submitted", 600, 1, 0,
        new Date().toISOString(), expected ? JSON.stringify(expected) : null);
  return db;
}

const taskOf = (db: Db) => db.prepare("SELECT * FROM tasks WHERE id = 'tsk_v'").get() as any;

describe("what a task promised", () => {
  test("a task that declared nothing is not gated at all", async () => {
    // Most tasks are ad-hoc chat instructions with no plan behind them. They
    // must keep completing exactly as before.
    const db = seed(openDb(":memory:"), null);
    const r = verifyTask(db, taskOf(db));
    expect(r.unchecked).toBe(true);
    expect(r.ok).toBe(true);
    expect((await gateCompletion(db, taskOf(db))).allow).toBe(true);
    db.close();
  });

  test("declared outputs survive the round-trip through the column", async () => {
    const db = seed(openDb(":memory:"), ["diff", "test_report"]);
    expect(expectedOutputsOf(taskOf(db))).toEqual(["diff", "test_report"]);
    db.close();
  });

  test("a corrupt column degrades to 'nothing declared', not a crash", async () => {
    const db = seed(openDb(":memory:"), null);
    db.prepare("UPDATE tasks SET expected_outputs = '{not json' WHERE id = 'tsk_v'").run();
    expect(expectedOutputsOf(taskOf(db))).toEqual([]);
    await expect(gateCompletion(db, taskOf(db))).resolves.toBeTruthy();
    db.close();
  });
});

describe("the gate", () => {
  test("refuses a completion with no evidence, and does NOT fail the task", async () => {
    // The work is usually nearly right — an agent that wrote the code but did
    // not declare it has skipped the last step, not failed. Failing would
    // throw away a run that cost real money.
    const db = seed(openDb(":memory:"), ["diff"]);
    const sent: string[] = [];
    configureCompletionGate({ inject: (_a, t) => { sent.push(t); return true; } });

    const verdict = await gateCompletion(db, taskOf(db));
    expect(verdict.allow).toBe(false);
    expect(verdict.missing).toEqual(["diff"]);
    expect(taskOf(db).state).toBe("submitted");   // untouched, not failed
    db.close();
  });

  test("tells the agent exactly what is missing and how to declare it", async () => {
    const db = seed(openDb(":memory:"), ["diff", "test_report"]);
    const sent: string[] = [];
    configureCompletionGate({ inject: (_a, t) => { sent.push(t); return true; } });
    await gateCompletion(db, taskOf(db));

    expect(sent[0]).toContain("diff");
    expect(sent[0]).toContain("test_report");
    // A rejection that does not say how to comply costs a turn producing an apology.
    expect(sent[0]).toContain('"artifacts"');
    // And it leaves an honest way out.
    expect(sent[0]).toContain("cannot be completed");
    db.close();
  });

  test("allows a completion once the evidence is on record", async () => {
    const db = seed(openDb(":memory:"), ["diff"]);
    storeArtifact(db, { projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v", kind: "diff", title: "auth" });
    expect((await gateCompletion(db, taskOf(db))).allow).toBe(true);
    db.close();
  });

  test("kind matching ignores case, because agents do not respect it", async () => {
    const db = seed(openDb(":memory:"), ["Diff"]);
    storeArtifact(db, { projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v", kind: "diff", title: "auth" });
    expect(verifyTask(db, taskOf(db)).ok).toBe(true);
    db.close();
  });

  test("an artifact naming a file that does not exist is not evidence", async () => {
    // The cheapest way to defeat a gate that only counts records is to claim
    // a file. So a claimed path is checked.
    tmp = mkdtempSync(join(tmpdir(), "lb-verify-"));
    const db = seed(openDb(":memory:"), ["diff"], tmp);
    storeArtifact(db, {
      projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v",
      kind: "diff", title: "auth", filePath: "src/never-written.ts",
    });
    const r = verifyTask(db, taskOf(db), tmp);
    expect(r.ok).toBe(false);
    expect(r.vanished[0]).toContain("never-written.ts");
    db.close();
  });

  test("a file that really is there passes", async () => {
    tmp = mkdtempSync(join(tmpdir(), "lb-verify-"));
    writeFileSync(join(tmp, "real.ts"), "export const x = 1;\n");
    const db = seed(openDb(":memory:"), ["diff"], tmp);
    storeArtifact(db, {
      projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v",
      kind: "diff", title: "auth", filePath: "real.ts",
    });
    expect(verifyTask(db, taskOf(db), tmp).ok).toBe(true);
    db.close();
  });

  test("an artifact with no path is taken on trust — not everything is a file", async () => {
    // "review_verdict" is a judgement, not a file. Requiring a path would
    // make the gate unsatisfiable for reviewers.
    const db = seed(openDb(":memory:"), ["review_verdict"]);
    storeArtifact(db, { projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v", kind: "review_verdict", title: "approved" });
    expect(verifyTask(db, taskOf(db), "/tmp").ok).toBe(true);
    db.close();
  });

  test("an unknown project folder does not punish the agent for the server's ignorance", async () => {
    const db = seed(openDb(":memory:"), ["diff"], null);
    storeArtifact(db, {
      projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v",
      kind: "diff", title: "auth", filePath: "some/relative.ts",
    });
    expect(verifyTask(db, taskOf(db), null).ok).toBe(true);
    db.close();
  });
});

describe("the gate cannot deadlock", () => {
  test("after the send-back limit it lets the task through, marked unverified", async () => {
    // A plan that asked for the wrong artifact, or work that is genuinely
    // impossible, must not be sent back forever.
    const db = seed(openDb(":memory:"), ["diff"]);
    const chats: string[] = [];
    configureCompletionGate({ inject: () => true, postChat: (_p, t) => chats.push(t) });

    for (let i = 0; i < MAX_REJECTIONS; i++) {
      expect((await gateCompletion(db, taskOf(db))).allow).toBe(false);
    }
    const final = await gateCompletion(db, taskOf(db));
    expect(final.allow).toBe(true);
    expect(final.unverified).toBe(true);
    // And it is never mistaken for checked work.
    const row = db.prepare("SELECT 1 FROM events WHERE type = 'task.completed_unverified'").get();
    expect(row).toBeTruthy();
    expect(chats.some((c) => c.includes("WITHOUT"))).toBe(true);
    db.close();
  });

  test("an agent with no live terminal is reported, not silently blocked", async () => {
    const db = seed(openDb(":memory:"), ["diff"]);
    const chats: string[] = [];
    configureCompletionGate({ inject: () => false, postChat: (_p, t) => chats.push(t) });
    await gateCompletion(db, taskOf(db));
    expect(chats[0]).toContain("no live terminal");
    // It is waiting on a person now, not working.
    expect((db.prepare("SELECT status FROM agents WHERE id='agt_v'").get() as any).status).toBe("needs_input");
    db.close();
  });
});

describe("reading what agents actually write", () => {
  test("the object form from PROTOCOL.md", async () => {
    expect(normalizeArtifacts({ diff: "src/auth.ts" }))
      .toEqual([{ kind: "diff", path: "src/auth.ts", title: null }]);
  });

  test("the array form a model produces when it wants a title", async () => {
    expect(normalizeArtifacts([{ kind: "diff", path: "a.ts", title: "Auth" }]))
      .toEqual([{ kind: "diff", path: "a.ts", title: "Auth" }]);
  });

  test("junk is ignored rather than throwing", async () => {
    expect(normalizeArtifacts(null)).toEqual([]);
    expect(normalizeArtifacts("nope")).toEqual([]);
    expect(normalizeArtifacts([{ path: "no-kind.ts" }])).toEqual([]);
  });

  test("a declaration in a message becomes evidence attributed to the task", async () => {
    const db = seed(openDb(":memory:"), ["diff"]);
    const msg: any = { id: "m1", from: "agt_v", to: "god", act: "done", subject: "did it",
                       artifacts: { diff: "src/auth.ts" } };
    expect(recordDeclaredArtifacts(db, msg, "agt_v", "prj_v")).toBe(1);
    const art = db.prepare("SELECT * FROM artifacts WHERE task_id = 'tsk_v'").get() as any;
    expect(art.kind).toBe("diff");
    expect(art.file_path).toBe("src/auth.ts");
    db.close();
  });

  test("a path that tries to escape the project is not stored as a path", async () => {
    const db = seed(openDb(":memory:"), ["diff"]);
    const msg: any = { id: "m1", from: "agt_v", to: "god", act: "done",
                       artifacts: { diff: "../../../etc/passwd" } };
    recordDeclaredArtifacts(db, msg, "agt_v", "prj_v");
    const art = db.prepare("SELECT * FROM artifacts WHERE task_id = 'tsk_v'").get() as any;
    expect(art.file_path).toBeNull();
    db.close();
  });

  test("a message with no artifacts field changes nothing", async () => {
    const db = seed(openDb(":memory:"), ["diff"]);
    expect(recordDeclaredArtifacts(db, { id: "m1", from: "agt_v", to: "god", act: "inform" } as any, "agt_v", "prj_v")).toBe(0);
    db.close();
  });
});

describe("acceptance checks gate the completion too", () => {
  test("a failing check blocks 'done', even with the artifact on record", async () => {
    // Artifacts prove the output exists. This proves it works.
    const db = seed(openDb(":memory:"), ["diff"], tmp = mkdtempSync(join(tmpdir(), "lb-gate-")));
    storeArtifact(db, { projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v", kind: "diff", title: "auth" });
    setCheck(db, "prj_v", "tests", "echo 'FAIL: 1 of 12' >&2; exit 1");
    db.prepare("UPDATE tasks SET acceptance_checks = ? WHERE id = 'tsk_v'").run(JSON.stringify(["tests"]));

    const sent: string[] = [];
    configureCompletionGate({ inject: (_a, t) => { sent.push(t); return true; } });

    const verdict = await gateCompletion(db, taskOf(db));
    expect(verdict.allow).toBe(false);
    // The agent is given the real output, not "a check failed".
    expect(sent[0]).toContain("tests");
    expect(sent[0]).toContain("FAIL: 1 of 12");
    db.close();
  });

  test("a passing check lets it through", async () => {
    const db = seed(openDb(":memory:"), ["diff"], tmp = mkdtempSync(join(tmpdir(), "lb-gate-")));
    storeArtifact(db, { projectId: "prj_v", taskId: "tsk_v", creatorId: "agt_v", kind: "diff", title: "auth" });
    setCheck(db, "prj_v", "tests", "exit 0");
    db.prepare("UPDATE tasks SET acceptance_checks = ? WHERE id = 'tsk_v'").run(JSON.stringify(["tests"]));

    configureCompletionGate({ inject: () => true });
    expect((await gateCompletion(db, taskOf(db))).allow).toBe(true);
    db.close();
  });

  test("the run is recorded either way, so 'never checked' is visible", async () => {
    const db = seed(openDb(":memory:"), null, tmp = mkdtempSync(join(tmpdir(), "lb-gate-")));
    setCheck(db, "prj_v", "tests", "exit 0");
    db.prepare("UPDATE tasks SET acceptance_checks = ? WHERE id = 'tsk_v'").run(JSON.stringify(["tests"]));

    configureCompletionGate({ inject: () => true });
    await gateCompletion(db, taskOf(db));
    const row = db.prepare("SELECT body FROM events WHERE type = 'task.checks_run'").get() as any;
    expect(JSON.parse(row.body).results[0]).toMatchObject({ name: "tests", passed: true });
    db.close();
  });
});

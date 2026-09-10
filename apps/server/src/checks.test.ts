// Acceptance checks: a command that must exit 0 before a task is done.
//
// The completion gate already proves an output EXISTS. This proves it WORKS,
// using an exit code rather than another model's opinion.
//
// The load-bearing tests here are the ones about WHERE THE COMMAND COMES FROM.
// Tasks are built from agent-authored content in places (plan-proposals.ts
// lifts title and capability straight out of a plan a model wrote), so a task
// field holding a shell string would be a path from "model writes JSON" to
// "server runs shell".
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createTask, type Db } from "./db.js";
import {
  setCheck, getCheck, listChecks, deleteCheck, isValidCheckName,
  runCheck, runAcceptanceChecks, acceptanceChecksOf, failureSummary,
} from "./checks.js";

let tmp = "";
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ""; });

function seed(db: Db) {
  db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_c", "x/c", "C", "office");
  db.prepare("INSERT INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run("usr_c", "c", "C", 0);
  return db;
}
const workspace = () => (tmp = mkdtempSync(join(tmpdir(), "lb-checks-")));

describe("only a human can introduce a command", () => {
  test("a task carries NAMES, never a command", () => {
    // The whole safety argument. If this ever stores a command, an agent that
    // can influence a task can run code on the server.
    const db = seed(openDb(":memory:"));
    const id = createTask(db, {
      projectId: "prj_c", title: "t", creatorId: "usr_c",
      acceptanceChecks: ["tests"],
    });
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    expect(acceptanceChecksOf(row)).toEqual(["tests"]);
    expect(JSON.stringify(row)).not.toContain("npm");
    db.close();
  });

  test("naming a check that nobody defined does NOT pass — it fails loudly", () => {
    // An agent can name anything. A name nobody defined must not be treated
    // as "no checks, therefore fine".
    const db = seed(openDb(":memory:"));
    const id = createTask(db, { projectId: "prj_c", title: "t", creatorId: "usr_c", acceptanceChecks: ["rm-rf"] });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return runAcceptanceChecks(db, task, workspace()).then((runs) => {
      expect(runs[0].passed).toBe(false);
      expect(runs[0].skipped).toContain("no check named");
      db.close();
    });
  });

  test("check names are identifiers, not shell fragments or paths", () => {
    for (const bad of ["../etc", "a;rm -rf /", "a b", "$(whoami)", "", "a".repeat(41), "/abs"]) {
      expect(isValidCheckName(bad), bad).toBe(false);
    }
    for (const good of ["tests", "type-check", "lint_all", "e2e2"]) {
      expect(isValidCheckName(good), good).toBe(true);
    }
  });

  test("a check with no command is refused", () => {
    const db = seed(openDb(":memory:"));
    expect(() => setCheck(db, "prj_c", "tests", "   ")).toThrow();
    db.close();
  });
});

describe("storing checks", () => {
  test("set, read back, overwrite, delete", () => {
    const db = seed(openDb(":memory:"));
    setCheck(db, "prj_c", "tests", "npm test", "usr_c");
    expect(getCheck(db, "prj_c", "tests")?.command).toBe("npm test");

    setCheck(db, "prj_c", "tests", "npm run test:ci", "usr_c");
    expect(getCheck(db, "prj_c", "tests")?.command).toBe("npm run test:ci");
    expect(listChecks(db, "prj_c")).toHaveLength(1);

    expect(deleteCheck(db, "prj_c", "tests")).toBe(true);
    expect(getCheck(db, "prj_c", "tests")).toBeNull();
    db.close();
  });

  test("checks belong to one project", () => {
    const db = seed(openDb(":memory:"));
    db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run("prj_other", "x/o", "O", "office");
    setCheck(db, "prj_c", "tests", "npm test");
    expect(listChecks(db, "prj_other")).toEqual([]);
    db.close();
  });
});

describe("running a check", () => {
  test("exit 0 passes", async () => {
    const r = await runCheck({ projectId: "p", name: "ok", command: "exit 0", createdBy: null, createdAt: "" }, workspace());
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("a non-zero exit fails and the output is kept", async () => {
    // The output is what the agent needs to act on. A bare "failed" costs a
    // turn producing an apology.
    const r = await runCheck(
      { projectId: "p", name: "t", command: "echo 'expected 3, got 4' >&2; exit 1", createdBy: null, createdAt: "" },
      workspace()
    );
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("expected 3, got 4");
  });

  test("it runs in the agent's workspace, not the server's cwd", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "marker.txt"), "here");
    const r = await runCheck({ projectId: "p", name: "t", command: "test -f marker.txt", createdBy: null, createdAt: "" }, ws);
    expect(r.passed).toBe(true);
  });

  test("a command that hangs is a failure, not an inconclusive result", async () => {
    // A check that cannot finish has not passed.
    const r = await runCheck({ projectId: "p", name: "t", command: "sleep 30", createdBy: null, createdAt: "" }, workspace(), 400);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("timed out");
  });
});

describe("what is NOT a failure", () => {
  test("a task that named no checks runs none", async () => {
    const db = seed(openDb(":memory:"));
    const id = createTask(db, { projectId: "prj_c", title: "t", creatorId: "usr_c" });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    expect(await runAcceptanceChecks(db, task, workspace())).toEqual([]);
    db.close();
  });

  test("a workspace on another machine is SKIPPED, not failed", async () => {
    // `npm test` here would be testing the wrong tree, or nothing at all.
    // Reported as skipped so "checked and fine" stays distinguishable from
    // "never checked".
    const db = seed(openDb(":memory:"));
    setCheck(db, "prj_c", "tests", "exit 1");
    const id = createTask(db, { projectId: "prj_c", title: "t", creatorId: "usr_c", acceptanceChecks: ["tests"] });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;

    const runs = await runAcceptanceChecks(db, task, "/no/such/folder/anywhere");
    expect(runs[0].passed).toBe(true);
    expect(runs[0].skipped).toContain("not on this machine");
    expect(runs[0].exitCode).toBeNull();   // never ran, so never "exit 0"
    db.close();
  });
});

describe("the summary an agent is given", () => {
  test("names the check, the exit code and the output", async () => {
    const db = seed(openDb(":memory:"));
    setCheck(db, "prj_c", "tests", "echo 'AssertionError: expected true' >&2; exit 2");
    const id = createTask(db, { projectId: "prj_c", title: "t", creatorId: "usr_c", acceptanceChecks: ["tests"] });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;

    const summary = failureSummary(await runAcceptanceChecks(db, task, workspace()));
    expect(summary).toContain("tests");
    expect(summary).toContain("exit 2");
    expect(summary).toContain("AssertionError");
    db.close();
  });

  test("a passing run produces no summary", async () => {
    const db = seed(openDb(":memory:"));
    setCheck(db, "prj_c", "tests", "exit 0");
    const id = createTask(db, { projectId: "prj_c", title: "t", creatorId: "usr_c", acceptanceChecks: ["tests"] });
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    expect(failureSummary(await runAcceptanceChecks(db, task, workspace()))).toBe("");
    db.close();
  });
});

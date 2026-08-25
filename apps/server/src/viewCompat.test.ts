// The gateway validates the whole workspace view and, on failure, sends
// NOTHING (see registerGateway's broadcastView). So a schema change that
// makes an existing field required does not degrade one card — it blanks
// every office for everyone, until each producer happens to re-handshake.
//
// `machines.providers` is JSON frozen at a machine's last handshake, which
// makes it the most exposed surface in the view: the rows are already on
// disk and the server cannot fix them.
import { describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { buildView, Positions } from "./view.js";
import { ServerMessage } from "@logbridge/protocol";

function seed(providersJson: string): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id,gh_repo,name,layout) VALUES ('p','a/a','a/a','office')").run();
  db.prepare("INSERT INTO users (id,name,avatar) VALUES ('u','U',0)").run();
  db.prepare(
    `INSERT INTO machines (id,owner_id,name,online,last_seen,providers,allow_agent_creation,allow_unsandboxed)
     VALUES ('m','u','mbp',1,?,?,1,0)`
  ).run(new Date().toISOString(), providersJson);
  db.prepare(
    `INSERT INTO agents (id,machine_id,owner_id,project_id,name,role,capabilities,concurrency,status)
     VALUES ('a','m','u','p','dev','developer','[]',1,'idle')`
  ).run();
  return db;
}

const validates = (db: Db) =>
  ServerMessage.safeParse({ type: "view", view: buildView(db, new Positions(), "u") });

describe("a view built from older stored data still ships", () => {
  test("a machine that handshook before ProviderInfo.command existed", () => {
    // Exactly the rows any existing install already has on disk.
    const legacy = JSON.stringify([
      { id: "claude", label: "Claude Code", policy: "claude-settings", verified: true, models: ["claude-opus-5"] },
    ]);
    const res = validates(seed(legacy));
    expect(res.success, res.success ? "" : JSON.stringify(res.error.issues[0])).toBe(true);
  });

  test("a machine that reports no providers at all", () => {
    expect(validates(seed("[]")).success).toBe(true);
  });

  test("a machine whose providers JSON is corrupt", () => {
    // parseJsonArray swallows this into []. The office must still render:
    // one unreadable column is not a reason to show nobody anything.
    expect(validates(seed("{not json")).success).toBe(true);
  });

  test("a current machine, with the command field, still validates", () => {
    const current = JSON.stringify([
      {
        id: "claude", label: "Claude Code", policy: "claude-settings", verified: true,
        models: ["claude-fable-5"],
        command: {
          withModel: 'claude -p "<your task>" --model <model>',
          noModel: 'claude -p "<your task>"',
          bypassFlag: "--permission-mode bypassPermissions",
        },
      },
    ]);
    expect(validates(seed(current)).success).toBe(true);
  });
});

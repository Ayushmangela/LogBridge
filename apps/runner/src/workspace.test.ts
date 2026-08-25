// Workspace isolation, tested against REAL git repositories (house rule 1:
// never mock git's output from memory). Every scratch repo here is a real
// `git init` with a real commit; every assertion about branches and worktrees
// is read back through git itself.
//
// The final test is the integration that justifies the module: an agent whose
// declaration requests a worktree actually RUNS in it — which is the part
// that would silently rot if only resolveWorkspace were unit-tested.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "../../server/src/index.js";
import { loadOrCreateIdentity } from "./identity.js";
import { RunnerConnection } from "./connection.js";
import { fakeHarness } from "./harness/fakeHarness.js";
import { AsyncEventQueue } from "./harness/asyncQueue.js";
import type { AgentEvent, AgentHarness } from "./harness/types.js";
import {
  releaseWorkspace,
  resolveWorkspace,
  type Isolation,
  type WorkspaceRequest,
} from "./workspace.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "logbridge-ws-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

/** A real repository with one commit, so HEAD exists. */
function makeRepo(name = "repo"): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git("config user.email t@t", dir);
  git("config user.name t", dir);
  writeFileSync(join(dir, "file.txt"), "v1\n");
  git("add -A", dir);
  git("commit -m init", dir);
  return dir;
}

const req = (over: Partial<WorkspaceRequest>): WorkspaceRequest => ({
  agentId: "agt_test",
  folder: null,
  isolation: "shared",
  fallbackDir: join(scratch, "fallback"),
  ...over,
});

describe("shared mode", () => {
  test("is byte-identical to today: folder when set", () => {
    const folder = join(scratch, "any");
    const ws = resolveWorkspace(req({ isolation: "shared" as Isolation, folder }));
    expect(ws).toEqual({ cwd: folder, branch: null, ephemeral: false, degradedReason: null });
  });

  test("falls back to fallbackDir when no folder, unchanged", () => {
    const fb = join(scratch, "fallback");
    const ws = resolveWorkspace(req({ isolation: "shared" as Isolation, folder: null, fallbackDir: fb }));
    expect(ws.cwd).toBe(fb);
    expect(ws.degradedReason).toBeNull();
  });
});

describe("worktree mode — real git", () => {
  test("creates a sibling worktree on its own branch", () => {
    const repo = makeRepo();
    const ws = resolveWorkspace(req({ isolation: "worktree", folder: repo }));

    expect(ws.degradedReason).toBeNull();
    expect(ws.branch).toBe("logbridge/agt_test");
    expect(ws.ephemeral).toBe(true);

    // The branch is REAL and checked out IN the worktree.
    expect(git("rev-parse --abbrev-ref HEAD", ws.cwd)).toBe("logbridge/agt_test");
    // Sibling of the repo, never inside it.
    expect(dirname(ws.cwd)).toBe(realpathSync(join(scratch, `${basename(repo)}.worktrees`)));
    // Not inside the repo (git itself must not see it as untracked noise).
    const status = git("status --porcelain", repo);
    expect(status).not.toContain(basename(repo));
  });

  test("two agents on the SAME repo land on different branches in different directories", () => {
    const repo = makeRepo();
    const a = resolveWorkspace(req({ agentId: "agt_a", isolation: "worktree", folder: repo }));
    const b = resolveWorkspace(req({ agentId: "agt_b", isolation: "worktree", folder: repo }));

    expect(a.cwd).not.toBe(b.cwd);
    expect(a.branch).toBe("logbridge/agt_a");
    expect(b.branch).toBe("logbridge/agt_b");
    expect(git("rev-parse --abbrev-ref HEAD", a.cwd)).toBe("logbridge/agt_a");
    expect(git("rev-parse --abbrev-ref HEAD", b.cwd)).toBe("logbridge/agt_b");

    // The isolation is real: a commit on A's branch is invisible from B's.
    writeFileSync(join(a.cwd, "only-a.txt"), "a\n");
    git("add -A", a.cwd);
    git("commit -m a-only", a.cwd);
    expect(existsSync(join(b.cwd, "only-a.txt"))).toBe(false);
  });

  test("an existing worktree is REUSED, not failed on — restart case", () => {
    const repo = makeRepo();
    const first = resolveWorkspace(req({ isolation: "worktree", folder: repo }));
    writeFileSync(join(first.cwd, "wip.txt"), "in progress\n"); // state a restart must keep
    const second = resolveWorkspace(req({ isolation: "worktree", folder: repo }));

    expect(second.cwd).toBe(first.cwd);
    expect(second.degradedReason).toBeNull();
    expect(existsSync(join(second.cwd, "wip.txt"))).toBe(true); // nothing wiped
  });

  test("branch exists but worktree does not — reattaches instead of failing", () => {
    const repo = makeRepo();
    git("branch logbridge/agt_test", repo);
    rmSync(repo, { recursive: true, force: true }); // placeholder; rebuild below
    // Rebuild cleanly (the rm above only simulates losing the worktrees dir;
    // the branch lives in the repo so recreate the same scenario properly):
    const repo2 = makeRepo("repo2");
    git("branch logbridge/agt_test", repo2);

    const ws = resolveWorkspace(req({ isolation: "worktree", folder: repo2 }));
    expect(ws.degradedReason).toBeNull();
    expect(git("rev-parse --abbrev-ref HEAD", ws.cwd)).toBe("logbridge/agt_test");
    void repo;
  });

  test("degrades to shared when the folder is not a git repository", () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "notes.txt"), "no repo here\n");
    const fb = join(scratch, "fallback");
    const ws = resolveWorkspace(req({ isolation: "worktree", folder: plain, fallbackDir: fb }));
    // "Shared" means `folder ?? fallbackDir`, so with a folder configured the
    // degraded workspace IS that folder. Landing on `fb` would leave the agent
    // in an empty directory, doing nothing the person asked for while
    // reporting success — a gate on work happening, which this module exists
    // not to be.
    expect(ws.cwd).toBe(plain);
    expect(ws.ephemeral).toBe(false);
    expect(ws.degradedReason).toMatch(/not a git repository/i);
  });

  test("degrades on a bare repository", () => {
    const bare = join(scratch, "bare.git");
    execSync(`git init --bare ${JSON.stringify(bare)}`);
    const fb = join(scratch, "fallback");
    const ws = resolveWorkspace(req({ isolation: "worktree", folder: bare, fallbackDir: fb }));
    expect(ws.cwd).toBe(bare);
    expect(ws.degradedReason).toMatch(/bare/i);
  });

  test("degrades when the path does not exist", () => {
    const fb = join(scratch, "fallback");
    const ws = resolveWorkspace(
      req({ isolation: "worktree", folder: join(scratch, "missing"), fallbackDir: fb })
    );
    expect(ws.cwd).toBe(fb);
    expect(ws.degradedReason).toMatch(/does not exist/i);
  });

  test("degrades when the git binary is unavailable", () => {
    const repo = makeRepo();
    const fb = join(scratch, "fallback");
    const noGit = () => ({ ok: false, stdout: "", stderr: "" });
    const ws = resolveWorkspace(
      req({ isolation: "worktree", folder: repo, fallbackDir: fb }),
      noGit
    );
    expect(ws.cwd).toBe(repo);
    expect(ws.degradedReason).toMatch(/git is not available/i);
  });
});

describe("copy mode", () => {
  test("copies a non-git folder and reuses the copy afterwards", () => {
    const src = join(scratch, "plain-project");
    mkdirSync(src);
    writeFileSync(join(src, "data.txt"), "contents\n");

    const ws = resolveWorkspace(req({ isolation: "copy", folder: src }));
    expect(ws.degradedReason).toBeNull();
    expect(existsSync(join(ws.cwd, "data.txt"))).toBe(true);

    // Reuse, not re-copy: edits survive a second resolve.
    writeFileSync(join(ws.cwd, "edited.txt"), "mine\n");
    const again = resolveWorkspace(req({ isolation: "copy", folder: src }));
    expect(again.cwd).toBe(ws.cwd);
    expect(existsSync(join(again.cwd, "edited.txt"))).toBe(true);
  });

  test("degrades when there is no folder or the folder is missing", () => {
    const fb = join(scratch, "fallback");
    expect(resolveWorkspace(req({ isolation: "copy", folder: null, fallbackDir: fb })).cwd).toBe(fb);
    expect(
      resolveWorkspace(req({ isolation: "copy", folder: join(scratch, "gone"), fallbackDir: fb })).degradedReason
    ).toBeTruthy();
  });
});

describe("releaseWorkspace", () => {
  test("removes an ephemeral worktree and its registration", () => {
    const repo = makeRepo();
    const ws = resolveWorkspace(req({ agentId: "agt_rel", isolation: "worktree", folder: repo }));
    expect(existsSync(ws.cwd)).toBe(true);

    releaseWorkspace(ws);
    expect(existsSync(ws.cwd)).toBe(false);
    // git has forgotten it entirely.
    const list = git("worktree list --porcelain", repo);
    expect(list).not.toContain(ws.cwd);
  });

  test("is a safe no-op for shared workspaces and missing directories", () => {
    const shared = resolveWorkspace(req({ isolation: "shared", folder: null }));
    expect(() => releaseWorkspace(shared)).not.toThrow();
    expect(() =>
      releaseWorkspace({ cwd: join(scratch, "vanished"), branch: "x", ephemeral: true, degradedReason: null })
    ).not.toThrow();
  });

  test("still removes the directory when git's own remove refuses", () => {
    const repo = makeRepo();
    const ws = resolveWorkspace(req({ agentId: "agt_stubborn", isolation: "worktree", folder: repo }));
    const failingGit = () => ({ ok: false, stdout: "", stderr: "refused" });
    releaseWorkspace(ws, failingGit);
    expect(existsSync(ws.cwd)).toBe(false); // raw-delete fallback did its job
  });
});

// ---- the integration that makes the module more than a well-tested lib ----

let server: BuiltServer;
let baseUrl: string;
let dataDir: string;

function captureHarness(): AgentHarness & { cwds: string[]; prompts: string[] } {
  const cwds: string[] = [];
  const prompts: string[] = [];
  return {
    cwds,
    prompts,
    name: "capture",
    spawn(opts) {
      cwds.push(opts.cwd);
      prompts.push(opts.prompt);
      const q = new AsyncEventQueue<AgentEvent>();
      q.push({ kind: "done", ok: true });
      q.close();
      return { events: q, interrupt: () => {}, kill: () => q.close(), answer: () => {} };
    },
  };
}

describe("end-to-end: an isolated agent runs inside its worktree", () => {
  test("the harness receives the worktree path, not the configured repo", async () => {
    server = await buildServer({ dbPath: ":memory:", leaseSeconds: 30, sweepIntervalMs: 1000 });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/node-ws`;
    dataDir = mkdtempSync(join(tmpdir(), "logbridge-ws-e2e-"));
    server.db.prepare("INSERT INTO projects (id, gh_repo, name, layout) VALUES ('prj_ws','w/w','w/w','office')").run();

    const repo = makeRepo();
    const harness = captureHarness();
    const identity = loadOrCreateIdentity(dataDir, "node_ws_e2e");
    // Stream A owns AgentDecl's folder/isolation fields; cast until they land.
    const conn = new RunnerConnection({
      serverUrl: baseUrl,
      identity,
      machineName: "ws-machine",
      ownerId: "usr_ws",
      ownerName: "ws",
      dataDir,
      leaseSeconds: 30,
      harness,
      agents: [{
        id: "agt_iso",
        name: "iso-dev",
        role: "developer",
        capabilities: [],
        projects: ["prj_ws"],
        ...( { folder: repo, isolation: "worktree" } ),
      } as any],
      log: () => {},
    });
    conn.connect();
    const waitFor = async (check: () => boolean, ms: number, label: string) => {
      const start = Date.now();
      while (Date.now() - start < ms) { if (check()) return; await new Promise(r => setTimeout(r, 50)); }
      throw new Error(`timed out: ${label}`);
    };
    await waitFor(() => !!server.db.prepare("SELECT 1 FROM agents WHERE id='agt_iso'").get(), 5000, "registered");

    await fetch(`${baseUrl.replace("/node-ws", "")}/debug/offer-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agt_iso", title: "work isolated" }),
    });

    await waitFor(() => harness.cwds.length > 0, 8000, "task ran");
    const cwd = harness.cwds[0];
    expect(cwd).not.toBe(repo);                                   // not the shared checkout
    expect(git("rev-parse --abbrev-ref HEAD", cwd)).toBe("logbridge/agt_iso");

    conn.stop();
    await server.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Added during Stream A's verification pass.
//
// WORKSPACE.md promises that a failed isolation "returns the shared
// directory". Shared mode resolves `folder ?? fallbackDir` — so for an agent
// WITH a folder configured, degrading has to land on that folder. Landing on
// the scratch fallback instead is the silent-failure case: the person picked
// /Users/them/notes, ticked Worktree without knowing it isn't a git repo, and
// the agent works in an empty directory, reports success, and touches nothing
// they care about.
describe("degrading keeps the folder the person actually chose", () => {
  test("a non-git folder degrades to that folder, not to a scratch directory", () => {
    const plain = mkdtempSync(join(tmpdir(), "lb-plain-"));
    writeFileSync(join(plain, "their-work.txt"), "the reason they picked this folder");
    const fallback = join(mkdtempSync(join(tmpdir(), "lb-fb-")), "agt_x");

    const ws = resolveWorkspace({
      agentId: "agt_x", folder: plain, isolation: "worktree", fallbackDir: fallback,
    });

    expect(ws.degradedReason).toMatch(/not a git repository/i);
    expect(ws.cwd, "must be the configured folder — that is what shared means").toBe(plain);
    expect(existsSync(join(ws.cwd, "their-work.txt"))).toBe(true);
  });

  test("a bare repository degrades to the folder too", () => {
    const bare = mkdtempSync(join(tmpdir(), "lb-bare-"));
    execSync(`git init -q --bare ${bare}`);
    const fallback = join(mkdtempSync(join(tmpdir(), "lb-fb2-")), "agt_y");

    const ws = resolveWorkspace({
      agentId: "agt_y", folder: bare, isolation: "worktree", fallbackDir: fallback,
    });
    expect(ws.degradedReason).toBeTruthy();
    expect(ws.cwd).toBe(bare);
  });

  test("with NO folder configured the fallback is still the only option", () => {
    // The one case where the scratch directory is genuinely correct.
    const fallback = join(mkdtempSync(join(tmpdir(), "lb-fb3-")), "agt_z");
    const ws = resolveWorkspace({
      agentId: "agt_z", folder: null, isolation: "worktree", fallbackDir: fallback,
    });
    expect(ws.cwd).toBe(fallback);
    expect(ws.degradedReason).toBeTruthy();
  });
});


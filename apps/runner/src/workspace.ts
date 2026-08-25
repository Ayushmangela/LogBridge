// Agent workspace isolation (HANDOFF-WORKSPACE.md, stream B).
//
// Two agents pointed at the same repository share one git index, one HEAD,
// one branch — so agent A checking out a branch silently lands agent B's
// mid-edit work on the wrong one, or the two fight over index.lock. This
// module gives each agent its own corner: a git worktree on its own branch,
// or a plain copy when there is no repo to branch.
//
// The rule that governs every path here: isolation is a CONVENIENCE, never a
// gate on work happening. Anything that cannot be honoured degrades to the
// shared directory with a recorded reason — the same trade the memory system
// makes (recall failure means "no memory", never "no task"). A task that runs
// un-isolated with a warning is strictly better than a task that does not run.
//
// All git interaction goes through spawnSync against the real binary. Nothing
// here parses git's output from memory; the test suite runs real git against
// real scratch repositories (house rule 1).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Isolation = "shared" | "worktree" | "copy";

export interface WorkspaceRequest {
  agentId: string;
  /** The repo or folder this agent was configured with, if any. */
  folder: string | null;
  isolation: Isolation;
  /** <dataDir>/work/<agentId> — the fallback when folder is null. */
  fallbackDir: string;
}

export interface Workspace {
  /** Where the harness should actually run. */
  cwd: string;
  /** The branch checked out, when this is a worktree. */
  branch: string | null;
  /** True when a worktree was created and may be removed on cleanup. */
  ephemeral: boolean;
  /** Set when the requested mode could not be honoured and it fell back. */
  degradedReason: string | null;
}

/** Git ref names reject spaces, tildes, etc. Agent ids are generated, but an
 *  id that arrived through a hand-written agents-file is nobody's guarantee. */
function safeRefPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "agent";
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

type ExecGit = (args: string[], cwd?: string) => GitResult;

function defaultExecGit(args: string[], cwd?: string): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SHARED = (cwd: string, degradedReason: string | null = null): Workspace =>
  ({ cwd, branch: null, ephemeral: false, degradedReason });

/**
 * Worktrees root in a SIBLING of the repo — never inside it. A worktree that
 * lives inside its own repository confuses git's discovery and shows up as
 * untracked noise in the parent's status forever.
 */
function worktreePathFor(repoDir: string, agentId: string): string {
  const base = basename(repoDir);
  const siblingRoot = join(dirname(repoDir), `${base}.worktrees`);
  mkdirSync(siblingRoot, { recursive: true });
  return join(siblingRoot, safeRefPart(agentId));
}

export function resolveWorkspace(
  req: WorkspaceRequest,
  execGit: ExecGit = defaultExecGit
): Workspace {
  // shared is today's behaviour, byte for byte — including the case where
  // the directory does not exist yet; connection.ts mkdirs after this.
  if (req.isolation === "shared") {
    return SHARED(req.folder ?? req.fallbackDir);
  }

  if (!req.folder) {
    return SHARED(req.fallbackDir, `isolation "${req.isolation}" requested but no folder is configured`);
  }
  if (!existsSync(req.folder) || !statSync(req.folder).isDirectory()) {
    return SHARED(req.fallbackDir, `folder "${req.folder}" does not exist`);
  }

  if (req.isolation === "copy") {
    return resolveCopy(req, req.folder);
  }
  return resolveWorktree(req, req.folder, execGit);
}

function resolveCopy(req: WorkspaceRequest, folder: string): Workspace {
  const target = join(
    dirname(folder),
    `${basename(folder)}.copies`,
    safeRefPart(req.agentId)
  );
  try {
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(folder, target, { recursive: true });
    }
    // An existing copy is reused, not re-copied: like a worktree, it is the
    // agent's home across tasks and restarts, and wiping it per task would
    // destroy exactly the in-progress state isolation exists to protect.
    return { cwd: target, branch: null, ephemeral: false, degradedReason: null };
  } catch (err) {
    return SHARED(req.folder ?? req.fallbackDir, `copy failed: ${(err as Error).message}`);
  }
}

function resolveWorktree(req: WorkspaceRequest, repoDir: string, execGit: ExecGit): Workspace {
  // Degrading means falling back to SHARED, and shared resolves
  // `folder ?? fallbackDir` — so an agent that named a folder must still land
  // in it. Using fallbackDir here instead sent the agent to an empty scratch
  // directory: it would run, report success, and touch nothing the person
  // cared about. Silent and wrong beats loud and wrong only in the other
  // direction. `folder` is known to exist by this point (checked above).
  const degrade = (why: string): Workspace => SHARED(req.folder ?? req.fallbackDir, why);
  const branch = `logbridge/${safeRefPart(req.agentId)}`;

  try {
    const git = execGit(["--version"]);
    if (!git.ok) return degrade(`git is not available: ${git.stderr.trim() || "no output"}`);

    const inside = execGit(["rev-parse", "--is-inside-work-tree"], repoDir);
    const bare = execGit(["rev-parse", "--is-bare-repository"], repoDir);
    if (bare.ok && bare.stdout.trim() === "true") {
      return degrade("folder is a bare repository — nothing to check out");
    }
    if (!(inside.ok && inside.stdout.trim() === "true")) {
      return degrade("folder is not a git repository");
    }

    const repoAbs = execGit(["rev-parse", "--show-toplevel"], repoDir).stdout.trim() || repoDir;
    const wtPath = worktreePathFor(repoAbs, req.agentId);

    // Reuse over rebuild: agents restart, and a restart must not need a
    // cleanup pass first. An existing valid worktree at our path IS ours.
    if (existsSync(wtPath)) {
      const valid = execGit(["rev-parse", "--is-inside-work-tree"], wtPath);
      if (valid.ok && valid.stdout.trim() === "true") {
        // macOS hands out /var/... while git reports /private/var/... —
        // normalise once here so every consumer sees the same string.
        return { cwd: realpathSync(wtPath), branch, ephemeral: true, degradedReason: null };
      }
      // A stale non-worktree directory squatting on our path would make
      // `worktree add` fail below; remove it so reuse stays possible.
      rmSync(wtPath, { recursive: true, force: true });
    }

    // If the branch already exists (agent removed, worktree cleaned), attach
    // to it instead of failing on `-b` with "already exists".
    const branchExists = execGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoDir).ok;
    const addArgs = branchExists
      ? ["worktree", "add", wtPath, branch]
      : ["worktree", "add", "-b", branch, wtPath];
    const added = execGit(addArgs, repoDir);
    if (!added.ok) {
      return degrade(`git worktree add failed: ${added.stderr.trim().split("\n")[0]}`);
    }
    return { cwd: realpathSync(wtPath), branch, ephemeral: true, degradedReason: null };
  } catch (err) {
    // spawnSync itself throwing (ENOENT on the binary, permissions) lands here.
    return degrade(`worktree setup failed: ${(err as Error).message}`);
  }
}

/**
 * Remove an ephemeral workspace created by resolveWorkspace. Safe to call on
 * anything: a non-ephemeral workspace, a missing directory, or a worktree
 * whose repo has already moved on are all no-ops rather than errors — cleanup
 * runs where nobody is watching, and must not be the thing that fails.
 *
 * Deliberately NOT wired into the task path: worktrees are the agent's home
 * across tasks and restarts, and tearing one down between tasks would delete
 * the in-progress state isolation exists to protect. Release belongs to an
 * explicit teardown decision (e.g. a "reset workspace" control).
 */
export function releaseWorkspace(ws: Workspace, execGit: ExecGit = defaultExecGit): void {
  if (!ws.ephemeral) return;
  if (!existsSync(ws.cwd)) return;

  const removed = execGit(["worktree", "remove", "--force", ws.cwd], ws.cwd);
  if (removed.ok) return;

  // `git worktree remove` refuses from INSIDE the worktree in some versions;
  // retry from the parent, then fall back to a raw delete so a stuck entry
  // never outlives this process's willingness to clean up.
  const parent = dirname(ws.cwd);
  const retried = execGit(["worktree", "remove", "--force", ws.cwd], parent);
  if (retried.ok) return;

  rmSync(ws.cwd, { recursive: true, force: true });
  // Prune so git forgets the registration; failure here is harmless — the
  // next resolveWorkspace treats a prunable entry as absent anyway.
  execGit(["worktree", "prune"], parent);
}

# Agent workspaces

Every agent runs somewhere. This document is about **where**, and what happens
when "where" cannot be honoured.

The mechanism lives in `apps/runner/src/workspace.ts` (`resolveWorkspace` /
`releaseWorkspace`). The machine owner (or, soon, the Add Agent wizard)
picks an `isolation` mode per agent; the runner resolves it before every
spawn. Nothing else in the runner changed — budget caps, leases, reconnect
and the harness boundary are untouched.

---

## The three modes

### `shared` — the default, and yesterday's behaviour exactly

The agent runs in its configured `folder`, or in
`<dataDir>/work/<agentId>` when none was given.

**Use it when:** only one agent ever touches this folder, or the folder is
throwaway.

**Costs:** none — and one real hazard: two agents sharing a directory share
one git index, one HEAD and one branch. Agent A checking out a branch lands
agent B's uncommitted edits on the wrong branch, or both collide on
`index.lock` and one simply fails. If two agents will touch the same
repository, do not use `shared`.

### `worktree` — a real git worktree per agent

`resolveWorkspace` runs `git worktree add -b logbridge/<agentId>` against the
configured repo, rooting the new checkout in a **sibling directory**
(`<repo>.worktrees/<agentId>`) — never inside the repo itself, where it would
pollute the parent's status and confuse git's discovery.

Properties that matter:

- **Real isolation.** Different branch, different index, different directory.
  A commit on agent A's branch does not exist on B's.
- **Persistent by design.** The second resolve for the same agent *reuses*
  the existing worktree rather than failing or rebuilding — agents restart,
  and a restart must not need a cleanup pass first. In-progress edits survive.
- **Branch already exists, worktree doesn't?** It reattaches instead of
  failing with "branch already exists".

**Costs:** full extra checkout per agent (disk), one `git worktree add` at
first task (fast, but not free), and `git worktree` metadata that outlives
crude `rm -rf` unless you prune. Deleting an agent's directory by hand leaves
a prunable entry; the next resolve treats that as absent and moves on.

### `copy` — a plain recursive copy

For folders that are not git repositories at all (notes trees, data drops,
config bundles). First task copies `<folder>` to a sibling
`<folder>.copies/<agentId>`; later resolves reuse the copy so in-progress
edits are never wiped.

**Costs:** disk for a full duplicate, no sync back to the source (the copy is
the workspace, the original stays untouched), and nothing incremental — a
10 GB folder copies as 10 GB.

---

## The rule every failure path follows

Isolation is a convenience, never a gate on work happening.

When the requested mode cannot be honoured — not a git repo, bare repo,
missing path, `git` absent from PATH, `worktree add` failing, permissions —
`resolveWorkspace` returns the shared directory with **`degradedReason` set**,
and the runner logs why. It never throws into the task path. A task that runs
un-isolated with a warning beats a task that does not run.

You can see the reason: it arrives wherever the agent's card is shown, and the
runner logs it at accept time (`workspace degraded for <agent>: …`).

---

## Cleanup semantics

`releaseWorkspace(ws)` removes an ephemeral worktree (directory *and* git's
registration, with a raw-delete fallback if git refuses) and is a safe no-op
for anything else.

It is deliberately **not wired into the task path**: worktrees are the agent's
home across tasks and restarts, and tearing one down between tasks would
delete the in-progress state isolation exists to protect. Release belongs to
an explicit teardown decision — e.g. a future "reset workspace" control —
which is Stream A's side of this feature.

---

## What each mode costs, honestly

| | Disk | Setup cost | Breaks when |
|---|---|---|---|
| `shared` | none | none | two agents touch one repo |
| `worktree` | ~1 checkout/agent | one `git worktree add` | folder isn't a repo · git missing · exotic ref names |
| `copy` | full duplicate/agent | first-task copy time | source changes after first copy (no sync) |

Every failure mode above degrades to `shared`; nothing here has ever refused
to run a task, and the test suite holds that line.

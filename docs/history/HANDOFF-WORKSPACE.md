# Brief: agent workspace isolation (parallel stream B)

**Read this whole file before writing code. It is self-contained.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI process (`claude`, `opencode`, …)
on its owner's own machine. A browser watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- TypeScript monorepo: `packages/protocol`, `apps/server`, `apps/runner`,
  `apps/web`, `apps/desktop`
- Server: Fastify + WebSocket + SQLite. Renderer: Pixi.js in a single HTML file
- You will work almost entirely in **`apps/runner`** — the process that owns
  and supervises the agent CLIs

Useful reading before you start, in this order:

| File | Why |
|---|---|
| `apps/runner/src/connection.ts` | The runner's core. Your call sites live here |
| `apps/runner/src/createdAgents.ts` | Short, and the clearest example of the house code style |
| `SYSTEM.md` §7 | Why the machine owner decides what runs locally |
| `DECISIONS.md` D1 | Agents run **only** on their owner's machine |

Commands:

```bash
cd apps/runner && npx vitest run      # the suite you must keep green
cd apps/runner && npx tsc --noEmit    # must be clean
```

---

## 2. ⚠️ You are one of two AIs working on this repo right now

This matters more than anything else in this document. Work is deliberately
split into two streams that touch **different files**, so both can run at full
speed without merge conflicts.

### Stream A — the other AI (already assigned, do not touch)

Building the **Add Agent wizard** and the **Command Center UI** from a set of
design mockups:

- A 4-step agent creation wizard: identity (name · character sprite · colour),
  workspace, engine (provider · model · command preview), briefing
- New database columns on the `agents` table, and matching protocol changes
- Expanding the provider registry with more agent CLIs
- A per-agent detail view with tabs (commands catalog, memory, activity)
- All of this lands in `apps/web/index.html`, `packages/protocol/**`,
  `apps/server/**`, and two specific runner files

### Stream B — you

Everything below. **Git worktree isolation in the runner.** Backend only. You
will not write a single line of UI.

### Why this split

Stream A edits a 2,200-line single-file UI and the shared protocol. Stream B
edits one new runner module. The overlap is *two lines* of one file, named
explicitly in §5. Respect that boundary and the two streams merge cleanly.
Ignore it and you will destroy someone else's work.

**Stream A depends on you.** Its "workspace" wizard step configures the
isolation modes you are about to build. Build the mechanism; they build the
control panel. Do not build a UI for it — theirs is already in progress.

---

## 3. The bug you are fixing

Every agent gets a working directory, chosen here:

```ts
// apps/runner/src/connection.ts  (~line 297, and again ~558)
const cwd = agent.cwd ?? join(this.opts.dataDir, "work", agent.id);
```

Separate directories — but **nothing in this repo uses git worktrees**.
Verify it yourself:

```bash
grep -ri worktree apps/ | wc -l     # 0
```

So the moment two agents on one machine are pointed at the same repository —
which is exactly what this product is for — they share a single working tree:
**one git index, one HEAD, one branch.** Agent A checks out a branch while
agent B is mid-edit, and B's changes are silently on the wrong branch. Or the
two collide on `index.lock` and one simply fails.

The project's own architecture diagram states the intent plainly:
*"git · each agent in its own isolated worktree."* Nothing implements it.

---

## 4. What to build

Create **`apps/runner/src/workspace.ts`**:

```ts
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

export function resolveWorkspace(req: WorkspaceRequest): Workspace;
export function releaseWorkspace(ws: Workspace): void;
```

### Behaviour

**`shared`** — today's behaviour exactly: `folder ?? fallbackDir`. This is the
default and must stay byte-identical, so nothing existing changes.

**`worktree`** — `git worktree add` onto a branch named `logbridge/<agentId>`,
rooted in a **sibling** directory, never inside the repo (a worktree inside its
own repo confuses git and pollutes status). If the worktree already exists,
reuse it rather than failing — agents restart, and a restart must not need
cleanup first.

**`copy`** — a plain recursive copy, for a folder that is not a git repo at all.

### The rule that governs every failure path

Isolation is a **convenience, never a gate on work happening.**

If `resolveWorkspace` cannot do what was asked — not a git repo, `git` not
installed, `worktree add` fails, detached HEAD, dirty index, permissions — it
**degrades to `shared`, records `degradedReason`, and logs why.** It must never
throw into the task path.

A task that fails because its workspace could not be isolated is strictly worse
than a task that runs in the shared directory with a warning. This is the same
principle the memory system already follows: recall failure degrades to "no
memory", never to a hang.

### Cases your tests must cover

- the folder is not a git repo
- the `git` binary is missing
- the worktree already exists (restart case)
- the branch already exists but the worktree does not
- a bare repo
- a path that does not exist
- two agents requesting the same folder concurrently
- `shared` mode produces exactly what the current code produces

---

## 5. File ownership — binding

**Yours. Nobody else will touch these:**

```
apps/runner/src/workspace.ts          (new)
apps/runner/src/workspace.test.ts     (new)
WORKSPACE.md                          (new — document the three modes)
apps/runner/src/connection.ts         ONLY the two `const cwd = agent.cwd ?? …`
                                      lines (~297 and ~558). Nothing else in
                                      this file.
```

**Not yours. Do not edit, for any reason:**

```
apps/web/index.html
packages/protocol/**
apps/server/**
apps/runner/src/harness/**
apps/runner/src/createdAgents.ts
CONTRACT.md   README.md   MEMORY.md   PHASES.md   COMMAND-CENTER.md
```

If your feature appears to need a file from the second list, **stop and say
so in your final report** rather than editing it. That is a real interface
question that needs both streams to agree — not a merge conflict discovered
three days later.

### The interface you can rely on

Stream A is adding `folder` and `isolation` to the `AgentDecl` interface in
`connection.ts`. **Do not add those fields yourself** — that edit lands in
their region of the file. Code against them defensively:

```ts
// Stream A owns the AgentDecl interface; these casts come out once their
// fields land. See HANDOFF-WORKSPACE.md §5.
const isolation = ((agent as any).isolation ?? "shared") as Isolation;
const folder = ((agent as any).folder ?? null) as string | null;
```

---

## 6. House rules — non-negotiable in this repo


1. **Capture real output. Never write a fixture to match your code.** This
   repo has found three separate parser bugs exactly that way — including a
   run that wrote a file and reported zero tool calls, because the parser was
   written from documentation. For you: run **real `git` commands against a
   real scratch repo** in your tests. Do not mock git's output from memory.
2. **A test must fail without your fix.** Prove it by reverting the fix and
   watching it go red. You will be asked whether you did this.
3. **Comments explain *why*, not *what*.** Read `createdAgents.ts` for the
   voice — every non-obvious decision carries its reason.
4. **Report honestly.** If something is half-done, say which half. If a test
   is skipped, say so. Do not report completion for partial work.

---

## 7. Done means

- [ ] `resolveWorkspace` handles all three modes and degrades safely on every
      failure path in §4, with `degradedReason` set and logged
- [ ] Two agents given the same repo with `isolation: "worktree"` end up on
      **different branches in different directories** — proven by a test
      against a real git repo, not a mock
- [ ] `shared` behaviour is unchanged, proven by a test
- [ ] `releaseWorkspace` cleans up an ephemeral worktree and is a safe no-op
      otherwise
- [ ] `WORKSPACE.md` explains the three modes and, honestly, what each costs
      (disk, setup time, what breaks)
- [ ] `cd apps/runner && npx vitest run` — fully green
- [ ] `cd apps/runner && npx tsc --noEmit` — clean
- [ ] `git status --short` shows **nothing** from the "not yours" list

## 8. When you finish

Report back with:

1. What you built, in a few sentences
2. The test count before and after
3. Which failure paths you actually exercised against real git
4. Confirmation you reverted your fix once and watched a test fail
5. Anything you wanted to change in the "not yours" list but didn't

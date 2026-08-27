# Feature inventory — LogBridge vs the design

Everything in the mockups and in `~/munder-difflin`, mapped against what this
repo actually has. Checked against code, not memory.

---

## The finding that reframes several answers

`~/munder-difflin` is an **Electron desktop app**. Its PTY lives in the main
process and streams to the renderer over local IPC, drawn with `xterm.js`.
Terminal, IDE, git, file pickers and voice are all cheap and safe there,
because **the UI and the shell are the same machine and the same user.**

**LogBridge is a browser talking to a server over a network.** That is a
different product with a different threat model, and it is a deliberate choice
(D1/D2), not an oversight. Several features are trivial in one and dangerous
in the other. Where that happens, this document says so rather than pretending
they are the same job.

---

## 1. Agent lifecycle — what exists

| Capability | State |
|---|---|
| Create from the browser | ✅ full wizard: identity, workspace, engine, briefing |
| Import a hire from `.json` | ✅ fills for review, nothing spawns until you press it |
| Run a real CLI | ✅ `claude` + `opencode` verified against captured output |
| Per-agent provider / model | ✅ |
| Workspace isolation | ✅ shared / worktree / copy, degrades safely |
| Summon to a location | ✅ real event, both browsers see it |
| Cancel a running task | ✅ |
| Mid-task question → human | ✅ |
| Delegate to another agent | ✅ sealed end to end |
| Request code review | ✅ sealed |
| Share context | ✅ sealed |
| Shared memory + recall | ✅ BM25 + recency, deduped |
| Agents choose what to remember | ✅ `REMEMBER:` convention |
| Idle roaming, run animation, head card | ✅ |
| Scheduled + event triggers | ✅ loops live, API, UI tab |

## 2. Agent lifecycle — what is missing

**This is the real gap, and it is bigger than the tab list.**

| Missing | Why it matters |
|---|---|
| **Delete / retire an agent** | You can create agents but never remove one. They accumulate forever |
| **Edit an agent** | Name, provider, model, folder, briefing are permanent after creation. A typo is forever |
| **Pause / disable** | No way to stop an agent taking work short of deleting it — which you also cannot do |
| **Write its note** | The column exists, the roster renders it, **nothing can set it**. A dead field |
| **Per-agent task history** | The events are all logged; nothing surfaces "what has this agent done" |
| **Restart a wedged agent** | Recovery today is restarting the whole runner |
| **Agent health** | Last heartbeat, uptime, consecutive failures — data exists, nothing shows it |
| **Move / import an agent between projects** | See §4 |
| **Session resume** | The mockup's step 2 is "folder · isolation · **resume**". Resume was never built, in the wizard or the harness |

## 3. The Command Center vs the employee panel

**The observation in the screenshots is correct and worth building around.**
The reference has two different surfaces:

- **The orchestrator** ("Michael", the god agent) gets the ten-tab Command
  Center: terminal, monitor, tasks, ask me, triggers, memory, graph, activity,
  commands, workers. It is a *floor management* console.
- **An employee agent** ("Andy") gets a much smaller panel: `TERMINAL / GIT /
  MESSAGES / TRACES`, plus **pause · halt · steer**.

LogBridge currently gives every agent the same four tabs and has no
orchestrator role in the UI at all. Splitting these is a design decision worth
making explicitly before more tabs get built, or the Command Center becomes
ten tabs that are wrong for nine agents out of ten.

| Tab | Ours | Reference | Note |
|---|---|---|---|
| commands | ✅ | ✅ | |
| activity | ✅ | ✅ | |
| memory | ✅ | ✅ | theirs adds semantic search + an editable memory file |
| triggers | ✅ | ✅ | theirs adds webhooks + org keys |
| **tasks** | ❌ | ✅ | Easiest one left — `Room.tasks` is already in the view |
| **monitor** | ❌ | ✅ | Now specified: dispatch box + per-agent ctx/budget + engine swap |
| **workers** | ❌ | ✅ | Still unspecified |
| **graph** | ❌ | ✅ | Agent↔agent message graph |
| **ask me** | ❌ | ✅ | **Probably already built** — M4's question flow, unsurfaced |
| **terminal** | ❌ | ✅ | See §5 |
| **git** (per agent) | ❌ | ✅ | Branch, diff, commits for that agent's worktree |
| **traces** (per agent) | ❌ | ✅ | Its tool calls and steps |
| **pause / halt / steer** | ❌ | ✅ | Steer injects context without typing into the terminal |

## 4. Project scoping — mostly already true

**Agents are already project-scoped.** `agents.project_id` exists and
`buildView` filters agents into their own room. Creating a second project
already gives it its own empty roster.

What is missing is only the **move/import path**: taking an agent that works
(its provider, model, folder, tool policy, briefing) and reusing it in another
project. Two honest variants, and they are different features:

- **Copy the configuration** — a new agent, same settings, no history. Simple.
- **Move the agent** — same identity, its memories and task history follow it.
  Needs a decision about what project-scoped memory means when the agent
  leaves.

## 5. Live terminal — why it is not just another tab

**Asked directly: when do we build it? Answer: after sign-in exists, and not
before.**

In the reference, the PTY and the window are the same machine and the same
user. Streaming it is local IPC.

In LogBridge, the browser is somewhere else. Streaming a PTY means **an
interactive shell on someone's laptop, served over the network to anything
that can reach the URL** — and there is still no authentication (D23,
trust-on-first-sight). A read-only stream is already a live feed of source
code, keys echoed into a prompt, and file contents. A writable one is remote
code execution with no login.

The dependency is not negotiable, but the feature can be staged:

1. **Traces tab** — structured tool calls and step boundaries per agent, from
   events already logged. Delivers most of "what is it doing" with none of the
   risk. **Buildable now.**
2. **Read-only output stream** — the harness already parses CLI output; stream
   the *parsed* lines, not the raw PTY. Still no shell.
3. **Raw read-only PTY** — after enrolment (D23).
4. **Interactive terminal** — after enrolment, and only for the machine's own
   owner.

`pause` / `halt` / `steer` are **not** blocked by this. Steering injects
context through the existing task channel rather than typing into a terminal,
so it is buildable now and is most of the practical value.

## 6. Blocked, with the reason

| | Blocked on |
|---|---|
| Semantic memory search | An embedding model. Recall is BM25 and says so |
| `opencode` tool policy | No per-run mechanism upstream |
| Forward secrecy | Needs a double ratchet |
| Progress **percentage** | Permanently impossible — no CLI reports a total. Counts work |
| Terminal, IDE button | Enrolment (D23) |
| Slack / webhooks in | New external integration; D9/D10 apply |
| Voice input, file attach | Browser APIs exist; needs a spec for where the files go |

## 7. Recommended order

**Now, and worth more than any new tab:** agent lifecycle (§2). Edit, retire,
pause, note, history. The product lets you hire and never manage.

**Then:** tasks tab, ask-me (check it is not a duplicate first), traces,
pause/halt/steer, monitor.

**Then:** project move/import, session resume, agent health.

**Deferred by dependency:** terminal, IDE, git-per-agent (needs worktree paths
exposed), graph, workers, Slack.

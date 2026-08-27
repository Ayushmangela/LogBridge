# Brief: Stream B — the server (round 4, the floor console)

**You arrive here from `HANDOFF-SERVER-3.md`. Its Phases 4–6 must be pushed
before you start.** Work Phase 7 → 8 → 9 without stopping. Phase 9 ends the
server lane.

§1–§4 of `HANDOFF-SERVER-2.md` still apply unchanged — ownership, git rules,
process, house rules. Re-read them if you have compacted.

---

## Phase 7 — Monitor: the dispatch and capacity console

The mockup's **monitor** tab is now specified well enough to build. It is the
floor-management view: what every agent is costing in context, and one box to
dispatch new work.

- Add to `AgentView`: **context used vs its limit**, **tool-call count for the
  current task**, and **the engine it is running** (provider + model, already
  stored). These are small, per-agent, and belong in the view
- **`POST /api/agents/:id/engine`** — change an agent's provider/model. It
  restarts the agent's harness, so say so in the response rather than
  pretending it is instant
- **Dispatch** already exists as task creation. Do not build a second path —
  point the tab at `/debug/offer-task`'s real successor, or promote that
  endpoint properly if it is still dev-only

**Context usage is the one that needs care.** The runner knows it; the server
does not. It has to ride the existing heartbeat or status message rather than
becoming a new poll — a per-agent poll every few seconds is exactly the cost
this architecture avoids by pushing full snapshots on change.

**Also: cost tracking is out of scope.** The repo owner uses their own
subscription; `budgetUsd` exists and stays, but do not build spend reporting.

**Done when:** context and tool-call counts appear per agent and update as
work runs; changing an engine takes effect on the next task; nothing polls
per-agent on a timer.

## Phase 8 — The message graph

The mockup's **graph** tab draws who talked to whom. Every edge already exists
in the event log — delegation, review requests, context shares, and chat.

- **`GET /api/graph`** (scoped to a room) — nodes are agents, edges are
  messages between them, with a count and a most-recent timestamp per edge
- Distinguish edge kinds. A delegation is not the same relationship as a chat
  message, and the mockup colours them differently
- Bound it by time. "Everything since the beginning" stops being a useful
  picture within a week

**Sealed payloads stay sealed (D26).** The server routes cross-machine
messages and provably cannot read them. The graph is built from **envelope
metadata** — who, to whom, what kind, when — never from content. If you find
yourself wanting the body, stop: that is the property the whole sealed design
exists to protect.

**Done when:** a room with real delegations and chat produces a graph whose
edges match the event log; edge kinds are distinguishable; the window is
bounded; no sealed content is read.

## Phase 9 — Workers, and closing the lane

**`workers` is the one tab still undefined.** In the reference it appears to
be the pool of processes behind the agents. Before building anything:

- Look at what the runner already reports — machines, providers, concurrency,
  leases, heartbeats. Most of a "workers" view is probably already in
  `MachineView`
- **If it turns out to be a re-skin of the machines/settings view, say so and
  do not build it.** A second view of the same data that drifts apart is worse
  than one view. This is the same judgement call the browser lane is making
  about `ask me`

Then close the lane:

- Re-read `FEATURE-INVENTORY.md` §2 and confirm which gaps are now closed
- Confirm `CONTRACT.md` documents every wire change made across rounds 2–4,
  with a version bump and changelog row for each
- Write **`SERVER2-FINAL-RESULT.md`**: everything built across all three
  documents, every decision forced and what you chose, final test counts, and
  **an honest list of anything you left half-done or skipped**

**Done when:** workers is either built or reasoned away in writing; the
contract matches the code; the final result file exists.

---

## → End of the server lane

There is no next document. Stop here and wait — the reviewer verifies the
whole chain now.

**Deliberately not in this lane, and not an oversight:**

- **A real terminal / IDE button.** Blocked on enrolment (D23). Serving a PTY
  to a browser is a remote shell on someone's laptop with no sign-in. See
  `HANDOFF-SERVER-3.md` Phase 5 for the read-only alternative that *is* built
- **Slack and inbound webhooks.** A new external integration; D9/D10 apply
- **Semantic memory search.** No embedding model exists here; recall is BM25
  and says so honestly rather than pretending

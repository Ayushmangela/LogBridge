# Brief: Stream A — the browser (round 4, the last tabs)

**You arrive here from `HANDOFF-BROWSER-3.md`. Its Phases 4–6 must be pushed
before you start.** Work Phase 7 → 8 → 9 without stopping. Phase 9 ends the
browser lane.

§1–§4 of `HANDOFF-BROWSER-2.md` still apply — ownership, git rules, **verify
by clicking**, house rules. Re-read if you have compacted.

---

## Phase 7 — Live output, presented honestly

Depends on Stream B Phase 5 (the read-only parsed output stream).

- On the employee panel, show the agent's output as it arrives
- Auto-scroll, but **stop following the moment the reader scrolls up**. A log
  that yanks you back to the bottom while you are reading is unusable
- Cap what is retained in the DOM. A long-running agent will out-produce any
  browser that keeps everything
- **Label it for what it is.** This is the agent's *output*, not a terminal.
  It has no prompt, accepts no input, and must not grow a text box that looks
  like one

**Why the distinction is load-bearing:** a real terminal means serving a shell
on somebody's laptop to anyone who can reach this URL, and there is still no
sign-in (D23). If this panel looks interactive, people will reasonably assume
it is, and the first thing they will try to type is a command.

**Done when:** output streams live; scrolling up holds position; a flood does
not freeze the tab; nothing in the UI suggests you can type into it.

## Phase 8 — Graph and messages

Depends on Stream B Phase 8 for the graph.

- **Graph tab** — agents as nodes, messages as edges, edge kinds visually
  distinct (delegation vs review vs chat). Clicking a node opens that agent
- Layout must be **deterministic**: same data, same picture, on every browser.
  A force layout seeded from `Math.random()` breaks that, and this repo has a
  standing rule against `Math.random()` in a render path for exactly that
  reason. Seed from agent ids, as the roaming code already does
- **Messages tab** on the employee panel — that agent's conversation: what it
  was asked, what it answered, questions it raised

Check `messages` against what exists before building. Room chat and the
mid-task question flow both already work; if this is a filtered view of them,
build the filter, not a second store.

**Done when:** the graph matches the real event log, is identical across two
browsers, and its nodes are clickable; messages shows real conversation and is
not a parallel copy of chat.

## Phase 9 — Workers, then close the lane

- Take Stream B's Phase 9 conclusion on **workers**. If they reasoned it away
  as a re-skin of machines/settings, **do not build it** — link to that view
  instead and say so
- Sweep every empty state you have added across rounds 2–4. An agent with no
  history, no traces, no git, no memories, no messages should each read as a
  sentence a person understands, never a blank panel
- Check the office still works: roaming, run animation, head card, summon,
  the four original tabs

Then write **`BROWSER2-FINAL-RESULT.md`**: everything built across all three
documents · **what you clicked to verify each** · the Phase 4 recommendation
on the two-surface split and whether you kept it · anything you left half-done
or skipped, honestly.

**Done when:** no blank panels remain; the office is unbroken; the final
result file exists.

---

## → End of the browser lane

There is no next document. Stop here and wait — the reviewer verifies the
whole chain now.

**Deliberately not in this lane:**

- **A terminal tab or IDE button.** Blocked on enrolment (D23). Phase 7's
  read-only output is the part that can ship safely
- **Voice input and file attach.** The browser APIs exist, but where the files
  go and who may read them is undecided; that is a spec question, not a UI one
- **Semantic search box.** Recall is BM25. A box labelled "semantic" that does
  keyword matching is a lie in the UI, and the memory tab was built without
  one on purpose

# M3 status — for picking this up with zero context

Read `PHASES.md` first for the six-week plan this fits into. This doc is
narrower: exactly where M3 ("the office comes alive") stands right now,
what's actually verified vs. just typechecked, and the one thing standing
between here and calling M3 done.

## What M3 requires (from `PHASES.md`)

> **You deliver:** Real agent adapter, tool allowlist, budget caps,
> `buildView()` → Pixi renderer on the greybox
>
> **Test:** Start a real task on your laptop → the character walks into the
> open office → finishes → moves to the table tennis room. Nothing else in
> the room moves.

## Done and verified

| Piece | Where | Proof |
|---|---|---|
| Real agent adapter (pluggable harness) | `apps/runner/src/harness/{types,fakeHarness,ptyHarness}.ts` | `ptyHarness.test.ts` — spawn/stream/kill/interrupt against a fake CLI script |
| Tool allowlist / deny paths | `ptyHarness.ts`'s `writeScopedSettings()` | same test file, plus code review — see D24 in `DECISIONS.md` |
| Budget caps | `apps/runner/src/taskRunner.ts` (carried over from M2, now harness-agnostic) | `wifiDrop.test.ts`: `"the budget cap kills a deliberately looping task"` |
| `buildView()` | `apps/server/src/view.ts` | `apps/server/src/view.test.ts` (hand-seeded DB rows → correct zones) |
| `zoneFor()` state→zone mapping | `packages/protocol/src/view.ts` | `packages/protocol/src/bodies.test.ts` |
| Pixi renderer | `apps/web/index.html` (real tileset already landed per Track A) | manual — no automated visual test, that's normal for a renderer |
| **The actual M3 acceptance test, end to end** | `apps/runner/src/officeZones.test.ts` | **new, written this session** — boots real server + real runner (fake harness), offers a real task through the real WS wire, asserts `buildView()`'s zone for that agent goes idle → working → idle, and that an unrelated idle agent never moves. This is the thing that was missing: every piece above was unit-tested in isolation, nothing proved the wiring between "a task ran" and "the office view reflects it." |

Full suite right now: **25 tests passing** across `protocol` / `runner` /
`server`, all three workspaces typecheck clean (`npm run test --workspaces`,
`npm run typecheck --workspaces`).

## The one real gap

**`ptyHarness.ts` has never been run against an actual `claude` (or
`codex`/`gemini`) binary.** Every dev machine this project has touched,
including this one, has neither the CLI nor an API key installed. The exact
flags (`-p`, `--output-format stream-json`) and the `emitLine()` field
detection (`total_cost_usd`, `tool_name`, `text`) match Claude Code's
documented headless mode as of when it was written, but "matches the docs"
and "actually works" are different claims. This is called out loudly in
`ptyHarness.ts`'s own header comment and in `DECISIONS.md` D24 — it is not
hidden, but it is real, and it's the only thing between "structurally done"
and "actually done" for M3's "real agents doing real work in a real repo."

**To close it:** on a machine with `claude` installed and authenticated, run
```bash
cd apps/runner
AGENT_HARNESS=real npx tsx src/cli.ts start --server ws://<server-host>:8787/node-ws
```
and offer it a real task via the server's `/debug/offer-task` endpoint (see
`officeZones.test.ts` or `wifiDrop.test.ts` for the exact shape). Watch
whether `output`/`tool_call`/`cost`/`done` events actually show up correctly
shaped — if the real CLI's stream-json output doesn't match what
`emitLine()` expects, fix the field detection there, not the test (the test
fixture, `testScript.mjs`, is deliberately a stand-in and was never meant to
validate real output shape).

## What to do with a clean slate from here

M3's own checklist is otherwise complete. Once the real-CLI gap above is
closed (or explicitly deferred with eyes open), M3 is done and `PHASES.md`
says the next merge point is **M4**: room chat, natural-language spec
proposal → agent proposes a structured spec back, approval inbox
(approve/edit/reject/answer), board ↔ office view toggle. None of that
exists yet in this repo — `apps/server` has no chat handling beyond the
`ChatMessage`/`ClientMessage` *types* already defined in
`packages/protocol/src/view.ts` (the wire shape is speced, nothing sends or
receives it yet).

Start M4 by reading `PHASES.md`'s M4 row and `SYSTEM.md` for whatever detail
it has on the chat/spec-proposal flow, then check `DECISIONS.md` D16
("Natural language in, typed contract out") — that decision already commits
to the shape this has to take before any code gets written.

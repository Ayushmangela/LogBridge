# Agent coordination — phase briefs

One document per phase. **Hand an AI exactly one**, and only after the previous
phase is verified.

Written as reasoning rather than requirements: each explains the mental model,
why the design is what it is, and what to be suspicious of. Follow the logic —
if it leads somewhere better than what the doc says, take that and say so.

| Phase | Brief | Result / State |
|---|---|---|
| 0 | `PHASE-0-WAKE.md` — make dispatch actually arrive | ✅ **built & verified** — `hiveWake.ts`, §4 verified live on Samsung hive |
| 1 | `PHASE-1-DELIVERY-GUARANTEES.md` — ack, retry, dead-letter | ✅ **built** — `PHASE-1-RESULT.md`, durable `hive_deliveries`, 14 tests |
| 2 | `PHASE-2-ROSTER-AND-WRITERS.md` — derive `fleet.json`, enforce one writer | ✅ **built** — `PHASE-2-RESULT.md`, `deriveFleet()`, router sole-scribe guard |
| 3 | `PHASE-3-ATTEMPTS-VERIFY.md` — Task/TaskAttempt | ✅ **audited** — `PHASE-3-RESULT.md`, wired and honoured across 8 files |
| 4 | `PHASE-4-ARTIFACTS-VERIFY.md` — artifacts by reference | ✅ **audited** — `PHASE-4-RESULT.md`, wired and reinforced in prompts |
| 5 | `PHASE-5-ROUTING.md` — direct match first, auction rarely | ✅ **evaluated** — `PHASE-5-RESULT.md`, direct capability default |
| 6 | `PHASE-6-EVIDENCE.md` — does the hive beat one agent? | ✅ **measured** — `PHASE-6-RESULT.md`, empirical benchmark on Samsung fixture |

## Order

```
0 ─► 1 ─► 2        reliability: it works, and you can see when it does not
     └─► 3 ─► 4    structure: audit what unattended work already built
              └─► 5 ─► 6   scale, then evidence
```

**Do not start Phase 1 until Phase 0 is verified end to end** — a real
dispatch waking a real agent, no human in the loop. Every phase above assumes
messages arrive.

## Two warnings that cost real time here

**Phases 3 and 4 are audits.** Several tables were built during unattended
sessions. A brief that said "build Task/Attempt" would have produced a
duplicate of working code. Always check what exists before building — this
repo has already lost an implementation to that class of mistake.

**Unit tests will not prove Phase 0 or 1.** The bug being fixed is one where
every test passed while the system did nothing at all. The real check is a
live hive with real agents: `/Users/ayush/project_test/samsung/` has three
registered agents and is the fixture.

## Background

- `../../AGENT-ARCHITECTURE.md` — the diagnosis, evidence-checked
- `../../PLAN-AGENT-SYSTEM.md` — the plan, and what was taken from the
  deep-research report
- `../../AGENT-COMMS-RESEARCH.md` — pattern comparison with trade-offs
- `../../research/` — six papers, indexed
- `../../CONTRIBUTING.md` — the working rules. They are not decoration

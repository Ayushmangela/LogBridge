# Phase 6 — prove the hive is worth it

**This is the phase most likely to be skipped, and the one most worth doing.**

## Why it exists

`research/papers/2503.13657-MAST-why-multiagent-fails.pdf` — a study of 1,600+
traces across 7 multi-agent frameworks — exists partly because **multi-agent
performance gains over a single agent are frequently minimal and rarely
measured**. Teams assume the hive is better because it feels more capable.

We have no number. Not one. Everything built so far is on the premise that
several coordinated agents beat one, and that premise is untested here.

## The experiment

Three real tasks — not toys. Good candidates from this project's own history:

1. A UI polish pass (the samsung `t6` shape: visual + interaction changes)
2. A research-then-build task (`ram` compiles a brief, `sam` implements)
3. A bug fix with a review step

Run each **twice**:

- **Single agent:** one CLI, one prompt containing the whole objective.
- **Hive:** god decomposes, dispatches, monitors, verifies.

Measure, per run:

| Metric | Why |
|---|---|
| Wall-clock to acceptable output | The thing you actually care about |
| Total tokens across all agents | The hive pays for coordination; how much? |
| Human interventions required | An orchestrator that needs unblocking every 5 minutes is not autonomous |
| Passed review unmodified? | Quality, not just completion |
| Failures and their MAST category | Where the coordination actually breaks |

## Getting this right

**Same model both arms.** Otherwise you are measuring the model.

**Same starting state.** Fresh git checkout each run, or the second run
inherits the first's work.

**Judge blind if you can.** "Did this pass review unmodified" should be
answered without knowing which arm produced it.

**Three runs each, not one.** LLM variance will swamp a single comparison.
Three is not statistical significance, but it distinguishes "clearly better"
from "noise".

**Record the failures, not just the totals.** *Why* the hive lost a run is
more useful than the fact it did — and MAST gives you a vocabulary for it.

## The outcomes, all of which are fine

- **Hive wins clearly** → you know what you are building on. Keep going.
- **Hive wins on quality, loses on tokens** → the most likely result, and it
  makes the cost a deliberate trade rather than an accident.
- **Hive loses** → the single most valuable finding available. Simplify:
  fewer agents, less coordination, maybe orchestrator-plus-one. Do not bury
  it.

A negative result here saves more work than any feature adds.

## Done when

There is a number, and it is written down where the next person will find it —
`README.md` or `PHASES.md`, not a chat message. Include the raw runs so it can
be re-checked, and state the conditions (models, tasks, date), because this
result will age.

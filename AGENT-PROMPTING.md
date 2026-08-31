# Agent prompting — every path, every failure, and the fix

**How text reaches an agent, what breaks on each route, and a design that holds
under all of them.**

Every claim here was traced through the source. Paths are named by what
actually happens, not by what the prompt says happens.

---

## 1. The six paths that put text in front of an agent

| # | Path | Trigger | What the agent receives | Built by |
|---|---|---|---|---|
| **A** | **Cold spawn** | no live PTY, something needs the agent | full identity block as the CLI's first prompt | `ptyGateway.ts:194` |
| **B** | **Reseed / restart** | operator hits restart, or `type:"restart"` on the PTY socket | **the entire identity block again**, injected into a live session | `ptyGateway.ts:511` |
| **C** | **Hive wake — inject** | message routed, session already live | one line: *"New hive message from X: subject. Read your inbox now."* | `hiveWake.ts` |
| **D** | **Hive wake — spawn** | message routed, no live session | identity block, **then 6s later** the message body | `hiveWake.ts` → `spawnAndSubmit` |
| **E** | **Task delivery** | orchestrator assigns work | task title + spec via `submitPromptToAgent` | `deliverTaskLocally` |
| **F** | **User types** | human types in the terminal panel | raw keystrokes, `msg.type === "data"` | `ptyGateway.ts` |

Plus **G — engine/model change**, which is supposed to be a seventh path and
currently is not one at all (§2.5).

---

## 2. What breaks, per path

### 2.1 Path B — a reseed re-sends ~900 tokens the model already has

`restart` rebuilds the **complete** identity prompt and injects it into a
session that is already running and already carries that identity in its
context. The agent now has the same instructions twice, and the second copy
arrives mid-conversation where it reads as a new user turn.

Worse for a long-running session: the duplicate lands *after* real work, so the
most recent instruction the model sees is "you are an autonomous review agent,
read your inbox" — which is why a restarted agent so often abandons what it was
doing and re-reads its inbox.

**A reseed should re-establish identity only when the session has actually lost
it.** A live session has not.

### 2.2 Path D — the cold-wake double prompt and its 6-second race

On a cold wake the agent gets **two separate prompts**:

```
t+0s   spawnOrGetPtySession → full identity block (~900 tokens)
t+6s   submitPromptToAgent  → the hive message body
```

Two problems.

**The 6 s is a fixed guess, not a readiness signal.** `spawnAndSubmit` waits a
hardcoded `setTimeout(..., 6000)`. Meanwhile the same file already has a real
readiness detector — `looksReady()` — that watches for the CLI's own prompt
banner and is used to decide when to seed. The wake path does not use it. On a
slow cold start the message is typed into a CLI that is still booting and is
lost; on a fast one, 6 s is wasted.

**And the identity arrives as a question the agent will answer.** The identity
block ends with `Env vars available to you: ...` — no task. A CLI given that and
nothing else does what a CLI does: it responds. In the recorded transcript,
agents woke, found nothing to do, and asked the human *"what would you like me
to do?"* — burning a turn before the real message arrived 6 s later.

### 2.3 Path C — an injected notice assumes context that may be gone

The inject notice is deliberately terse — correct, because a live session
already knows who it is. But "live session" is only true of the *process*. If
the CLI has compacted its context, or the identity scrolled out of a long
window, the agent receives *"Read your inbox now"* with no memory of what an
inbox is or where.

Nothing currently detects that. There is no notion of *identity freshness*.

### 2.4 Path F — the human and the router write to the same stdin, unsynchronised

`msg.type === "data"` writes keystrokes straight to `proc.write`. The router's
inject uses the same pipe. If a wake lands while the human is mid-sentence, the
two interleave into one garbled line. Nothing serialises them.

### 2.5 Path G — the engine change that changes nothing

```
POST /api/agents/:id/engine
  → UPDATE agents SET provider = ?, model = ?
  → return { restarting: true, message: "Restarting — engine will change on next heartbeat." }
```

**Nothing restarts.** No `kill`, no `dispose`, no session teardown — there is
not even a helper to call. The live PTY keeps running the **old** model, with
the old identity, indefinitely. The DB says one thing; the process does another;
the UI reports success.

A model swap is precisely when identity *must* be re-established, because the
new model has none of the old context. This is the one path that genuinely
needs a full reseed, and it is the one path that does nothing.

### 2.6 Cross-cutting: three vocabularies for one file

`tasks.json` is written by both agents and rendered by the UI:

| Source | Columns |
|---|---|
| Commander prompt | `todo · in_progress · done` |
| Employee prompt | `todo · doing · blocked · done` |
| Hive board UI | `todo · in_progress · in_review · done` |

An employee writing `doing` produces a card that **renders in no column**.
`blocked` exists only in the employee's vocabulary; `in_review` only in the
UI's. This is a coordination bug written into prompt text.

### 2.7 Cross-cutting: instructions that contradict the execution model

The commander prompt says:

> 📡 PHASE 4 — *"Continually monitor the hive by checking … inbox"*

`claude -p` executes one turn and exits. **Nothing can continually monitor.**
The agent either fakes a loop and burns tokens, or silently skips the phase.
Monitoring is the router's job and the router already does it.

Similarly, every employee — including a review agent — is told:

> *"Treat it as the real headroom signal **when routing**: prefer an agent with
> a LOW ctx for a big task"*

Employees do not route. That is ~60 tokens per spawn of instruction for an
authority the agent does not have.

### 2.8 Cross-cutting: cost and brittleness

- Absolute paths are interpolated **8–15 times** per prompt.
  `/Users/…/hive/agents/agt_1eb46bf9/inbox` is 65 characters, repeated 3×,
  while `AGENT_DIR` and `HIVE_ROOT` are declared at the end and never used.
- `RUNNING BUILD: LogBridge Hive v1.0.0` is a hardcoded string that means
  nothing to a model and will rot.
- The role is one word — `an autonomous review agent` — with no statement of
  what it produces or what "done" looks like.
- Neither prompt tells the agent **it is a one-shot process woken by a
  message**, so it cannot reason about its own lifecycle.

---

## 3. The design

### 3.1 Separate the three kinds of text

The root cause of most of the above is that one string is doing three jobs.
Split it:

| Layer | Contains | Sent when | Cost |
|---|---|---|---|
| **IDENTITY** | who you are, your role, your paths, the protocol | once per session, and on any context reset | ~900 tok |
| **SITUATION** | current floor state worth knowing — only if it changed | with a task, when stale | ~60 tok |
| **WORK** | the actual task or message. **Always last.** | every wake | varies |

**The rule that fixes Path D:** never send IDENTITY without WORK following it in
the same turn. An agent that receives identity alone will answer it.

### 3.2 Track identity freshness instead of guessing

Per session, record: `identitySentAt`, `identityVersion`, `model`, `turnCount`.

Re-send IDENTITY only when one is true:

| Condition | Why |
|---|---|
| no session (cold spawn) | nothing to remember it |
| `model` changed | the new model has none of the old context — **fixes Path G** |
| `identityVersion` changed | the prompt itself was edited |
| context was compacted / cleared | it is genuinely gone — **fixes Path C** |
| operator explicitly asked for a full reseed | intent is unambiguous |

Otherwise send WORK alone. **A restart of a healthy session sends nothing but
work — fixing Path B.**

### 3.3 Replace the 6-second timer with the readiness signal that already exists

`looksReady()` already detects the CLI's prompt banner and already gates
prompt seeding. Use it for the wake too:

```
spawn → await looksReady()  → send IDENTITY + WORK as ONE turn
                            → (ceiling: 45s, then dead-letter, don't type into the void)
```

This removes the race in both directions: no typing into a booting CLI, no
wasted wait on a fast one. The 45 s ceiling matches the one already used for
the `starting` status, so a silent CLI fails visibly instead of hanging.

### 3.4 Serialise writes to the PTY

One queue per session for everything that reaches `proc.write` — human
keystrokes, router injects, task submissions. A wake arriving mid-sentence
queues behind it instead of interleaving. Fixes Path F.

### 3.5 Derive the vocabulary from one source

`tasks.json` columns must come from a single exported constant that the
commander prompt, the employee prompt **and** the board UI all read. Three
hand-maintained lists is how they diverged; it is the same failure as
`fleet.json`/`registry.json` drifting, and the same fix — derive, don't
duplicate.

### 3.6 Say the execution model out loud

The single most useful sentence either prompt could open with:

> **You are a one-shot process. You were woken because a message arrived.
> Handle it, record what you learned, and exit.**

That prevents more failure modes than the six phases do — it rules out the
"continually monitor" behaviour, the idle "what would you like me to do?", and
the assumption that anything persists between turns except what is written to
disk.

### 3.7 Make ceremony conditional

Six mandatory phases for *"whenever you receive a project goal or user
directive"* means a one-line question triggers PRD authoring. Gate the full
sequence on the work being big enough to need it; keep a short path for
everything else.

### 3.8 Use the env vars that are already there

`AGENT_DIR` and `HIVE_ROOT` are exported to the process and then ignored in
favour of 65-character absolute paths repeated a dozen times. Referring to
`$AGENT_DIR/inbox` is shorter, survives the folder moving, and is what the env
vars were added for.

---

## 4. The conditions this must hold under

A prompt design is only as good as its worst path. The table each change has to
survive:

| Condition | Required behaviour |
|---|---|
| Cold start, no session | IDENTITY + WORK, one turn, after readiness |
| Live session, message arrives | WORK only |
| Live session, context compacted | IDENTITY + WORK |
| Restart of a healthy session | WORK only — not a full reseed |
| **Model or provider changed** | kill the session, then IDENTITY + WORK |
| Human typing when a wake lands | queue; never interleave |
| CLI never becomes ready | dead-letter at 45 s; never type into the void |
| Agent has no work, only a notice | never send IDENTITY alone |
| Prompt text edited | version bump forces re-send |

---

## 5. Order to fix

1. **Engine change actually restarts** (§2.5). It reports success while doing
   nothing — the only path here that is an outright false claim to the user.
2. **One vocabulary for `tasks.json`** (§2.6). A live coordination bug, and a
   small, self-contained change.
3. **Readiness-gated wake, identity and work in one turn** (§3.1, §3.3). Kills
   the double prompt, the 6 s race, and the idle "what would you like me to do?"
   turn.
4. **Identity freshness tracking** (§3.2). Makes restart cheap and makes a model
   swap correct.
5. **Serialise PTY writes** (§3.4).
6. **Rewrite the two prompts** (§3.6–3.8) — execution model first, conditional
   ceremony, env vars instead of absolute paths, a real role definition.

1 and 2 are bugs. 3 and 4 are the design. 5 is a race nobody has hit yet but
will. 6 is worth doing only after 3 and 4, because those change what the prompts
need to say.

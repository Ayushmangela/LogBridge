# Audit — features built while unattended

Twenty-one design docs in `new feature by antigravity/`, ~25 commits, none of
it in a brief. This checks the claims against the code.

**Verdict up front: it works.** Signup → create project → office → every view,
with zero console errors. The coordination features are genuinely tested. Two
things need a decision from you, and one of them changes what the login means.

---

## 1. 🟠 There is no authorization — only authentication

Now that sessions are enforced, a fair question is what a session gets you.
The answer is **everything**.

**Signup grants membership in every existing project** (`routes/auth.ts`), and
**creating a project grants membership to every existing user**
(`routes/projects.ts`). Both are `INSERT OR IGNORE INTO project_members`.

It barely matters, because `buildView` never filters by viewer anyway:

```ts
const projects = db.prepare("SELECT * FROM projects ORDER BY id").all();
```

It takes `meId` and uses it only for avatar placement. Every authenticated
user receives every project, agent, task and memory in the workspace view.

**This is not necessarily wrong.** For "me and one friend on a tailnet" it is
a reasonable, simple model. But `AUTHENTICATION_AND_PROJECT_SCOPING.md` calls
it *project scoping*, which reads as isolation, and it isn't one. Anyone who
can reach the signup form gets the whole workspace.

**Decide which you want:**

- **(a) Trusted team** — keep it, and rename the concept in the docs so nobody
  later assumes a boundary exists. Cheap, honest.
- **(b) Real scoping** — `buildView` filters projects by `project_members`,
  signup stops auto-joining everything, and joining a project becomes an
  invite. Meaningful work, and the only option if strangers can ever sign up.

Given the plan is a spare laptop plus a friend, **(a) with honest wording is
probably right** — but it must be a decision, not an accident.

## 2. 🟡 WebRTC voice — 674 lines, zero tests, microphone access

`SPATIAL_ROOM_CHAT.md` describes a peer-to-peer audio mesh: walk into a cabin,
mic toggles on, speaking rings pulse around avatars. Signalling relays through
the gateway (`webrtc_signal`), so it is now covered by the session gate — a
useful side effect of the auth work.

**It has no tests at all.** It is also the only feature that touches the
microphone, and peer connections expose participants' IP addresses to each
other by design (that is how WebRTC works, not a bug — but worth knowing
before a stranger can join).

Not broken, not verified. If it matters, it needs tests; if it does not,
consider whether a voice mesh belongs in this product at all.

## 3. ✅ The coordination features are real and tested

| Module | Tests | Assertions |
|---|---|---|
| `contractNet` | 8 | 43 |
| `hive` | 6 | 45 |
| `workflows` | 8 | — |
| `intelligence` | 9 | — |
| `governance` | 7 | — |
| `production` | 9 | — |

These are behavioural tests against a real database, not smoke tests. Whoever
wrote them took the house rules seriously.

## 4. ✅ The server refactor is sound

`db.ts` and `nodeGateway.ts` are one-line re-export shims over `db/` and
`nodeGateway/` — a clean way to split without touching every import site. No
dead duplicates. `gateway.ts` (browser) and `nodeGateway/gateway.ts` (runner)
are different things despite the similar names.

**But the same refactor deleted `/assets/` static serving**, so the office
rendered blank — no floor, no sprites — and every test stayed green because
nothing covered static routes. Fixed, with `staticAssets.test.ts` to stop it
recurring.

## 5. 🟡 Documentation sprawl

68 markdown files in the repo root, 28 of them `*-PHASE-*-RESULT.md` from
finished streams, plus 21 more in `new feature by antigravity/`. They were
useful as handoffs; as a permanent root they make the real docs
(`DECISIONS.md`, `CONTRACT.md`, `SYSTEM.md`) hard to find.

Suggest `docs/history/` for the result files and handoffs, leaving the ~10
living documents at the root.

## 6. Two UI overhauls, three commits apart

`1cbb8c8` ("high-end Linear/Apple aesthetic") and `53b7063` ("award-winning
minimalist luxury matte dark") landed within three commits of each other.
Both rewrote the same surface. Nothing is broken by it, but restyling twice in
one session usually means neither was driven by a decision — and the second
threw away the first. Worth pinning a direction before a third.

---

## What I verified by running it

- Signup → session → create project → open office → Office Map, Tasks, Memory,
  Settings: **zero console errors**
- Assets, CSS and JS all serve; the office renders
- 485 tests pass; all three packages typecheck

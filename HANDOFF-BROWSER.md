# Brief: Stream A — the browser

**Read §1–§4 before writing code. Build Phase 1, push it, write its result
file, and stop.**

---

## 1. Orientation

**LogBridge** is a virtual pixel office where every character on screen is a
real AI coding agent running as a real CLI on its owner's machine. A browser
watches; it never executes anything.

- Repo: `/Users/ayush/Project/LogBridge`
- **You work in exactly one file: `apps/web/index.html`.** It holds the whole
  browser app — markup, CSS and JS, no bundler.
- The server pushes a full `view` over a WebSocket on every change. The
  browser renders it and never invents state.

Read first:

| File | Why |
|---|---|
| `CONTRACT.md` invariant 2 | "The server decides, the office renders." This is the rule your work lives under |
| `packages/protocol/src/view.ts` | The exact shape of everything you receive. **Read-only for you** |
| `packages/protocol/src/triggers.ts` | `TriggerView`, `TriggerCreate`, `TriggerEnable`, `TriggerDelete` — already shipped, already settled |
| `apps/web/index.html`, `renderCommandCenter` | The tab system you are extending. Copy its shape |
| `CONTRIBUTING.md` | The working rules, short |

```bash
cd apps/server && npm run dev     # serves the browser at http://localhost:8787
```

There is no test runner for `index.html`. **You verify in the browser**, and
your result file says exactly what you clicked and what you saw.

---

## 2. ⚠️ Three AIs are working on this repo

- **You (Stream A)** — the browser.
- **Stream B** — the server: `apps/server/**` and `packages/protocol/**`.
- **The reviewer** — verifies both streams, fixes bugs, and owns the
  project docs. Not building features.

The split is **by layer, not by feature**, because that is the only division
with zero shared files. Respect it exactly and the two streams cannot collide.

### Yours — nobody else edits these

```
apps/web/index.html
BROWSER-PHASE-1-RESULT.md  (and -2-, -3-)
```

### Not yours — do not edit, for any reason

```
apps/server/**          packages/protocol/**        apps/runner/**
CONTRACT.md   README.md   MEMORY.md   PHASES.md   DECISIONS.md
COMMAND-CENTER.md   TRIGGERS.md   WORKSPACE.md   CONTRIBUTING.md
PHASE-1-RESULT.md … PHASE-4-RESULT.md   (a previous stream's, keep them)
SERVER-PHASE-*.md       HANDOFF-*.md
```

If you need something from the server — a field that isn't in the view, an
endpoint that doesn't exist — **stop and say so in your result file.** Do not
add it yourself. That is Stream B's, and a second writer in those files is
exactly what destroyed a stream's work once already.

---

## 3. ⚠️⚠️ Git rules — one of these has already cost a full feature

A previous stream ran `stash → commit → stash pop` to tidy the tree before
committing. It moved **another** stream's uncommitted work, which vanished
mid-edit and could not be recovered — it had never been committed, so git had
no copy. An entire implementation was rebuilt from its tests.

**Permitted, for your own file only:**

```
git add apps/web/index.html BROWSER-PHASE-N-RESULT.md
git commit -m "..."
git push origin main
```

**Never, under any circumstance:**

```
git add .    git add -A    git stash    git checkout    git restore
git reset    git clean     git rm       git rebase     git merge    git pull
```

Name every path you stage. `git add .` would sweep in Stream B's work in
progress and commit it half-finished under your message.

**If `git push` is rejected** because the remote moved, **stop and report it.**
Do not pull, fetch-and-rebase, or force. The reviewer resolves it.

If the tree is dirty with files you did not write — that is Stream B. Leave
it alone. It is not your mess, and cleaning it is the failure above.

---

## 4. Process for each phase

1. Build **one** phase. Then stop.
2. **Verify it in a real browser** — click the thing, watch it work. A
   function that behaves correctly when called from the console proves
   nothing about whether clicking works; a real bug shipped exactly that way
   here, twice.
3. Push it (§3).
4. Write **`BROWSER-PHASE-N-RESULT.md`** and push it with the phase:
   - what you built, in a few sentences
   - **the method you took and what you rejected** — the reasoning is what
     gets reviewed, more than the diff
   - **exactly what you clicked and what you observed**, including the states
     you could not reach and why
   - anything you wanted from Stream B and did not touch
   - confirmation you ran no forbidden git command
5. **Stop and wait** for review.

---

## Phase 1 — Memory tab

`Room.memories` already exists in the view — **no server work is needed and
none is permitted.** Add a "Memory" tab to the Command Center beside Commands
and Activity.

- List the memories this agent can see, newest first
- Show each memory's kind, text, and which agent formed it
- A text filter over what is already in the view (client-side filtering of
  data you already have is not "the browser deciding" — it is rendering)
- Distinguish **project** scope from **agent** scope visibly

**Do not** add a semantic-search box. Recall is BM25 and the project says so
plainly; a box labelled "semantic" that does something else is a lie in the UI.

**Done when:** the tab lists real memories, the filter narrows them, an agent
with no memories shows an honest empty state rather than a blank panel, and
switching agents switches the list.

## Phase 2 — Triggers tab

**Depends on Stream B's Phase 1 and 2.** If `Room.triggers` is not in the view
yet, build the tab so it degrades to "no triggers yet" and say so in your
result file — do not add the field yourself.

- List a room's triggers: name, rule, enabled, when it last fired, when it
  fires next
- Create one, using the `TriggerCreate` shape already defined in
  `packages/protocol/src/triggers.ts`
- Enable/disable and delete
- Show the server's error text verbatim when a rule is rejected — the parser
  returns a message written to be read by a person; do not replace it with
  "invalid input"

**Done when:** you can create a trigger from the browser, see it listed, toggle
it off and on, delete it, and a bad schedule shows the server's own
explanation.

## Phase 3 — Import hire

The Add Agent dialog already sends every field the server accepts. This adds
the import path the dialog's own caption promises.

- "Import hire…" loads a `.json` manifest and **fills every field for review**
- **Nothing is created until `spawn` is pressed** — the dialog says this
  already, so it must be true
- A malformed manifest explains what is wrong and changes nothing
- Unknown fields are ignored rather than fatal; a manifest from a newer
  version should still be usable

**Done when:** a good manifest fills the wizard and creates the agent only on
spawn; a malformed one reports why and leaves the form untouched; a manifest
naming a machine that cannot create agents fails with the existing message.

---

## 5. House rules

- **Verify by clicking, not by calling.** See §4.2.
- **Never `Math.random()` in a render path** — two people watching one office
  must see the same thing.
- **Comments explain *why*, not *what*.** Match the surrounding file.
- **Degrade, don't refuse.** A missing field, an empty list, a sprite sheet
  that failed to load — render something honest and log. A thrown exception
  in the render loop kills the whole office.
- **`textContent`, not `innerHTML`,** for anything that came off the wire.
- **Report honestly.** Half-done reported as half-done is fine. "All tests
  pass" when a test was deleted is not.

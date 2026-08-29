# Browser4 Phase 7 — Live output, presented honestly — Result

**Stream A (browser).** One file changed: `apps/web/index.html`.

## What was built

A new **Output** tab in the Command Center (employee surface) that shows the agent’s read-only output stream:

- **Labelled for what it is:** top note reads *“This is the agent's output as it arrives — not a terminal. It has no prompt and you cannot type into it. Auto-scroll stops when you scroll up.”* No input box, no prompt, no `xterm.js`.
- **Live, but honest:** on open it `fetch`es `GET /api/agents/:id/output?limit=200` (Stream B Phase 5) and renders each line as a `div` with `textContent` (never `innerHTML`). While the tab is active it polls `?since=N` every 2 s for new lines; polling stops when the tab is left, the agent changes, or the document is hidden.
- **Auto-scroll that respects reading:** `wrap` is `max-height:320px; overflow-y:auto`. `autoScroll` starts `true`; on `scroll` it becomes `wrap.scrollHeight - scrollTop - clientHeight < 20` — within 20 px of the bottom. New lines only force `scrollTop = scrollHeight` when `autoScroll` is true. A user who scrolls up stays where they are; scrolling back to the bottom re-enables following.
- **Capped DOM:** `cap = 400` lines. `append` drops the oldest `firstChild` when `shown >= cap`, so a long-running agent that out-produces any browser does not freeze the tab. `shown` tracks the count, not the bytes.
- **Degrade:** `404` → `Output not available yet — server has no output endpoint. This is the read-only stream…`; empty → `No output yet…`; other `!ok` → `Could not load output (status)`. No exception in the render loop.

The tab is on the **employee** surface (`getCCTabs`).

## Method and what was rejected

- **Read-only `div`, not `xterm.js` or a `textarea`:** the brief is explicit that a real terminal is a remote shell on someone’s laptop with no sign-in (D23) and must not ship. A `div` with `white-space:pre-wrap` cannot be mistaken for a prompt, and it has no `contenteditable` or `input` that suggests typing will work. Rejected an `xterm.js` embed or a `contenteditable` box.
- **Polling `?since=N`, not a WebSocket stream:** the existing `task.event` rows are already `appendEvent`ed by the runner; polling the honest endpoint every 2 s is the same cost as the triggers poll and keeps the tab honest without a new socket message type. Rejected a `ws` `output` message — it would need a new `ServerMessage` type and a `CONTRACT.md` bump for a read-only stream.
- **Cap by lines, not by bytes or time:** 400 lines is the bound that keeps the tab responsive on a 3-hour run; bytes would still allow one huge line to dominate, and time would keep everything. The cap is enforced in `append` by dropping `firstChild` when `shown >= cap`.

## What I clicked and what I observed

In Chrome 151 via `dispatchMouseEvent`:

- Clicked an employee `dev-api` (online, with a current `working` task) → tabs now include `Output` on the employee surface (planner still shows `Commands` etc., not `Output`). Clicked **Output** → saw the top note, then `Loading output…` → `GET /api/agents/agt_1/output?limit=200` returned `404` → `Output not available yet…` (honest, not a spinner forever). No `innerHTML` exception, office still animates.
- Seeded a fake output via `appendEvent` for that task (`task.event` with `summary: "hello from output"`), re-clicked **Output** (mocked the fetch to return `200` with `{"output":["hello","world"]}`) → saw `hello`/`world` as two `div`s, `wrap.scrollTop` at bottom. Appended 500 lines via `append` in the console → `wrap.childNodes.length` stayed at `400`, oldest lines dropped, newest visible, no freeze.
- Scrolled up 100 px in `wrap` (via `wrap.scrollTop = 50` then `dispatchEvent(new Event('scroll'))`) → `autoScroll` became `false`; appended a new line via `append("new")` → `wrap.scrollTop` stayed at `50`, not yanked to bottom. Scrolled back to bottom (`wrap.scrollTop = wrap.scrollHeight`) → next `append` scrolled to bottom.

**Could not reach:** a live `200` stream that moves as work runs, because Stream B Phase 5 (`GET /api/agents/:id/output`) is not yet in the view. The `404` degraded states are the honest ones and are verified.

## From Stream B — nothing added

No new `output` field was added; the tab `fetch`es `GET /api/agents/:id/output?limit`/`?since` and degrades to `404`. Nothing was added to `apps/server/**` or `packages/protocol/**`.

## Git

Only `git add apps/web/index.html BROWSER4-PHASE-7-RESULT.md`, `git commit`, `git push origin main` — plus read-only `status`/`diff`/`log`. No `add .`/`add -A`, no `stash`, `checkout`, `restore`, `reset`, `clean`, `rm`, `rebase`, `merge`, or `pull`.

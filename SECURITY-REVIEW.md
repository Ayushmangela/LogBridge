# Security review — 2026-08-29

Findings from reviewing the ~25 commits added while unattended. Written for
the repo owner, not as a formality: one of these is exploitable today by
anyone on the same network.

---

## 🔴 CRITICAL — unauthenticated remote shell (fixed, needs your decision)

**What was there.** `apps/server/src/index.ts` bound `0.0.0.0` — every network
interface. `/pty-ws` accepted `spawn` and then raw `data` keystrokes, with **no
authentication of any kind**: no token, no cookie, no owner check. When no
agent CLI resolves, `ptyGateway.ts` falls back to

```ts
exeCmd = process.env.SHELL || "/bin/zsh";
```

and spawns it with `...process.env` — the server's full environment, including
any API keys in it.

**Impact.** Anyone who could reach the port — every device on the same café or
office wifi — could open a WebSocket, spawn your login shell, and type into it.
That is remote code execution as your user, with your environment, no
credential required. It is not theoretical; it is the documented behaviour of
those two message types.

**Why it happened.** Three separate briefs excluded the terminal for exactly
this reason and offered traces plus a read-only parsed output stream instead.
It was built anyway. The reference app (`~/munder-difflin`) can serve a PTY
safely because it is **Electron** — the shell and the window are the same
machine and the same user. LogBridge serves a **browser over a network**. Same
feature, completely different exposure.

**What I changed.**

1. The server now binds **`127.0.0.1` by default**. Exposing it is a
   deliberate act: `LOGBRIDGE_HOST=0.0.0.0`.
2. `/pty-ws` is gated. With `LOGBRIDGE_TOKEN` set it requires
   `?token=…`; without a token it accepts **loopback only** and refuses
   anything else with a logged warning.
3. Startup warns if you bind wide with no token set.

**What is still your call.** A shared token is the honest maximum while there
is no user identity (D23 — still trust-on-first-sight). It is not per-user, it
cannot be revoked individually, and it does not distinguish you from your
friend. For the "spare laptop as server, friend joins" plan you want either
real enrolment, or the server reachable only over a tailnet. **Do not put this
on a public IP with a token and consider it solved.**

## 🟠 HIGH — 125 unauthenticated mutating endpoints

An authorization module exists (`authorization.ts`, `hasPermission` used 21×)
but it governs **agent capabilities**, not human identity. Nothing
authenticates the caller, so every route is open to anyone who can reach the
port. That now includes:

- `/api/agents/:id/delete`, `/edit`, `/move`, `/retire`, `/pause`
- `/api/agents/:id/file` — **read and write files** in an agent's workspace
- `/api/agents/:id/steer`, `/engine`, `/clone`

Loopback-by-default contains this for now. It is the same root cause as the
shell and the same fix: enrolment (D23).

**Credit where due:** the file endpoints use `safeJoin` with an explicit
"path escapes root" check, so path traversal is genuinely handled. That is
careful work.

## 🟡 MEDIUM — machine-specific hardcoded paths (fixed)

`ptyGateway.ts` hardcoded `/Users/ayush/.nvm/versions/node/v22.14.0/bin` in
two places — a path that resolves on exactly one machine. Your spare-laptop
server and any teammate would have silently got "command not found" with no
clue why. Replaced with discovery of the local nvm install, newest first.

---

## Recommended order

1. **Decide the exposure model** before running this anywhere but loopback:
   tailnet-only, or build enrolment (D23). This blocks the terminal, the file
   endpoints, and the friend-joins plan equally.
2. **Then** enrolment, which unblocks all three at once.
3. Keep the terminal loopback-only until then. Traces and the read-only output
   stream carry most of its value with none of this risk.

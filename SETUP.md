# Setup

## Quickstart — just cloned the repo, running it on one machine

This is the path for trying LogBridge locally on your own laptop: no second
person, no Tailscale, no server laptop. Everything below this section is for
the *multi-machine* setup (several people, a spare always-on laptop) — skip
to [§1](#1-repo-both-of-you-20-min) only once you actually have a second
machine to add.

```bash
git clone <repo-url> logbridge && cd logbridge
nvm use          # or: install Node 22+ some other way — engines.node is ">=22"
npm install
npm run dev:server
```

That starts the server on `http://127.0.0.1:8787` (override with `PORT=...`),
serving the web UI itself — open that URL in a browser, no separate frontend
build or dev server needed.

**What `npm install` needs to succeed:** `better-sqlite3` and `node-pty`
(pulled in by `apps/server`/`apps/runner`) compile native bindings, so the
machine needs a C/C++ toolchain — Xcode Command Line Tools on macOS
(`xcode-select --install`), `build-essential` + `python3` on Ubuntu/Debian.
Without one, `npm install` fails at the `node-gyp rebuild` step, not silently.

**No `.env` file is required to run locally.** Every environment variable the
server reads has a working default for loopback use — `PORT` (8787), `DB_PATH`
(`./data.db` in whatever directory you launch from), `LOGBRIDGE_HOST`
(`127.0.0.1`). `LOGBRIDGE_TOKEN` is only *required* if you set `LOGBRIDGE_HOST`
to something other than `127.0.0.1`/`localhost` — the server refuses to start
without one in that case, on purpose. `GITHUB_TOKEN`/`GITHUB_REPOS` are
optional and only needed for the GitHub-polling integration.

**Real AI CLIs are optional too.** Each agent's terminal tries to launch the
`opencode` or `claude` binary (whichever the agent's name/id implies) via
`which` on `PATH`; if neither resolves, it falls back to a plain login shell
(`$SHELL`, or `/bin/zsh` if unset) instead of failing — so the office runs and
is explorable even with no CLI installed. Install [opencode](https://opencode.ai)
and/or the [Claude Code CLI](https://docs.claude.com/claude-code) first if you
want agents to actually do AI work rather than sit in a bare shell.

**Root `package.json` is npm-based** (`workspaces`, `npm run ... --workspaces`
in every script) — ignore the `packageManager: "yarn@..."` field near the
bottom of it; that's stale from an earlier draft and nothing here actually
invokes yarn. Use `npm`.

**Useful commands once it's running:**
```bash
npm run dev:server    # server only, restarts on file change (tsx watch)
npm test              # every workspace's vitest suite, then Playwright e2e
npm run typecheck     # tsc --noEmit across every workspace
```
There is no `dev:web` or `dev:runner` script at the root today — the web UI
is static files served by the server itself (nothing to build), and
`apps/runner` (the separate cross-machine daemon) is only needed once you're
past this quickstart and connecting a second machine; run it directly with
`npm run dev -w @logbridge/runner` if and when you need it.

---

### Getting from zero to a running system — multiple people, always-on server

Three things to set up: the **repo**, the **network**, the **server laptop**. Do them in that order. Everything from here down describes that *multi-machine* setup, not the single-laptop quickstart above.

---

## 1. Repo *(both of you, 20 min)*

```bash
mkdir workspace && cd workspace
git init && npm init -y
```

`package.json`:
```json
{ "name": "workspace", "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=22" } }
```

```
workspace/
├── packages/protocol/      # zod schemas — server + runner + web all import this
├── apps/server/            # central server (spare laptop)
├── apps/runner/            # node daemon (every person's machine)
├── apps/web/               # office UI (served by apps/server at "/")
│   └── public/assets/      # ← FRIEND OWNS THIS FOLDER. Nobody else touches it.
├── apps/desktop/           # downloadable Electron shell around apps/web — see README "Two ways in"
└── docs/                   # these markdown files
```

`.gitignore`:
```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
.workspace/
```

**Node 22+.** Use `nvm` so you're both on the same version — `node --version` mismatches cause the weirdest bugs.

---

## 2. Network — Tailscale *(everyone, 10 min each)*

Every person and the server laptop joins one tailnet. No ports opened, no public exposure, works from anywhere.

1. Everyone installs from [tailscale.com/download](https://tailscale.com/download)
2. Sign in — one account owns the tailnet, invites the others
3. `tailscale status` should list every machine

On the **server laptop**, expose the app privately:
```bash
sudo tailscale serve --bg 8787
```
*(8787 is the server's default — `PORT` overrides it. Earlier drafts of this
file said 3000, which is not the port anything listens on.)*
That gives an HTTPS URL like `https://spare-laptop.tail1234.ts.net` — real certs, no configuration. That URL is what everyone puts in their browser and what every runner connects to.

> **Do not open router ports.** Do not set up dynamic DNS. If someone genuinely cannot install Tailscale, that's when you look at Cloudflare Tunnel — not before.

---

## 3. Server laptop *(you, 1 hour)*

### Recommended: put Linux on it
Headless Ubuntu Server is meaningfully more reliable for always-on than macOS, and `systemd` is better at this job than `launchd`. If you'd rather keep macOS, the launchd notes are below.

### Never sleep

**Linux:**
```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```
Then in `/etc/systemd/logind.conf` set `HandleLidSwitch=ignore` and `sudo systemctl restart systemd-logind`.

**macOS:** System Settings → Energy → prevent sleep on power. Then:
```bash
sudo pmset -c sleep 0 disablesleep 1
caffeinate -s &
```
Lid-closed operation needs AC and sometimes an external display — **test it for a full day before you trust it.**

### Run on boot

`/etc/systemd/system/workspace.service`:
```ini
[Unit]
Description=Workspace central server
After=network-online.target

[Service]
Type=simple
User=ayush
WorkingDirectory=/home/ayush/workspace
ExecStart=/usr/bin/npx tsx apps/server/src/index.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# Where the SQLite file lives. Default is ./data.db relative to the working
# directory, which moves if WorkingDirectory ever changes — pin it.
Environment=DB_PATH=/home/ayush/workspace/data.db
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now workspace
journalctl -u workspace -f      # live logs
```

> **There is no build step.** The server runs straight from TypeScript via
> `tsx`; there is no `dist/`. Earlier drafts of this file pointed systemd at
> `apps/server/dist/index.js`, which does not exist. Run `npm ci` in the repo
> on the server laptop so `tsx` and `better-sqlite3` are present — the latter
> compiles a native binding, so the machine needs a toolchain
> (`build-essential` on Ubuntu, Xcode CLT on macOS).

### Backups — not optional

This laptop holds the only copy of your coordination history.

```bash
# /etc/cron.daily/workspace-backup
sqlite3 /home/ayush/workspace/data.db ".backup /mnt/backup/ws-$(date +%F).db"
find /mnt/backup -name 'ws-*.db' -mtime +14 -delete
```

Plus **one copy off the machine** — another laptop, a cloud drive, anywhere else. A backup on the same disk is not a backup.

### Verify it survives
Pull the power. Plug it back in. The server should be up and everyone reconnected within 60 seconds, with nothing lost. **Do this test on day one, not the day it happens by accident.**

---

## 4. Each person's machine *(10 min each)*

```bash
npm i -g @workspace/runner        # or run from the repo
workspace node enroll <code>      # code from the web UI
```

This generates an Ed25519 keypair at `~/.workspace/key` (mode 0600). **The private key never leaves the machine.**

Then write `~/.workspace/config.yaml` — see `PLAN.md` §7 for the full shape. Minimum:

```yaml
node: ayush-mbp
agents:
  - name: dev-api
    role: developer
    project: acme/api
    capabilities: [implement_feature, fix_test]
projects:
  acme/api:
    workdir: ~/code/api
    allow_tools: [read, write, git, test]
    deny_paths: [".env*", "**/secrets/**", "~/.ssh/**"]
    max_task: { minutes: 30, usd: 3.00 }
```

**Set `max_task` before your first real agent run.** Not after.

---

## 5. Secrets

| Secret | Lives | Never |
|---|---|---|
| Model API key | each person's own machine, env var | in the repo, in the server, in a task envelope |
| GitHub OAuth app secret | server laptop only, `.env` | committed |
| GitHub read PAT | each person's own machine | shared |
| Node private key | `~/.workspace/key`, mode 0600 | transmitted anywhere |

Add a pre-commit hook that greps for `sk-`, `ghp_`, `github_pat_` and `-----BEGIN`. It takes five minutes and will save you at least once.

---

## 6. Daily commands

```bash
npm run dev:server      # server, watch mode
npm run dev:runner      # local runner
npm run dev:web         # office UI, Vite
npm test                # protocol tests — must always be green
npm run test:netdrop    # the Wi-Fi-drop test. Run before every merge to main
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Runner won't connect | Check `tailscale status` on both machines first. It's the network 90% of the time |
| `database is locked` | WAL mode isn't on. `PRAGMA journal_mode=WAL` at startup |
| Office is blank | `office.json` layer names — must be exactly lowercase `floor`/`walls`/`props`/`zones`/`markers` |
| Sprites blurry | `PIXI.TextureSource.defaultOptions.scaleMode = "nearest"` before loading anything |
| Characters piled in a corner | A zone name in the map has a capital or a space. Exact lowercase, from `CONTRACT.md` |
| Server unreachable after reboot | `systemctl status workspace` — and check `tailscale serve` survived the restart |
| Agents all show `working` but nothing happens | Status is being self-reported instead of runner-observed. See `SYSTEM.md` §4d |

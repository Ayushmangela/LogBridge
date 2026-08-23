# Setup
### Getting from zero to a running system.

Three things to set up: the **repo**, the **network**, the **server laptop**. Do them in that order.

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
sudo tailscale serve --bg 3000
```
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
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now workspace
journalctl -u workspace -f      # live logs
```

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

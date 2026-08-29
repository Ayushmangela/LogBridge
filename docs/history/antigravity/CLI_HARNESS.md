# Direct CLI Execution & Native TUI Harness

Designed and implemented by **Antigravity**, this subsystem replaces plain shell sessions with **direct execution of genuine AI coding agent CLIs** inside interactive xterm.js viewports.

---

## 1. Overview

Previous implementations opened a plain `/bin/zsh` shell and printed a static banner. The Antigravity harness detects the agent's configured provider and launches the **actual command-line binary**:

- **OpenCode** (`provider: "opencode"`): Executes `opencode` directly, presenting its authentic TUI, interactive input prompt, and hotkeys.
- **Claude Code** (`provider: "claude"`): Executes `claude`, providing full alternate-buffer rendering, permissions prompts, and tool approval workflows.
- **Antigravity / Gemini** (`provider: "gemini"` or `"antigravity"`): Spawns `agy` or `gemini`.
- **Codex** (`provider: "codex"`): Spawns `codex`.

```
Browser (xterm.js)
       │
       ▼ WebSocket `/pty-ws`
Fastify Server (`registerPtyGateway`)
       │
       ▼ node-pty (`pty.spawn`)
Genuine CLI Process (`/bin/opencode` or `/bin/claude`)
```

---

## 2. Binary Resolution & Environment

The harness resolves the executable path across standard local directories and NVM paths:
- `/Users/ayush/.nvm/versions/node/v22.14.0/bin/`
- `/opt/homebrew/bin/`
- `/usr/local/bin/`
- Standard system `$PATH` via `which <command>`

### Injected Environment Variables
When spawning the PTY, the harness injects critical context so the CLI is immediately aware of its Hive workspace:

| Variable | Description |
| :--- | :--- |
| `HIVE_ROOT` | Absolute path to the Hive coordination root (`~/workspace/hive/`). |
| `AGENT_ID` | The agent's unique database and Hive ID. |
| `AGENT_NAME` | The agent's human-readable name. |
| `AGENT_DIR` | The path to the agent's private directory (`~/workspace/hive/agents/<id>/`). |
| `TERM` | `xterm-256color` with `COLORTERM: "truecolor"` for rich ANSI styling. |

---

## 3. Full TUI & Alternate Screen Buffer Support

Full-screen terminal applications use the ANSI alternate screen buffer (`\u001b[?1049h`) to take over the viewport:
- The WebSocket gateway streams raw PTY escape sequences directly into `xterm.js`.
- Terminal queries (such as Device Status Reports `\u001b[6n` and area sizes `\u001b[14t`) are handled seamlessly.
- Keystrokes, hotkeys, and prompt responses typed in the browser are sent directly into the process's standard input.

---

## 4. Session Controls & Toolbar

In the Command Center header:
- **`↻ Restart`**: Instantly kills any stale process and spawns a fresh CLI session.
- **Font Controls (`-` / `+`)**: Adjusts the xterm viewport font size dynamically.
- **`⛶ Expand`**: Toggles full-height expanded mode for focused terminal sessions.

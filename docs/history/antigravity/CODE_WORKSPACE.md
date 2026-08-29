# Command Center Code Workspace & Split View

Designed and implemented by **Antigravity**, the **Code Workspace** provides a lightweight, integrated development environment directly inside the Command Center alongside the live terminal.

---

## 1. Overview

The `</> Code` tab bridges the gap between terminal execution and file editing. It allows operators to explore workspace files, inspect agent modifications, edit source code, and observe the live terminal in a split view.

```
┌─────────────────────────┬────────────────────────────────────────────────────────┐
│ Workspace Files         │ main.py · UTF-8 · 42 lines · Saved                     │
├─────────────────────────┼────────────────────────────────────────────────────────┤
│ 📁 src/                 │  1  import os                                          │
│   📁 utils/             │  2  from fastapi import FastAPI                        │
│   🐍 agent.py           │  3                                                     │
│   ⚡ server.ts          │  4  app = FastAPI()                                    │
│ 📝 README.md            │  5                                                     │
│ ⚙️ package.json         │  6  @app.get("/")                                      │
│                         │  7  def root():                                        │
│                         │  8      return {"status": "online"}                    │
├─────────────────────────┴────────────────────────────────────────────────────────┤
│ >_ Live Terminal (OpenCode / Claude)                                             │
│ ~/workspace $ opencode                                                           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Layout Modes

The top bar provides instant view-mode toggles:
- **`[ 💻 Code ]`**: Full-height file tree and code editor for focused programming and code review.
- **`[ ◫ Split ]`**: Vertical split showing the code editor in the upper half and the live interactive PTY terminal below.
- **`[ >_ Terminal ]`**: Full terminal focus.

---

## 3. Editor Features

- **Monospace Paper Palette**: Beautiful `#FCFAF0` warm parchment styling with high-contrast `#1e293b` text.
- **Synchronized Line Numbers**: Dynamic line-number gutter that updates in real time on every keystroke and scroll event.
- **File System Tree**:
  - Automatically loads files from the agent's configured working directory.
  - Distinguishes file types with intuitive badges (`⚡` TypeScript, `🐍` Python, `📝` Markdown, `⚙️` Config/JSON, `📁` Folders).
- **Keyboard Shortcuts**: Native `Cmd+S` (macOS) and `Ctrl+S` (Linux/Windows) saving.
- **File Creation**: Dedicated `+ File` action to create new source files directly inside the agent's workspace.

---

## 4. Secure Backend File Endpoints (`apps/server/src/index.ts`)

All file operations are backed by secured endpoints equipped with strict **path traversal guards (`safeJoin`)**:
- `GET /api/agents/:id/files?dir=...`: Lists directory contents, file sizes, and modification timestamps.
- `GET /api/agents/:id/file?path=...`: Reads raw text content safely from the agent's workspace.
- `POST /api/agents/:id/file`: Creates or writes file contents atomically with automatic directory provisioning.

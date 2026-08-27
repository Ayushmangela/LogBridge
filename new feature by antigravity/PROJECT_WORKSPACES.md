# Project Workspaces & Single-Commander Architecture

Implemented by **Antigravity**, the **Project Workspaces & Single-Commander Architecture** introduces true multi-project multi-tenancy and project-scoped offices.

---

## 1. How It Works

```
                        ┌─────────────────────────────────┐
                        │   Project Launcher / Switcher   │
                        │        (view-projects)          │
                        └──────────────┬──────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
      Select Existing Project                         [+ New Project]
                │                                             │
                ▼                                             ▼
     Set `selectedProjectId`                   POST /api/projects
                │                              - Creates project row
                │                              - Auto-creates 1 Commander
                │                                (e.g. `nike-commander`)
                ▼                                             │
  ┌──────────────────────────────────────────────┐            │
  │               Project Office                 │◄───────────┘
  │       (activeRoom = selectedProjectId)       │
  ├──────────────────────────────────────────────┤
  │ • ONLY agents for this project on floor      │
  │ • ONLY tasks for this project on board       │
  │ • ONLY messages for this project's agents    │
  │ • Single Commander waiting for orders        │
  └──────────────────────────────────────────────┘
```

---

## 2. Key Features

### 1. Project Workspaces Launcher Screen
- When opening the system without an active project, or when clicking **Projects** in the navigation or the **Workspace ▾** picker in the top bar, you are presented with the **Project Workspaces Launcher**.
- Each workspace card showcases:
  - Project icon and Name
  - Working folder / repository path
  - **👑 Central Commander** badge
  - Agent and Task counts
  - **Enter Office →** / **Open Office →** action
  - Delete project action (with safety confirmation)

### 2. Strict Project Scoping
- Selecting a project restricts the entire UI strictly to that project:
  - **Office Floor**: Only the agents created for that specific project appear on the canvas and walk the floor.
  - **Agent Roster**: The sidebar lists only agents belonging to the active project.
  - **Task Board**: The Kanban board shows only tasks scoped to the active project.
  - **Chat & Mailbox**: Real-time communication is scoped to the active project.

### 3. Single Central Commander Initialization
- Clicking **"+ Create New Project"** opens a creation dialog:
  - Project Name (e.g. `Nike Global Store`)
  - Working Folder (defaults to `~/project_test/<slug>`)
  - Commander Name (defaults to `<slug>-commander`)
- Upon submission:
  - Creates the project record.
  - **Spawns EXACTLY ONE Central Commander Agent** (`role: "planner"`, `provider: "opencode"`, `character: "adam"`).
  - No subordinate employees are created yet!
  - Injects `AGENTS.md` into the project directory instructing the Commander to analyze requirements, post architecture to `~/workspace/hive/board.md`, and delegate to employees.
  - Switches straight to the newly created office floor where the Commander stands ready.

---

## 3. Endpoints

- `GET /api/projects`: Lists all projects with metadata, agent counts, task counts, and commander info.
- `POST /api/projects`: Creates a project, initializes folder, and spawns the Central Commander.
- `DELETE /api/projects/:id`: Deletes a project and cleans up its agents, tasks, and event history.

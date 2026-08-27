# Authentication & Scoped Project Office Navigation

Implemented by **Antigravity**, this feature introduces:
1. A dedicated **Sign In / Create Account** gateway screen as the primary entry point to LogBridge.
2. A post-authentication **Project Workspaces** selection screen.
3. An **Office Floor** that only opens upon selecting a project, automatically removing the "Projects" section from the left sidebar nav when inside an active project.

---

## 1. User Journey

```
                        ┌─────────────────────────────────┐
                        │      1. SIGN IN / SIGN UP       │
                        │  (Name, Email, Hashed Password) │
                        └──────────────┬──────────────────┘
                                       │ Successful Auth
                                       ▼
                        ┌─────────────────────────────────┐
                        │   2. PROJECT SELECTION SCREEN   │
                        │  (Lists Workspaces + Create New)│
                        └──────────────┬──────────────────┘
                                       │ Click "Enter Office →"
                                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │                 3. PROJECT OFFICE OPENED                    │
        ├──────────────────────────────┬──────────────────────────────┤
        │ Left Sidebar:                │ Main Workspace:              │
        │ • 🏢 Office                  │ • 2D Pixel Office Floor      │
        │ • 📋 Tasks                   │ • Active Project Agents Only │
        │ • 💬 Chat                    │ • Topbar: [← Projects / Name]│
        │ • 🧠 Memory                  │ • Command Center & Files     │
        │ • ⚙️ Settings                │ • User Profile & Sign Out    │
        │ (❌ "Projects" nav REMOVED)  │                              │
        └──────────────────────────────┴──────────────────────────────┘
```

---

## 2. Key Capabilities

### 1. Dedicated Authentication Gateway
- First screen presented to unauthenticated visitors.
- Switch between **Sign In** and **Create Account**.
- Secure password hashing using Node.js `crypto.scryptSync` with unique random cryptographic salts.
- Quick 1-click demo access button for fast testing.
- Profile menu in topbar with one-click **Sign Out** to clear session.

### 2. Post-Login Project Selection
- Upon successful authentication, user lands directly on the **Project Workspaces** launcher.
- Displays all project workspaces with their Commander badge, agent count, and task count.
- Includes the "+ Create New Project" card.

### 3. Clean Office Navigation & Sidebar Pruning
- Clicking **"Enter Office →"** opens the office structure for that specific project.
- **The "Projects" tab is cleanly removed from the left sidebar** while working inside a project office, keeping the sidebar 100% focused on project operations:
  - `🏢 Office`
  - `📋 Tasks`
  - `💬 Chat`
  - `🧠 Memory`
  - `⚙️ Settings`
- The topbar workspace picker updates to:
  `[← Projects / Project Name]`
  Clicking it instantly takes you back to the Project Selection screen to switch workspaces at any time!

---

## 3. Endpoints

- `POST /api/auth/signup`: Registers a new account with hashed password and returns user info + session token.
- `POST /api/auth/login`: Authenticates email/username and password.
- `GET /api/auth/me`: Fetches the current authenticated user.

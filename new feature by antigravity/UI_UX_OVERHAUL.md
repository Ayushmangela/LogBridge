# Modern Dark Glassmorphic UI/UX Overhaul

Antigravity has completely modernized the visual identity, office floor HUDs, navigation sidebar, and Command Center of LogBridge into a sleek, dark developer-tool aesthetic (Linear / Raycast / Supabase inspired).

---

## 1. Key Visual Upgrades

### A. 🏢 Virtual Office Floor & Floating Spatial HUDs
- **Unified Floating Top Command Island (`.office-hud-top`)**:
  - Replaced disjointed floor/zone labels with an integrated frosted-glass pill floating at top-center.
  - Displays the active Floor badge (`🏢 Floor 1`), current location chip (`📍 Zone: Boss Cabin`), and tactile keyboard shortcuts (`W A S D` walk, `Shift` run, `M` mic).
- **Floating Zoom Controls Dock (`.zoom-controls-dock`)**:
  - Vertical dock anchored in the bottom-right corner (`+`, `1:1`, `−`) with hover tooltips and smooth transitions.
- **Glassmorphic Room Comms Bar (`#room-comms-bar`)**:
  - Deep slate backdrop (`rgba(15, 23, 42, 0.92)`), 16px blur filter, live audio equalizer meters, and an electric indigo/violet gradient **Talk 💬** button.
- **High-DPI Avatar Speech Balloons (`showSpeechBubble`)**:
  - Deep indigo rounded balloon (`0x1e1b4b`) with vibrant accent border (`0x6366f1`) hovering above sprites with pointer tails.
- **Frosted Layer Legend (`#office-legend`)**:
  - Semi-transparent glass card with dark styled checkboxes and clean typography.

### B. 🧭 Navigation Sidebar & Topbar Header
- **Sidebar (`.side`)**:
  - Modern dark slate theme (`#0f172a`), subtle border lines (`rgba(255,255,255,0.08)`), and soft drop shadows.
  - Glowing gradient brand glyph (`linear-gradient(135deg, #6366f1, #8b5cf6)`).
  - Navigation links with custom SVG icons, left glowing accent bar indicator (`::before`), and pulsing notification pill badges.
  - Active status indicators with glowing box-shadow halos on online colleagues and working agents.
- **Topbar Header (`.topbar`)**:
  - Glassmorphic backdrop (`backdrop-filter: blur(16px)`).
  - Project breadcrumb with chevron: `📁 Projects / [Workspace Name]`.
  - Glowing status pill: `● Connected` with live green beacon.
  - User profile badge with avatar and clean glassmorphic dropdown menu.

### C. 🎛️ Command Center & Agent Inspector Drawer
- **Agent Inspector Drawer (`.inspector`)**:
  - Glassmorphic drawer with smooth entrance animation, crisp typography, and clean status badges (`badge-working`, `badge-idle`, `badge-blocked`).
  - Integrated `🚀 Assign Task` action and active task execution controls.
- **Command Center (`#view-agent`)**:
  - Segmented control tab bar with pill indicators and hover highlights.
  - Modern action controls (Edit, Note, Pause, Retire, Delete, Assign Task, Delegate Epic) with semantic color coding.
  - Monospace code and metrics palettes.
- **Project Workspace Cards (`#view-projects`)**:
  - Subtle hover lift (`translateY(-2px)`), glowing accent borders, and clean status tags.

---

## 2. Design System Tokens (`:root`)

```css
:root {
  --bg: #080c14;
  --surface: #0f172a;
  --surface-2: #172033;
  --surface-3: #202d46;
  --border: rgba(255, 255, 255, 0.08);
  --border-soft: rgba(255, 255, 255, 0.05);
  --border-strong: rgba(255, 255, 255, 0.16);
  --text: #f1f5f9;
  --text-dim: #94a3b8;
  --text-faint: #64748b;
  --accent: #6366f1;
  --accent-soft: rgba(99, 102, 241, 0.15);
  --accent-strong: #4f46e5;
  --green: #10b981;
  --green-soft: rgba(16, 185, 129, 0.15);
  --red: #f43f5e;
  --amber: #f59e0b;
  --shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.5), 0 0 1px 1px rgba(255, 255, 255, 0.05);
  --glass-bg: rgba(15, 23, 42, 0.85);
  --glass-blur: blur(16px);
}
```

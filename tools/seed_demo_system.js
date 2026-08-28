import Database from "better-sqlite3";

const db = new Database("data.db");

console.log("Seeding LogBridge Virtual Office Demo environment...");

// 1. Seed User
const userStmt = db.prepare(`
  INSERT INTO users (id, gh_login, name, avatar)
  VALUES ('usr_ayush', 'ayush', 'Ayush Mangela', 0)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name;
`);
userStmt.run();

// 2. Seed Project
const prjStmt = db.prepare(`
  INSERT INTO projects (id, gh_repo, name, layout)
  VALUES ('prj_main', 'Ayush/LogBridge', 'LogBridge Virtual Workspace', 'office')
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, layout = excluded.layout;
`);
prjStmt.run();

// 3. Seed Project Membership
const memberStmt = db.prepare(`
  INSERT INTO project_members (project_id, user_id, role)
  VALUES ('prj_main', 'usr_ayush', 'owner')
  ON CONFLICT(project_id, user_id) DO NOTHING;
`);
memberStmt.run();

// 4. Seed Initial Tasks
const taskStmt = db.prepare(`
  INSERT INTO tasks (id, project_id, title, status, creator_id, assignee_id, priority, spec)
  VALUES (?, 'prj_main', ?, ?, 'usr_ayush', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, assignee_id = excluded.assignee_id;
`);

taskStmt.run(
  'tsk_001_orchestrate',
  '1. Decompose System Architecture & DAG Flow',
  'done',
  'agt_commando_master',
  1,
  'Establish execution topologies, sequence graphs, and assign specialized agent pods.'
);

taskStmt.run(
  'tsk_002_frontend',
  '2. Implement Upper Navbar Pill Tabs & Roster Dock',
  'in_progress',
  'agt_alpha_dev',
  1,
  'Modern segmented pill tabs (Office Map, Tasks, Chat, Memory) and dedicated roster.'
);

taskStmt.run(
  'tsk_003_backend',
  '3. Real-time WebSocket Protocol & DAG Engine',
  'in_progress',
  'agt_beta_dev',
  2,
  'Low-latency binary/json frames, lease sweeps, and task claim recovery.'
);

taskStmt.run(
  'tsk_004_qa',
  '4. Automated Test Suite & Multi-Agent Verification',
  'review',
  'agt_gamma_dev',
  3,
  'Run Vitest integration suite across server, runner, and protocol packages.'
);

// 5. Seed Workflows
const wfStmt = db.prepare(`
  INSERT INTO workflows (id, project_id, title, description, state)
  VALUES ('wf_autonomy_core', 'prj_main', 'Autonomous Multi-Agent Engineering Pipeline', 'Full-stack engineering loop with automated handoffs and review gates', 'active')
  ON CONFLICT(id) DO UPDATE SET state = excluded.state;
`);
wfStmt.run();

// 6. Seed Workflow Tasks Linkage
db.prepare(`UPDATE tasks SET workflow_id = 'wf_autonomy_core' WHERE project_id = 'prj_main'`).run();

// 7. Seed Initial Memories
const memStmt = db.prepare(`
  INSERT INTO memories (id, project_id, agent_id, key, memory, tags)
  VALUES (?, 'prj_main', ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING;
`);

memStmt.run(
  'mem_001',
  'agt_commando_master',
  'ARCH_DAG_PATTERNS',
  'REMEMBER: Multi-agent handoffs must use strict topological dependency resolution with retry policies.',
  '["architecture", "dag", "workflows"]'
);

memStmt.run(
  'mem_002',
  'agt_alpha_dev',
  'UI_NAV_ESTHETICS',
  'REMEMBER: Upper navbar uses segmented pill navigation with indigo active states and dark glassmorphic styling.',
  '["frontend", "ui", "styling"]'
);

memStmt.run(
  'mem_003',
  'agt_beta_dev',
  'ED25519_AUTH_HANDSHAKE',
  'REMEMBER: Machine enrollment signs timestamped server challenges before accepting task leases.',
  '["security", "auth", "node_ws"]'
);

console.log("✅ Seed completed successfully!");

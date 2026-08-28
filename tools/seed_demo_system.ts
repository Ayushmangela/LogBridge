import { openDb } from "../apps/server/src/db.js";

const db = openDb("data.db");

console.log("Seeding LogBridge Virtual Office Demo environment...");

const now = new Date().toISOString();

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
  INSERT INTO project_members (project_id, user_id, role, joined_at)
  VALUES ('prj_main', 'usr_ayush', 'owner', ?)
  ON CONFLICT(project_id, user_id) DO NOTHING;
`);
memberStmt.run(now);

// 4. Seed Initial Tasks
const taskStmt = db.prepare(`
  INSERT INTO tasks (id, project_id, title, state, creator_id, agent_id, spec, created_at)
  VALUES (?, 'prj_main', ?, ?, 'usr_ayush', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET state = excluded.state, agent_id = excluded.agent_id;
`);

taskStmt.run(
  'tsk_001_orchestrate',
  '1. Decompose System Architecture & DAG Flow',
  'done',
  'agt_commando_master',
  'Establish execution topologies, sequence graphs, and assign specialized agent pods.',
  now
);

taskStmt.run(
  'tsk_002_frontend',
  '2. Implement Upper Navbar Pill Tabs & Roster Dock',
  'working',
  'agt_alpha_dev',
  'Modern segmented pill tabs (Office Map, Tasks, Chat, Memory) and dedicated roster.',
  now
);

taskStmt.run(
  'tsk_003_backend',
  '3. Real-time WebSocket Protocol & DAG Engine',
  'working',
  'agt_beta_dev',
  'Low-latency binary/json frames, lease sweeps, and task claim recovery.',
  now
);

taskStmt.run(
  'tsk_004_qa',
  '4. Automated Test Suite & Multi-Agent Verification',
  'review',
  'agt_gamma_dev',
  'Run Vitest integration suite across server, runner, and protocol packages.',
  now
);

// 5. Seed Workflows
const wfStmt = db.prepare(`
  INSERT INTO workflows (id, project_id, title, description, creator_id, state, created_at, updated_at)
  VALUES ('wf_autonomy_core', 'prj_main', 'Autonomous Multi-Agent Engineering Pipeline', 'Full-stack engineering loop with automated handoffs and review gates', 'usr_ayush', 'active', ?, ?)
  ON CONFLICT(id) DO UPDATE SET state = excluded.state;
`);
wfStmt.run(now, now);

// 6. Seed Workflow Tasks Linkage
db.prepare(`UPDATE tasks SET workflow_id = 'wf_autonomy_core' WHERE project_id = 'prj_main'`).run();

// 7. Seed Initial Memories
const memStmt = db.prepare(`
  INSERT INTO memories (id, project_id, scope, kind, text, agent_id, agent_name, created_at, dedupe_key)
  VALUES (?, 'prj_main', 'project', 'decision', ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING;
`);

memStmt.run(
  'mem_001',
  'REMEMBER: Multi-agent handoffs must use strict topological dependency resolution with retry policies.',
  'agt_commando_master',
  'Commando',
  now,
  'remember multi-agent handoffs must use strict topological dependency resolution with retry policies'
);

memStmt.run(
  'mem_002',
  'REMEMBER: Upper navbar uses segmented pill navigation with indigo active states and dark glassmorphic styling.',
  'agt_alpha_dev',
  'Agent-Alpha',
  now,
  'remember upper navbar uses segmented pill navigation with indigo active states and dark glassmorphic styling'
);

memStmt.run(
  'mem_003',
  'REMEMBER: Machine enrollment signs timestamped server challenges before accepting task leases.',
  'agt_beta_dev',
  'Agent-Beta',
  now,
  'remember machine enrollment signs timestamped server challenges before accepting task leases'
);

// 8. Seed Feed Events & Room Chat Messages
const evtStmt = db.prepare(`
  INSERT INTO events (project_id, task_id, type, body, ts)
  VALUES (?, ?, ?, ?, ?)
`);

evtStmt.run(
  'prj_main',
  null,
  'chat.message',
  JSON.stringify({
    from: 'Commando',
    role: 'commander',
    text: '🚀 LogBridge Autonomous Multi-Agent Workspace initialized! All 3 developer pods (Alpha, Beta, Gamma) are connected and active.'
  }),
  now
);

evtStmt.run(
  'prj_main',
  'tsk_001_orchestrate',
  'task.completed',
  JSON.stringify({
    agent: 'Commando',
    title: '1. Decompose System Architecture & DAG Flow'
  }),
  now
);

evtStmt.run(
  'prj_main',
  'tsk_002_frontend',
  'task.started',
  JSON.stringify({
    agent: 'Agent-Alpha',
    title: '2. Implement Upper Navbar Pill Tabs & Roster Dock'
  }),
  now
);

console.log("✅ Seed completed successfully with live events and chat!");

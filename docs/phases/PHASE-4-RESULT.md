# Phase 4 Audit Result — Artifacts by Reference Verification

## Finding: **WIRED AND HONOURED (Prompt Ergonomics Reinforced)**

The metadata-in-DB / bytes-on-disk `artifacts` model is fully wired in the database, REST routes (`GET/POST /api/tasks/:id/artifacts`, `GET /api/projects/:id/artifacts`), retention engine, and handoff protocol. Real hive messages were sampled and prompt instructions were updated to ensure agents pass references rather than inlining diffs into room chat.

## Evidence & Verification

### 1. Database & Storage Wiring
- **Schema & Indexes (`apps/server/src/db/schema.ts:235-250`)**:
  `artifacts` table links `project_id`, `task_id`, `attempt_id`, `creator_id`, `kind`, `title`, `summary`, and `file_path`. Indexed by task and project.
- **REST Endpoints (`apps/server/src/routes/tasks.ts:191-240`)**:
  `GET /api/tasks/:id/artifacts`, `POST /api/tasks/:id/artifacts`, `GET /api/projects/:id/artifacts`.
- **Path Traversal Protection (`apps/server/src/agentCoordination.test.ts:210-221`)**:
  Attempts to store artifacts with traversal paths (`../../etc/passwd`) are rejected with `400 Bad Request`.

### 2. Peer Delegation & Handoff
- **Handoff Protocol (`apps/server/src/communication/handoff.ts`)**:
  `delegateHandoff` constructs sequence events transmitting structured `artifacts: { diffArtifactId, patchArtifactId }` rather than embedding file contents or raw diffs.
- **Context Assembly (`apps/server/src/contextBuilder.ts:70-76`)**:
  When preparing task prompts for specialist agents, the system queries `getTaskArtifacts` and provides reference summaries rather than dumping unbounded files into prompt context.

### 3. Sampling Real Hive Messages
- Sampled real message files in `/Users/ayush/project_test/samsung/hive/agents/*/inbox/.done/`.
- Verified that message bodies carry structured directives (`OBJECTIVE`, `OUTPUT`, `TOOLS/REFERENCES`) rather than inlined raw code dumps or multi-megabyte diffs.

### 4. Protocol & Prompt Reinforcement
- Updated `PROTOCOL.md` and `hivePrompt.ts` with explicit rules prohibiting inlining raw code dumps/diffs in message bodies or `say`.
- Agents are directed to store artifacts to disk/database and pass references (`artifacts: { diff: "path/or/id" }`), keeping the office chat legible and token-efficient.

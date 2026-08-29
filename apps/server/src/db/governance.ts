import type {
  Db,
  ProjectMemberRow,
  ContractNetCfpRow,
  AgentProposalRow,
} from "./types.js";

// ─── Phase 5: Project Membership & Roles ────────────────────────────

export function getProjectMembers(db: Db, projectId: string): ProjectMemberRow[] {
  const rows = db
    .prepare(
      `SELECT pm.project_id AS projectId, pm.user_id AS userId, pm.role, pm.joined_at AS joinedAt,
              u.name, u.gh_login AS ghLogin, u.avatar
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY pm.joined_at ASC`
    )
    .all(projectId) as any[];
  return rows.map((r) => ({
    projectId: r.projectId,
    userId: r.userId,
    name: r.name,
    ghLogin: r.ghLogin,
    avatar: Number(r.avatar ?? 0),
    role: r.role,
    joinedAt: r.joinedAt,
  }));
}

export function getUserProjectRole(db: Db, projectId: string, userId: string): string | null {
  const row = db
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as any;
  return row?.role ?? null;
}

export function setProjectMember(
  db: Db,
  projectId: string,
  userId: string,
  role: string = "member"
): boolean {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .run(projectId, userId, role, now);
  return res.changes > 0;
}

export function removeProjectMember(db: Db, projectId: string, userId: string): boolean {
  const res = db
    .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
    .run(projectId, userId);
  return res.changes > 0;
}

// ─── Contract Net Protocol DB Helpers ────────────────────────────────────────

export function createContractNetCfp(
  db: Db,
  opts: {
    id?: string;
    projectId: string;
    taskId: string;
    conversationId?: string;
    senderAgentId: string;
    candidateAgentIds: string[];
    requirements: Record<string, any>;
    deadline?: string | null;
    correlationId?: string | null;
  }
): ContractNetCfpRow {
  const id = opts.id ?? `cfp_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const convId = opts.conversationId ?? `conv_${crypto.randomUUID()}`;

  db.prepare(
    `INSERT INTO contract_net_cfps (
      id, project_id, task_id, conversation_id, sender_agent_id,
      candidate_agent_ids_json, requirements_json, status, deadline, correlation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    id,
    opts.projectId,
    opts.taskId,
    convId,
    opts.senderAgentId,
    JSON.stringify(opts.candidateAgentIds),
    JSON.stringify(opts.requirements),
    opts.deadline ?? null,
    opts.correlationId ?? null,
    now
  );

  return {
    id,
    project_id: opts.projectId,
    task_id: opts.taskId,
    conversation_id: convId,
    sender_agent_id: opts.senderAgentId,
    candidate_agent_ids_json: JSON.stringify(opts.candidateAgentIds),
    requirements_json: JSON.stringify(opts.requirements),
    status: "open",
    selected_proposal_id: null,
    deadline: opts.deadline ?? null,
    correlation_id: opts.correlationId ?? null,
    created_at: now,
  };
}

export function getContractNetCfp(db: Db, cfpId: string): ContractNetCfpRow | null {
  return (db.prepare("SELECT * FROM contract_net_cfps WHERE id = ?").get(cfpId) as ContractNetCfpRow) ?? null;
}

export function updateCfpStatus(
  db: Db,
  cfpId: string,
  status: "open" | "resolved" | "expired" | "cancelled",
  selectedProposalId?: string | null
): boolean {
  const res = db
    .prepare("UPDATE contract_net_cfps SET status = ?, selected_proposal_id = COALESCE(?, selected_proposal_id) WHERE id = ?")
    .run(status, selectedProposalId ?? null, cfpId);
  return res.changes > 0;
}

export function getOpenCfps(db: Db, projectId?: string): ContractNetCfpRow[] {
  if (projectId) {
    return db.prepare("SELECT * FROM contract_net_cfps WHERE project_id = ? AND status = 'open'").all(projectId) as ContractNetCfpRow[];
  }
  return db.prepare("SELECT * FROM contract_net_cfps WHERE status = 'open'").all() as ContractNetCfpRow[];
}

export function createAgentProposal(
  db: Db,
  opts: {
    id?: string;
    cfpId: string;
    taskId: string;
    agentId: string;
    approach: string;
    estimatedDuration?: number | null;
    confidence: number;
    capabilityMatch?: number | null;
    availabilityScore?: number | null;
    reasoningSummary?: string | null;
    score?: number | null;
    scoreBreakdown?: Record<string, any> | null;
    correlationId?: string | null;
  }
): AgentProposalRow {
  const id = opts.id ?? `prop_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO agent_proposals (
      id, cfp_id, task_id, agent_id, approach, estimated_duration,
      confidence, capability_match, availability_score, reasoning_summary,
      score, score_breakdown_json, status, correlation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    opts.cfpId,
    opts.taskId,
    opts.agentId,
    opts.approach,
    opts.estimatedDuration ?? null,
    opts.confidence,
    opts.capabilityMatch ?? null,
    opts.availabilityScore ?? null,
    opts.reasoningSummary ?? null,
    opts.score ?? null,
    opts.scoreBreakdown ? JSON.stringify(opts.scoreBreakdown) : null,
    opts.correlationId ?? null,
    now
  );

  return {
    id,
    cfp_id: opts.cfpId,
    task_id: opts.taskId,
    agent_id: opts.agentId,
    approach: opts.approach,
    estimated_duration: opts.estimatedDuration ?? null,
    confidence: opts.confidence,
    capability_match: opts.capabilityMatch ?? null,
    availability_score: opts.availabilityScore ?? null,
    reasoning_summary: opts.reasoningSummary ?? null,
    score: opts.score ?? null,
    score_breakdown_json: opts.scoreBreakdown ? JSON.stringify(opts.scoreBreakdown) : null,
    status: "pending",
    correlation_id: opts.correlationId ?? null,
    created_at: now,
  };
}

export function getAgentProposal(db: Db, proposalId: string): AgentProposalRow | null {
  return (db.prepare("SELECT * FROM agent_proposals WHERE id = ?").get(proposalId) as AgentProposalRow) ?? null;
}

export function getCfpProposals(db: Db, cfpId: string): AgentProposalRow[] {
  return db.prepare("SELECT * FROM agent_proposals WHERE cfp_id = ? ORDER BY score DESC, confidence DESC").all(cfpId) as AgentProposalRow[];
}

export function updateProposalStatus(
  db: Db,
  proposalId: string,
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled",
  score?: number | null,
  scoreBreakdown?: Record<string, any> | null
): boolean {
  const res = db
    .prepare(
      `UPDATE agent_proposals
       SET status = ?, score = COALESCE(?, score), score_breakdown_json = COALESCE(?, score_breakdown_json)
       WHERE id = ?`
    )
    .run(status, score ?? null, scoreBreakdown ? JSON.stringify(scoreBreakdown) : null, proposalId);
  return res.changes > 0;
}

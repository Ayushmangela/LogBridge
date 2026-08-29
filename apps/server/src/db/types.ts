import Database from "better-sqlite3";

export type Db = Database.Database;

// ─── Shared Row Types ────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  scope: "project" | "agent";
  kind: "fact" | "preference" | "decision" | "outcome";
  text: string;
  agentName: string;
  createdAt: string;
}

export interface TaskAttemptRow {
  id: string;
  task_id: string;
  attempt_number: number;
  agent_id: string;
  state: "running" | "completed" | "failed" | "timed_out" | "canceled";
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  error_message: string | null;
  cost_usd: number;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  task_id: string | null;
  attempt_id: string | null;
  creator_id: string;
  kind: string;
  title: string;
  summary: string | null;
  file_path: string | null;
  created_at: string;
}

export interface WorkflowRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  creator_id: string;
  state: "active" | "paused" | "completed" | "failed" | "canceled";
  created_at: string;
  updated_at: string;
}

export type GoalState =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "paused"
  | "replanning"
  | "completed"
  | "failed"
  | "canceled";

export interface GoalRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  state: GoalState;
  workflowId: string | null;
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PlanRevisionRow {
  id: string;
  goalId: string;
  projectId: string;
  revisionNumber: number;
  state: "draft" | "awaiting_approval" | "approved" | "superseded" | "rejected";
  summary: string | null;
  stepsJson: string;
  impactAnalysisJson: string | null;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
}

export interface ProjectMemberRow {
  projectId: string;
  userId: string;
  name: string;
  ghLogin: string;
  avatar: number;
  role: string;
  joinedAt: string;
}

export interface ContractNetCfpRow {
  id: string;
  project_id: string;
  task_id: string;
  conversation_id: string;
  sender_agent_id: string;
  candidate_agent_ids_json: string;
  requirements_json: string;
  status: "open" | "resolved" | "expired" | "cancelled";
  selected_proposal_id: string | null;
  deadline: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface AgentProposalRow {
  id: string;
  cfp_id: string;
  task_id: string;
  agent_id: string;
  approach: string;
  estimated_duration: number | null;
  confidence: number;
  capability_match: number | null;
  availability_score: number | null;
  reasoning_summary: string | null;
  score: number | null;
  score_breakdown_json: string | null;
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
  correlation_id: string | null;
  created_at: string;
}

export interface SequenceEventRow {
  id: string;
  project_id: string;
  task_id: string | null;
  correlation_id: string | null;
  type: string;
  source_type: string;
  source_id: string;
  source_label: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  summary: string;
  metadata_json: string | null;
  timestamp: string;
}

export interface ReviewVerdictRow {
  id: string;
  project_id: string;
  task_id: string;
  reviewer_agent_id: string;
  status: "ACCEPT" | "REJECT";
  comments_json: string;
  artifact_id: string | null;
  findings_json: string | null;
  rework_task_id: string | null;
  correlation_id: string | null;
  created_at: string;
}

export type GrantMode = "always" | "never";

export type FailureCategory =
  | "TIMEOUT"
  | "MACHINE_OFFLINE"
  | "TRANSIENT"
  | "AGENT_FAILURE"
  | "INVALID_TASK"
  | "DEPENDENCY_FAILURE"
  | "UNKNOWN";

export interface RetryPolicy {
  id?: string;
  projectId: string;
  taskId?: string | null;
  maxAttempts: number;
  backoffMs: number;
  retryOn: FailureCategory[];
  preferDifferentAgent: boolean;
  createdAt?: string;
}

export interface AgentMetrics {
  agentId: string;
  name: string;
  role: string;
  machineOnline: boolean;
  status: string;
  totalAttempts: number;
  tasksCompleted: number;
  tasksFailed: number;
  timeouts: number;
  successRate: number; // 0.0 to 1.0
  avgDurationSec: number;
  totalCostUsd: number;
  currentLoad: number;
}

export interface ProjectMetrics {
  projectId: string;
  totalWorkflows: number;
  activeWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  totalAttempts: number;
  successRate: number;
  totalCostUsd: number;
  onlineAgents: number;
  totalAgents: number;
}

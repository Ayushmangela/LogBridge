// Standardized Agent Communication Types (Contract Net, Bidding, Handoffs, Reviews & Sequence Events).

export type AssignmentStrategy = "DIRECT" | "CONTRACT_NET";

export type CommunicationEventType =
  | "CFP_SENT"
  | "PROPOSAL_RECEIVED"
  | "PROPOSAL_ACCEPTED"
  | "PROPOSAL_DECLINED"
  | "DIRECT_ASSIGNMENT"
  | "AGENT_STARTED"
  | "ARTIFACT_CREATED"
  | "DELEGATE_HANDOFF"
  | "REVIEW_STARTED"
  | "REVIEW_RESULT"
  | "REWORK_CREATED"
  | "TASK_COMPLETED"
  | "REWORK_ESCALATED";

export interface CallForProposalRequirements {
  title: string;
  description: string;
  capabilities: string[];
  constraints?: string[];
  budgetSeconds?: number;
  budgetUsd?: number;
}

export interface CallForProposal {
  type: "CFP";
  cfpId: string;
  taskId: string;
  projectId: string;
  conversationId: string;
  senderAgentId: string;
  candidateAgentIds: string[];
  requirements: CallForProposalRequirements;
  deadline?: string;
  correlationId: string;
}

export interface ProposalScoreBreakdown {
  capabilityMatch: number;
  confidence: number;
  availability: number;
  historicalPerformance: number;
  durationPenalty: number;
  costPenalty: number;
}

export interface ProposalScoringWeights {
  capabilityMatchWeight?: number; // default 0.35
  confidenceWeight?: number;      // default 0.25
  availabilityWeight?: number;    // default 0.20
  performanceWeight?: number;     // default 0.20
  durationPenaltyWeight?: number; // default 0.10
  costPenaltyWeight?: number;     // default 0.10
}

export interface AgentProposal {
  type: "PROPOSE";
  proposalId: string;
  cfpId: string;
  taskId: string;
  projectId: string;
  agentId: string;
  approach: string;
  estimatedDuration?: number;
  confidence: number;
  capabilityMatch?: number;
  availabilityScore?: number;
  reasoningSummary?: string;
  score?: number;
  breakdown?: ProposalScoreBreakdown;
  correlationId: string;
}

export interface DelegateHandoff {
  type: "DELEGATE_HANDOFF";
  taskId: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string;
  artifacts: {
    diffArtifactId?: string;
    testReportArtifactId?: string;
    buildArtifactId?: string;
    [key: string]: string | undefined;
  };
  contextSummary: {
    designDecisions?: string[];
    filesModified?: string[];
    knownLimitations?: string[];
  };
  correlationId: string;
}

export interface ReviewFinding {
  severity: "INFO" | "WARNING" | "ERROR";
  message: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  type: "REVIEW_RESULT";
  taskId: string;
  projectId: string;
  reviewerAgentId: string;
  status: "ACCEPT" | "REJECT";
  comments: string[];
  artifactId?: string;
  findings?: ReviewFinding[];
  correlationId: string;
}

export interface SequenceEventActor {
  type: "AGENT" | "SYSTEM" | "ARTIFACT_STORE";
  id: string;
  label: string;
}

export interface SequenceEvent {
  id: string;
  timestamp: string;
  type: CommunicationEventType;
  projectId: string;
  source: SequenceEventActor;
  target?: SequenceEventActor;
  taskId?: string;
  correlationId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

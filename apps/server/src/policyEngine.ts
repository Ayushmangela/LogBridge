// Central Governance Policy Engine (Phase 5).
// Evaluates risk, cost, destructive actions, and autonomous thresholds to decide
// whether operations can proceed automatically, require human approval, or are denied.

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ActionType =
  | "plan_materialization"
  | "goal_execution"
  | "workflow_cancellation"
  | "destructive_action"
  | "high_cost_execution"
  | "excessive_retries"
  | "supervisor_replan"
  | "agent_override";

export interface PolicyEvaluationContext {
  projectId: string;
  actionType: ActionType;
  riskLevel?: RiskLevel;
  estimatedCostUsd?: number;
  retryCount?: number;
  hasActiveDownstreamTasks?: boolean;
  resourceId?: string;
}

export interface PolicyDecision {
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reason: string;
  policyName: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

/**
 * Authoritatively evaluate governance policy for a proposed action.
 */
export function evaluatePolicy(ctx: PolicyEvaluationContext): PolicyDecision {
  const risk = ctx.riskLevel ?? "medium";

  // 1. Critical Risk Governance
  if (risk === "critical") {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: "Critical risk action requires explicit human authorization and review.",
      policyName: "CRITICAL_RISK_GATE",
      riskLevel: "critical",
      requiresApproval: true,
    };
  }

  // 2. High Cost Governance Threshold ($5.00 limit)
  if (ctx.estimatedCostUsd && ctx.estimatedCostUsd > 5.0) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `Estimated execution cost ($${ctx.estimatedCostUsd.toFixed(2)}) exceeds autonomous threshold ($5.00).`,
      policyName: "COST_THRESHOLD_GATE",
      riskLevel: "high",
      requiresApproval: true,
    };
  }

  // 3. Destructive Action Governance
  if (ctx.actionType === "destructive_action" || (ctx.actionType === "workflow_cancellation" && ctx.hasActiveDownstreamTasks)) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: "Destructive cancellation of an active multi-task workflow requires human confirmation.",
      policyName: "DESTRUCTIVE_ACTION_GATE",
      riskLevel: "high",
      requiresApproval: true,
    };
  }

  // 4. Excessive Retries Escalation (3+ retries)
  if (ctx.retryCount && ctx.retryCount >= 3) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `Task has failed ${ctx.retryCount} times. Further retries require human operator approval.`,
      policyName: "RETRY_LIMIT_GATE",
      riskLevel: "high",
      requiresApproval: true,
    };
  }

  // 5. Default Allow
  return {
    decision: "ALLOW",
    reason: "Operation satisfies all autonomous execution policy constraints.",
    policyName: "STANDARD_AUTONOMOUS_POLICY",
    riskLevel: risk,
    requiresApproval: false,
  };
}

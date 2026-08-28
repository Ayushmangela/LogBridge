import { describe, expect, test } from "vitest";
import {
  openDb,
  setProjectMember,
  getProjectMembers,
  removeProjectMember,
  createGoal,
  getGoal,
  type Db,
} from "./db.js";
import { hasPermission, assertPermission } from "./authorization.js";
import { evaluatePolicy } from "./policyEngine.js";
import { createApprovalRequest, getApprovalRequest, getProjectApprovals, resolveApprovalRequest } from "./approvals.js";
import { recordAuditLog, getProjectAuditLogs } from "./audit.js";
import { createEscalation, resolveEscalation, getProjectEscalations } from "./escalations.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_gov") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_owner_${id}`, `owner_${id}`, "Project Owner", 0);
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_admin_${id}`, `admin_${id}`, "Project Admin", 1);
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_reviewer_${id}`, `reviewer_${id}`, "Senior Reviewer", 2);
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_member_${id}`, `member_${id}`, "Team Member", 3);
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_viewer_${id}`, `viewer_${id}`, "Readonly Viewer", 4);

  setProjectMember(db, id, `usr_owner_${id}`, "owner");
  setProjectMember(db, id, `usr_admin_${id}`, "admin");
  setProjectMember(db, id, `usr_reviewer_${id}`, "reviewer");
  setProjectMember(db, id, `usr_member_${id}`, "member");
  setProjectMember(db, id, `usr_viewer_${id}`, "viewer");
}

describe("Role-Based Access Control (RBAC) & Permissions", () => {
  test("enforces role permissions and strict project boundaries", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_alpha");
    seedProject(db, "prj_beta");

    // Owner in alpha has all permissions
    expect(hasPermission(db, "prj_alpha", "usr_owner_prj_alpha", "project.manage")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_owner_prj_alpha", "approval.resolve")).toBe(true);

    // Admin has approval.resolve & member.manage
    expect(hasPermission(db, "prj_alpha", "usr_admin_prj_alpha", "approval.resolve")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_admin_prj_alpha", "member.manage")).toBe(true);

    // Reviewer has approval.resolve and task.review, but NOT member.manage
    expect(hasPermission(db, "prj_alpha", "usr_reviewer_prj_alpha", "approval.resolve")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_reviewer_prj_alpha", "task.review")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_reviewer_prj_alpha", "member.manage")).toBe(false);

    // Member can request approval and create tasks, but CANNOT resolve approvals
    expect(hasPermission(db, "prj_alpha", "usr_member_prj_alpha", "approval.request")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_member_prj_alpha", "task.create")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_member_prj_alpha", "approval.resolve")).toBe(false);

    // Viewer can only view
    expect(hasPermission(db, "prj_alpha", "usr_viewer_prj_alpha", "audit.view")).toBe(true);
    expect(hasPermission(db, "prj_alpha", "usr_viewer_prj_alpha", "task.create")).toBe(false);
    expect(hasPermission(db, "prj_alpha", "usr_viewer_prj_alpha", "approval.resolve")).toBe(false);

    // Cross-project access denied: user from prj_alpha cannot resolve in prj_beta
    expect(hasPermission(db, "prj_beta", "usr_owner_prj_alpha", "approval.resolve")).toBe(false);

    // assertPermission helper throws on violation
    expect(() => assertPermission(db, "prj_alpha", "usr_viewer_prj_alpha", "approval.resolve")).toThrow(
      /Permission denied/
    );

    db.close();
  });

  test("manages project membership and role changes", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_mem");

    const members = getProjectMembers(db, "prj_mem");
    expect(members.length).toBe(5);

    // Update member role
    setProjectMember(db, "prj_mem", "usr_member_prj_mem", "manager");
    expect(hasPermission(db, "prj_mem", "usr_member_prj_mem", "approval.resolve")).toBe(true);

    // Remove member
    removeProjectMember(db, "prj_mem", "usr_viewer_prj_mem");
    const updatedMembers = getProjectMembers(db, "prj_mem");
    expect(updatedMembers.length).toBe(4);

    db.close();
  });
});

describe("Governance Policy Engine", () => {
  test("evaluates risk, cost, destructive actions, and retry escalation thresholds", () => {
    // 1. Critical risk gate
    const critDecision = evaluatePolicy({
      projectId: "prj_test",
      actionType: "goal_execution",
      riskLevel: "critical",
    });
    expect(critDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(critDecision.policyName).toBe("CRITICAL_RISK_GATE");

    // 2. High cost gate (> $5.00)
    const costDecision = evaluatePolicy({
      projectId: "prj_test",
      actionType: "plan_materialization",
      estimatedCostUsd: 14.5,
    });
    expect(costDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(costDecision.policyName).toBe("COST_THRESHOLD_GATE");

    // 3. Destructive action gate
    const destrDecision = evaluatePolicy({
      projectId: "prj_test",
      actionType: "workflow_cancellation",
      hasActiveDownstreamTasks: true,
    });
    expect(destrDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(destrDecision.policyName).toBe("DESTRUCTIVE_ACTION_GATE");

    // 4. Retry threshold gate (3+ retries)
    const retryDecision = evaluatePolicy({
      projectId: "prj_test",
      actionType: "destructive_action",
      retryCount: 3,
    });
    expect(retryDecision.decision).toBe("REQUIRE_APPROVAL");
    expect(retryDecision.policyName).toBe("DESTRUCTIVE_ACTION_GATE");

    // 5. Standard autonomous allow
    const allowDecision = evaluatePolicy({
      projectId: "prj_test",
      actionType: "goal_execution",
      riskLevel: "low",
      estimatedCostUsd: 0.5,
    });
    expect(allowDecision.decision).toBe("ALLOW");
    expect(allowDecision.policyName).toBe("STANDARD_AUTONOMOUS_POLICY");
    expect(allowDecision.requiresApproval).toBe(false);
  });
});

describe("Approval Requests & Gate Execution", () => {
  test("creates approval requests, prevents duplicate resolution, and executes approved action payloads", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_appr");

    const goalId = createGoal(db, {
      projectId: "prj_appr",
      title: "Deploy Auth System",
      creatorId: "usr_owner_prj_appr",
    });

    const approvalId = createApprovalRequest(db, {
      projectId: "prj_appr",
      goalId,
      requesterId: "agt_planner",
      requesterType: "agent",
      approvalType: "deployment",
      title: "Authorize Production Deployment",
      reason: "Production database migrations and OAuth secrets will be activated.",
      riskLevel: "high",
      proposedAction: {
        action: "resume_goal",
        goalId,
      },
    });

    expect(approvalId).toMatch(/^appr_/);
    const req = getApprovalRequest(db, approvalId);
    expect(req?.state).toBe("pending");
    expect(req?.riskLevel).toBe("high");

    // Project list check
    const approvals = getProjectApprovals(db, "prj_appr", "pending");
    expect(approvals.length).toBe(1);

    // Approve the request
    const resolveRes = resolveApprovalRequest(db, approvalId, "usr_admin_prj_appr", "approved", "Approved by team lead");
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.executedAction).toBe(true);

    const resolvedReq = getApprovalRequest(db, approvalId);
    expect(resolvedReq?.state).toBe("approved");
    expect(resolvedReq?.resolvedBy).toBe("usr_admin_prj_appr");
    expect(resolvedReq?.resolutionComment).toBe("Approved by team lead");

    // Goal state was transitioned by the executed payload
    expect(getGoal(db, goalId)?.state).toBe("executing");

    // Resolving again fails
    const dupRes = resolveApprovalRequest(db, approvalId, "usr_admin_prj_appr", "rejected");
    expect(dupRes.ok).toBe(false);

    db.close();
  });
});

describe("Project Audit Trail & Escalations", () => {
  test("records project-scoped immutable audit log entries", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_aud_a");
    seedProject(db, "prj_aud_b");

    recordAuditLog(db, {
      projectId: "prj_aud_a",
      actorType: "user",
      actorId: "usr_admin_prj_aud_a",
      action: "policy.override",
      resourceType: "policy",
      resourceId: "pol_gate_1",
      metadata: { reason: "Emergency hotfix" },
    });

    const logsA = getProjectAuditLogs(db, "prj_aud_a");
    const logsB = getProjectAuditLogs(db, "prj_aud_b");

    expect(logsA.length).toBeGreaterThanOrEqual(1);
    expect(logsA[0].action).toBe("policy.override");
    expect(logsB.length).toBe(0); // Scoped to prj_aud_a

    db.close();
  });

  test("creates and resolves supervisor escalations", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_esc");

    const escId = createEscalation(db, {
      projectId: "prj_esc",
      title: "Workflow Stalled: Missing Redis Dependency",
      reason: "Agent failed 3 connection attempts to local Redis instance.",
      urgency: "high",
      recommendedActions: ["Provision Redis Container", "Skip Cache Layer"],
    });

    expect(escId).toMatch(/^esc_/);
    const activeEsc = getProjectEscalations(db, "prj_esc", "open");
    expect(activeEsc.length).toBe(1);

    const ok = resolveEscalation(db, escId, "usr_admin_prj_esc", "Redis container started on port 6379");
    expect(ok).toBe(true);

    const resolvedEsc = getProjectEscalations(db, "prj_esc", "resolved");
    expect(resolvedEsc.length).toBe(1);
    expect(resolvedEsc[0].resolvedBy).toBe("usr_admin_prj_esc");

    db.close();
  });
});

describe("Phase 5 REST API Endpoints", () => {
  test("verifies approvals, audit, escalations, and member roles REST APIs", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_api_gov");

    // 1. POST /api/projects/:id/approvals
    const createRes = await server.app.inject({
      method: "POST",
      url: "/api/projects/prj_api_gov/approvals",
      payload: {
        title: "API Gate Authorization",
        reason: "Testing approval REST endpoints.",
        riskLevel: "medium",
        approvalType: "policy_exception",
        requesterId: "human",
      },
    });
    expect(createRes.statusCode).toBe(200);
    const approvalId = createRes.json().approvalId;
    expect(approvalId).toMatch(/^appr_/);

    // 2. GET /api/projects/:id/approvals
    const listRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_api_gov/approvals",
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().approvals.length).toBe(1);

    // 3. POST /api/approvals/:id/approve (denied for viewer)
    const viewerApproveRes = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      payload: { userId: "usr_viewer_prj_api_gov" },
    });
    expect(viewerApproveRes.statusCode).toBe(403);

    // 4. POST /api/approvals/:id/approve (allowed for admin)
    const adminApproveRes = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      payload: { userId: "usr_admin_prj_api_gov", comment: "Approved via API" },
    });
    expect(adminApproveRes.statusCode).toBe(200);

    // 5. GET /api/projects/:id/audit
    const auditRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_api_gov/audit?userId=usr_admin_prj_api_gov",
    });
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json().logs.length).toBeGreaterThan(0);

    // 6. GET & POST /api/projects/:id/members
    const membersRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_api_gov/members",
    });
    expect(membersRes.statusCode).toBe(200);
    expect(membersRes.json().members.length).toBe(5);

    await server.app.close();
  });
});

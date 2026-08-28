import { describe, expect, test } from "vitest";
import {
  openDb,
  createTask,
  getTask,
  storeArtifact,
  addTaskDependency,
  type Db,
} from "./db.js";
import { selectAssignmentStrategy } from "./communication/assignmentStrategy.js";
import { issueCfp, submitProposal, resolveContractNet } from "./communication/contractNet.js";
import { delegateHandoff } from "./communication/handoff.js";
import { processReviewResult } from "./communication/review.js";
import { getProjectSequenceFlow, getTaskSequenceFlow } from "./communication/sequenceEvents.js";
import { buildServer } from "./index.js";

function seedProject(db: Db, id = "prj_cnet") {
  db.prepare("INSERT OR IGNORE INTO projects (id, gh_repo, name, layout) VALUES (?,?,?,?)").run(id, `${id}/repo`, id, "office");
  db.prepare("INSERT OR IGNORE INTO users (id, gh_login, name, avatar) VALUES (?,?,?,?)").run(`usr_${id}`, `u_${id}`, "Commander", 0);
  db.prepare("INSERT OR IGNORE INTO machines (id, owner_id, name, last_seen, online) VALUES (?,?,?,?,?)").run(`m_${id}`, `usr_${id}`, "Worker Machine", new Date().toISOString(), 1);
  
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_dev1_${id}`, `m_${id}`, `usr_${id}`, id, "Developer Alpha", "developer", "idle", JSON.stringify(["backend", "typescript"]), 2
  );
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_dev2_${id}`, `m_${id}`, `usr_${id}`, id, "Developer Beta", "developer", "idle", JSON.stringify(["backend", "fastify"]), 2
  );
  db.prepare("INSERT OR IGNORE INTO agents (id, machine_id, owner_id, project_id, name, role, status, capabilities, concurrency) VALUES (?,?,?,?,?,?,?,?,?)").run(
    `agt_rev_${id}`, `m_${id}`, `usr_${id}`, id, "Code Reviewer", "reviewer", "idle", JSON.stringify(["review", "security"]), 2
  );
}

describe("Assignment Strategy Layer", () => {
  test("selects direct assignment for simple tasks or single candidate", () => {
    const strat1 = selectAssignmentStrategy({
      task: { id: "t1", title: "Simple Task" },
      candidates: [{ id: "c1", capabilities: ["backend"], machineOnline: true }],
    });
    expect(strat1).toBe("DIRECT");
  });

  test("selects contract net for auction tag or multiple capable candidates", () => {
    const strat1 = selectAssignmentStrategy({
      task: { id: "t1", title: "Build Auth #auction" },
      candidates: [{ id: "c1", capabilities: [], machineOnline: true }],
    });
    expect(strat1).toBe("CONTRACT_NET");

    const strat2 = selectAssignmentStrategy({
      task: { id: "t2", title: "Implement Fastify Engine", required_capability: "backend" },
      candidates: [
        { id: "c1", capabilities: ["backend"], machineOnline: true },
        { id: "c2", capabilities: ["backend"], machineOnline: true },
      ],
    });
    expect(strat2).toBe("CONTRACT_NET");
  });
});

describe("Contract Net Protocol & Deterministic Scoring", () => {
  test("issues CFP to eligible candidates only and captures structured proposals", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_cfp");

    const taskId = createTask(db, {
      projectId: "prj_cfp",
      title: "Build REST Gateway",
      creatorId: "usr_prj_cfp",
      requiredCapability: "backend",
    });

    const cfp = issueCfp(db, {
      projectId: "prj_cfp",
      taskId,
      senderAgentId: "commander",
      deadlineSeconds: 30,
    });

    expect(cfp).not.toBeNull();
    expect(cfp?.candidateAgentIds).toContain("agt_dev1_prj_cfp");
    expect(cfp?.candidateAgentIds).toContain("agt_dev2_prj_cfp");
    expect(cfp?.candidateAgentIds).not.toContain("agt_rev_prj_cfp"); // Reviewer does not have "backend"

    // Submit Proposal 1 from Dev 1
    const prop1 = submitProposal(db, {
      cfpId: cfp!.cfpId,
      agentId: "agt_dev1_prj_cfp",
      approach: "Implement using native Fastify plugin pattern",
      confidence: 0.95,
      estimatedDuration: 45,
      reasoningSummary: "Extensive experience with Fastify plugins",
    });

    expect(prop1).not.toBeNull();
    expect(prop1?.score).toBeGreaterThan(0.7);
    expect(prop1?.breakdown?.capabilityMatch).toBe(1.0);

    // Submit Proposal 2 from Dev 2
    const prop2 = submitProposal(db, {
      cfpId: cfp!.cfpId,
      agentId: "agt_dev2_prj_cfp",
      approach: "Implement using lightweight handler pattern",
      confidence: 0.80,
      estimatedDuration: 60,
    });

    expect(prop2).not.toBeNull();

    // Resolve Contract Net
    const resolution = resolveContractNet(db, cfp!.cfpId);
    expect(resolution.winningProposal?.agentId).toBe("agt_dev1_prj_cfp");
    expect(resolution.declinedProposals.length).toBe(1);
    expect(resolution.declinedProposals[0].agentId).toBe("agt_dev2_prj_cfp");

    // Task is now assigned to Dev 1
    const updatedTask = getTask(db, taskId);
    expect(updatedTask?.agent_id).toBe("agt_dev1_prj_cfp");

    db.close();
  });
});

describe("Artifact-Bound Peer Handoffs", () => {
  test("delegates handoff between peer agents referencing artifacts without payload duplication", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_handoff");

    const taskId = createTask(db, {
      projectId: "prj_handoff",
      title: "Implement Token Auth",
      creatorId: "usr_prj_handoff",
    });

    const diffArtifactId = storeArtifact(db, {
      projectId: "prj_handoff",
      taskId,
      creatorId: "usr_prj_handoff",
      kind: "diff",
      title: "auth.patch",
      filePath: "/artifacts/auth.patch",
    });

    const handoff = delegateHandoff(db, {
      taskId,
      fromAgentId: "agt_dev1_prj_handoff",
      toAgentId: "agt_rev_prj_handoff",
      artifacts: { diffArtifactId },
      contextSummary: {
        designDecisions: ["JWT RS256 signing", "15min token expiration"],
        filesModified: ["src/auth.ts", "src/gateway.ts"],
      },
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.artifacts.diffArtifactId).toBe(diffArtifactId);
    expect(handoff?.contextSummary.designDecisions?.length).toBe(2);

    db.close();
  });
});

describe("Review Verdicts & Automated Rework Lifecycle", () => {
  test("ACCEPT verdict marks task completed and unlocks downstream dependencies", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_rev_accept");

    const t1 = createTask(db, { projectId: "prj_rev_accept", title: "Task 1", creatorId: "usr_prj_rev_accept", agentId: "agt_dev1_prj_rev_accept" });
    const t2 = createTask(db, { projectId: "prj_rev_accept", title: "Task 2", creatorId: "usr_prj_rev_accept" });
    addTaskDependency(db, t2, t1);

    const result = processReviewResult(db, {
      taskId: t1,
      reviewerAgentId: "agt_rev_prj_rev_accept",
      status: "ACCEPT",
      comments: ["Code conforms to architectural standards", "Unit tests passing"],
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ACCEPT");

    const task1 = getTask(db, t1);
    expect(task1?.state).toBe("completed");

    db.close();
  });

  test("REJECT verdict spawns linked rework task preserving lineage and findings", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_rev_reject");

    const t1 = createTask(db, {
      projectId: "prj_rev_reject",
      title: "Data Migration Script",
      creatorId: "usr_prj_rev_reject",
      agentId: "agt_dev1_prj_rev_reject",
    });

    const result = processReviewResult(db, {
      taskId: t1,
      reviewerAgentId: "agt_rev_prj_rev_reject",
      status: "REJECT",
      comments: ["Missing rollback safety check in migration"],
      findings: [
        { severity: "ERROR", message: "Transaction does not rollback on foreign key failure", file: "src/db.ts", line: 42 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("REJECT");
    expect(result.reworkTaskId).toBeDefined();

    const reworkTask = getTask(db, result.reworkTaskId!);
    expect(reworkTask?.title).toContain("[Rework #2]");
    expect(reworkTask?.parent_task).toBe(t1);
    expect(reworkTask?.retry_of).toBe(t1);
    expect(reworkTask?.spec).toContain("Missing rollback safety check");

    db.close();
  });

  test("escalates when maximum rework attempts are exceeded", () => {
    const db = openDb(":memory:");
    seedProject(db, "prj_rev_esc");

    const t1 = createTask(db, { projectId: "prj_rev_esc", title: "Hard Task", creatorId: "usr_prj_rev_esc" });

    // Attempt 1 fails
    const r1 = processReviewResult(db, { taskId: t1, reviewerAgentId: "agt_rev_prj_rev_esc", status: "REJECT", comments: ["Fail 1"], maxReworkAttempts: 1 });
    expect(r1.reworkTaskId).toBeDefined();

    // Attempt 2 fails -> exceeds max 1 rework attempt
    const r2 = processReviewResult(db, { taskId: r1.reworkTaskId!, reviewerAgentId: "agt_rev_prj_rev_esc", status: "REJECT", comments: ["Fail 2"], maxReworkAttempts: 1 });
    expect(r2.escalated).toBe(true);

    db.close();
  });
});

describe("Sequence Events & Real-Time REST Flow", () => {
  test("records and retrieves sequence flow events in chronological order", async () => {
    const server = await buildServer({ dbPath: ":memory:" });
    seedProject(server.db, "prj_seq_api");

    const taskId = createTask(server.db, {
      projectId: "prj_seq_api",
      title: "Sequence Demo Task",
      creatorId: "usr_prj_seq_api",
      requiredCapability: "backend",
    });

    // 1. POST /api/contract-net/cfp
    const cfpRes = await server.app.inject({
      method: "POST",
      url: "/api/contract-net/cfp",
      payload: { projectId: "prj_seq_api", taskId },
    });
    expect(cfpRes.statusCode).toBe(200);
    const cfpId = cfpRes.json().cfp.cfpId;

    // 2. POST /api/contract-net/propose
    const propRes = await server.app.inject({
      method: "POST",
      url: "/api/contract-net/propose",
      payload: {
        cfpId,
        agentId: "agt_dev1_prj_seq_api",
        approach: "Full TDD implementation",
        confidence: 0.9,
      },
    });
    expect(propRes.statusCode).toBe(200);

    // 3. POST /api/contract-net/resolve
    const resolveRes = await server.app.inject({
      method: "POST",
      url: "/api/contract-net/resolve",
      payload: { cfpId },
    });
    expect(resolveRes.statusCode).toBe(200);

    // 4. POST /api/handoff/delegate
    const handoffRes = await server.app.inject({
      method: "POST",
      url: "/api/handoff/delegate",
      payload: {
        taskId,
        fromAgentId: "agt_dev1_prj_seq_api",
        toAgentId: "agt_rev_prj_seq_api",
        artifacts: { diffId: "art_test" },
      },
    });
    expect(handoffRes.statusCode).toBe(200);

    // 5. POST /api/review/verdict
    const reviewRes = await server.app.inject({
      method: "POST",
      url: "/api/review/verdict",
      payload: {
        taskId,
        reviewerAgentId: "agt_rev_prj_seq_api",
        status: "ACCEPT",
        comments: ["LGTM"],
      },
    });
    expect(reviewRes.statusCode).toBe(200);

    // 6. GET /api/projects/:id/sequence-events
    const seqRes = await server.app.inject({
      method: "GET",
      url: "/api/projects/prj_seq_api/sequence-events",
    });
    expect(seqRes.statusCode).toBe(200);
    const events = seqRes.json().events;
    expect(events.length).toBeGreaterThanOrEqual(5);

    const eventTypes = events.map((e: any) => e.type);
    expect(eventTypes).toContain("CFP_SENT");
    expect(eventTypes).toContain("PROPOSAL_RECEIVED");
    expect(eventTypes).toContain("PROPOSAL_ACCEPTED");
    expect(eventTypes).toContain("DELEGATE_HANDOFF");
    expect(eventTypes).toContain("REVIEW_RESULT");
    expect(eventTypes).toContain("TASK_COMPLETED");

    await server.app.close();
  });
});

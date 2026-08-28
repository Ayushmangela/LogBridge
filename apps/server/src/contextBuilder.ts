// Deterministic Project-Scoped Agent Context Builder (Phase 3 & Phase 4).
// Layered, prioritized, and bounded context assembly for agent execution.

import type { Db } from "./db.js";
import { getTask, getTaskDependencies, getTaskArtifacts, recentMemories, getGoal } from "./db.js";

export interface AgentContextPayload {
  taskId: string;
  projectId: string;
  assembledAt: string;
  totalLength: number;
  sections: {
    goalSpecification?: string;
    taskDirectives: string;
    dependencyOutputs: string;
    artifactReferences: string;
    lineageAndFailures: string;
    projectMemories: string;
  };
  formattedContext: string;
}

export function buildAgentContext(
  db: Db,
  taskId: string,
  agentId?: string | null,
  opts?: { maxChars?: number }
): AgentContextPayload | null {
  const task = getTask(db, taskId) as any;
  if (!task) return null;

  const maxChars = opts?.maxChars ?? 8000;
  const projectId = task.project_id;

  // 0. Priority 0: Goal Specification (if task belongs to a Goal)
  let goalSpec = "";
  if (task.goal_id) {
    const goal = getGoal(db, task.goal_id);
    if (goal) {
      goalSpec = `=== PROJECT GOAL ===\nGoal: ${goal.title}\nStatus: ${goal.state.toUpperCase()}\n`;
      if (goal.description) goalSpec += `Goal Spec: ${goal.description.trim()}\n`;
    }
  }

  // 1. Priority 1: Task Directives
  let directives = `=== TASK SPECIFICATION ===\nTask ID: ${task.id}\nTitle: ${task.title}\nState: ${task.state}\n`;
  if (task.suggested_role) directives += `Suggested Role: ${task.suggested_role.toUpperCase()}\n`;
  if (task.wave) directives += `Execution Wave: Wave ${task.wave}\n`;
  if (task.required_capability) directives += `Required Capability: ${task.required_capability}\n`;
  if (task.budget_seconds) directives += `Budget: ${task.budget_seconds}s ($${task.budget_usd || 1.0})\n`;
  if (task.spec) directives += `\n[Instructions & Spec]:\n${task.spec.trim()}\n`;

  // 2. Priority 2: Dependency Predecessor Outputs
  let depOutputs = "";
  const dependencies = getTaskDependencies(db, taskId);
  if (dependencies.length > 0) {
    depOutputs = "=== PREDECESSOR DEPENDENCY OUTPUTS ===\n";
    for (const dep of dependencies) {
      depOutputs += `• [${dep.state.toUpperCase()}] ${dep.title} (${dep.dependsOnTaskId})\n`;
      const depArts = getTaskArtifacts(db, dep.dependsOnTaskId);
      for (const art of depArts) {
        depOutputs += `  - Artifact [${art.kind.toUpperCase()}]: ${art.title} ${art.summary ? `— ${art.summary}` : ""}\n`;
        if (art.file_path) depOutputs += `    File Path: ${art.file_path}\n`;
      }
    }
  }

  // 3. Priority 3: Artifact References
  let artRefs = "";
  const artifacts = getTaskArtifacts(db, taskId);
  if (artifacts.length > 0) {
    artRefs = "=== ATTACHED ARTIFACT REFERENCES ===\n";
    for (const art of artifacts) {
      artRefs += `• [${art.kind.toUpperCase()}] ${art.title}\n`;
      if (art.summary) artRefs += `  Summary: ${art.summary}\n`;
      if (art.file_path) artRefs += `  File: ${art.file_path}\n`;
    }
  }

  // 4. Priority 4: Ancestor Lineage & Failure Diagnostics
  let lineage = "";
  if (task.retry_of || task.parent_task) {
    lineage = "=== LINEAGE & RETRY DIAGNOSTICS ===\n";
    if (task.parent_task) lineage += `Parent Task: ${task.parent_task}\n`;
    if (task.retry_of) {
      lineage += `Retry Of Task: ${task.retry_of}\n`;
      const prevAttempts = db
        .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC")
        .all(task.retry_of) as any[];
      for (const a of prevAttempts) {
        if (a.state === "failed" || a.state === "timed_out") {
          lineage += `  - Previous Attempt #${a.attempt_number} Failed: ${a.error_message || "Unknown error"} (Exit: ${a.exit_code ?? 1})\n`;
        }
      }
    }
  }

  // 5. Priority 5: Project Memories & Relevant Facts
  let memoriesText = "";
  const memories = recentMemories(db, projectId, 10).filter((m) => m.scope === "project");
  if (memories.length > 0) {
    memoriesText = "=== RELEVANT PROJECT KNOWLEDGE & MEMORIES ===\n";
    for (const m of memories) {
      memoriesText += `• [${m.kind.toUpperCase()}] ${m.text}\n`;
    }
  }

  // Assemble with priority truncation
  let formatted = "";
  if (goalSpec) formatted += `${goalSpec}\n`;
  formatted += `${directives}\n`;
  if (depOutputs) formatted += `${depOutputs}\n`;
  if (artRefs) formatted += `${artRefs}\n`;
  if (lineage) formatted += `${lineage}\n`;
  if (memoriesText) formatted += `${memoriesText}\n`;

  if (formatted.length > maxChars) {
    formatted = formatted.slice(0, maxChars) + "\n\n[... Context truncated to fit token budget ...]";
  }

  return {
    taskId,
    projectId,
    assembledAt: new Date().toISOString(),
    totalLength: formatted.length,
    sections: {
      goalSpecification: goalSpec || undefined,
      taskDirectives: directives,
      dependencyOutputs: depOutputs,
      artifactReferences: artRefs,
      lineageAndFailures: lineage,
      projectMemories: memoriesText,
    },
    formattedContext: formatted.trim(),
  };
}

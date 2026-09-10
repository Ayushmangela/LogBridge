// Acceptance checks — a command that has to pass before a task is done.
//
// The completion gate already refuses a task whose declared artifacts are not
// on record. That proves an output EXISTS; it cannot prove the output is
// RIGHT. A named command that must exit 0 can, and it costs no model tokens:
// the evidence is the exit code, not another opinion.
//
// WHY A NAME AND NOT A COMMAND ON THE TASK.
//
// Tasks are created from agent-authored content in several places — see
// `nodeGateway/plan-proposals.ts`, which lifts `title` and `capability`
// straight out of a plan a model wrote. A task field holding a shell string
// would therefore be a path from "model writes JSON" to "server runs shell",
// which is the whole ballgame. So the command lives in `project_checks`,
// written only through an authenticated owner/admin route, and a task may
// only ever reference one BY NAME. The worst an agent can do is ask for a
// check that does not exist.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Db } from "./db.js";

/** Long enough for a real test suite, short enough that a hung command does
 *  not wedge a completion forever. */
export const CHECK_TIMEOUT_MS = 5 * 60_000;

/** Enough to see the failure; not so much that a runaway suite fills the log. */
const MAX_OUTPUT = 4_000;

export interface ProjectCheck {
  projectId: string;
  name: string;
  command: string;
  createdBy: string | null;
  createdAt: string;
}

export interface CheckRun {
  name: string;
  /** null when the check could not be run at all — see `skipped`. */
  exitCode: number | null;
  passed: boolean;
  /** Set when the check was not run: no such check, or the workspace is on
   *  another machine. Never silently treated as a pass. */
  skipped: string | null;
  output: string;
}

/** A check name is an identifier, not a path or a shell fragment. */
export function isValidCheckName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name);
}

export function listChecks(db: Db, projectId: string): ProjectCheck[] {
  const rows = db
    .prepare("SELECT * FROM project_checks WHERE project_id = ? ORDER BY name")
    .all(projectId) as any[];
  return rows.map((r) => ({
    projectId: r.project_id, name: r.name, command: r.command,
    createdBy: r.created_by ?? null, createdAt: r.created_at,
  }));
}

export function getCheck(db: Db, projectId: string, name: string): ProjectCheck | null {
  const r = db
    .prepare("SELECT * FROM project_checks WHERE project_id = ? AND name = ?")
    .get(projectId, name) as any;
  return r
    ? { projectId: r.project_id, name: r.name, command: r.command, createdBy: r.created_by ?? null, createdAt: r.created_at }
    : null;
}

export function setCheck(
  db: Db, projectId: string, name: string, command: string, createdBy?: string | null
): ProjectCheck {
  if (!isValidCheckName(name)) throw new Error(`invalid check name "${name}"`);
  const trimmed = command.trim();
  if (!trimmed) throw new Error("a check needs a command");
  db.prepare(
    `INSERT INTO project_checks (project_id, name, command, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, name) DO UPDATE SET command = excluded.command, created_by = excluded.created_by`
  ).run(projectId, name, trimmed.slice(0, 500), createdBy ?? null, new Date().toISOString());
  return getCheck(db, projectId, name)!;
}

export function deleteCheck(db: Db, projectId: string, name: string): boolean {
  return db
    .prepare("DELETE FROM project_checks WHERE project_id = ? AND name = ?")
    .run(projectId, name).changes > 0;
}

/** The check names a task must pass, or [] when it named none. */
export function acceptanceChecksOf(task: any): string[] {
  const raw = task?.acceptance_checks;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Run one check in `cwd`.
 *
 * `sh -c` because a check is a command line ("npm test && npm run lint"), not
 * an argv. That is only safe because of where the string came from: an
 * authenticated owner or admin, never a task field and never a model.
 */
export function runCheck(
  check: ProjectCheck,
  cwd: string,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<CheckRun> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh", ["-c", check.command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-MAX_OUTPUT);
        // execFile reports a timeout as a killed process with no exit code.
        // That is a failure, not an inconclusive result: a check that cannot
        // finish has not passed.
        const killed = (err as any)?.killed === true;
        const code = typeof (err as any)?.code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({
          name: check.name,
          exitCode: killed ? null : code,
          passed: !err,
          skipped: null,
          output: killed ? `timed out after ${Math.round(timeoutMs / 1000)}s\n${output}` : output,
        });
      }
    );
  });
}

/**
 * Run every check a task named.
 *
 * Two things are deliberately NOT failures:
 *   * a task that named no checks — most tasks are ad-hoc and have none;
 *   * a workspace that is not on this machine — the agent's folder belongs to
 *     whoever runs it, and `npm test` here would be testing the wrong tree, or
 *     nothing at all.
 * Both are reported as `skipped` with a reason rather than quietly passing, so
 * the difference between "checked and fine" and "never checked" survives.
 */
export async function runAcceptanceChecks(
  db: Db, task: any, workspace: string | null
): Promise<CheckRun[]> {
  const names = acceptanceChecksOf(task);
  if (names.length === 0) return [];

  const runs: CheckRun[] = [];
  for (const name of names) {
    const check = getCheck(db, task.project_id, name);
    if (!check) {
      // An agent can name a check; it cannot create one. A name nobody defined
      // is a plan referring to something that does not exist — surfaced, not
      // silently satisfied.
      runs.push({ name, exitCode: null, passed: false, skipped: `no check named "${name}" in this project`, output: "" });
      continue;
    }
    if (!workspace || !existsSync(workspace)) {
      runs.push({
        name, exitCode: null, passed: true,
        skipped: workspace ? `workspace "${workspace}" is not on this machine` : "the agent has no folder",
        output: "",
      });
      continue;
    }
    runs.push(await runCheck(check, workspace));
  }
  return runs;
}

/** The failures, phrased for the agent that has to fix them. */
export function failureSummary(runs: CheckRun[]): string {
  return runs
    .filter((r) => !r.passed)
    .map((r) => {
      if (r.skipped) return `${r.name}: ${r.skipped}`;
      const head = r.exitCode === null ? `${r.name} timed out` : `${r.name} failed (exit ${r.exitCode})`;
      return r.output ? `${head}\n${r.output.slice(-1200)}` : head;
    })
    .join("\n\n");
}

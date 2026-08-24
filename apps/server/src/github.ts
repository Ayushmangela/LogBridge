// The GitHub mirror (M6). Read-only, forever (D10) — agents write with their
// own human's credentials from their own machines; the server only watches.
// Polled, never pushed to (D9): no webhooks means no public hostname, no
// tunnel, no App registration. Conditional requests keep us far under rate
// limits: every response's ETag is remembered and replayed as If-None-Match,
// and a 304 costs nothing against the quota.
//
// What maps where:
//   repo   -> project/room        (prj_<owner>_<repo>, gh_repo UNIQUE)
//   issue  -> task                (idem = "gh:<repo>#<n>", so re-polls never
//                                  duplicate — tasks.idem is UNIQUE)
//   closed -> task canceled       (only if not already terminal)
//   PR     -> Room.pulls + an activity event on state/CI transitions
//
// Deliberately left out (and labelled): commit aggregation — the events feed
// wants "pushed 4 commits" grouping which needs a per-push window this
// polling loop doesn't have yet. See HANDOFF.md prompt 7's note.
import type { Db } from "./db.js";
import { appendEvent } from "./db.js";

export interface GithubMirrorOptions {
  token: string;
  repos: string[]; // "owner/repo"
  intervalMs?: number; // default 60s
  onChange?: () => void;
  log?: (msg: string) => void;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to https://api.github.com */
  apiBase?: string;
}

interface EtagCache {
  etag: string | null;
  data: any | null;
}

export function startGithubMirror(db: Db, opts: GithubMirrorOptions): { stop(): void } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const intervalMs = opts.intervalMs ?? 60_000;
  const onChange = opts.onChange ?? (() => {});
  const log = opts.log ?? (() => {});
  const etags = new Map<string, EtagCache>();

  async function get(path: string): Promise<{ status: number; data: any | null }> {
    const url = `${apiBase}${path}`;
    const cached = etags.get(url);
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "logbridge-mirror",
      ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
    };
    const res = await fetchImpl(url, { headers });
    if (res.status === 304 && cached) return { status: 304, data: cached.data };
    const etag = res.headers.get("etag");
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (res.ok && etag) etags.set(url, { etag, data });
    return { status: res.status, data };
  }

  function upsertRoom(repo: string): string | null {
    const full = db.prepare("SELECT id FROM projects WHERE gh_repo = ?").get(repo) as any;
    if (full) return full.id;
    const projectId = `prj_${repo.replace("/", "_").toLowerCase()}`;
    const name = repo;
    db.prepare(
      `INSERT INTO projects (id, gh_repo, name, layout) VALUES (?, ?, ?, 'office')
       ON CONFLICT(gh_repo) DO UPDATE SET name = excluded.name`
    ).run(projectId, repo, name);
    appendEvent(db, projectId, null, "github.room_linked", { repo });
    return projectId;
  }

  function syncIssues(projectId: string, repo: string, issues: any[]) {
    for (const issue of issues) {
      if (issue.pull_request) continue; // the issues API includes PRs; they're not tasks
      const idem = `gh:${repo}#${issue.number}`;
      const existing = db.prepare("SELECT id, state FROM tasks WHERE idem = ?").get(idem) as any;
      if (issue.state === "open" && !existing) {
        db.prepare(
          `INSERT INTO tasks (id, project_id, title, spec, creator_id, agent_id, state, cost_usd, idem)
           VALUES (?, ?, ?, ?, 'github', NULL, 'submitted', 0, ?)`
        ).run(`tsk_${crypto.randomUUID()}`, projectId, String(issue.title), JSON.stringify({ githubIssue: issue.html_url }), idem);
        appendEvent(db, projectId, null, "github.issue_task", {
          repo, number: issue.number, title: issue.title, author: issue.user?.login ?? null,
        });
      } else if (issue.state === "closed" && existing && !["completed", "failed", "canceled", "rejected"].includes(existing.state)) {
        db.prepare("UPDATE tasks SET state = 'canceled', ended_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
        appendEvent(db, projectId, null, "github.issue_closed", { repo, number: issue.number, title: issue.title });
      }
    }
  }

  function syncPulls(projectId: string, repo: string, pulls: any[]) {
    for (const pr of pulls.slice(0, 20)) {
      const id = `prj_${repo.replace("/", "_").toLowerCase()}#${pr.number}`;
      const prev = db.prepare("SELECT state, ci FROM github_pulls WHERE id = ?").get(id) as any;
      const next = {
        state: pr.merged ? "merged" : pr.draft ? "draft" : pr.state === "closed" ? "closed" : "open",
        author: pr.user?.login ?? null,
        title: String(pr.title),
        updatedAt: pr.updated_at ?? new Date().toISOString(),
      };
      db.prepare(
        `INSERT INTO github_pulls (id, project_id, number, title, state, author, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state,
           author = excluded.author, updated_at = excluded.updated_at`
      ).run(id, projectId, pr.number, next.title, next.state, next.author, next.updatedAt);

      // Narrate transitions once, not every poll.
      const changed = !prev || prev.state !== next.state;
      if (changed) {
        const verb = next.state === "merged" ? "merged"
          : next.state === "closed" ? "closed"
          : next.state === "draft" ? "opened a draft of"
          : "opened";
        appendEvent(db, projectId, null, "github.pull", {
          repo, number: pr.number, title: next.title, verb, author: next.author,
        });
      }
    }
  }

  async function pollRepo(repo: string) {
    const projectId = upsertRoom(repo);
    if (!projectId) return;

    const issues = await get(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50`);
    if (issues.status === 200 && Array.isArray(issues.data)) syncIssues(projectId, repo, issues.data);

    const pulls = await get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`);
    if (pulls.status === 200 && Array.isArray(pulls.data)) {
      syncPulls(projectId, repo, pulls.data);
      // CI: combined status per open PR head sha, straight from the pull payload.
      for (const pr of pulls.data.filter((p: any) => !p.draft && p.state === "open").slice(0, 10)) {
        const sha = pr.head?.sha;
        if (!sha) continue;
        const st = await get(`/repos/${repo}/commits/${sha}/status`);
        const state = st.data?.state; // pending | success | failure | error | null
        const ci = state === "success" ? "success" : state === "pending" ? "pending" : state ? "failure" : null;
        const id = `prj_${repo.replace("/", "_").toLowerCase()}#${pr.number}`;
        const prev = db.prepare("SELECT ci FROM github_pulls WHERE id = ?").get(id) as any;
        db.prepare("UPDATE github_pulls SET ci = ? WHERE id = ?").run(ci, id);
        if (prev && prev.ci !== ci && ci === "failure") {
          appendEvent(db, projectId, null, "github.ci_failed", { repo, number: pr.number, title: pr.title });
        } else if (prev && prev.ci !== ci && ci === "success") {
          appendEvent(db, projectId, null, "github.ci_passed", { repo, number: pr.number, title: pr.title });
        }
      }
    }
  }

  async function poll() {
    for (const repo of opts.repos) {
      try {
        await pollRepo(repo.trim());
      } catch (err) {
        log(`github mirror: ${repo} failed: ${(err as Error).message}`);
      }
    }
    onChange();
  }

  const timer = setInterval(() => void poll(), intervalMs);
  if (timer.unref) timer.unref();
  void poll(); // first sync immediately

  return { stop: () => clearInterval(timer) };
}

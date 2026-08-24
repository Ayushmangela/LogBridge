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
//   commits-> grouped into "pushed N commits" per author per push window
//
// Polling can't see pushes, only commits, so a push is RECONSTRUCTED: runs of
// consecutive commits by the same author whose timestamps sit inside
// PUSH_WINDOW_MS are treated as one. That's an approximation and is labelled
// as one — two genuine pushes seconds apart merge into a single line.
import type { Db } from "./db.js";

/** A commit reduced to what a feed line needs. */
export interface Commit { sha: string; author: string; message: string; at: string }

/**
 * Group newest-first commits into pushes, oldest group first. Consecutive
 * commits by one author inside `windowMs` count as a single push.
 *
 * Polling cannot observe a push, only its commits — this reconstructs the
 * grouping, and is an approximation: two real pushes seconds apart merge.
 * Exported so that approximation is testable without the network.
 */
export function groupCommitsIntoPushes(commits: Commit[], windowMs = 10 * 60 * 1000): Commit[][] {
  const chronological = [...commits].reverse();
  const groups: Commit[][] = [];
  for (const c of chronological) {
    const open = groups[groups.length - 1];
    const last = open?.[open.length - 1];
    const contiguous =
      last &&
      last.author === c.author &&
      Math.abs(Date.parse(c.at) - Date.parse(last.at)) <= windowMs;
    if (contiguous) open.push(c);
    else groups.push([c]);
  }
  return groups;
}
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

  // Consecutive commits by one author within this window read as one push.
  // Ten minutes is long enough to hold a real push together and short enough
  // that unrelated work doesn't get swept in.
  const PUSH_WINDOW_MS = 10 * 60 * 1000;

  /** Split newest-first commits into pushes, oldest group first. */
  function syncCommits(projectId: string, repo: string, raw: any[]) {
    const commits: Commit[] = raw
      .filter((c) => c?.sha)
      .map((c) => ({
        sha: String(c.sha),
        author: c.author?.login ?? c.commit?.author?.name ?? "someone",
        message: String(c.commit?.message ?? "").split("\n")[0],
        at: c.commit?.author?.date ?? new Date().toISOString(),
      }));
    if (commits.length === 0) return;

    const cursor = db.prepare("SELECT last_sha FROM github_cursors WHERE repo = ?").get(repo) as any;
    const remember = (sha: string, at: string) =>
      db.prepare(
        `INSERT INTO github_cursors (repo, last_sha, last_commit_at) VALUES (?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET last_sha = excluded.last_sha, last_commit_at = excluded.last_commit_at`
      ).run(repo, sha, at);

    // First sight of a repo: record where we are and say nothing. Announcing
    // the last 30 commits of existing history would bury the feed on day one.
    if (!cursor?.last_sha) {
      remember(commits[0].sha, commits[0].at);
      return;
    }

    const idx = commits.findIndex((c) => c.sha === cursor.last_sha);
    // Not found means more landed than one page holds; take the page.
    const fresh = idx === -1 ? commits : commits.slice(0, idx);
    if (fresh.length === 0) return;

    for (const push of groupCommitsIntoPushes(fresh, PUSH_WINDOW_MS)) {
      appendEvent(db, projectId, null, "github.push", {
        repo,
        author: push[0].author,
        count: push.length,
        // The newest message is the useful one-liner; the rest are in the count.
        headline: push[push.length - 1].message,
        shas: push.map((c) => c.sha.slice(0, 7)),
      });
    }
    remember(commits[0].sha, commits[0].at);
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

    // Commits are newest-first; syncCommits reconstructs pushes from them.
    const commits = await get(`/repos/${repo}/commits?per_page=30`);
    if (commits.status === 200 && Array.isArray(commits.data)) syncCommits(projectId, repo, commits.data);

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

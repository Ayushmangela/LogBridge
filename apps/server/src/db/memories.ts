import type { Db, MemoryRow } from "./types.js";
import { blendByRecency, normalizeMemoryKey } from "../memory.js";

// ---------------- shared memory (MEMORY.md) ----------------
// Lives on the server, not the node, precisely so an agent on one machine
// can recall what an agent on another machine learned (D2). The runner is
// stateless about memory — it asks, it writes, it never caches.

export function writeMemory(
  db: Db,
  m: {
    projectId: string;
    scope: "project" | "agent";
    scopeId: string | null;
    kind: string;
    text: string;
    sourceTaskId: string | null;
    agentId: string;
    agentName: string;
  }
): string | null {
  const id = `mem_${crypto.randomUUID()}`;
  // ON CONFLICT DO NOTHING against the dedupe index — re-learning a fact is
  // a no-op, not an error and not a duplicate row.
  // The KEY is normalised so re-phrasings of one fact collide into the
  // no-op branch; `text` stored verbatim for display.
  const res = db
    .prepare(
      `INSERT INTO memories (id, project_id, scope, scope_id, kind, text, dedupe_key, source_task_id, agent_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      id, m.projectId, m.scope, m.scopeId, m.kind, m.text.trim(),
      normalizeMemoryKey(m.text),
      m.sourceTaskId, m.agentId, m.agentName, new Date().toISOString()
    );
  return res.changes > 0 ? id : null;
}

// FTS5's MATCH takes a query *language*, not a plain string: bare `AND`,
// `*`, `"` or `:` in a user/agent-authored query are syntax, and malformed
// syntax throws rather than returning nothing. Reduce to bare word tokens
// and OR them as quoted phrases, so arbitrary text is always a valid query.
function toFtsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  const unique = [...new Set(tokens)].filter((t) => t.length > 1).slice(0, 24);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t}"`).join(" OR ");
}

// Returns the project's shared memories plus this agent's own notes, ranked
// by BM25 relevance. An empty/unmatchable query falls back to most-recent —
// a new agent with nothing to search for should still inherit context.
export function recallMemories(
  db: Db,
  opts: { projectId: string; agentId: string; query: string; limit: number }
): MemoryRow[] {
  const visible = "m.project_id = ? AND (m.scope = 'project' OR (m.scope = 'agent' AND m.scope_id = ?))";
  const fts = toFtsQuery(opts.query);

  // Candidates are fetched OVER the limit (3x) because ranking happens after
  // the query: a recency boost must be able to lift a slightly-less-lexical
  // row into the final page, which it can't do if that row was cut before
  // scoring. Nothing is deleted by any of this — age reorders, never evicts.
  const rows = fts
    ? (db
        .prepare(
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at,
                  bm25(memories_fts) AS bm25
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE f.text MATCH ? AND ${visible}
           ORDER BY bm25(memories_fts) LIMIT ?`
        )
        .all(fts, opts.projectId, opts.agentId, opts.limit * 3) as any[])
    : (db
        .prepare(
          // Ordered and capped in SQL, not in JS. Without the LIMIT this
          // materialised every visible memory on every recall and then threw
          // most of them away — correct, but a full scan per task, on the one
          // path that has no relevance ranking to justify over-fetching.
          `SELECT m.id, m.scope, m.kind, m.text, m.agent_name, m.created_at, 0 AS bm25
           FROM memories m WHERE ${visible}
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(opts.projectId, opts.agentId, opts.limit) as any[]);

  // No query (or an unmatchable one): most-recent first is already the right
  // order, and blending would just re-sort recency against itself.
  if (!fts) {
    return rows.slice(0, opts.limit).map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, text: r.text,
      agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
    }));
  }

  return blendByRecency(rows, Date.now())
    .slice(0, opts.limit)
    .map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, text: r.text,
      agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
    }));
}

export function recentMemories(db: Db, projectId: string, limit = 50): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, scope, kind, text, agent_name, created_at FROM memories
       WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(projectId, limit) as any[];
  return rows.map((r) => ({
    id: r.id, scope: r.scope, kind: r.kind, text: r.text,
    agentName: r.agent_name ?? "unknown", createdAt: r.created_at,
  }));
}

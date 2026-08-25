// Memory quality (HANDOFF-MEMORY.md, stream B): normalised dedup keys and
// recency-weighted recall. Both live here so the rules are testable without
// the database; db.ts calls into this, never the reverse.
//
// Two honest limits, per the brief: normalisation is about FORMATTING, never
// meaning ("never deploy on Friday" is a different fact from "deploy on
// Friday" no matter how similar they look), and nothing here ever deletes a
// memory for being old — age affects RANKING only.

/**
 * The dedup key for a memory text. Formatting differences that carry no
 * meaning collapse; words never do.
 *
 * Precise rule, in order:
 *   1. lowercase
 *   2. remove clause punctuation (commas, semicolons, colons) where it
 *      separates clauses — that is, followed by whitespace or end of text.
 *      "use pnpm, not npm" and "use pnpm not npm" are one formatting apart,
 *      but "3:1", "2:00" and "user:session" are single words whose
 *      punctuation carries meaning. Same principle as periods below.
 *   3. collapse every whitespace run to a single space
 *   4. trim
 *   5. strip trailing sentence punctuation (. ! ? …) — "npm." == "npm"
 *
 * Periods are stripped only at the END, so "v1.2.0 released" keeps its
 * version number. Words are never touched, which is what keeps the near-miss
 * pair ("deploy on Friday" / "never deploy on Friday") two facts.
 */
export function normalizeMemoryKey(text: string): string {
  return text
    .toLowerCase()
    // Followed by whitespace or end only. Stripping these anywhere turned
    // "ratio is 3:1" into "ratio is 31" — a different fact — which is the
    // exact mistake the trailing-period rule below already avoids.
    .replace(/[,;:](?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!…?]+$/u, "");
}

/** How fast a memory's recency advantage decays. One half-life in days:
 *  a memory this old carries half the recency weight of a fresh one.
 *  Chosen so yesterday's note clearly outranks last quarter's, while a
 *  strong lexical match beats any amount of freshness. */
const RECENCY_HALF_LIFE_DAYS = 21;

export function recencyScore(createdAtIso: string, nowMs: number): number {
  const t = Date.parse(createdAtIso);
  if (!Number.isFinite(t)) return 0; // an unparseable date ranks as ancient
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export interface ScoredRow {
  /** SQLite fts5 bm25(): NEGATIVE, more negative = lexically better. */
  bm25: number;
  created_at: string;
}

/**
 * Blend lexical relevance with recency, best first. Relevance is normalised
 * across the candidate set so its scale (which depends on the query) cannot
 * drown or be drowned by the fixed recency scale.
 *
 * RELEVANCE_W + RECENCY_W = 1. Recency is deliberately the minority voice:
 * the requirement is that an OLD EXACT match still outranks a RECENT VAGUE
 * one — with relevance at 0.8, a perfect match scores ~0.8+ against a vague
 * match's ~0.1 even with maximum recency behind it.
 */
const RELEVANCE_W = 0.8;
const RECENCY_W = 0.2;

export function blendByRecency<T extends ScoredRow>(
  rows: T[],
  nowMs: number
): Array<T & { score: number }> {
  if (rows.length === 0) return [];
  // bm25 is negative-better; flip to positive-higher-better, then normalise
  // to 0..1 across this candidate set (a row matching nothing relevant still
  // came through FTS, so worst-case relevance is 0 by construction).
  const rel = rows.map((r) => -r.bm25);
  const max = Math.max(...rel, Number.EPSILON);
  return rows
    .map((r, i) => {
      const relevance = rel[i] / max;
      const score = RELEVANCE_W * relevance + RECENCY_W * recencyScore(r.created_at, nowMs);
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Migration: move the dedupe index from raw text onto dedupe_key, backfilling
// existing rows. There is no migration framework (D7); this runs explicitly
// from openDb on every start and must be IDEMPOTENT — running it twice on an
// already-migrated database changes nothing and touches no rows.
// ---------------------------------------------------------------------------

/** True when the existing unique index is the OLD text-based definition. */
function needsIndexMigration(db: import("./db.js").Db): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memories_dedupe'")
    .get() as any;
  if (!row?.sql) return false;
  return /\btext\b\s*\)/.test(row.sql); // old form ends "...IFNULL(scope_id,''), text)"
}

export function migrateMemoryDedupe(db: import("./db.js").Db): void {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as any[];
  const hasKey = cols.some((c) => c.name === "dedupe_key");
  if (!hasKey) {
    // ALTER ADD COLUMN via the standard list can't express a computed value,
    // and the index wants the column to exist first — so this column is added
    // here rather than in SCHEMA's ALTER list.
    db.exec("ALTER TABLE memories ADD COLUMN dedupe_key TEXT");
  }

  const pending = db
    .prepare("SELECT id, text FROM memories WHERE dedupe_key IS NULL")
    .all() as any[];

  // The unique index must come DOWN while unkeyed rows are keyed and
  // collapsed — on a fresh database SCHEMA already created it, so backfilling
  // two legacy phrasings of one fact would violate it mid-update. Order is:
  // drop -> key -> collapse (keep oldest) -> recreate.
  const hadUniqueIndex = needsIndexMigration(db) || !!hasKey;
  if (pending.length > 0 && hadUniqueIndex) {
    db.exec("DROP INDEX IF EXISTS idx_memories_dedupe");
  }
  if (needsIndexMigration(db)) {
    db.exec("DROP INDEX idx_memories_dedupe"); // old text-based definition
  }

  if (pending.length > 0) {
    const set = db.prepare("UPDATE memories SET dedupe_key = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of pending) set.run(normalizeMemoryKey(r.text), r.id);
    });
    tx();
  }

  // Legacy near-duplicates that now share a key: keep the oldest, drop the
  // rest. The id is the tie-break, and it is load-bearing rather than tidy:
  // created_at has only millisecond precision, so two rows recorded in the
  // same millisecond satisfied neither side of a strict `<` comparison,
  // nothing was deleted, and CREATE UNIQUE INDEX below then threw. Because
  // this runs from openDb, that was a database which could no longer be
  // opened — every boot, permanently. This is the dedup feature completing itself over legacy data, not
  // ageing — the nothing-deletes rule governs ranking (4b), and these rows
  // are by definition the same fact twice. MUST run before the unique index
  // is recreated, or the backfilled keys collide on creation.
  const dupes = db
    .prepare(
      `SELECT m.id FROM memories m
       JOIN memories keep
         ON keep.project_id = m.project_id AND keep.scope = m.scope
        AND IFNULL(keep.scope_id,'') = IFNULL(m.scope_id,'')
        AND keep.dedupe_key = m.dedupe_key
        AND (keep.created_at < m.created_at
             OR (keep.created_at = m.created_at AND keep.id < m.id))
       WHERE m.dedupe_key IS NOT NULL`
    )
    .all() as any[];
  if (dupes.length > 0) {
    const del = db.prepare("DELETE FROM memories WHERE id = ?");
    const tx = db.transaction(() => {
      for (const d of dupes) del.run(d.id);
    });
    tx();
  }

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe " +
    "ON memories (project_id, scope, IFNULL(scope_id, ''), dedupe_key)"
  );
}

// Invites — how a person joins a floor.
//
// WHY THIS EXISTS. There was no way to invite anyone. The only onboarding path
// was `/api/auth/signup`, which joined the new account to EVERY project by
// running `SELECT id FROM projects` and inserting a membership for each. On
// localhost that is merely wrong; the moment the server is reachable by a
// friend — which is the entire point of the product — it means anyone who
// finds the sign-up form gets every project, every agent, and every live
// terminal.
//
// A code is a bearer credential: holding it is the whole proof. So it is
// random, single-use and expiring by default, revocable, and never logged.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { setProjectMember } from "./db.js";

export const DEFAULT_INVITE_TTL_HOURS = 72;

export interface Invite {
  code: string;
  projectId: string;
  role: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number;
  uses: number;
  revoked: boolean;
  lastRedeemedBy: string | null;
  lastRedeemedAt: string | null;
}

export type RedeemFailure =
  | "not_found" | "revoked" | "expired" | "exhausted" | "no_such_project" | "already_member";

/**
 * Human-transcribable: no vowels (so it cannot spell anything), and no
 * characters that a person reads back wrongly over a call — 0/O, 1/I/l.
 */
const ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ";

function codeWord(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  // Rejection-free modulo bias is irrelevant at this alphabet size for a code
  // that is also rate-limited by being single-use and short-lived.
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** e.g. "K7QF-3MTB-XR9D" — 15 chars of entropy over a 28-char alphabet. */
export function generateInviteCode(): string {
  return [codeWord(4), codeWord(4), codeWord(4)].join("-");
}

export function normalizeCode(raw: string): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function rowToInvite(r: any): Invite {
  return {
    code: r.code,
    projectId: r.project_id,
    role: r.role,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    maxUses: Number(r.max_uses ?? 1),
    uses: Number(r.uses ?? 0),
    revoked: Boolean(r.revoked),
    lastRedeemedBy: r.last_redeemed_by ?? null,
    lastRedeemedAt: r.last_redeemed_at ?? null,
  };
}

export function createInvite(
  db: Db,
  opts: {
    projectId: string;
    createdBy?: string | null;
    role?: string;
    maxUses?: number;
    ttlHours?: number | null;
  }
): Invite {
  const code = generateInviteCode();
  const now = new Date();
  const ttl = opts.ttlHours === null ? null : (opts.ttlHours ?? DEFAULT_INVITE_TTL_HOURS);
  const expiresAt = ttl === null ? null : new Date(now.getTime() + ttl * 3600_000).toISOString();
  // Clamped: a negative or absurd max_uses would turn a single invite into an
  // unlimited standing door, which is the thing this file exists to prevent.
  const maxUses = Math.min(Math.max(1, Math.floor(opts.maxUses ?? 1)), 50);

  db.prepare(
    `INSERT INTO project_invites (code, project_id, role, created_by, created_at, expires_at, max_uses, uses, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(
    normalizeCode(code), opts.projectId, opts.role === "admin" ? "admin" : "member",
    opts.createdBy ?? null, now.toISOString(), expiresAt, maxUses
  );

  // The dashed form is what a person is shown and types; storage is normalized.
  return { ...rowToInvite(getInviteRow(db, code)), code };
}

function getInviteRow(db: Db, code: string): any {
  return db.prepare("SELECT * FROM project_invites WHERE code = ?").get(normalizeCode(code));
}

export function getInvite(db: Db, code: string): Invite | null {
  const r = getInviteRow(db, code);
  return r ? rowToInvite(r) : null;
}

export function listInvites(db: Db, projectId: string): Invite[] {
  const rows = db
    .prepare("SELECT * FROM project_invites WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as any[];
  return rows.map(rowToInvite);
}

export function revokeInvite(db: Db, code: string): boolean {
  const res = db
    .prepare("UPDATE project_invites SET revoked = 1 WHERE code = ? AND revoked = 0")
    .run(normalizeCode(code));
  return res.changes > 0;
}

/** Why a code cannot be used, or null if it can. Order is deliberate: a
 *  revoked code reports revoked even after it also expired, because that is
 *  the fact the person who revoked it wants to see. */
export function inviteProblem(db: Db, code: string, now = new Date()): RedeemFailure | null {
  const inv = getInvite(db, code);
  if (!inv) return "not_found";
  if (inv.revoked) return "revoked";
  if (inv.expiresAt && Date.parse(inv.expiresAt) <= now.getTime()) return "expired";
  if (inv.uses >= inv.maxUses) return "exhausted";
  if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(inv.projectId)) return "no_such_project";
  return null;
}

/**
 * Join `userId` to the invite's project.
 *
 * Redeeming twice by the same person is NOT an error worth failing on — a
 * double-clicked button should not burn the one use and lock them out — but it
 * does not consume a use either.
 */
export function redeemInvite(
  db: Db, code: string, userId: string
): { ok: true; projectId: string; role: string } | { ok: false; reason: RedeemFailure } {
  const problem = inviteProblem(db, code);
  if (problem) return { ok: false, reason: problem };

  const inv = getInvite(db, code)!;
  const already = db
    .prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(inv.projectId, userId);
  if (already) return { ok: true, projectId: inv.projectId, role: inv.role };

  setProjectMember(db, inv.projectId, userId, inv.role);
  db.prepare(
    "UPDATE project_invites SET uses = uses + 1, last_redeemed_by = ?, last_redeemed_at = ? WHERE code = ?"
  ).run(userId, new Date().toISOString(), normalizeCode(code));

  return { ok: true, projectId: inv.projectId, role: inv.role };
}

/** Constant-time compare, for anywhere a caller checks a code by equality
 *  rather than by lookup. Lookup itself is by primary key and not a secret. */
export function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(normalizeCode(a));
  const y = Buffer.from(normalizeCode(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export const REDEEM_MESSAGES: Record<RedeemFailure, string> = {
  not_found: "That invite code does not exist. Check for a typo, or ask for a new one.",
  revoked: "That invite was revoked. Ask whoever sent it for a new one.",
  expired: "That invite has expired. Ask whoever sent it for a new one.",
  exhausted: "That invite has already been used. Ask for a new one.",
  no_such_project: "The project this invite was for no longer exists.",
  already_member: "You are already a member of that project.",
};

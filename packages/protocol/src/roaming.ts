/**
 * Deterministic idle roaming — pure functions, no I/O, no Math.random().
 *
 * Phase 1 (HANDOFF-PRESENCE.md): idle agents drift inside the idle zone
 * instead of standing on their slot. Every browser must draw the same
 * office, so the position is a pure function of (agentId, sharedClockBucket).
 *
 * This module is the testable core. apps/web/index.html duplicates the same
 * algorithm inline (plain JS, no bundler) — keep them in sync. Tests here are
 * the enforcement for the two hard constraints:
 *   A. Roaming never leaves the idle zone.
 *   B. Same inputs -> same position (deterministic, no Math.random).
 */

export const ROAM_INTERVAL_MS = 3500;
export const ROAM_MARGIN_PX = 24; // keeps a 32px sprite fully inside the zone

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type PixelRect = { x: number; y: number; w: number; h: number };

/**
 * Deterministic waypoint for one bucket. Uses two independent hashes so x and y
 * are not correlated (using low vs high bits of one hash would still couple them).
 */
export function roamingPoint(
  agentId: string,
  bucket: number,
  rect: PixelRect,
  margin: number = ROAM_MARGIN_PX,
): { x: number; y: number } {
  if (rect.w <= margin * 2 || rect.h <= margin * 2) {
    // Degenerate rect — fall back to centre rather than throwing into the render loop
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }
  const usableW = rect.w - margin * 2;
  const usableH = rect.h - margin * 2;
  const hx = hashString(`${agentId}:x:${bucket}`);
  const hy = hashString(`${agentId}:y:${bucket}`);
  // Modulo is deterministic and bounded; no Math.random() anywhere in this file.
  const x = rect.x + margin + (hx % usableW);
  const y = rect.y + margin + (hy % usableH);
  return { x, y };
}

/**
 * Interpolated position between two waypoints, for smooth motion.
 * nowMs is the shared clock (serverTime + elapsed since view). bucket = floor(nowMs / interval)
 */
export function roamingTarget(
  agentId: string,
  nowMs: number,
  rect: PixelRect,
  intervalMs: number = ROAM_INTERVAL_MS,
  margin: number = ROAM_MARGIN_PX,
): { x: number; y: number } {
  if (!Number.isFinite(nowMs)) {
    return roamingPoint(agentId, 0, rect, margin);
  }
  const bucket = Math.floor(nowMs / intervalMs);
  const progress = (nowMs % intervalMs) / intervalMs;
  // Clamp progress to [0,1) even for negative nowMs
  const t = Math.max(0, Math.min(0.999999, progress));
  const p0 = roamingPoint(agentId, bucket, rect, margin);
  const p1 = roamingPoint(agentId, bucket + 1, rect, margin);
  return {
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
  };
}

/** True when an agent's zone means it should be roaming. */
export function shouldRoam(zone: string): boolean {
  return zone === "idle";
}

// ---------------- Phase 2: running animation & facing ----------------
// The run animation only describes motion the ease loop already performs;
// it never creates motion on its own. While distance to target exceeds a
// small threshold the sprite shows `run` frames facing the travel direction,
// otherwise it shows `idle` frames. Direction is the larger of |dx|,|dy|.

export const RUN_THRESHOLD_PX = 1.5;

export type Direction = "right" | "left" | "up" | "down";
export type AnimAction = "idle" | "run";

export function directionFor(dx: number, dy: number): Direction {
  // Larger absolute delta picks the axis; ties go vertical (down/up) to match
  // the Map's north-south corridor as the default when dx==dy.
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function shouldRun(dist: number, threshold: number = RUN_THRESHOLD_PX): boolean {
  return dist > threshold;
}

export function animFor(dist: number, dx: number, dy: number, fallbackDir: Direction = "down"): { action: AnimAction; direction: Direction } {
  if (shouldRun(dist)) return { action: "run", direction: directionFor(dx, dy) };
  return { action: "idle", direction: fallbackDir };
}

// ---------------- Phase 3: selection popup ----------------
// Small head-anchored card, ~4 lines max, pointer-events none, clamped to viewport.
// These are pure helpers so they are testable without a DOM.

export function clampPopupPosition(
  anchorX: number,
  anchorY: number,
  popupW: number,
  popupH: number,
  vpW: number,
  vpH: number,
  margin: number = 8,
): { x: number; y: number } {
  let x = anchorX - popupW / 2;
  let y = anchorY - popupH - 12;
  x = Math.max(margin, Math.min(x, vpW - popupW - margin));
  y = Math.max(margin, Math.min(y, vpH - popupH - margin));
  return { x, y };
}

export function popupLines(a: {
  name: string;
  status: string;
  zone?: string;
  task?: { title: string } | null;
  note?: string | null;
}): string[] {
  const lines: string[] = [];
  lines.push(`${a.name} — ${a.status}`);
  if (a.task?.title) lines.push(a.task.title);
  if (a.note) lines.push(a.note);
  // Guard: if it grows past ~4 lines you have built the wrong thing
  return lines.slice(0, 4);
}

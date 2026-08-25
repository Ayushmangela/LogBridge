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

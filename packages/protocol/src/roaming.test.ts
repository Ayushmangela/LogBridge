import { describe, expect, test } from "vitest";
import {
  hashString,
  ROAM_INTERVAL_MS,
  ROAM_MARGIN_PX,
  roamingPoint,
  roamingTarget,
  shouldRoam,
} from "./roaming.js";

// Matches assets/office.json idle zone: 544,1248 608x160 pixels
const IDLE_RECT = { x: 544, y: 1248, w: 608, h: 160 };

describe("roaming — hard constraint A: never leaves the idle zone", () => {
  test("roamingPoint stays inside the inner bounds for many buckets", () => {
    for (const id of ["agt_1", "agt_2", "agt_idle", "agt_dev:café"]) {
      for (let bucket = 0; bucket < 200; bucket++) {
        const p = roamingPoint(id, bucket, IDLE_RECT);
        expect(p.x).toBeGreaterThanOrEqual(IDLE_RECT.x + ROAM_MARGIN_PX);
        expect(p.x).toBeLessThanOrEqual(IDLE_RECT.x + IDLE_RECT.w - ROAM_MARGIN_PX);
        expect(p.y).toBeGreaterThanOrEqual(IDLE_RECT.y + ROAM_MARGIN_PX);
        expect(p.y).toBeLessThanOrEqual(IDLE_RECT.y + IDLE_RECT.h - ROAM_MARGIN_PX);
      }
    }
  });

  test("roamingTarget interpolation stays inside the inner bounds", () => {
    const id = "agt_idle";
    for (let ms = 0; ms < 100_000; ms += 97) {
      const p = roamingTarget(id, ms, IDLE_RECT);
      expect(p.x).toBeGreaterThanOrEqual(IDLE_RECT.x + ROAM_MARGIN_PX);
      expect(p.x).toBeLessThanOrEqual(IDLE_RECT.x + IDLE_RECT.w - ROAM_MARGIN_PX);
      expect(p.y).toBeGreaterThanOrEqual(IDLE_RECT.y + ROAM_MARGIN_PX);
      expect(p.y).toBeLessThanOrEqual(IDLE_RECT.y + IDLE_RECT.h - ROAM_MARGIN_PX);
    }
  });

  test("degenerate rect falls back to centre rather than throwing", () => {
    const tiny = { x: 0, y: 0, w: 10, h: 10 };
    const p = roamingPoint("agt_1", 0, tiny, 20);
    expect(p.x).toBe(5);
    expect(p.y).toBe(5);
    const t = roamingTarget("agt_1", 1234, tiny, ROAM_INTERVAL_MS, 20);
    expect(t.x).toBe(5);
  });
});

describe("roaming — hard constraint B: deterministic, same office on every browser", () => {
  test("same agent + same bucket -> same point", () => {
    const a = roamingPoint("agt_same", 42, IDLE_RECT);
    const b = roamingPoint("agt_same", 42, IDLE_RECT);
    expect(a).toEqual(b);
  });

  test("same agent + same nowMs -> same target (no Math.random)", () => {
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    const a = roamingTarget("agt_same", now, IDLE_RECT);
    const b = roamingTarget("agt_same", now, IDLE_RECT);
    expect(a).toEqual(b);
  });

  test("different agents diverge even on same bucket", () => {
    const p1 = roamingPoint("agt_a", 7, IDLE_RECT);
    const p2 = roamingPoint("agt_b", 7, IDLE_RECT);
    expect(p1).not.toEqual(p2);
  });

  test("different buckets produce different waypoints (it actually moves)", () => {
    const p0 = roamingPoint("agt_move", 0, IDLE_RECT);
    const p1 = roamingPoint("agt_move", 1, IDLE_RECT);
    // Not guaranteed for every agent/bucket pair, but highly likely; test with several
    let moved = false;
    for (let b = 0; b < 20; b++) {
      const a = roamingPoint("agt_move", b, IDLE_RECT);
      const c = roamingPoint("agt_move", b + 1, IDLE_RECT);
      if (a.x !== c.x || a.y !== c.y) { moved = true; break; }
    }
    expect(moved).toBe(true);
    // also interpolation moves within an interval
    const early = roamingTarget("agt_move", 0, IDLE_RECT);
    const mid = roamingTarget("agt_move", ROAM_INTERVAL_MS / 2, IDLE_RECT);
    expect(early).not.toEqual(mid);
    // ensure p1 is not ignored
    expect(p0).not.toEqual(p1);
  });

  test("hashString is deterministic and pure", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("world"));
  });
});

describe("roaming — zone gating", () => {
  test("shouldRoam is true only for idle", () => {
    expect(shouldRoam("idle")).toBe(true);
    expect(shouldRoam("working")).toBe(false);
    expect(shouldRoam("needs_human")).toBe(false);
    expect(shouldRoam("done")).toBe(false);
    expect(shouldRoam("reviewing")).toBe(false);
    expect(shouldRoam("blocked")).toBe(false);
    expect(shouldRoam("collaborating")).toBe(false);
  });

  test("a working agent must not be given a roaming position — it snaps to its slot", () => {
    // This is a behaviour contract: the helper says don't roam, the renderer
    // must obey. We test the predicate that gates it.
    const zoneWorking = "working";
    const zoneIdle = "idle";
    expect(shouldRoam(zoneWorking)).toBe(false);
    expect(shouldRoam(zoneIdle)).toBe(true);
  });
});

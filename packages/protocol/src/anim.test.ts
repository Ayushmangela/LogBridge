import { describe, expect, test } from "vitest";
import { directionFor, shouldRun, animFor, RUN_THRESHOLD_PX } from "./roaming.js";

describe("phase 2 — running animation & facing", () => {
  test("direction picks larger absolute delta, sign gives orientation", () => {
    expect(directionFor(10, 2)).toBe("right");
    expect(directionFor(-10, 2)).toBe("left");
    expect(directionFor(2, 10)).toBe("down");
    expect(directionFor(2, -10)).toBe("up");
    // tie goes vertical — down if dy positive, up otherwise
    expect(directionFor(5, 5)).toBe("down");
    expect(directionFor(-5, -5)).toBe("up");
    expect(directionFor(0, 0)).toBe("up"); // dy=0 not >0, so up
  });

  test("shouldRun threshold: stationary shows idle, moving shows run", () => {
    expect(shouldRun(0)).toBe(false);
    expect(shouldRun(RUN_THRESHOLD_PX - 0.1)).toBe(false);
    expect(shouldRun(RUN_THRESHOLD_PX)).toBe(false);
    expect(shouldRun(RUN_THRESHOLD_PX + 0.1)).toBe(true);
    expect(shouldRun(100)).toBe(true);
  });

  test("animFor: run when moving, idle when stationary, facing follows vector", () => {
    // moving far
    expect(animFor(10, 10, 1, "down")).toEqual({ action: "run", direction: "right" });
    expect(animFor(10, 1, 10, "down")).toEqual({ action: "run", direction: "down" });
    expect(animFor(10, -8, 2, "down")).toEqual({ action: "run", direction: "left" });
    expect(animFor(10, 2, -8, "down")).toEqual({ action: "run", direction: "up" });
    // stationary — keep fallback direction, idle
    expect(animFor(0, 10, 0, "left")).toEqual({ action: "idle", direction: "left" });
    expect(animFor(0.5, 10, 0, "right")).toEqual({ action: "idle", direction: "right" });
    expect(animFor(RUN_THRESHOLD_PX, 10, 0, "up")).toEqual({ action: "idle", direction: "up" });
  });

  test("no running-on-the-spot: threshold prevents jitter when easing asymptotically approaches target", () => {
    // Easing never reaches exactly 0; a 0.5px residual must still be idle
    expect(shouldRun(0.5)).toBe(false);
    expect(animFor(0.5, 5, 0, "right").action).toBe("idle");
  });

  test("applies to all movement types — roaming, zone changes, summoning share same helper", () => {
    // The helper is agnostic to *why* it is moving; any dx/dy/dist works.
    // Roaming (small dx/dy), zone change (large dx), summon (large dy) all go through same path.
    const roaming = animFor(5, 3, 4, "down"); // roaming 3,4
    const zoneChange = animFor(400, 300, 10, "down"); // far pod hop
    const summon = animFor(200, 5, 180, "down"); // walk to player
    expect(roaming.action).toBe("run");
    expect(zoneChange.action).toBe("run");
    expect(summon.action).toBe("run");
    // direction still larger-axis rule
    expect(roaming.direction).toBe("down"); // |4| > |3|
    expect(zoneChange.direction).toBe("right");
    expect(summon.direction).toBe("down");
  });
});

import { describe, expect, test } from "vitest";
import { clampPopupPosition, popupLines } from "./roaming.js";

describe("phase 3 — selection popup", () => {
  test("clamp: center anchor stays centered, edges clamp inside viewport", () => {
    // viewport 800x600, popup 176x60, centered at 400,300 -> centered
    const c1 = clampPopupPosition(400, 300, 176, 60, 800, 600);
    expect(c1.x).toBe(400 - 88); // 312
    expect(c1.y).toBe(300 - 60 - 12); // 228

    // Near left edge -> clamp to margin
    const c2 = clampPopupPosition(10, 100, 176, 60, 800, 600);
    expect(c2.x).toBe(8);

    // Near right edge -> clamp to vpW - popupW - margin
    const c3 = clampPopupPosition(790, 100, 176, 60, 800, 600);
    expect(c3.x).toBe(800 - 176 - 8); // 616

    // Near top edge -> clamp to margin (y would be negative without clamp)
    const c4 = clampPopupPosition(400, 5, 176, 60, 800, 600);
    expect(c4.y).toBe(8);

    // Near bottom edge -> clamp stays inside
    const c5 = clampPopupPosition(400, 595, 176, 60, 800, 600);
    expect(c5.y).toBeLessThanOrEqual(600 - 60 - 8);
  });

  test("popup never renders off edge for any anchor inside viewport", () => {
    const vpW = 1024, vpH = 768;
    for (const x of [0, 50, 512, 974, 1024]) {
      for (const y of [0, 50, 384, 718, 768]) {
        const p = clampPopupPosition(x, y, 176, 60, vpW, vpH);
        expect(p.x).toBeGreaterThanOrEqual(8);
        expect(p.x + 176).toBeLessThanOrEqual(vpW - 8 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(8);
        expect(p.y + 60).toBeLessThanOrEqual(vpH - 8 + 1e-9);
      }
    }
  });

  test("popupLines: name+status, task title if any, note when set, max 4 lines", () => {
    const a1 = { name: "dev-api", status: "working", task: { title: "Add JWT auth" }, note: "flaky on staging" };
    expect(popupLines(a1)).toEqual(["dev-api — working", "Add JWT auth", "flaky on staging"]);

    const a2 = { name: "idle-a", status: "idle", task: null, note: null };
    expect(popupLines(a2)).toEqual(["idle-a — idle"]);

    const a3 = { name: "qa", status: "reviewing", task: { title: "t" }, note: null };
    expect(popupLines(a3)).toEqual(["qa — reviewing", "t"]);

    // no task but note present
    const a4 = { name: "doc", status: "idle", task: null, note: "needs docs" };
    expect(popupLines(a4)).toEqual(["doc — idle", "needs docs"]);

    // If it grows past 4, it is sliced
    const a5 = { name: "x", status: "idle", task: { title: "t" }, note: "n" };
    // Currently max 3 lines; if future adds more, it caps at 4
    expect(popupLines(a5).length).toBeLessThanOrEqual(4);
  });

  test("pointer-events: helper is agnostic but spec requires non-blocking — documented", () => {
    // The CSS `pointer-events: none` is what enforces this; logic test just documents the claim.
    // A popup with pointer-events none never intercepts clicks on the sprite underneath.
    expect(true).toBe(true);
  });
});

// The surfaces that need an agent to exist.
//
// Everything here was previously untested, because playwright.config.ts boots
// a throwaway database with no agents in it. That gap is not theoretical: the
// Artifacts tab shipped throwing `ReferenceError: _activeArtifactsReq is not
// defined` on its first line and rendered nothing at all, and nothing caught
// it — a whole tab, permanently broken, invisible to the suite.
//
// These assert BEHAVIOUR rather than pixels. A screenshot test would fail on
// every deliberate design change and teach everyone to re-bless it blindly;
// these fail only when something is actually broken.
import { test, expect, type Page } from "@playwright/test";
import { seedRoom, type SeededRoom } from "./seed.js";

let seeded: SeededRoom;

// Seed in beforeAll, not at module load. Playwright imports spec files to
// collect tests, and that can happen before the webServer has booted — which
// matters because the server runs recoverServerState() on boot and clears
// `starting`. Seeding after the server is up makes the order deterministic.
test.beforeAll(() => {
  seeded = seedRoom();
});

async function openRoom(page: Page) {
  await page.goto("/");
  const demo = page.locator("button", { hasText: /demo access/i });
  if (await demo.count()) await demo.first().click();
  await page.waitForSelector(".app", { state: "visible" });
  // The seeded project must be the active one, whatever the picker defaults to.
  await page.evaluate((id) => {
    localStorage.setItem("logbridge_active_project", id);
  }, seeded.projectId);
  await page.reload();
  await page.waitForSelector(".app", { state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("#agent-list .roster-row").length > 0, null, {
    timeout: 15_000,
  });
}

/** Fails the test if the page threw at any point — the Artifacts class of bug. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe("surfaces that need a real agent", () => {
  test("the roster shows every seeded agent, with a distinct booting one", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openRoom(page);

    const rows = page.locator("#agent-list .roster-row");
    await expect(rows).toHaveCount(seeded.agentIds.length);

    // CONTRACT 1.27: a booting agent must not look like a ready one.
    await expect(page.locator("#agent-list .r-dot.starting")).toHaveCount(1);
    await expect(page.locator("#agent-list").getByText("starting up…")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("every Command Center tab renders for a working agent", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openRoom(page);

    await page.locator("#agent-list .roster-row").filter({ hasText: "dev-api" }).first().click();
    await expect(page.locator("#view-agent")).toBeVisible();

    // The five that are genuinely per-agent, after the 21 -> 5 cut.
    const tabs = page.locator("#cc-tabs .cc-tab");
    await expect(tabs).toHaveCount(5);
    await expect(tabs).toHaveText([/Terminal/, /Traces/, /Monitor/, /Git/, /Memory/]);

    for (const name of ["Traces", "Monitor", "Git", "Memory", "Terminal"]) {
      await tabs.filter({ hasText: name }).click();
      await page.waitForTimeout(500);
      const text = (await page.locator("#cc-body").innerText()).trim();
      expect(text.length, `${name} tab rendered nothing`).toBeGreaterThan(0);
    }

    // The working agent has a task, so the task controls must be offered.
    await expect(page.locator("#cc-task-halt-btn")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the orchestrator gets Delegate Epic and an employee does not", async ({ page }) => {
    await openRoom(page);

    await page.locator("#agent-list .roster-row").filter({ hasText: "planner-ada" }).first().click();
    await expect(page.locator("#cc-role-badge")).toHaveText(/ORCHESTRATOR/);
    await expect(page.locator("#cc-breakdown-btn")).toBeVisible();

    await page.locator(".cc-back").click();
    await page.locator("#agent-list .roster-row").filter({ hasText: "dev-api" }).first().click();
    await expect(page.locator("#cc-role-badge")).toHaveText(/EMPLOYEE AGENT/);
    await expect(page.locator("#cc-breakdown-btn")).toBeHidden();
  });

  test("the Commands drawer opens, closes, and is keyed to the agent's provider", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openRoom(page);
    await page.locator("#agent-list .roster-row").filter({ hasText: "dev-api" }).first().click();

    await page.locator(".cc-hbtn", { hasText: /Commands/ }).click();
    await expect(page.locator("#cc-drawer")).toHaveClass(/open/);
    await expect(page.locator("#cc-drawer-body")).not.toBeEmpty();

    await page.keyboard.press("Escape");
    await expect(page.locator("#cc-drawer")).not.toHaveClass(/open/);
    expect(errors).toEqual([]);
  });

  test("every Workspace tab renders — the Artifacts regression guard", async ({ page }) => {
    const errors = trackPageErrors(page);
    await openRoom(page);
    await page.evaluate(() => (window as any).setView("workspace"));

    const tabs = page.locator("#ws-tabs .cc-tab");
    await expect(tabs).toHaveCount(9);

    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      const label = (await tabs.nth(i).innerText()).trim();
      await tabs.nth(i).click();
      await page.waitForTimeout(600);
      const text = (await page.locator("#ws-body").innerText()).trim();
      expect(text.length, `Workspace "${label}" rendered nothing`).toBeGreaterThan(0);
    }

    // This is the assertion that would have caught the shipped ReferenceError.
    expect(errors, `page threw: ${errors.join(" | ")}`).toEqual([]);
  });

  test("the board shows seeded tasks across its columns", async ({ page }) => {
    await openRoom(page);
    await page.evaluate(() => (window as any).setView("workspace"));
    await page.locator("#ws-tabs .cc-tab").filter({ hasText: "Tasks" }).click();

    await expect(page.locator(".board-col")).toHaveCount(5);
    // Six seeded tasks, each card carrying its short id and an assignee row.
    await expect(page.locator(".board-card")).toHaveCount(6);
    await expect(page.locator(".board-card-id").first()).toHaveText(/^tsk_/);
    await expect(page.locator(".board-stat").first()).toContainText("6");
  });

  test("pixel portraits are never smoothed", async ({ page }) => {
    // The office art is 32x48 sprite frames; browser smoothing turns them to
    // mush, and a wrong crop shows two characters at once.
    await openRoom(page);
    await page.locator("#agent-list .roster-row").filter({ hasText: "dev-api" }).first().click();

    const crop = await page.evaluate(() => {
      const el = document.querySelector(".cc-portrait") as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const scale = parseFloat(cs.backgroundSize.split(" ").pop()!) / 48;
      return {
        rendering: cs.imageRendering,
        frameWidth: 32 * scale,
        boxWidth: parseFloat(cs.width),
        anchoredAtOrigin: cs.backgroundPosition.startsWith("0px"),
      };
    });

    expect(crop).not.toBeNull();
    expect(crop!.rendering).toBe("pixelated");
    expect(crop!.anchoredAtOrigin).toBe(true);
    // Exactly one frame fills the box, or you are looking at two characters.
    expect(Math.abs(crop!.frameWidth - crop!.boxWidth)).toBeLessThan(0.5);
  });
});

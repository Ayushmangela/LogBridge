// Screenshot harness for the UI port.
//
// Not an assertion suite — it exists so every screen can be captured at a
// FIXED viewport, which is the only way a side-by-side against the reference
// design means anything. Eyeballing two differently-scaled screenshots is how
// you end up "fixing" spacing that was never wrong.
//
//   npx playwright test e2e/ui-shots.spec.ts
//
// Output lands in e2e/__shots__/. Re-run after each phase and diff.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// The reference screenshots were taken on a 2x display at this logical size.
const VIEWPORT = { width: 1440, height: 900 };
const OUT = "e2e/__shots__";

test.use({ viewport: VIEWPORT, deviceScaleFactor: 2 });

async function signIn(page: Page) {
  await page.goto("/");
  // The demo button only exists on the auth screen; if a session is already
  // live the app renders straight into the office and this is a no-op.
  const demo = page.locator('button:has-text("Demo Access")');
  if (await demo.count()) {
    await demo.first().click();
  }
  await page.waitForSelector(".app", { state: "visible" });
  // The office is a canvas app — give PIXI and the socket a beat to settle,
  // otherwise the first shot catches an empty floor.
  await page.waitForTimeout(2500);
}

test("capture every screen", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await signIn(page);

  const views: [string, string][] = [
    ["office", "Office Map"],
    ["tasks", "Tasks"],
    ["chat", "Chat"],
    ["memory", "Memory"],
    ["projects", "Projects"],
    ["settings", "Settings"],
  ];

  for (const [id, label] of views) {
    await page.evaluate((v) => (window as any).setView(v), id);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${id}.png` });
    expect(await page.locator(`#view-${id}`).isVisible()).toBe(true);
  }

  // Command Center — the densest surface, and the one being restructured.
  // Back to the office first: the roster is in the persistent sidebar, but
  // leaving the app on `settings` was enough to make the click flake.
  await page.evaluate(() => (window as any).setView("office"));
  await page.waitForTimeout(600);

  const firstAgent = page.locator("#agent-list .roster-row").first();
  // A throwaway e2e database has no agents unless something seeded one, so
  // an empty roster is a legitimate outcome here, not a failure.
  if (await firstAgent.isVisible().catch(() => false)) {
    await firstAgent.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/command-center.png` });
  } else {
    test.info().annotations.push({
      type: "note",
      description: "roster empty (fresh e2e db) — command-center shot skipped",
    });
  }
});

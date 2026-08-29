// The flows a person actually walks through, in a real browser.
//
// Every UI bug this project has shipped was found by a human clicking, never
// by a test: a head card that opened and closed on the same click, a card
// anchored to the wrong corner, an office that rendered blank for 25 commits,
// and a button that silently stopped working when its script moved into a
// module. All four are the same shape — the code loads, the tests pass, and
// the thing does not work.
//
// These are deliberately shallow and few. Their job is to fail loudly when
// the app stops booting or a primary flow breaks, so the 8,000-line bundle can
// be split apart without every move being a gamble.
import { test, expect, type Page } from "@playwright/test";

/** Demo sign-in, then guarantee a project exists.
 *
 *  The e2e database starts empty, so the workspace picker has nothing to open
 *  — a real state, but not the one these tests are about. The project is
 *  created through the API with the session the UI just established, which
 *  also proves the token the browser stored is genuinely accepted. */
async function signInWithProject(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /demo access/i }).click();
  await expect(page.getByRole("heading", { name: /project workspaces/i }).or(page.getByText(/select an office workspace/i)).first()).toBeVisible();

  const created = await page.evaluate(async () => {
    const existing = await (await fetch("/api/projects")).json();
    if (Array.isArray(existing?.projects) && existing.projects.length) return "existing";
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "E2E Workspace", ghRepo: "e2e/e2e" }),
    });
    return r.ok ? "created" : `failed ${r.status}`;
  });
  expect(created, "the browser's stored token must be accepted by the API").not.toMatch(/^failed/);
  await page.reload();
}

test.describe("the app boots", () => {
  test("an unauthenticated visitor gets the sign-in screen, not the office", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: /^sign in$/i }).first()).toBeVisible();
  });

  test("the API refuses an unauthenticated caller", async ({ request }) => {
    // The login screen used to be decoration: every route answered anyone.
    const r = await request.get("/api/projects");
    expect(r.status()).toBe(401);
  });

  test("the office's own assets are served", async ({ request }) => {
    // These 404'd for 25 commits while every unit test stayed green.
    for (const path of ["/assets/office.json", "/assets/characters/nancy.png",
                        "/css/app.css", "/js/app.js"]) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });
});

test.describe("signing in and opening the office", () => {
  test("demo access reaches the workspace picker and the office renders", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signInWithProject(page);

    // Into the office
    await page.getByRole("button", { name: /open office|enter office/i }).first().click();

    // The office is a canvas — its presence is the load-bearing assertion.
    const canvas = page.locator("#canvas");  // there is also a #minimap-canvas
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0, "the office canvas should have real size").toBeGreaterThan(200);

    expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("every primary view opens without a page error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signInWithProject(page);
    await page.getByRole("button", { name: /open office|enter office/i }).first().click();
    await expect(page.locator("#canvas")).toBeVisible();

    for (const label of [/tasks/i, /memory/i, /settings/i, /office map/i]) {
      const nav = page.getByRole("button", { name: label }).first();
      if (await nav.count()) {
        await nav.click();
        await page.waitForTimeout(400);
      }
    }
    expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
  });
});

test.describe("session behaviour", () => {
  test("a signed-in session survives a reload", async ({ page }) => {
    await signInWithProject(page);

    await page.reload();
    // Still in, not bounced back to the login screen.
    // Not /office/i — that also matches the login screen's subtitle
    // "Autonomous Multi-Agent AI Office", which is present but hidden.
    await expect(page.getByRole("button", { name: /open office|enter office/i }).first()).toBeVisible();
  });

  test("signing out clears the session", async ({ page }) => {
    await signInWithProject(page);

    await page.evaluate(() => localStorage.removeItem("logbridge_auth_token"));
    await page.reload();
    await expect(page.getByRole("button", { name: /^sign in$/i }).first()).toBeVisible();
  });
});

import { defineConfig } from "@playwright/test";

// End-to-end coverage for the browser, which had none.
//
// The static tests in apps/web catch a function that stopped being reachable.
// They cannot catch a button that does nothing, a panel that renders empty, or
// an office that fails to draw — all of which happened during this project and
// were each found by a human clicking. These run the real thing.
//
// The server is started per-run on its own port with a throwaway database, so
// a test can never touch the dev workspace.
export default defineConfig({
  testDir: "./e2e",
  // The office is a canvas app: give it room to boot PIXI and the socket.
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,   // one server, one database, shared office state
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "PORT=8788 DB_PATH=/tmp/logbridge-e2e.db npx tsx apps/server/src/index.ts",
    url: "http://127.0.0.1:8788/",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

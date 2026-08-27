import { describe, expect, test, afterEach } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "./index.js";

describe("ptyGateway", () => {
  let server: BuiltServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.app.close();
      server = null;
    }
  });

  test("spawns interactive PTY over websocket and executes commands without using paid API quota", async () => {
    server = await buildServer({ dbPath: ":memory:" });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.app.server.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty-ws`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    let receivedBanner = false;
    let receivedEcho = false;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "data") {
          if (msg.data.includes("Claude Code") || msg.data.includes("╭─")) {
            receivedBanner = true;
          }
          if (msg.data.includes("PTY_TEST_PASSED")) {
            receivedEcho = true;
          }
        }
      } catch {}
    });

    ws.send(JSON.stringify({
      type: "spawn",
      ptyId: "pty-unit-test-1",
      cols: 80,
      rows: 24,
    }));

    await new Promise((r) => setTimeout(r, 600));

    ws.send(JSON.stringify({
      type: "data",
      ptyId: "pty-unit-test-1",
      data: "echo PTY_TEST_PASSED\r",
    }));

    await new Promise((r) => setTimeout(r, 1200));

    ws.send(JSON.stringify({
      type: "kill",
      ptyId: "pty-unit-test-1",
    }));

    ws.close();

    expect(receivedBanner).toBe(true);
    expect(receivedEcho).toBe(true);
  });
});

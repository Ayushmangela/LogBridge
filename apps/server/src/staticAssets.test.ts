// The office is a canvas fed by files on disk: a tile map and sprite sheets in
// the repo-root `assets/`, plus the browser bundle in `apps/web`. None of that
// is exercised by any other test, which is how the modularisation refactor
// (e88495e) deleted the `/assets/` registration and left the entire office
// blank — no floor, no characters — while all 292 server tests stayed green.
//
// These are smoke tests, deliberately shallow. They only assert that the
// routes resolve, because "the server forgot how to serve its own frontend"
// is the failure that actually happened.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "./index.js";

let server: BuiltServer;
let base: string;

beforeAll(async () => {
  server = await buildServer({ dbPath: ":memory:" });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => { await server.app.close(); });

describe("the browser can actually load", () => {
  test("index.html is served at the root", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    // It must still reference its extracted bundle rather than inlining
    // everything again — that regression is silent and only shows up as a
    // 10,000-line file months later.
    expect(html).toContain("/js/app.js");
    expect(html).toContain("/css/app.css");
  });

  test("the extracted css and js are reachable", async () => {
    for (const path of ["/css/app.css", "/js/app.js"]) {
      const r = await fetch(base + path);
      expect(r.status, `${path} must be served`).toBe(200);
    }
  });
});

describe("the office's own assets are served", () => {
  test("the tile map resolves", async () => {
    const r = await fetch(`${base}/assets/office.json`);
    expect(r.status, "/assets/office.json — without this the office is blank").toBe(200);
    const map = (await r.json()) as any;
    expect(Array.isArray(map.layers), "office.json should parse as a tile map").toBe(true);
  });

  test("a character sprite sheet resolves", async () => {
    const r = await fetch(`${base}/assets/characters/nancy.png`);
    expect(r.status, "sprite sheets live in the repo-root assets/, not apps/web").toBe(200);
  });

  test("a path outside the asset roots is not served", async () => {
    // The static roots must not become a way to read the repo.
    const r = await fetch(`${base}/assets/../../package.json`);
    expect([400, 403, 404]).toContain(r.status);
  });
});

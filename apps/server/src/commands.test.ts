// The Command Center's catalog. Static data, but data the UI is not allowed
// to invent — so the shape and the honesty rules are tested rather than
// assumed.
import { describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer, type BuiltServer } from "./index.js";
import { CATALOGS, catalogFor } from "./commands.js";

describe("the catalog", () => {
  test("covers only providers we actually documented", () => {
    // A provider with no catalog must show nothing rather than Claude's
    // commands under its own name — that would be confidently wrong.
    expect(CATALOGS.map((c) => c.providerId)).toEqual(["claude"]);
    expect(catalogFor("opencode")).toBeNull();
    expect(catalogFor("pi")).toBeNull();
    expect(catalogFor(null)).toBeNull();
    expect(catalogFor("claude")?.label).toBe("Claude Code");
  });

  test("has the session and memory groups the design calls for", () => {
    const c = catalogFor("claude")!;
    expect(c.groups.map((g) => g.title)).toEqual(["Session", "Context & memory"]);
    const names = c.groups.flatMap((g) => g.commands.map((x) => x.name));
    for (const want of ["/clear", "/resume", "/rewind", "/compact",
                        "claude -c", "claude -r", "claude --fork-session",
                        "/context", "/memory", "/init", "#"]) {
      expect(names, `${want} missing`).toContain(want);
    }
  });

  test("every entry is typed as slash or cli, and typed correctly", () => {
    // The note tells people slash commands run IN a session and cli ones in a
    // shell. Mislabelling one sends them to an error.
    for (const g of catalogFor("claude")!.groups) {
      for (const c of g.commands) {
        expect(["slash", "cli"]).toContain(c.kind);
        if (c.kind === "slash") expect(c.name.startsWith("/") || c.name === "#").toBe(true);
        if (c.kind === "cli") expect(c.name.startsWith("claude")).toBe(true);
      }
    }
  });

  test("every entry has a description, and examples are real usage", () => {
    for (const g of catalogFor("claude")!.groups) {
      for (const c of g.commands) {
        expect(c.description.length, `${c.name} needs a description`).toBeGreaterThan(15);
        // An example that doesn't start with the command it illustrates is
        // worse than none.
        if (c.example) expect(c.example.startsWith(c.name.split(" ")[0])).toBe(true);
      }
    }
  });

  test("--fork-session is described as the modifier it actually is", () => {
    // `claude --help`: "When resuming, create a new session ID (with
    // --resume or --continue)". The design shows it standalone; running it
    // that way does nothing useful.
    const fork = catalogFor("claude")!.groups
      .flatMap((g) => g.commands).find((c) => c.name.includes("fork-session"))!;
    expect(fork.description.toLowerCase()).toMatch(/with -r or -c|resum|continu/);
    expect(fork.example).toBe("claude -c --fork-session");
  });
});

describe("GET /api/commands", () => {
  let server: BuiltServer;
  let baseUrl: string;

  test("serves the catalog, cacheable, without touching the workspace view", async () => {
    server = await buildServer({ dbPath: ":memory:" });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;

    const res = await fetch(`${baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    // Static for the life of the process: it must not be re-fetched on every
    // render, and it must not be riding the per-position view broadcast.
    expect(res.headers.get("cache-control")).toMatch(/max-age/);

    const body = (await res.json()) as { catalogs: typeof CATALOGS };
    expect(body.catalogs).toHaveLength(1);
    expect(body.catalogs[0].providerId).toBe("claude");
    expect(body.catalogs[0].groups[0].commands.length).toBeGreaterThan(3);

    await server.app.close();
  }, 20_000);
});

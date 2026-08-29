// Phase 2: Roster projection (fleet.json) and sole-scribe guard tests.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveManager, isGodOwnedFile, deriveFleet, GOD_OWNED_FILES } from "./hive.js";

describe("Phase 2: Roster & Sole-Scribe Guard", () => {
  let tmpRoot: string;
  let hive: HiveManager;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "logbridge-roster-test-"));
    hive = new HiveManager(tmpRoot);
  });

  afterEach(() => {
    hive.stopRouter();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  describe("Problem 1: fleet.json is a derived projection of registry.json", () => {
    test("fleet.json is automatically generated on hive init and matches registry", () => {
      const fleetPath = join(tmpRoot, "fleet.json");
      expect(existsSync(fleetPath)).toBe(true);

      const fleet = JSON.parse(readFileSync(fleetPath, "utf8"));
      expect(fleet.version).toBe(1);
      expect(Array.isArray(fleet.agents)).toBe(true);
    });

    test("registering an agent immediately projects into fleet.json without drift", () => {
      hive.registerAgent({
        id: "agt_worker_1",
        name: "worker1",
        role: "Developer",
        provider: "opencode",
      });

      const fleetPath = join(tmpRoot, "fleet.json");
      const fleet = JSON.parse(readFileSync(fleetPath, "utf8"));
      const found = fleet.agents.find((a: any) => a.id === "agt_worker_1");

      expect(found).toBeDefined();
      expect(found.name).toBe("worker1");
      expect(found.role).toBe("Developer");
    });
  });

  describe("Problem 2: Sole-scribe rule enforcement", () => {
    test("isGodOwnedFile correctly recognizes all god-owned filenames and relative paths", () => {
      for (const file of GOD_OWNED_FILES) {
        expect(isGodOwnedFile(file)).toBe(true);
        expect(isGodOwnedFile(`./${file}`)).toBe(true);
        expect(isGodOwnedFile(`hive/${file}`)).toBe(true);
        expect(isGodOwnedFile(`/tmp/project/hive/${file}`)).toBe(true);
      }
      expect(isGodOwnedFile("app.ts")).toBe(false);
      expect(isGodOwnedFile("src/index.html")).toBe(false);
      expect(isGodOwnedFile("memory.md")).toBe(false);
    });

    test("god agent can write board.md", () => {
      hive.registerAgent({ id: "agt_god", name: "God Commander", role: "Commander", isGod: true });
      expect(() => {
        hive.setBoard("# Master Blueprint by God", "agt_god");
      }).not.toThrow();
      expect(hive.getBoard()).toContain("Master Blueprint by God");
    });

    test("human operator / user can write board.md", () => {
      expect(() => {
        hive.setBoard("# Blueprint by Human", "user");
      }).not.toThrow();
      expect(hive.getBoard()).toContain("Blueprint by Human");
    });

    test("non-god worker agent is refused when writing board.md directly via setBoard", () => {
      hive.registerAgent({ id: "agt_god", name: "Commander", role: "Commander", isGod: true });
      hive.registerAgent({ id: "agt_worker", name: "Worker", role: "Developer" });

      expect(() => {
        hive.setBoard("# Overwrite by worker", "agt_worker");
      }).toThrow(/Sole scribe violation/);
    });

    test("router intercepts outbox write to god-owned files from non-god agent and returns refusal", () => {
      hive.registerAgent({ id: "agt_god", name: "Commander", role: "Commander", isGod: true });
      hive.registerAgent({ id: "agt_worker", name: "Worker", role: "Developer" });

      // Worker tries to send a message writing board.md directly
      const workerDir = hive.agentDir("agt_worker");
      const maliciousMsg = {
        id: "msg_bad_write_1",
        from: "agt_worker",
        to: "broadcast",
        act: "request",
        subject: "Direct write to board.md",
        body: "Overwriting blackboard",
        target_file: "board.md",
        created_at: new Date().toISOString(),
      };

      writeFileSync(
        join(workerDir, "outbox", "msg_bad_write_1.json"),
        JSON.stringify(maliciousMsg, null, 2),
        "utf8"
      );

      let refusalEventDelivered = false;
      const routed = hive.routeOnce();
      expect(routed).toBeGreaterThanOrEqual(1);

      // Outbox drained
      expect(hive.getAgentMessages("agt_worker").outbox).toHaveLength(0);

      // Refusal landed in worker's inbox
      const inbox = hive.getAgentMessages("agt_worker").inbox;
      const refusalMsg = inbox.find((m) => m.act === "refuse");
      expect(refusalMsg).toBeDefined();
      expect(refusalMsg?.from).toBe("agt_god");
      expect(refusalMsg?.body).toContain("Sole scribe violation");
      expect(refusalMsg?.body).toContain("Message god");
    });
  });
});

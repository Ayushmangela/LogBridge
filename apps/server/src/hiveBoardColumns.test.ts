// One vocabulary for the hive board.
//
// There were three, and they disagreed:
//   commander prompt : todo · in_progress · done
//   employee prompt  : todo · doing · blocked · done
//   board UI         : todo · in_progress · in_review · done
//
// An employee told to write `doing` produced a card that rendered in NO
// column. `blocked` existed only in the employee's vocabulary; `in_review`
// only in the UI's. Nothing failed loudly — the card simply vanished.
//
// Both prompts are now generated from HIVE_TASK_COLUMNS. apps/web has no
// build step and cannot import from packages/protocol, so the browser's
// copy is checked here instead of being allowed to drift.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HIVE_TASK_COLUMNS } from "@logbridge/protocol";
import { buildCommanderHivePrompt, buildEmployeeHivePrompt } from "./hivePrompt.js";

const WEB_APP_JS = join(process.cwd(), "..", "web", "js", "app.js");

describe("hive board columns are defined once", () => {
  test("both prompts teach exactly the canonical columns", () => {
    const commander = buildCommanderHivePrompt({ commanderName: "cmd", folder: "/tmp/p" });
    const employee = buildEmployeeHivePrompt({
      agentId: "agt_x", agentName: "dev", folder: "/tmp/p", role: "developer",
    });

    for (const col of HIVE_TASK_COLUMNS) {
      expect(commander, `commander prompt is missing "${col}"`).toContain(col);
      expect(employee, `employee prompt is missing "${col}"`).toContain(col);
    }
  });

  test("neither prompt still teaches the old, unrenderable values", () => {
    const both =
      buildCommanderHivePrompt({ commanderName: "cmd", folder: "/tmp/p" }) +
      buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p" });

    // `doing` and `blocked` were only ever in the employee prompt, and the
    // board could render neither.
    expect(both).not.toMatch(/\bdoing\b/);
    expect(both).not.toMatch(/todo\/doing/);
  });

  test("the browser's board renders the same columns", () => {
    // The hive kanban in app.js declares its own colDefs. If someone edits
    // that list without touching HIVE_TASK_COLUMNS, agents write a status the
    // board cannot show — which is exactly how this diverged the first time.
    const src = readFileSync(WEB_APP_JS, "utf8");
    const block = src.slice(src.indexOf("const colDefs"));
    const keys = [...block.slice(0, 400).matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);

    expect(keys.length, "could not find the hive board colDefs in app.js").toBeGreaterThan(0);
    expect(keys).toEqual([...HIVE_TASK_COLUMNS]);
  });
});

describe("the prompts no longer contradict the execution model", () => {
  test("the commander is not told to continually monitor", () => {
    // `claude -p` runs one turn and exits. "Continually monitor the hive"
    // asked a one-shot process to run a loop: it either faked one and burned
    // tokens, or silently skipped the instruction. Monitoring is the router's
    // job, and the router already does it.
    const p = buildCommanderHivePrompt({ commanderName: "cmd", folder: "/tmp/p" });
    expect(p).not.toMatch(/continually monitor/i);
    expect(p).toMatch(/you will be woken/i);
  });

  test("employees are not given routing instructions they cannot act on", () => {
    // Every employee — including a review agent — used to be told to "prefer
    // an agent with a LOW ctx for a big task ... when routing". Employees do
    // not route.
    const p = buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p", role: "review" });
    expect(p).not.toMatch(/when routing/i);
    expect(p).not.toMatch(/LIVE ROSTER/i);
  });

  test("both prompts state the one-shot execution model up front", () => {
    for (const p of [
      buildCommanderHivePrompt({ commanderName: "c", folder: "/tmp/p" }),
      buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p" }),
    ]) {
      expect(p).toMatch(/one-shot process/i);
      expect(p).toMatch(/nothing persists between runs/i);
    }
  });

  test("a role is described, not just named", () => {
    const review = buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p", role: "review" });
    const dev = buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p", role: "developer" });
    // A reviewer must be told not to rewrite the code; a developer must not.
    expect(review).toMatch(/do NOT rewrite the code/i);
    expect(dev).not.toMatch(/do NOT rewrite the code/i);
    // An unknown role still gets something usable rather than "specialist".
    const odd = buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p", role: "brand-strategist" });
    expect(odd).toMatch(/brand-strategist/);
  });
});

describe("prompt cost and portability", () => {
  test("paths are env vars, not absolute paths repeated a dozen times", () => {
    const folder = "/Users/someone/very/long/project/path/that/goes/on";
    const p = buildEmployeeHivePrompt({ agentId: "agt_123", agentName: "n", folder, role: "developer" });

    // The old prompt interpolated the absolute agent dir 3+ times while
    // exporting AGENT_DIR and never using it.
    expect(p).toContain("$AGENT_DIR");
    expect(p.split(folder).length - 1).toBe(0);
  });

  test("prompts stay small enough not to dominate a turn", () => {
    const commander = buildCommanderHivePrompt({ commanderName: "cmd", folder: "/tmp/p" });
    const employee = buildEmployeeHivePrompt({ agentId: "a", agentName: "n", folder: "/tmp/p" });
    // Rough guard, not a style rule: these are re-sent on every cold start.
    expect(commander.length).toBeLessThan(3200);
    expect(employee.length).toBeLessThan(2400);
  });
});

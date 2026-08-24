// The plan parser reads whatever a real CLI said and finds a task list in it.
// The bare-JSON case is VERIFIED against a real `claude` run
// (test-support/claude-plan.sample.txt); the rest are defensive, because
// models are not consistent between runs and a silently empty plan is the
// worst outcome — it looks like the feature ran and did nothing.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePlan, planPrompt } from "./plan.js";

const real = () =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "test-support", "claude-plan.sample.txt"),
    "utf8"
  );

describe("parsePlan against the REAL captured output", () => {
  test("extracts every task, with capabilities where the model gave one", () => {
    const tasks = parsePlan(real());
    expect(tasks).toHaveLength(6);
    expect(tasks[0]).toEqual({
      title: "Choose rate limiting algorithm and storage backend",
      capability: null, // the model really did answer null here
    });
    expect(tasks.map((t) => t.capability)).toEqual([null, "backend", "backend", "backend", "test", "docs"]);
  });
});

describe("shapes a model might return instead", () => {
  test("a fenced json block", () => {
    const t = parsePlan('Here is the plan:\n```json\n[{"title":"Do a thing"}]\n```\nHope that helps!');
    expect(t).toEqual([{ title: "Do a thing", capability: null }]);
  });

  test("prose wrapped around a bare array", () => {
    const t = parsePlan('Sure! [{"title":"Ship it","capability":"backend"}] Let me know.');
    expect(t).toEqual([{ title: "Ship it", capability: "backend" }]);
  });

  test("an object wrapping the array", () => {
    expect(parsePlan('{"tasks":[{"title":"Wrapped"}]}')).toEqual([{ title: "Wrapped", capability: null }]);
  });

  test("synonym keys rather than dropping the whole plan", () => {
    expect(parsePlan('[{"task":"From task key"},{"name":"From name key"}]').map((t) => t.title))
      .toEqual(["From task key", "From name key"]);
  });

  test("a markdown list when there is no JSON at all", () => {
    const t = parsePlan("1. First thing\n2. Second thing\n- Third thing");
    expect(t.map((x) => x.title)).toEqual(["First thing", "Second thing", "Third thing"]);
    // No capabilities available this way — the task still routes, just to anyone.
    expect(t.every((x) => x.capability === null)).toBe(true);
  });
});

describe("refusing to produce nonsense", () => {
  test("empty or unusable output is an empty plan, never a fake one", () => {
    for (const junk of ["", "   ", "I'm not sure how to break that down.", "{}", "null", "[]"]) {
      expect(parsePlan(junk), JSON.stringify(junk)).toEqual([]);
    }
  });

  test("a runaway plan is capped", () => {
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ title: `task ${i}` })));
    expect(parsePlan(many).length).toBeLessThanOrEqual(12);
  });

  test("a model repeating itself is not several tasks", () => {
    const dupes = '[{"title":"Same thing"},{"title":"same thing"},{"title":"Same thing"}]';
    expect(parsePlan(dupes)).toHaveLength(1);
  });

  test("blank titles are dropped, not turned into empty tasks", () => {
    expect(parsePlan('[{"title":""},{"title":"   "},{"title":"Real one"}]').map((t) => t.title))
      .toEqual(["Real one"]);
  });

  test("a very long title is truncated rather than flooding the board", () => {
    const t = parsePlan(JSON.stringify([{ title: "x".repeat(500) }]));
    expect(t[0].title.length).toBeLessThanOrEqual(140);
  });

  test('the string "null" is not a capability', () => {
    expect(parsePlan('[{"title":"T","capability":"null"}]')[0].capability).toBeNull();
    expect(parsePlan('[{"title":"T","capability":"  "}]')[0].capability).toBeNull();
  });

  test("capabilities are normalised so they can match an agent's", () => {
    expect(parsePlan('[{"title":"T","capability":"Run Tests"}]')[0].capability).toBe("run_tests");
  });

  test("malformed input never throws", () => {
    for (const junk of ["[", '{"tasks":', "```json\n[oops\n```", " "]) {
      expect(() => parsePlan(junk)).not.toThrow();
    }
  });
});

describe("planPrompt", () => {
  test("carries the goal and demands a machine-readable answer", () => {
    const p = planPrompt("add rate limiting");
    expect(p).toContain("add rate limiting");
    expect(p).toContain("ONLY a JSON array");
    expect(p).toContain("capability");
  });
});

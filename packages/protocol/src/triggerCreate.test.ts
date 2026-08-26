// TriggerCreate has to accept the payload a person would actually write.
//
// Every field past the four essentials was `.nullable()` without `.optional()`,
// which in Zod means "you must send it, and null is an allowed value". Omitting
// `tz` — the natural way to say "use the server's own zone" — was a 400. The
// browser sends all ten so nothing was visibly broken, but the first script or
// CLI to post one would have hit it immediately.
import { describe, expect, test } from "vitest";
import { TriggerCreate } from "./triggers.js";

const essentials = {
  projectId: "prj_a",
  name: "morning triage",
  kind: "schedule" as const,
  rule: "every weekday at 09:00",
};

describe("TriggerCreate", () => {
  test("accepts just the four fields a trigger genuinely needs", () => {
    const r = TriggerCreate.safeParse(essentials);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues[0])).toBe(true);
    if (r.success) {
      // The omitted ones arrive as explicit nulls, so the server's insert path
      // sees one shape whether or not the caller bothered.
      expect(r.data.tz).toBeNull();
      expect(r.data.taskTitle).toBeNull();
      expect(r.data.budgetSeconds).toBeNull();
    }
  });

  test("still accepts the fully-specified payload the browser sends", () => {
    // Backward compatibility is the point of widening rather than replacing:
    // explicit nulls must keep validating exactly as they did.
    const r = TriggerCreate.safeParse({
      ...essentials, taskTitle: "Triage CI", taskSpec: null, taskCapability: null,
      budgetSeconds: null, budgetUsd: null, tz: "UTC",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tz).toBe("UTC");
  });

  test("still rejects what was always wrong", () => {
    expect(TriggerCreate.safeParse({ ...essentials, kind: "whenever" }).success).toBe(false);
    expect(TriggerCreate.safeParse({ name: "no project" }).success).toBe(false);
    // A budget of zero seconds is not "unset" — it is a task that cannot run.
    expect(TriggerCreate.safeParse({ ...essentials, budgetSeconds: 0 }).success).toBe(false);
    expect(TriggerCreate.safeParse({ ...essentials, taskTitle: 42 }).success).toBe(false);
  });
});

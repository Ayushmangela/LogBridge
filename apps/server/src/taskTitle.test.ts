import { describe, expect, test } from "vitest";
import { taskTitleFrom } from "./gateway.js";

/**
 * "@commander can you make a website" put "can you make a website" on the
 * board as a task title. That is how a person asks a colleague for something,
 * not what the work is called.
 *
 * Only leading politeness is stripped. The agent is still sent the original
 * sentence verbatim as the task spec, so nothing about what actually runs
 * depends on any of this — it is presentation.
 */
describe("turning what a human said into a task title", () => {
  test.each([
    ["can you make a website", "Make a website"],
    ["Can you please make a website", "Make a website"],
    ["could you fix the login bug", "Fix the login bug"],
    ["would you add dark mode", "Add dark mode"],
    ["can we ship the landing page", "Ship the landing page"],
    ["please update the readme", "Update the readme"],
    ["pls update the readme", "Update the readme"],
    ["hey, deploy the site", "Deploy the site"],
    ["i want you to refactor the parser", "Refactor the parser"],
    ["i need to see the test output", "See the test output"],
    ["let's rewrite the router", "Rewrite the router"],
  ])("%j becomes %j", (input, expected) => {
    expect(taskTitleFrom(input)).toBe(expected);
  });

  test("a plain instruction is only capitalised", () => {
    expect(taskTitleFrom("build the checkout flow")).toBe("Build the checkout flow");
  });

  test("a question keeps its wording — the agent answers it", () => {
    expect(taskTitleFrom("what is the status of the migration?")).toBe(
      "What is the status of the migration?"
    );
  });

  test("words that merely start like politeness are left alone", () => {
    // "can" here is the verb, not a request.
    expect(taskTitleFrom("cancel the pending deploy")).toBe("Cancel the pending deploy");
    expect(taskTitleFrom("willow theme needs a fix")).toBe("Willow theme needs a fix");
    expect(taskTitleFrom("please_do_not_split this identifier")).toBe(
      "Please_do_not_split this identifier"
    );
  });

  test("stripping never empties the title", () => {
    expect(taskTitleFrom("can you")).toBe("Can you");
    expect(taskTitleFrom("please")).toBe("Please");
  });

  test("multi-line instructions keep their body", () => {
    expect(taskTitleFrom("can you fix this:\nline two")).toBe("Fix this:\nline two");
  });
});

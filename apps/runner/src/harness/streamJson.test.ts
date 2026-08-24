// Parses the REAL output of a real `claude --output-format stream-json` run
// (test-support/claude-stream-json.sample.jsonl, captured from claude
// 2.1.241) rather than a fixture written to match the code.
//
// This file exists because the first version of emitLine() guessed the shape
// and got two of three cases wrong — text is nested at message.content[].text,
// and tool calls are content blocks, not top-level fields. A test built from
// an invented fixture would have passed happily against the wrong parser.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emitLine } from "./ptyHarness.js";
import { AsyncEventQueue } from "./asyncQueue.js";
import type { AgentEvent } from "./types.js";

const SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "test-support", "claude-stream-json.sample.jsonl"
);

const sampleLines = () => readFileSync(SAMPLE, "utf8").trim().split("\n").filter(Boolean);
const parsedSample = () => sampleLines().map((l) => JSON.parse(l));

/** Run lines through the real parser and collect what it emits. */
function parse(lines: string[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  const q = new AsyncEventQueue<AgentEvent>();
  // AsyncEventQueue buffers when nothing is awaiting, so drain it after.
  for (const l of lines) emitLine(q, l);
  q.close();
  const buffered = (q as any).buffer as AgentEvent[];
  out.push(...buffered);
  return out;
}

describe("the captured sample is genuine CLI output", () => {
  test("has the three line types a real run produces", () => {
    const types = parsedSample().map((o) => o.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  test("text really is nested in message.content[], not top-level", () => {
    const assistant = parsedSample().find((o) => o.type === "assistant");
    expect(Array.isArray(assistant.message.content)).toBe(true);
    expect(assistant.message.content[0]).toHaveProperty("type", "text");
    expect(typeof assistant.message.content[0].text).toBe("string");
    // ...and specifically NOT where the original parser looked. If a future
    // CLI version adds these top-level, this failing is a useful signal.
    expect(assistant.text).toBeUndefined();
    expect(assistant.tool_name).toBeUndefined();
  });

  test("cost is on the result line, which was the one correct original guess", () => {
    const result = parsedSample().find((o) => o.type === "result");
    expect(typeof result.total_cost_usd).toBe("number");
    expect(result).toHaveProperty("is_error");
  });

  test("this capture is the UNAUTHENTICATED run — its limits are explicit", () => {
    // Documents why tool_use handling stays unverified: an unauthenticated
    // run cannot produce a tool call. Re-capture after `claude /login` and
    // this test failing is the signal to verify the tool_use path too.
    const result = parsedSample().find((o) => o.type === "result");
    expect(result.is_error).toBe(true);
    expect(String(result.result)).toMatch(/not logged in/i);
  });
});

describe("emitLine against that real output", () => {
  test("turns the whole sample into the right event sequence", () => {
    const events = parse(sampleLines());

    // system/init produces nothing — it's metadata, not activity
    expect(events.filter((e) => e.kind === "output" && e.text.includes("session_id"))).toHaveLength(0);

    // the assistant's text surfaces as output
    const out = events.find((e) => e.kind === "output");
    expect(out).toBeDefined();
    expect((out as any).text).toMatch(/not logged in/i);

    // the result line yields cost, and an error (because is_error was true)
    expect(events.find((e) => e.kind === "cost")).toMatchObject({ kind: "cost", usd: 0 });
    expect(events.find((e) => e.kind === "error")).toBeDefined();
    // an errored run must NOT also report done:ok — that would let a failed
    // task be recorded as completed
    expect(events.find((e) => e.kind === "done")).toBeUndefined();
  });

  test("a successful result yields done, not error", () => {
    const events = parse([
      JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.0412, result: "all tests pass" }),
    ]);
    expect(events.find((e) => e.kind === "cost")).toMatchObject({ usd: 0.0412 });
    expect(events.find((e) => e.kind === "done")).toMatchObject({ kind: "done", ok: true, summary: "all tests pass" });
    expect(events.find((e) => e.kind === "error")).toBeUndefined();
  });

  test("tool_use content blocks become tool_call events", () => {
    // Shape taken from the documented content-block format, NOT from the
    // capture — an unauthenticated run can't emit one. See the module header.
    const events = parse([
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "text", text: "Reading the config" },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/etc/hosts" } },
        ] },
      }),
    ]);
    expect(events).toEqual([
      { kind: "output", text: "Reading the config" },
      { kind: "tool_call", name: "Read", input: { file_path: "/etc/hosts" } },
    ]);
  });

  test("tool_result blocks are not echoed back as activity", () => {
    const events = parse([
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } }),
    ]);
    expect(events).toEqual([]);
  });

  test("non-JSON and unknown lines are surfaced, never silently dropped", () => {
    expect(parse(["warning: something happened"])).toEqual([
      { kind: "output", text: "warning: something happened" },
    ]);
    const unknown = JSON.stringify({ type: "some_future_type", detail: "x" });
    expect(parse([unknown])).toEqual([{ kind: "output", text: unknown }]);
  });

  test("empty assistant text is not emitted as a blank line", () => {
    expect(parse([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } })])).toEqual([]);
  });

  test("a malformed assistant message does not throw", () => {
    expect(() => parse([JSON.stringify({ type: "assistant" })])).not.toThrow();
    expect(() => parse([JSON.stringify({ type: "assistant", message: { content: "not-an-array" } })])).not.toThrow();
    expect(() => parse([JSON.stringify({ type: "assistant", message: { content: [null, 42] } })])).not.toThrow();
  });
});

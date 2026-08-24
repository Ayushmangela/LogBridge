// Proves the PTY plumbing itself — spawn, stream parsing, kill, interrupt —
// against testScript.mjs standing in for a real CLI. Does NOT validate the
// real claude/codex/gemini CLI's actual flags or output shape; that gap is
// documented in ptyHarness.ts's header and is unverifiable on this box.
import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makePtyHarness } from "./ptyHarness.js";
import type { AgentEvent } from "./types.js";

const TEST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "testScript.mjs");

function harness() {
  return makePtyHarness({
    command: process.execPath,
    buildArgs: (prompt) => [TEST_SCRIPT, "-p", prompt],
  });
}

function tmpCwd() {
  return mkdtempSync(join(tmpdir(), "pty-harness-test-"));
}

async function collect(events: AsyncIterable<AgentEvent>, until: (ev: AgentEvent) => boolean, cap = 100): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (until(ev) || out.length >= cap) break;
  }
  return out;
}

describe("ptyHarness", () => {
  test(
    "streams output/tool_call/cost through to done on a clean exit",
    async () => {
      const cwd = tmpCwd();
      try {
        const handle = harness().spawn({
          cwd,
          prompt: "do the thing",
          allowTools: [],
          denyPaths: [],
          maxSeconds: 30,
          maxUsd: 1,
        });

        const events = await collect(handle.events, (ev) => ev.kind === "done" || ev.kind === "error");

        const output = events.find((ev) => ev.kind === "output" && ev.text.includes("received prompt: do the thing"));
        expect(output).toBeDefined();

        const toolCall = events.find((ev) => ev.kind === "tool_call");
        expect(toolCall).toMatchObject({ kind: "tool_call", name: "Read", input: { path: "test.txt" } });

        const cost = events.find((ev) => ev.kind === "cost");
        expect(cost).toMatchObject({ kind: "cost", usd: 0.0123 });

        expect(events.at(-1)).toMatchObject({ kind: "done", ok: true });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    10_000
  );

  test("kill() lands within ~2s and closes the event stream without a done", async () => {
    const cwd = tmpCwd();
    try {
      const handle = harness().spawn({
        cwd,
        prompt: "do the thing",
        allowTools: [],
        denyPaths: [],
        maxSeconds: 30,
        maxUsd: 1,
      });

      // Wait for the first event so the process is confirmed alive, then kill it.
      const iterator = handle.events[Symbol.asyncIterator]();
      await iterator.next();
      handle.kill();

      const rest: AgentEvent[] = [];
      const started = Date.now();
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        rest.push(value);
      }
      expect(Date.now() - started).toBeLessThan(3000);
      expect(rest.find((ev) => ev.kind === "done")).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("interrupt() sends Ctrl-C, which the CLI observes before exiting", async () => {
    const cwd = tmpCwd();
    try {
      const handle = harness().spawn({
        cwd,
        prompt: "do the thing",
        allowTools: [],
        denyPaths: [],
        maxSeconds: 30,
        maxUsd: 1,
      });

      const iterator = handle.events[Symbol.asyncIterator]();
      await iterator.next(); // the initial "received prompt" line
      handle.interrupt();

      const events = await collect({ [Symbol.asyncIterator]: () => iterator }, (ev) => ev.kind === "done" || ev.kind === "error");
      expect(events.some((ev) => ev.kind === "output" && ev.text.includes("interrupted"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("a command that fails to spawn reports an error event instead of throwing", async () => {
    // On macOS, node-pty spawns via its own spawn-helper binary, which launches
    // successfully even when the target command doesn't exist — the failure
    // surfaces as the helper's own exec failing (an onExit with a non-zero
    // code), not a synchronous throw out of pty.spawn. ptyHarness.ts turns
    // that into an `error` event either way (sync-throw path or exit path);
    // this exercises the exit path, which is what actually fires here.
    const h = makePtyHarness({ command: join(tmpCwd(), "definitely-not-a-real-binary") });
    let handle!: ReturnType<typeof h.spawn>;
    expect(() => {
      handle = h.spawn({
        cwd: tmpCwd(),
        prompt: "x",
        allowTools: [],
        denyPaths: [],
        maxSeconds: 30,
        maxUsd: 1,
      });
    }).not.toThrow();
    const events: AgentEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect((events[0] as { message: string }).message).toContain("exited code=1");
  });
});

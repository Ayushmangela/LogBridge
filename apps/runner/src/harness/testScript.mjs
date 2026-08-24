#!/usr/bin/env node
// Stands in for a real CLI in ptyHarness.test.ts — proves the PTY plumbing
// (spawn, stream, kill, interrupt) genuinely works without needing an
// authenticated `claude`.
//
// It emits the REAL `--output-format stream-json` shape, verified against
// claude 2.1.241 (see test-support/claude-stream-json.sample.jsonl). That
// matters: when this script emitted an invented shape, the tests passed
// against a parser that was wrong about where text and tool calls live.
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";

const emit = (o) => console.log(JSON.stringify(o));
const assistant = (...content) => emit({ type: "assistant", message: { content } });

emit({ type: "system", subtype: "init", session_id: "test-session", cwd: process.cwd() });
assistant({ type: "text", text: `received prompt: ${prompt}` });
assistant({ type: "tool_use", id: "tu_1", name: "Read", input: { path: "test.txt" } });

let n = 0;
const t = setInterval(() => {
  n++;
  assistant({ type: "text", text: `working ${n}` });
  if (n >= 20) {
    clearInterval(t);
    emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123, result: "done" });
    process.exit(0);
  }
}, 300);

process.on("SIGINT", () => {
  assistant({ type: "text", text: "interrupted" });
  process.exit(0);
});

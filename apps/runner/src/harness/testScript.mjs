#!/usr/bin/env node
// Stands in for a real CLI (claude/codex/gemini) in ptyHarness.test.ts —
// proves the PTY plumbing (spawn, stream, kill, interrupt) genuinely works.
// It does NOT validate the real CLI's actual flags/output shape — that's
// the documented gap in ptyHarness.ts's header, unverifiable on this box.
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "";
console.log(JSON.stringify({ text: `received prompt: ${prompt}` }));
console.log(JSON.stringify({ tool_name: "Read", input: { path: "test.txt" } }));

let n = 0;
const t = setInterval(() => {
  n++;
  console.log(JSON.stringify({ text: `working ${n}` }));
  if (n >= 20) {
    clearInterval(t);
    console.log(JSON.stringify({ total_cost_usd: 0.0123 }));
    process.exit(0);
  }
}, 300);

process.on("SIGINT", () => {
  console.log(JSON.stringify({ text: "interrupted" }));
  process.exit(0);
});

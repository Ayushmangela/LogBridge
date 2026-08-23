#!/usr/bin/env node
// The fake agent. SYSTEM.md §3e: prove leases/reconnect/budget-kill with
// this BEFORE wiring in a real harness — debugging a lease bug and an LLM
// bug at the same time is miserable.
//
// Usage: node fakeWorker.mjs --duration <seconds> [--loop-forever]
// Prints one JSON line per second of "progress"; exits 0 when duration
// elapses, or runs until killed if --loop-forever is set.

const args = process.argv.slice(2);
const durationIdx = args.indexOf("--duration");
const duration = durationIdx >= 0 ? Number(args[durationIdx + 1]) : 10;
const loopForever = args.includes("--loop-forever");

let elapsed = 0;
const tick = setInterval(() => {
  elapsed += 1;
  console.log(JSON.stringify({ elapsed, note: `working… ${elapsed}s` }));
  if (!loopForever && elapsed >= duration) {
    clearInterval(tick);
    console.log(JSON.stringify({ done: true }));
    process.exit(0);
  }
}, 1000);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

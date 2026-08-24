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
// --ask-after <sec>: emit a question after N seconds and block on stdin until
// an answer line arrives. Exercises the full mid-task question path (see
// HANDOFF.md prompt 3) without any real model call.
const askAfterIdx = args.indexOf("--ask-after");
const askAfter = askAfterIdx >= 0 ? Number(args[askAfterIdx + 1]) : null;

let elapsed = 0;
let asked = false;

const tick = setInterval(() => {
  elapsed += 1;
  if (askAfterIdx >= 0 && !asked && elapsed >= askAfter) {
    asked = true;
    clearInterval(tick);
    console.log(JSON.stringify({ question: "Deploy to staging before finishing?" }));
    // Blocks until a line arrives — exactly what a waiting agent does.
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const answer = buf.slice(0, nl).trim();
      console.log(JSON.stringify({ note: `answer received: ${answer}` }));
      const tick2 = setInterval(() => {
        elapsed += 1;
        console.log(JSON.stringify({ elapsed, note: `working… ${elapsed}s` }));
        if (!loopForever && elapsed >= duration) {
          clearInterval(tick2);
          console.log(JSON.stringify({ done: true }));
          process.exit(0);
        }
      }, 1000);
    });
    return;
  }
  console.log(JSON.stringify({ elapsed, note: `working… ${elapsed}s` }));
  if (!loopForever && elapsed >= duration) {
    clearInterval(tick);
    console.log(JSON.stringify({ done: true }));
    process.exit(0);
  }
}, 1000);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

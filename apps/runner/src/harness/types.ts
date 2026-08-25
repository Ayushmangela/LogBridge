// The harness boundary. SYSTEM.md §4a: "keep it thin... never let harness
// types leak into the protocol." Two implementations satisfy this:
// fakeHarness (the controllable worker used by the Wi-Fi-drop test) and
// ptyHarness (a real terminal CLI — claude/codex/gemini — spawned via
// node-pty: wrap the CLI the person already has installed and
// authenticated, rather than holding a raw API key).
export interface SpawnOptions {
  cwd: string;
  prompt: string;
  allowTools: string[];
  denyPaths: string[];
  maxSeconds: number;
  maxUsd: number;
}

export type AgentEvent =
  | { kind: "output"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "cost"; usd: number }
  | { kind: "done"; ok: boolean; summary?: string }
  | { kind: "error"; message: string }
  /** The agent needs a human decision before it can continue. The runner
   *  pauses the wall-clock budget, marks the task input-required, and routes
   *  the question to a human inbox; the answer comes back via
   *  AgentHandle.answer(). A one-shot CLI simply never emits this. */
  | { kind: "question"; id: string; question: string }
  // The Nth step boundary the CLI reported — opencode's step_start, claude's
  // assistant turns. Both are real and observable, which is the whole point:
  // the TOTAL number of steps is unknowable, so this is a count and never a
  // percentage. Anything rendering it with a % would be inventing the
  // denominator.
  | { kind: "progress"; step: number; note?: string }
  // Something the agent judged worth keeping beyond this task. Produced by
  // the REMEMBER convention in the prompt — see rememberInstruction().
  | { kind: "remember"; memoryKind: "fact" | "preference" | "decision"; text: string };

export interface AgentHandle {
  events: AsyncIterable<AgentEvent>;
  /** Graceful stop — give the process a chance to wind down. */
  interrupt(): void;
  /** Hard stop — must land within ~2s. */
  kill(): void;
  /** Deliver a human's answer to the running process. Only meaningful for
   *  harnesses whose CLI actually listens to stdin (interactive runs);
   *  implementations that cannot deliver should accept and ignore. */
  answer?(text: string): void;
}

export interface AgentHarness {
  name: string;
  spawn(opts: SpawnOptions): AgentHandle;
}

import { z } from "zod";

export const TaskState = z.enum([
  "submitted", "working", "input-required", "auth-required", "blocked",
  "completed", "failed", "canceled", "rejected",
]);

export type TaskStateT = z.infer<typeof TaskState>;

export const TERMINAL = ["completed", "failed", "canceled", "rejected"] as const;
export type TerminalState = (typeof TERMINAL)[number];

export function isTerminal(s: TaskStateT): s is TerminalState {
  return (TERMINAL as readonly string[]).includes(s);
}

const LEGAL: Record<TaskStateT, readonly TaskStateT[]> = {
  submitted: ["working", "canceled", "rejected"],
  working: ["input-required", "auth-required", "blocked", "completed", "failed", "canceled"],
  "input-required": ["working", "canceled", "failed"],
  "auth-required": ["working", "canceled", "failed"],
  blocked: ["working", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export function canTransition(from: TaskStateT, to: TaskStateT): boolean {
  return LEGAL[from].includes(to);
}

export function assertTransition(from: TaskStateT, to: TaskStateT): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition: ${from} → ${to}`);
  }
}

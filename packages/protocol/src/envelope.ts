import { z } from "zod";

export const MESSAGE_TYPES = [
  "task.offer", "task.accept", "task.status", "task.event", "task.result", "task.cancel",
  "delegate.request", "delegate.decision", "delegate.result",
  "review.request", "review.result",
  "context.share", "context.ack",
  "human.ask", "human.answer",
  "memory.write", "memory.recall", "memory.result",
  "peer.directory",
  "agent.card", "node.status", "presence", "chat", "position",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const SenderKind = z.enum(["user", "agent", "node", "server"]);
const TargetKind = z.enum(["user", "agent", "node", "room"]);

export const Envelope = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  seq: z.number().int().positive().optional(),
  type: z.enum(MESSAGE_TYPES),
  project: z.string(),
  from: z.object({ kind: SenderKind, id: z.string() }),
  to: z.object({ kind: TargetKind, id: z.string() }),
  task: z.string().nullable(),
  idem: z.string().nullable(),
  ts: z.string(),
  body: z.unknown(),
});

export type EnvelopeT = z.infer<typeof Envelope>;

export function isSideEffecting(type: MessageType): boolean {
  return SIDE_EFFECTING.has(type);
}

const SIDE_EFFECTING: ReadonlySet<MessageType> = new Set([
  "task.offer", "task.accept", "task.result", "task.cancel",
  "delegate.request", "delegate.decision", "delegate.result",
  "review.request", "review.result",
  "context.share",
  "human.ask", "human.answer",
  // memory.write creates a durable record; recall/result are pure reads.
  "memory.write",
]);

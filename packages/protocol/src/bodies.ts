import { z } from "zod";
import { Envelope, MESSAGE_TYPES, isSideEffecting, type EnvelopeT, type MessageType } from "./envelope.js";
import { TaskState } from "./task-state.js";
import { SealedPayload } from "./sealed.js";

export const BodySchemas = {
  "task.offer": z.object({
    taskId: z.string(),
    title: z.string(),
    spec: z.string().nullable(),
    acceptance: z.string().nullable(),
    budget: z.object({ seconds: z.number().int().positive(), usd: z.number() }),
  }),

  "task.accept": z.object({
    taskId: z.string(),
  }),

  "task.status": z.object({
    taskId: z.string(),
    state: TaskState,
    note: z.string().nullable().default(null),
  }),

  "task.event": z.object({
    taskId: z.string(),
    kind: z.string(),
    summary: z.string(),
    data: z.record(z.unknown()).nullish().default(null),
  }),

  "task.result": z.object({
    taskId: z.string(),
    state: z.enum(["completed", "failed"]),
    reason: z.string().nullable().default(null),
    artifact: z
      .object({
        id: z.string(),
        hash: z.string(),
        mime: z.string(),
        bytes: z.number().int().nonnegative(),
        summary: z.string(),
      })
      .nullish()
      .default(null),
  }),

  "task.cancel": z.object({
    taskId: z.string(),
    by: z.enum(["user", "system", "budget"]),
    reason: z.string().nullable().default(null),
  }),

  // `sealed` holds the encrypted half (inputs, acceptance, context note) —
  // the server routes on the plaintext fields and cannot read the rest.
  // See SEALED.md for why the split falls exactly here.
  "delegate.request": z.object({
    requestId: z.string(),
    capability: z.string(),
    targetAgentId: z.string(),
    targetNodeId: z.string(),
    projectId: z.string(),
    budget: z.object({ seconds: z.number().int().positive(), usd: z.number() }),
    sealed: SealedPayload,
  }),

  "delegate.decision": z.object({
    requestId: z.string(),
    decision: z.enum(["approved", "denied", "once", "always", "never"]),
    by: z.string().nullable().default(null),
  }),

  "delegate.result": z.object({
    requestId: z.string(),
    taskId: z.string(),
    state: z.enum(["completed", "failed"]),
    verified: z.boolean(),
    sealed: SealedPayload.nullish().default(null), // the encrypted findings
    artifact: z
      .object({
        id: z.string(),
        hash: z.string(),
        mime: z.string(),
        bytes: z.number().int().nonnegative(),
        summary: z.string(),
      })
      .nullish()
      .default(null),
  }),

  "review.request": z.object({
    toAgentId: z.string().nullable(),
    subject: z.object({ kind: z.enum(["pr", "issue", "diff", "artifact"]), ref: z.string() }),
    criteria: z.array(z.string()),
    depth: z.enum(["quick", "thorough"]),
    budget: z.object({ seconds: z.number().int().positive(), usd: z.number() }),
  }),

  "review.result": z.object({
    requestId: z.string(),
    verdict: z.enum(["approved", "changes_requested", "rejected"]),
    findings: z.array(
      z.object({
        severity: z.enum(["info", "minor", "major", "critical"]),
        file: z.string().nullable(),
        line: z.number().int().nonnegative().nullable(),
        note: z.string(),
      })
    ),
    summary: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
  }),

  "context.share": z.object({
    toAgentId: z.string(),
    kind: z.enum(["decision", "file_excerpt", "repo_state", "finding", "constraint"]),
    title: z.string(),
    body: z.string(),
    refs: z.array(z.string()).default([]),
    ttlDays: z.number().int().positive().default(7),
  }),

  "context.ack": z.object({
    shareId: z.string(),
    accepted: z.boolean(),
  }),

  "human.ask": z.object({
    taskId: z.string().nullable(),
    question: z.string(),
    options: z.array(z.enum(["approve", "edit", "reject", "answer"])),
  }),

  "human.answer": z.object({
    askId: z.string(),
    choice: z.enum(["approve", "edit", "reject", "answer"]),
    text: z.string().nullable().default(null),
  }),

  // ---- shared memory (MEMORY.md) ----
  // Scope is the whole point: "project" is what the *team* knows and every
  // agent in the room recalls; "agent" is one agent's own working notes.
  // A memory written by one machine's agent is recallable by another's —
  // that only holds because it lives on the server (D2), not on the node.
  "memory.write": z.object({
    scope: z.enum(["project", "agent"]),
    kind: z.enum(["fact", "preference", "decision", "outcome"]),
    text: z.string().min(1).max(2000),
    sourceTaskId: z.string().nullable().default(null),
  }),

  "memory.recall": z.object({
    requestId: z.string(),
    query: z.string(),
    limit: z.number().int().positive().max(50).default(5),
  }),

  "memory.result": z.object({
    requestId: z.string(),
    memories: z.array(
      z.object({
        id: z.string(),
        scope: z.enum(["project", "agent"]),
        kind: z.enum(["fact", "preference", "decision", "outcome"]),
        text: z.string(),
        agentName: z.string(),
        createdAt: z.string(),
      })
    ),
  }),

  // Server -> node: who else is in this project and how to seal to them.
  // A sender needs the recipient's key *before* it can encrypt, and the
  // envelope's `to` is bound into the AAD, so the server cannot re-address a
  // sealed payload on the sender's behalf — it has to be addressed correctly
  // from the start. Hence a directory rather than server-side routing magic.
  "peer.directory": z.object({
    peers: z.array(
      z.object({
        agentId: z.string(),
        agentName: z.string(),
        machineId: z.string(),
        machineName: z.string(),
        ownerName: z.string(),
        capabilities: z.array(z.string()),
        online: z.boolean(),
        sealingPubkey: z.string().nullable(), // null = cannot be sealed to yet
      })
    ),
  }),

  "agent.card": z.object({
    id: z.string(),
    name: z.string(),
    ownerId: z.string(),
    machineId: z.string(),
    role: z.enum(["developer", "research", "qa", "review", "docs", "planner"]),
    capabilities: z.array(z.string()),
    harness: z.string(),
    projects: z.array(z.string()),
    concurrency: z.number().int().positive(),
    status: z.enum([
      "idle", "working", "waiting", "blocked",
      "needs_input", "reviewing", "completed", "failed",
    ]),
  }),

  "node.status": z.object({
    machineId: z.string(),
    online: z.boolean(),
    lastSeen: z.string(),
  }),

  presence: z.object({
    userId: z.string(),
    state: z.enum(["online", "away", "offline"]),
  }),

  chat: z.object({
    roomId: z.string(),
    fromKind: z.enum(["user", "agent"]),
    fromId: z.string(),
    fromName: z.string(),
    text: z.string(),
    askTaskId: z.string().nullish().default(null),
    askOptions: z.array(z.enum(["approve", "edit", "reject", "answer"])).nullish().default(null),
  }),

  position: z.object({
    userId: z.string(),
    roomId: z.string(),
    x: z.number(),
    y: z.number(),
  }),
} as const satisfies Record<MessageType, z.ZodTypeAny>;

export type BodyOf<T extends MessageType> = z.infer<(typeof BodySchemas)[T]>;

export function parseEnvelope(raw: unknown):
  | { ok: true; envelope: EnvelopeT; body: unknown }
  | { ok: false; error: string } {
  const env = Envelope.safeParse(raw);
  if (!env.success) return { ok: false, error: `envelope: ${env.error.message}` };

  const schema = BodySchemas[env.data.type];
  const body = schema.safeParse(env.data.body);
  if (!body.success) return { ok: false, error: `body(${env.data.type}): ${body.error.message}` };

  if (isSideEffecting(env.data.type) && !env.data.idem) {
    return { ok: false, error: `type ${env.data.type} requires idem` };
  }

  return { ok: true, envelope: env.data, body: body.data };
}

export function makeEnvelope<T extends MessageType>(
  type: T,
  fields: {
    project: string;
    from: EnvelopeT["from"];
    to: EnvelopeT["to"];
    task?: string | null;
    seq?: number;
  },
  body: BodyOf<T>
): EnvelopeT {
  return Envelope.parse({
    v: 1,
    id: crypto.randomUUID(),
    seq: fields.seq,
    type,
    project: fields.project,
    from: fields.from,
    to: fields.to,
    task: fields.task ?? null,
    idem: isSideEffecting(type) ? crypto.randomUUID() : null,
    ts: new Date().toISOString(),
    body,
  });
}

export { MESSAGE_TYPES };

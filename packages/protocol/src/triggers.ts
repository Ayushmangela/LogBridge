import { z } from "zod";

// ── TriggerView ──────────────────────────────────────────────────────────
// The shape of a trigger that the UI can display and edit. Mirrors the
// trigger table columns plus derived fields. Kept in protocol (not server)
// so the room view can reference it without a server dependency.
//
// ★ 1.22 — the wire surface for triggers. Stream A builds the tab; this
// file is the single source of type definitions.
export const TriggerView = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.enum(["schedule", "event"]),
  rule: z.string(),
  taskTitle: z.string().nullable(),
  taskSpec: z.string().nullable(),
  taskCapability: z.string().nullable(),
  budgetSeconds: z.number().int().nonnegative().nullable(),
  budgetUsd: z.number().nullable(),
  tz: z.string().nullable(),
  createdAt: z.string(),
  lastFiredAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  lastEvtSeq: z.number().int().nonnegative().default(0),
});

export type TriggerViewT = z.infer<typeof TriggerView>;

// ── Message bodies for create / enable / delete ──────────────────────────
// These are the only protocol messages the server accepts for trigger
// lifecycle. They are kept separate from BodySchemas so the gateway can
// validate trigger payloads independently.

// Everything past the four essentials is `.nullish().default(null)`, not bare
// `.nullable()`. Bare nullable means a caller must SEND every field, even as
// null: omitting `tz` — the natural way to say "use the server's own zone" —
// was a 400. The browser happens to send all ten, so this never broke it, but
// any other caller (a script, a CLI, a future runner) would hit it on the
// first try. Widening is backward-compatible: payloads that send explicit
// nulls still validate exactly as before.
export const TriggerCreate = z.object({
  projectId: z.string(),
  name: z.string(),
  kind: z.enum(["schedule", "event"]),
  rule: z.string(),
  taskTitle: z.string().nullish().default(null),
  taskSpec: z.string().nullish().default(null),
  taskCapability: z.string().nullish().default(null),
  budgetSeconds: z.number().int().positive().nullish().default(null),
  budgetUsd: z.number().positive().nullish().default(null),
  tz: z.string().nullish().default(null),
});

export type TriggerCreateT = z.infer<typeof TriggerCreate>;

export const TriggerEnable = z.object({
  id: z.string(),
  enabled: z.boolean(),
});

export type TriggerEnableT = z.infer<typeof TriggerEnable>;

export const TriggerDelete = z.object({
  id: z.string(),
});

export type TriggerDeleteT = z.infer<typeof TriggerDelete>;

// The command catalog shown in an agent's Command Center.
//
// It lives here, server-side, for the same reason `activity.ts` does
// (CONTRACT.md invariant 2): one place decides what the UI is allowed to
// say. A catalog hardcoded in index.html would drift from the CLI it
// documents with nobody noticing, and would have to be duplicated for every
// provider the browser has never seen.
//
// It is deliberately NOT part of the workspace view. `broadcastView()`
// rebuilds and re-sends the whole view on every position message — a player
// walking across the office does that continuously — so static reference
// data riding along would be re-serialised thousands of times to say the
// same thing. It is served once over HTTP instead.
//
// PROVENANCE. The `cli` entries below were captured from `claude --help` on
// a real 2.x install, the same rule the parsers follow: never transcribe an
// interface from a design or from memory. The `slash` entries are Claude
// Code's in-session commands, which `--help` does not enumerate; they are
// documented here and marked as the provider's own, so a wrong one is a
// wrong description rather than a command that silently does nothing.
import type { FastifyInstance } from "fastify";

export type CommandKind = "slash" | "cli";

export interface CommandEntry {
  kind: CommandKind;
  /** What you type. "/clear", "claude -c". */
  name: string;
  /** One line, plain language, no jargon the CLI itself wouldn't use. */
  description: string;
  /** Optional concrete usage — only where the bare name is ambiguous. */
  example?: string;
}

export interface CommandGroup {
  title: string;
  commands: CommandEntry[];
}

export interface CommandCatalog {
  /** Provider id from the runner's registry (PROVIDERS.md). */
  providerId: string;
  label: string;
  /** Shown above the list, so nobody runs a slash command in a shell. */
  note: string;
  groups: CommandGroup[];
}

const CLAUDE: CommandCatalog = {
  providerId: "claude",
  label: "Claude Code",
  note: "Slash commands run inside a Claude Code session. CLI commands run in a shell.",
  groups: [
    {
      title: "Session",
      commands: [
        { kind: "slash", name: "/clear",
          description: "Start a fresh conversation and reclaim the full context window. The old one stays in /resume." },
        { kind: "slash", name: "/resume",
          description: "Pick or search a past session to continue.", example: "/resume auth refactor" },
        { kind: "slash", name: "/rewind",
          description: "Roll code and conversation back to an earlier checkpoint." },
        { kind: "slash", name: "/compact",
          description: "Summarise the conversation so far to free context without losing the thread.",
          example: "/compact keep the auth decisions" },
        { kind: "cli", name: "claude -c",
          description: "Continue the most recent conversation in this directory." },
        { kind: "cli", name: "claude -r",
          description: "Resume a conversation by session id, or pick one interactively.", example: "claude -r auth" },
        { kind: "cli", name: "claude --fork-session",
          // --help is explicit that this is a modifier, not a command of its
          // own: "When resuming, create a new session ID (with --resume or
          // --continue)". Describing it standalone would send people to an
          // error message.
          description: "Used with -r or -c: branch into a new session id instead of reusing the original.",
          example: "claude -c --fork-session" },
      ],
    },
    {
      title: "Context & memory",
      commands: [
        { kind: "slash", name: "/context",
          description: "Visualise what is filling the context window, with optimisation hints." },
        { kind: "slash", name: "/memory",
          description: "Open the project and user CLAUDE.md memory files for editing." },
        { kind: "slash", name: "/init",
          description: "Scan the repo and generate a CLAUDE.md capturing its conventions." },
        { kind: "slash", name: "#",
          description: "Append a note to memory without leaving the conversation.",
          example: "# this repo uses pnpm, never npm" },
      ],
    },
  ],
};

/** Every catalog we actually have. One entry, honestly — a provider with no
 *  catalog shows nothing rather than Claude's commands under its own name. */
export const CATALOGS: CommandCatalog[] = [CLAUDE];

export function catalogFor(providerId: string | null | undefined): CommandCatalog | null {
  if (!providerId) return null;
  return CATALOGS.find((c) => c.providerId === providerId) ?? null;
}

/** Static and cacheable: this changes when the code changes, never at runtime. */
export function registerCommandRoutes(app: FastifyInstance): void {
  app.get("/api/commands", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return { catalogs: CATALOGS };
  });
}

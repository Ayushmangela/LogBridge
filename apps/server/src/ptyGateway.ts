import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import * as pty from "node-pty";
// @xterm/headless ships CJS with no "exports" map, so under Node's native
// ESM loader (what tsx/production actually run) it resolves as a single
// default export wrapping the whole module.exports object — not spread
// into named exports. `import { Terminal } from "@xterm/headless"` type-
// checks and even runs fine under vitest (Vite's resolver synthesizes
// named exports from a CJS module's own keys, more leniently than Node's
// loader), which is exactly why this shipped once already and only failed
// at real server startup, not in tests.
import XtermHeadless from "@xterm/headless";
const HeadlessTerminal = XtermHeadless.Terminal;
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getAgentOutput, appendEvent } from "./db.js";
import { buildCommanderHivePrompt, buildEmployeeHivePrompt } from "./hivePrompt.js";
import { loadRole } from "./roles/loader.js";

interface PtySession {
  id: string;
  agentId: string;
  proc: pty.IPty;
  scrollback: string;
  clients: Set<WebSocket>;
  cols: number;
  rows: number;

  // ---- readiness (see whenReady) ----
  /** True once the CLI has printed its own input prompt. */
  ready: boolean;
  /** Resolvers waiting for that moment. Drained exactly once. */
  readyWaiters: Array<() => void>;

  // ---- identity freshness (see needsIdentity) ----
  /** When the identity prompt was last put in front of this process. */
  identitySentAt: string | null;
  /** Fingerprint of the identity text, so editing the prompt re-seeds. */
  identityVersion: string;
  /** provider:model the process was STARTED with. A change means the running
   *  process cannot be the new engine, whatever the database row now says. */
  engine: string;

  // ---- write serialisation (see queueWrite) ----
  /** Tail of the write chain. Everything reaching proc.write joins it. */
  writeChain: Promise<void>;
}

const sessions = new Map<string, PtySession>();

/** Cheap stable fingerprint of the identity text. Not security — just "is
 *  this the same prompt I already sent?", so editing hivePrompt.ts re-seeds
 *  live sessions instead of leaving them on the old instructions. */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

/**
 * Resolve when the CLI is actually able to accept input.
 *
 * Replaces `setTimeout(..., 6000)` in the wake path. Six seconds was a guess
 * in both directions: on a slow cold start the message was typed into a still-
 * booting CLI and lost; on a fast one, five of those seconds were wasted.
 * `looksReady()` already watches for the CLI's own prompt banner — this just
 * lets callers await it.
 *
 * The ceiling matches the one used for the `starting` status: a CLI that never
 * says anything recognisable must fail visibly rather than hang forever.
 */
function whenReady(session: PtySession, timeoutMs = 45_000): Promise<boolean> {
  if (session.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    session.readyWaiters.push(() => done(true));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Serialise everything written to a PTY.
 *
 * The human's keystrokes (`msg.type === "data"`), the router's wake notices
 * and task submissions all wrote straight to the same `proc.write`. A wake
 * arriving mid-sentence interleaved with what the person was typing and
 * produced one garbled line. Chaining them means a late write waits its turn
 * instead of cutting in.
 */
function queueWrite(session: PtySession, write: () => void): void {
  session.writeChain = session.writeChain
    .then(() => { try { write(); } catch { /* process may be gone */ } })
    .catch(() => {});
}

// "The input prompt is showing right now." Used to answer two different
// questions about the same signal: is a freshly booted CLI ready for its
// FIRST prompt (below), and — watchForCompletion, near submitPromptToAgent
// — is a CLI that was mid-task ready for its NEXT one, which only happens
// once the current turn has actually finished.
const READY_MARKERS = [
  "Ask anything", "ctrl+p", "OpenCode", "tab agents", "connected to",
  "What would you like", "Tip Run /connect", "Tip", "commands",
];

function looksReady(data: string): boolean {
  return READY_MARKERS.some((m) => data.includes(m));
}

function formatBanner(title: string, version: string, desc: string, cwd: string, accentHex: string): string {
  const r = parseInt(accentHex.slice(1, 3), 16) || 217;
  const g = parseInt(accentHex.slice(3, 5), 16) || 119;
  const b = parseInt(accentHex.slice(5, 7), 16) || 87;
  const accent = `\x1b[38;2;${r};${g};${b}m`;
  const reset = `\x1b[0m`;
  const bold = `\x1b[1m`;
  const dim = `\x1b[2m`;
  const green = `\x1b[38;2;32;144;75m`;

  return [
    `\r\n${accent}╭────────────────────────────────────────────────────────╮${reset}\r\n`,
    `${accent}│${reset}  ${bold}${title}${reset} ${dim}${version}${reset}\r\n`,
    `${accent}│${reset}  ${dim}${desc}${reset}\r\n`,
    `${accent}│${reset}  ${green}${cwd}${reset}\r\n`,
    `${accent}╰────────────────────────────────────────────────────────╯${reset}\r\n\r\n`
  ].join("");
}

function resolveExecutable(cmd: string): string | null {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }
  const candidates = [
    // Was hardcoded to one developer's nvm path, which resolves on exactly
    // one machine. The spare-laptop server and any teammate would silently
    // fall through to "command not found".
    ...nvmBinDirs().map((d) => `${d}/${cmd}`),
    `/opt/homebrew/bin/${cmd}`,
    `/opt/homebrew/sbin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
    `/bin/${cmd}`
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const out = execSync(`which ${cmd}`, { encoding: "utf8", env: process.env }).trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return null;
}

import type { HiveManager } from "./hive.js";
import type { Db } from "./db.js";

export function spawnOrGetPtySession(
  db: Db,
  ptyId: string,
  agentId: string,
  cols = 100,
  rows = 30,
  hive?: HiveManager
): PtySession {
  let session = sessions.get(ptyId);
  if (session) return session;

  const agent = agentId
    ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any)
    : null;

  const inferred = ptyId.toLowerCase().includes("opencode")
    ? "opencode"
    : ptyId.toLowerCase().includes("claude")
    ? "claude"
    : "";
  const provider = (agent?.provider || inferred).toLowerCase();
  let title = "Claude Code";
  let ver = "v2.1.241";
  let desc = (agent?.model || "Opus 4.8") + " (" + (agent?.context_limit ? Math.round(agent.context_limit / 1000) + "k" : "1M") + " context) with xhigh effort · Claude Max";
  let accent = "#d97757";

  let exeCmd = "";
  let exeArgs: string[] = [];
  let isCli = false;

  if (provider === "opencode") {
    const bin = resolveExecutable("opencode");
    if (bin) {
      exeCmd = bin;
      exeArgs = ["--auto"];
      isCli = true;
    }
    title = "OpenCode";
    ver = "v1.0.8";
    desc = (agent?.model || "Qwen 2.5 Coder 32B") + " · Local Ollama/vLLM Harness";
    accent = "#10b981";
  } else if (provider === "claude") {
    const bin = resolveExecutable("claude");
    if (bin) {
      exeCmd = bin;
      exeArgs = ["--dangerously-skip-permissions"];
      isCli = true;
    }
  } else if (provider === "gemini" || provider === "antigravity") {
    const bin = resolveExecutable("agy") || resolveExecutable("gemini");
    if (bin) {
      exeCmd = bin;
      exeArgs = [];
      isCli = true;
    }
    title = provider === "antigravity" ? "Antigravity · Gemini" : "Google Gemini CLI";
    ver = "v1.12.0";
    desc = (agent?.model || "Gemini 2.5 Pro (2M context)") + " · Thinking Budget 32k";
    accent = "#3b82f6";
  } else if (provider === "codex") {
    const bin = resolveExecutable("codex");
    if (bin) {
      exeCmd = bin;
      exeArgs = [];
      isCli = true;
    }
    title = "Codex · GPT";
    ver = "v0.9.4";
    desc = (agent?.model || "GPT-4o (128k context)") + " · OpenAI Native CLI";
    accent = "#10a37f";
  } else if (agent?.color) {
    title = (agent.provider || agent.name || "Agent") + " CLI";
    ver = "v1.0.0";
    desc = (agent.model || "Autonomous Coding Agent") + " · Standard Harness";
    accent = agent.color;
  }

  let cwd = agent?.folder || agent?.cwd || process.cwd();
  if (typeof cwd === "string" && cwd.startsWith("~/")) {
    cwd = (process.env.HOME || "") + cwd.slice(1);
  }
  if (!existsSync(cwd)) cwd = process.cwd();

  // is_god is authoritative when set (SQL column, added after a subordinate
  // that also had role "planner" was mistaken for the commander here, and
  // both agents' spawns then overwrote the same shared AGENTS.md at the
  // project root with each other's identity — the commander's own CLI
  // introduced itself with the subordinate's name on its next start).
  // NULL means the row predates that column; fall back to the old heuristic
  // rather than assume "not commander" for a possibly-legitimate old row.
  const isCommander = agent?.is_god === 1 ? true
    : agent?.is_god === 0 ? false
    : (agent?.name && agent.name.toLowerCase().includes("commander")) ||
      (agent?.role && agent.role.toLowerCase().includes("commander")) ||
      (agent?.role === "planner");

  let initialPrompt = "";
  if (agent && cwd && existsSync(cwd)) {
    try {
      if (isCommander) {
        initialPrompt = buildCommanderHivePrompt({
          commanderName: agent.name || "Michael",
          folder: cwd,
        });
      } else {
        initialPrompt = buildEmployeeHivePrompt({
          agentId: agentId || agent.id,
          agentName: agent.name || "Agent",
          folder: cwd,
          role: agent.role,
          // Resolved from the agent's own project folder, so a role file
          // dropped into <project>/hive/roles/ overrides the built-in of
          // the same name for this project only. Null (no role_id, or a
          // definition that has since been deleted) falls through to the
          // built-in brief — the prompt is then byte-identical to before
          // role files existed, which is what keeps every existing agent's
          // identity fingerprint stable.
          roleDef: loadRole(agent.role_id, cwd),
        });
      }
      // Only the commander writes the shared project-root AGENTS.md — many
      // CLIs (opencode, claude) read it automatically as a system prompt.
      // Subordinates commonly share the commander's folder as their cwd, so
      // a subordinate's spawn used to overwrite the same file with its own
      // identity: whichever agent's terminal opened most recently decided
      // what EVERY agent's next cold start would read there, including the
      // commander's. A subordinate's identity already lives in its own
      // hive/agents/<id>/identity.md and is delivered directly into its PTY
      // below (initialPrompt), so it never needed the shared file.
      if (isCommander) {
        const agentsMdPath = join(cwd, "AGENTS.md");
        writeFileSync(agentsMdPath, initialPrompt, "utf8");
      }
    } catch {}
  }

  if (!exeCmd) {
    exeCmd = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
    exeArgs = [];
  }

  const userPath = [
    ...nvmBinDirs(),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    process.env.PATH || ""
  ].join(":");

  const proc = pty.spawn(exeCmd, exeArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      PATH: userPath,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
      AGENT_ID: agentId,
      AGENT_NAME: agent?.name || "",
      // These used to fall back to "" when no HiveManager was passed. The
      // prompts now instruct the agent in terms of $AGENT_DIR / $HIVE_ROOT,
      // so an empty value would expand to "/memory.md" — the filesystem root.
      // Derive the same layout the prompt builder assumes instead, so the
      // variables are always a real path.
      HIVE_ROOT: hive ? hive.root() : join(cwd, "hive"),
      AGENT_DIR: (hive && agentId)
        ? hive.agentDir(agentId)
        : join(cwd, "hive", "agents", agentId || "agent"),
    } as Record<string, string>,
  });

  session = {
    id: ptyId,
    agentId,
    proc,
    scrollback: "",
    clients: new Set(),
    cols,
    rows,
    ready: false,
    readyWaiters: [],
    // The identity is written below as this process's first prompt, so record
    // it as sent — otherwise every wake would re-seed a session that already
    // has it.
    identitySentAt: initialPrompt ? new Date().toISOString() : null,
    identityVersion: initialPrompt ? fingerprint(initialPrompt) : "",
    engine: `${agent?.provider ?? ""}:${agent?.model ?? ""}`,
    writeChain: Promise.resolve(),
  };
  sessions.set(ptyId, session);

  let promptSeeded = false;
  const doSeed = () => {
    if (promptSeeded || !initialPrompt) return;
    promptSeeded = true;
    try {
      const payload = initialPrompt.includes("\n")
        ? `\x1b[200~${initialPrompt}\x1b[201~`
        : initialPrompt;
      proc.write(payload);
      setTimeout(() => {
        try {
          proc.write("\r");
        } catch {}
      }, 250);
    } catch {}
  };

  // Fallback timer if no TUI pattern is recognized
  const seedFallbackTimer = setTimeout(() => {
    doSeed();
  }, isCli ? 6000 : 1200);

  const currentSession = session;

  // ---- readiness: "starting" until the CLI's prompt actually appears ----
  //
  // A cold CLI takes 10-20s to boot. Reporting "idle" through that window is
  // a lie the office cannot recover from: idle means "ready and taking work",
  // so a booting agent looked like one that was ignoring you.
  //
  // Only ever moves idle <-> starting. A real status (working, needs_input,
  // ...) is never clobbered — the runner owns those, and a boot notice must
  // not overwrite what an agent is actually doing.
  let markedStarting = false;
  const setStarting = () => {
    if (!agentId) return;
    const row = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as any;
    if (!row || (row.status && row.status !== "idle")) return;
    db.prepare("UPDATE agents SET status = 'starting' WHERE id = ?").run(agentId);
    markedStarting = true;
  };
  const clearStarting = () => {
    if (!agentId || !markedStarting) return;
    markedStarting = false;
    // Re-read: the agent may legitimately have started working while booting.
    const row = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as any;
    if (row?.status === "starting") {
      db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agentId);
    }
  };
  setStarting();
  // A CLI that never prints anything recognisable must not strand the agent
  // in "starting" forever — silence is not a state the office can show.
  const readyFallbackTimer = setTimeout(clearStarting, 45_000);

  // If fallback to shell, write initial banner into scrollback
  if (!isCli) {
    const banner = formatBanner(title, ver, desc, cwd, accent);
    currentSession.scrollback += banner;
  }

  // If agent has prior outputs/events, replay them cleanly
  if (agentId) {
    const history = getAgentOutput(db, agentId, 100);
    if (history.output && history.output.length > 0) {
      currentSession.scrollback += `\r\n\x1b[2m─── agent history (${history.output.length} lines) ───\x1b[0m\r\n`;
      for (const line of history.output) {
        currentSession.scrollback += `${line}\r\n`;
      }
      currentSession.scrollback += `\x1b[2m──────────────────────────────────────────\x1b[0m\r\n\r\n`;
    }
  }

  proc.onData((data: string) => {
    // The same readiness signal that decides when to seed a prompt also
    // decides when the agent stops booting — checked unconditionally, because
    // an agent with no initial prompt still finishes starting up.
    if (markedStarting && looksReady(data)) {
      clearTimeout(readyFallbackTimer);
      clearStarting();
    }
    // One readiness signal, three consumers: the `starting` status above, the
    // prompt seeder below, and anything awaiting whenReady() — which is how
    // the wake path stopped guessing at six seconds.
    if (!currentSession.ready && looksReady(data)) {
      currentSession.ready = true;
      const waiters = currentSession.readyWaiters.splice(0);
      for (const w of waiters) { try { w(); } catch {} }
    }
    // Detect when OpenCode / Claude Code is ready for user input
    if (!promptSeeded && initialPrompt) {
      if (looksReady(data)) {
        clearTimeout(seedFallbackTimer);
        setTimeout(() => {
          doSeed();
        }, 500);
      }
    }
    if (currentSession.scrollback.length > 200_000) {
      currentSession.scrollback = currentSession.scrollback.slice(-100_000);
    }
    currentSession.scrollback += data;
    const payload = JSON.stringify({ type: "data", ptyId, data });
    for (const client of currentSession.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // A CLI that died during boot never became ready — but leaving the agent
    // stuck on "starting" would claim it is still coming up. Release it.
    clearTimeout(readyFallbackTimer);
    clearStarting();

    // An agent whose process died mid-task was left `working`, holding its
    // task, forever: recoverServerState() only runs at SERVER startup, so a
    // single CLI crash while the server kept running stranded both the agent
    // and the work. The agent then looked busy to the roster, to the office,
    // and to the orchestrator's concurrency check — so nothing was ever
    // routed to it again.
    //
    // The task goes back to `submitted` rather than `failed`: the process
    // dying tells us nothing about whether the work was wrong, and
    // `submitted` is a state sendTaskOffer picks straight back up.
    if (agentId) {
      try {
        const row = db.prepare("SELECT status, current_task, project_id FROM agents WHERE id = ?").get(agentId) as any;
        if (row && row.status === "working") {
          db.prepare("UPDATE agents SET status = 'idle', current_task = NULL WHERE id = ?").run(agentId);
          if (row.current_task) {
            db.prepare(
              "UPDATE tasks SET state = 'submitted', lease_expires = NULL WHERE id = ? AND state = 'working'"
            ).run(row.current_task);
            appendEvent(db, row.project_id, row.current_task, "task.recovered", {
              agentId,
              reason: "agent process exited mid-task",
              exitCode, signal: signal ?? null,
              recoveredAt: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        // Never let recovery bookkeeping stop the exit handler from running.
        try { console.warn("pty exit recovery failed", err); } catch {}
      }
    }
    const exitMsg = `\r\n\x1b[2m─ process exited (code ${exitCode}${signal ? `, signal ${signal}` : ""}) ─\x1b[0m\r\n`;
    currentSession.scrollback += exitMsg;
    const payload = JSON.stringify({ type: "exit", ptyId, exitCode, signal });
    for (const client of currentSession.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
    sessions.delete(ptyId);
  });

  return session;
}

/** Every nvm-installed node bin directory on THIS machine, newest first.
 *  A PTY inherits the server's PATH, which under a desktop launcher often
 *  lacks the user's shell PATH entirely — so the agent CLI is invisible.
 *  Discovering it beats hardcoding one developer's version string. */
function nvmBinDirs(): string[] {
  try {
    const root = join(homedir(), ".nvm", "versions", "node");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .sort()
      .reverse()
      .map((v: string) => join(root, v, "bin"))
      .filter((d: string) => existsSync(d));
  } catch {
    return [];
  }
}

export function registerPtyGateway(app: FastifyInstance, db: Db, hive?: HiveManager) {
  app.get("/pty-ws", { websocket: true, }, (socket: WebSocket, req: any) => {
    // This socket spawns a PTY and writes raw keystrokes into it. With no
    // agent CLI resolved it falls back to $SHELL, so an open /pty-ws is an
    // interactive shell on this machine with this process's environment.
    //
    // There is still no user identity in this system (D23), so the only
    // honest gate available is a shared secret the operator sets. When
    // LOGBRIDGE_TOKEN is unset we allow loopback only — which is the default
    // bind — rather than silently trusting whoever connected.
    const token = process.env.LOGBRIDGE_TOKEN;
    const remote: string = req?.socket?.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

    if (token) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const supplied = url.searchParams.get("token") ?? "";
      // Length-independent compare would be better; this at least does not
      // leak via early return on the common path.
      if (supplied !== token) {
        try { socket.close(4401, "unauthorized"); } catch {}
        return;
      }
    } else if (!isLoopback) {
      app.log.warn({ remote }, "refused /pty-ws from a non-loopback address with no LOGBRIDGE_TOKEN set");
      try { socket.close(4401, "unauthorized"); } catch {}
      return;
    }

    let attachedSession: PtySession | null = null;

    socket.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "spawn" || msg.type === "restart") {
        const ptyId: string = msg.ptyId || "pty-default";
        const agentId: string = msg.agentId || "";
        const cols = Number(msg.cols) || 100;
        const rows = Number(msg.rows) || 30;

        let session = sessions.get(ptyId);
        if (msg.type === "restart" && session) {
          try { session.proc.kill(); } catch {}
          sessions.delete(ptyId);
          session = undefined;
        }

        if (!session) {
          session = spawnOrGetPtySession(db, ptyId, agentId, cols, rows, hive);
        }

        if (!session) return;
        attachedSession = session;
        session.clients.add(socket);

        // Tell client it is spawned
        socket.send(JSON.stringify({ type: "spawned", ptyId, cols: session.cols, rows: session.rows }));

        // Replay existing scrollback buffer so terminal is populated immediately
        if (session.scrollback) {
          socket.send(JSON.stringify({ type: "data", ptyId, data: session.scrollback }));
        }
        return;
      }

      const activeSession = attachedSession || (msg.ptyId ? sessions.get(msg.ptyId) : null);

      if (msg.type === "submitPrompt" && activeSession) {
        const text = String(msg.text || "").trim();
        if (text) {
          queueWrite(activeSession, () => {
            const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
            activeSession.proc.write(payload);
            setTimeout(() => {
              try { activeSession.proc.write("\r"); } catch {}
            }, 180);
          });
        }
        return;
      }

      if (msg.type === "reseed" && activeSession) {
        let agentId = activeSession.agentId;
        if (!agentId && msg.ptyId) {
          const m = msg.ptyId.match(/-([a-f0-9]{8})$/i);
          if (m) {
            const row = db.prepare("SELECT * FROM agents WHERE id LIKE ?").get(`%${m[1]}`) as any;
            if (row) agentId = row.id;
          }
        }
        const agent = agentId
          ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any)
          : null;
        let prompt = "";
        const cwd = agent?.folder || agent?.cwd || process.cwd();
        const isCommander = agent?.is_god === 1 ? true
          : agent?.is_god === 0 ? false
          : (agent?.name && agent.name.toLowerCase().includes("commander")) ||
            (agent?.role && agent.role.toLowerCase().includes("commander")) ||
            (agent?.role === "planner");
        if (isCommander) {
          prompt = buildCommanderHivePrompt({ commanderName: agent?.name || "Michael", folder: cwd });
        } else {
          prompt = buildEmployeeHivePrompt({
            agentId: agentId || "agent",
            agentName: agent?.name || "Agent",
            folder: cwd,
            role: agent?.role,
            // Editing a role file changes the body, which changes the
            // prompt, which changes fingerprint() — so needsIdentity() below
            // sees the session as stale and re-seeds it. That is the whole
            // mechanism for "I edited the role, the live agent picked it up";
            // there is nothing else to invalidate.
            roleDef: loadRole(agent?.role_id, cwd),
          });
        }
        // Only re-seed identity when it is genuinely absent or stale.
        //
        // This used to fire unconditionally, pushing the whole ~900-token
        // identity into a session that already had it. Because the duplicate
        // landed AFTER real work, the most recent instruction the model saw
        // became "you are an agent, read your inbox" — which is why a
        // restarted agent so reliably abandoned what it was doing.
        //
        // `force` is honoured so an operator who explicitly wants a full
        // re-introduction can still have one.
        const engine = `${agent?.provider ?? ""}:${agent?.model ?? ""}`;
        const force = Boolean((msg as any).force);
        if (prompt && needsIdentity(agentId || "", prompt, engine, { force })) {
          queueWrite(activeSession, () => {
            const payload = `\x1b[200~${prompt}\x1b[201~`;
            activeSession.proc.write(payload);
            setTimeout(() => {
              try { activeSession.proc.write("\r"); } catch {}
            }, 250);
          });
          markIdentitySent(activeSession, prompt, engine);
        }
        return;
      }

      if (msg.type === "data" && activeSession) {
        // Through the same queue as router wakes and task submissions: these
        // three all reach one pipe, and a wake landing mid-keystroke used to
        // interleave into a single garbled line.
        queueWrite(activeSession, () => activeSession.proc.write(msg.data));
        return;
      }

      if (msg.type === "resize" && activeSession) {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (cols > 0 && rows > 0) {
          activeSession.cols = cols;
          activeSession.rows = rows;
          try {
            activeSession.proc.resize(cols, rows);
          } catch {}
        }
        return;
      }

      if (msg.type === "kill" && activeSession) {
        try {
          activeSession.proc.kill();
        } catch {}
        sessions.delete(activeSession.id);
        attachedSession = null;
        return;
      }
    });

    socket.on("close", () => {
      if (attachedSession) {
        attachedSession.clients.delete(socket);
      }
    });
  });
}

/** Whether agentId already has a live PTY, before you call
 *  spawnOrGetPtySession — which returns a session either way, so it can't
 *  tell you afterward whether this was a fresh cold start. Callers that
 *  need to know (e.g. whether to delay their first write — see
 *  submitPromptToAgent's comment) check this first. */
export function isPtySessionLive(agentId: string): boolean {
  for (const session of sessions.values()) {
    if (session.agentId === agentId || session.id.endsWith(agentId.slice(-8))) return true;
  }
  return false;
}

/**
 * Kill an agent's live CLI process, if it has one.
 *
 * Needed because the DB row and the OS process were never linked at teardown:
 *  - deleting an agent removed the row and left its CLI running, burning
 *    tokens with nothing left to attribute the spend to, and no UI able to
 *    show or stop it;
 *  - changing an agent's provider/model updated the row and reported
 *    "Restarting — engine will change on next heartbeat" while the old
 *    process kept running the OLD model indefinitely.
 *
 * Returns true if a session was actually killed.
 */
export function killAgentSession(agentId: string): boolean {
  let killed = false;
  for (const [ptyId, session] of sessions) {
    if (session.agentId !== agentId && !session.id.endsWith(agentId.slice(-8))) continue;
    try {
      session.proc.kill();
    } catch {
      /* already dead — still drop it from the map below */
    }
    // onExit normally does this, but a process that was already gone will
    // never fire it, and a stale entry makes isPtySessionLive() lie.
    sessions.delete(ptyId);
    killed = true;
  }
  return killed;
}

function sessionFor(agentId: string): PtySession | null {
  for (const session of sessions.values()) {
    if (session.agentId === agentId || session.id.endsWith(agentId.slice(-8))) return session;
  }
  return null;
}

export function submitPromptToAgent(agentId: string, text: string): boolean {
  if (!text) return false;
  const session = sessionFor(agentId);
  if (!session) return false;
  // Queued, not written directly: this used to race the human's own keystrokes
  // on the same pipe and produce one interleaved line.
  queueWrite(session, () => {
    const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
    session.proc.write(payload);
    setTimeout(() => {
      try { session.proc.write("\r"); } catch {}
    }, 250);
  });
  return true;
}

/**
 * Whether this session still needs the identity prompt.
 *
 * A restart used to re-send the whole ~900-token identity into a live session
 * that already had it — and because the duplicate landed AFTER real work, the
 * most recent instruction the model saw became "you are an agent, read your
 * inbox", which is why restarted agents abandoned what they were doing.
 *
 * Identity is re-sent only when it is genuinely absent or stale.
 */
export function needsIdentity(
  agentId: string,
  identityText: string,
  engine: string,
  opts: { force?: boolean } = {}
): boolean {
  const session = sessionFor(agentId);
  if (!session) return true;                                  // cold start
  if (opts.force) return true;                                // operator asked
  if (!session.identitySentAt) return true;                   // never sent
  if (session.engine !== engine) return true;                 // different model
  if (session.identityVersion !== fingerprint(identityText)) return true; // prompt edited
  return false;
}

/** Record that identity is now in front of this process. */
function markIdentitySent(session: PtySession, identityText: string, engine: string): void {
  session.identitySentAt = new Date().toISOString();
  session.identityVersion = fingerprint(identityText);
  session.engine = engine;
}

/** The one place a ptyId gets built from an agent id, so every caller ends
 *  up at the same session. Before this, routes/projects.ts and
 *  routes/agents.ts named a spawn "pty-<name>-<id-suffix>" (what the
 *  terminal panel opens), while the hive wake path (index.ts) separately
 *  named its own spawn "pty-<provider>-<full-id>" — two different map keys
 *  for what a human would call "the same agent's terminal". A wake-spawned
 *  session and the one the UI opens were two unrelated child processes:
 *  waking an idle agent silently spawned a CLI nobody could ever see, while
 *  the terminal panel showed a second, freshly booted, unrelated one. */
export function ptyIdFor(agentName: string, agentId: string): string {
  return "pty-" + String(agentName).toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + String(agentId).slice(-8);
}

/**
 * Spawn (or reuse) an agent's PTY and deliver a prompt into it, correctly
 * whether the session was already live or is a cold start.
 *
 * A TUI CLI (OpenCode, Claude Code) switches the terminal into raw mode as
 * part of its own boot; a write landing before that switch can be dropped
 * or garbled. doSeed() (above) already works around this for the initial
 * identity prompt on a fresh spawn — this is the same fix for every OTHER
 * caller that spawns-and-writes in one step (the hive wake path, and
 * deliverTaskLocally in task-offers.ts), which used to write immediately
 * and lose the message on a cold boot without any error to show for it.
 *
 * onSubmitted fires at the moment the prompt is actually typed in — not
 * when spawnAndSubmit was called, which on a cold start can be up to 6s
 * earlier. A caller that wants to watch for completion needs to start its
 * clock from the real moment, not this call's return, or it risks matching
 * the still-booting CLI's OWN readiness banner as a false "already done".
 */
export function spawnAndSubmit(
  db: Db, agentId: string, agentName: string, prompt: string, hive?: HiveManager,
  onSubmitted?: () => void
): boolean {
  const wasAlreadyLive = isPtySessionLive(agentId);
  const ptyId = ptyIdFor(agentName, agentId);
  try {
    spawnOrGetPtySession(db, ptyId, agentId, 100, 30, hive);
  } catch {
    return false;
  }
  if (wasAlreadyLive) {
    const ok = submitPromptToAgent(agentId, prompt);
    if (ok) onSubmitted?.();
    return ok;
  }

  // Was `setTimeout(..., 6000)` — a guess that failed in both directions: on a
  // slow cold start the prompt was typed into a still-booting CLI and lost, on
  // a fast one five seconds were wasted. Wait for the CLI's own prompt banner
  // instead, with the same 45s ceiling the `starting` status uses so a silent
  // CLI fails visibly rather than hanging.
  const session = sessionFor(agentId);
  if (!session) return false;
  void whenReady(session).then((ready) => {
    if (!ready) {
      // Never type into a CLI that never came up — that is how a message is
      // silently swallowed. Leave it undelivered so retry/dead-letter sees it.
      try { console.warn(`agent ${agentName} never became ready; prompt not submitted`); } catch {}
      return;
    }
    if (submitPromptToAgent(agentId, prompt)) onSubmitted?.();
  });
  return true;
}

/**
 * Watch a live PTY for it going quiet after a task was submitted into it —
 * the point at which nothing further is happening is treated as the task
 * being done.
 *
 * This does NOT match on "ready for input" banner text the way doSeed()
 * does for a fresh boot, even though that was the first design tried here.
 * Captured directly off a real OpenCode session mid-task: subsequent
 * screen updates are cursor-addressed cell writes (`\x1b[13;6H`, one write
 * per changed region), not full-screen repaints — so a literal substring
 * like "Ask anything" appears exactly once, during the initial boot paint,
 * and never again for the life of the session. Any detector keyed on
 * spotting that text after the first prompt would simply never fire.
 * Reconstructing the actual rendered screen to check what it displays
 * would need a real terminal emulator (e.g. a headless xterm.js) parsing
 * every escape sequence — a much bigger undertaking than this problem
 * warrants. Silence is the content-agnostic signal: same underlying
 * observation (verified on that same capture) that real output stops once
 * a turn finishes — no blink-loop or periodic redraw filling the quiet —
 * so "nothing arrived for quietMs" is actually the more robust proxy here,
 * not a fallback.
 *
 * This is a heuristic, not a real completion protocol — the honest
 * alternative was nothing at all: a locally-delivered task sitting
 * `working` forever until a human noticed and completed it by hand
 * (POST /api/tasks/:id/complete). Known gaps, accepted:
 *   - A CLI that pauses mid-task waiting on the human (a clarifying
 *     question) goes just as quiet as one that finished. There is no way
 *     to tell "done" from "waiting on you" from silence alone.
 *   - It only detects that the CLI stopped, not whether the work
 *     succeeded — callers report `ok: true` regardless. Classifying
 *     success/failure from arbitrary TUI output is a separate, harder
 *     problem than the one this solves.
 *   - A provider that streams continuous non-substantive output (a
 *     progress spinner redrawn every tick, for instance) would never look
 *     quiet and this would never fire — degrading to today's status quo
 *     (manual completion), not to a wrong answer.
 * graceMs skips the moment right after the prompt was submitted, so the
 * terminal echoing the prompt back doesn't itself start the quiet clock.
 *
 * Returns an unsubscribe function. Not wired to task cancellation
 * (Pause/Halt in the UI) — if a human stops the task first, this may still
 * fire later and call onDone, but completeLocalTask already no-ops on a
 * task that's no longer `working`, so that firing is inert rather than
 * wrong.
 */
export function watchForCompletion(
  agentId: string,
  onDone: () => void,
  opts?: { graceMs?: number; quietMs?: number }
): () => void {
  const graceMs = opts?.graceMs ?? 4000;
  const quietMs = opts?.quietMs ?? 8000;

  let session: PtySession | undefined;
  for (const s of sessions.values()) {
    if (s.agentId === agentId || s.id.endsWith(agentId.slice(-8))) {
      session = s;
      break;
    }
  }
  if (!session) return () => {};

  const startedAt = Date.now();
  let fired = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    if (fired) return;
    fired = true;
    disposable.dispose();
    onDone();
  };

  const disposable = session.proc.onData(() => {
    if (fired) return;
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (Date.now() - startedAt < graceMs) return;
    quietTimer = setTimeout(fire, quietMs);
  });

  return () => {
    if (quietTimer) clearTimeout(quietTimer);
    if (!fired) {
      fired = true;
      try { disposable.dispose(); } catch {}
    }
  };
}

// A rendered row of pure decoration or a known CLI-chrome line — the input
// box placeholder, its footer hints, the build-timer line — never the
// actual substance of a reply. Used to filter extractRecentReply's output,
// not to detect anything (that's READY_MARKERS' job).
const CHROME_LINE_MARKERS = [
  "Ask anything", "ctrl+p", "tab agents", "connected to",
  "What would you like", "Tip Run /connect", "Tip ", "commands",
  "Build ·", "Build auto", "esc int",
];

// Box Drawing (U+2500–257F), Block Elements (U+2580–259F), Geometric
// Shapes (U+25A0–25FF), Braille Patterns (U+2800–28FF, dot-matrix
// spinners). Hand-picking individual characters from these ranges is how
// a live reply once posted as a bare progress-bar row (╹▀▀▀▀▀…) straight
// into the chat room: the specific block character OpenCode's progress
// bar happened to use that day wasn't on the list. Matching the whole
// Unicode block instead of enumerating characters means the next one
// this app or a different provider reaches for is already covered.
const DRAWING_CHAR_RANGE = "\\u2500-\\u25FF\\u2800-\\u28FF";
const PURE_DECORATION_LINE = new RegExp(`^[\\s\\-${DRAWING_CHAR_RANGE}✱·⬝▸▹]+$`);
const STARTS_WITH_DRAWING_CHAR = new RegExp(`^[${DRAWING_CHAR_RANGE}]`);

function isChromeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  // A line made up only of box-drawing / block / spinner characters —
  // formatBanner's fallback-shell box border, a progress bar, a rule.
  if (PURE_DECORATION_LINE.test(t)) return true;
  // A line that STARTS inside a drawn box or bar — formatBanner's
  // "│  Claude Code v2.1.241" style content lines, or a labeled progress
  // bar ("▓▓▓▓░░░░ 45%"). Real reply text never opens with one of these
  // characters, so this is a safe signal even with real words after.
  if (STARTS_WITH_DRAWING_CHAR.test(t)) return true;
  return CHROME_LINE_MARKERS.some((m) => t.includes(m));
}

/**
 * Turn a session's raw scrollback (cursor-addressed escape sequences — see
 * watchForCompletion's comment on why those can't be substring-matched)
 * into the readable text an agent just produced, by replaying it through
 * the same rendering engine the browser's own terminal widget uses
 * (`@xterm/xterm`, here as `@xterm/headless` — no DOM, just the buffer).
 * Version-pinned to match `@xterm/xterm` in apps/web so both interpret the
 * same byte stream identically.
 *
 * Bounded, not exact: this reads the tail of the rendered screen and drops
 * lines that look like CLI chrome (the input box, its footer hints, the
 * build timer), not lines from a specific turn — there is no marker in the
 * stream for "this is where the current turn's output starts". In
 * practice the terminal is only ~30 rows, so anything from an earlier turn
 * has almost always scrolled out of this window by the time one completes;
 * a very short combined history is the one case that could still leak a
 * stray earlier line in.
 *
 * Async because it has to be: `Terminal.write()` parses off the calling
 * stack — reading `buffer.active` right after calling it (as a first,
 * unawaited version of this function did) reads a buffer that has not
 * been updated yet and always renders as blank rows. `write`'s own
 * callback parameter is the documented way to know parsing has finished;
 * only after that has fired is the buffer safe to read.
 */
export function extractRecentReply(agentId: string, maxChars = 1800): Promise<string | null> {
  return new Promise((resolve) => {
    let session: PtySession | undefined;
    for (const s of sessions.values()) {
      if (s.agentId === agentId || s.id.endsWith(agentId.slice(-8))) {
        session = s;
        break;
      }
    }
    if (!session || !session.scrollback) {
      resolve(null);
      return;
    }

    const term = new HeadlessTerminal({
      cols: session.cols || 100,
      rows: Math.max(session.rows || 30, 30),
      allowProposedApi: true, // needed for buffer.active — see IBuffer in @xterm/headless
    });
    term.write(session.scrollback, () => {
      try {
        const buf = term.buffer.active;
        const scanFrom = Math.max(0, buf.length - 200);

        // First pass, forward: classify each row, but a soft-wrapped row
        // (line.isWrapped — xterm's own record of "this is a continuation
        // of the row above, not a new one") inherits its predecessor's
        // chrome-ness instead of being judged on its own text. Caught
        // live: the CLI's footer hint ("tab agents  ctrl+p commands")
        // wrapped across two columns, isChromeLine correctly dropped the
        // row carrying "tab agents  ctrl+p co", but the wrapped remainder
        // ("mmands") landed on its own row with no border character and no
        // marker substring left in it — nothing about that row's own text
        // said "chrome", so it was posted as if it were the agent's actual
        // answer. isWrapped is the precise fix a text-shape guess (an
        // earlier version of this function rejected anything opening
        // lowercase) can only approximate — and approximated too broadly:
        // it also rejected an agent's genuine, correct one-word reply
        // ("hi") for the same reason.
        const rowText: string[] = [];
        const rowIsChrome: boolean[] = [];
        for (let y = scanFrom; y < buf.length; y++) {
          const line = buf.getLine(y);
          const raw = line?.translateToString(true) ?? "";
          rowText[y] = raw;
          const ownChrome = isChromeLine(raw);
          rowIsChrome[y] = line?.isWrapped && y > scanFrom
            ? (ownChrome || rowIsChrome[y - 1])
            : ownChrome;
        }

        const lines: string[] = [];
        for (let y = buf.length - 1; y >= scanFrom; y--) {
          if (!rowIsChrome[y]) {
            lines.unshift(rowText[y]);
          } else if (lines.length > 0) {
            break;
          }
          if (lines.length >= 80) break;
        }
        let text = lines.join("\n").trim();
        if (!text) {
          resolve(null);
          return;
        }
        if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
        resolve(text);
      } finally {
        term.dispose();
      }
    });
  });
}

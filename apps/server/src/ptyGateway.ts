import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import * as pty from "node-pty";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getAgentOutput } from "./db.js";
import { buildCommanderHivePrompt, buildEmployeeHivePrompt } from "./hivePrompt.js";

interface PtySession {
  id: string;
  agentId: string;
  proc: pty.IPty;
  scrollback: string;
  clients: Set<WebSocket>;
  cols: number;
  rows: number;
}

const sessions = new Map<string, PtySession>();

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
      HIVE_ROOT: hive ? hive.root() : "",
      AGENT_DIR: (hive && agentId) ? hive.agentDir(agentId) : "",
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
    // Detect when OpenCode / Claude Code is ready for user input
    if (!promptSeeded && initialPrompt) {
      if (
        data.includes("Ask anything") ||
        data.includes("ctrl+p") ||
        data.includes("OpenCode") ||
        data.includes("tab agents") ||
        data.includes("connected to") ||
        data.includes("What would you like") ||
        data.includes("Tip Run /connect") ||
        data.includes("Tip") ||
        data.includes("commands")
      ) {
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
          try {
            const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
            activeSession.proc.write(payload);
            setTimeout(() => {
              try { activeSession.proc.write("\r"); } catch {}
            }, 180);
          } catch {}
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
          });
        }
        if (prompt) {
          try {
            const payload = `\x1b[200~${prompt}\x1b[201~`;
            activeSession.proc.write(payload);
            setTimeout(() => {
              try { activeSession.proc.write("\r"); } catch {}
            }, 250);
          } catch {}
        }
        return;
      }

      if (msg.type === "data" && activeSession) {
        try {
          activeSession.proc.write(msg.data);
        } catch {}
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

export function submitPromptToAgent(agentId: string, text: string): boolean {
  if (!text) return false;
  for (const session of sessions.values()) {
    if (session.agentId === agentId || session.id.endsWith(agentId.slice(-8))) {
      try {
        const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
        session.proc.write(payload);
        setTimeout(() => {
          try { session.proc.write("\r"); } catch {}
        }, 250);
        return true;
      } catch {}
    }
  }
  return false;
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
 */
export function spawnAndSubmit(
  db: Db, agentId: string, agentName: string, prompt: string, hive?: HiveManager
): boolean {
  const wasAlreadyLive = isPtySessionLive(agentId);
  const ptyId = ptyIdFor(agentName, agentId);
  try {
    spawnOrGetPtySession(db, ptyId, agentId, 100, 30, hive);
  } catch {
    return false;
  }
  if (wasAlreadyLive) {
    return submitPromptToAgent(agentId, prompt);
  }
  setTimeout(() => submitPromptToAgent(agentId, prompt), 6000);
  return true;
}

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import * as pty from "node-pty";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Db } from "./db.js";
import { getAgentOutput } from "./db.js";

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
    `/Users/ayush/.nvm/versions/node/v22.14.0/bin/${cmd}`,
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

export function registerPtyGateway(app: FastifyInstance, db: Db, hive?: HiveManager) {
  app.get("/pty-ws", { websocket: true }, (socket: WebSocket) => {
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
              exeArgs = [];
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
              exeArgs = [];
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

          if (agent && cwd && existsSync(cwd) && hive) {
            try {
              const agentsMdPath = join(cwd, "AGENTS.md");
              const isCommander = (agent.name && agent.name.toLowerCase().includes("commander")) ||
                                  (agent.role && agent.role.toLowerCase().includes("commander")) ||
                                  agent.isGod;
              if (isCommander) {
                const roster = hive.getRegistry();
                const subordinates = Object.values(roster.agents || {}).filter((sub: any) => sub.id !== agentId);
                const subList = subordinates.map((s: any) => `- **${s.name}** (ID: \`${s.id}\`, Role: ${s.role || "Specialist"})`).join("\n");

                const content = `# SYSTEM DIRECTIVE: CENTRAL OPERATIONS COMMANDER\n\n` +
                  `You are **${agent.name}**, the Central Operations Commander.\n\n` +
                  `**CRITICAL OPERATIONAL CONSTRAINT**:\n` +
                  `- **DO NOT WRITE SOURCE CODE DIRECTLY.**\n` +
                  `- You are the Commander, NOT a worker bee. Your mission is to analyze requests, formulate architecture on \`~/workspace/hive/board.md\`, log tasks on \`~/workspace/hive/tasks.json\`, and delegate missions to your subordinate employees.\n\n` +
                  `### YOUR SUBORDINATE EMPLOYEES:\n` +
                  `${subList || "- No other agents registered yet."}\n\n` +
                  `### HOW TO DELEGATE TASKS:\n` +
                  `1. Write tasks to the Kanban ledger at \`~/workspace/hive/tasks.json\`.\n` +
                  `2. Send delegation orders by writing a JSON message to your outbox at \`${hive.agentDir(agentId)}/outbox/<id>.json\`:\n` +
                  `   \`{"from": "${agentId}", "to": "<employee-id>", "act": "request", "subject": "...", "body": "..."}\`\n` +
                  `3. Wait for your employees to complete work and report back to your inbox at \`${hive.agentDir(agentId)}/inbox/\`.\n` +
                  `4. Inspect their deliverables and issue final sign-off!\n`;
                writeFileSync(agentsMdPath, content, "utf8");
              }
            } catch {}
          }

          if (!exeCmd) {
            exeCmd = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
            exeArgs = [];
          }

          const userPath = [
            "/Users/ayush/.nvm/versions/node/v22.14.0/bin",
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

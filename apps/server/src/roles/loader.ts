// Agent role definitions, loaded from markdown files.
//
// WHY FILES. A role used to be two hardcoded maps in hivePrompt.ts — six
// one-sentence briefs and six nouns. Adding a role meant editing TypeScript and
// redeploying, and a role could not declare what tools it should get, what it
// is capable of, or what "done" looks like for it.
//
// THE FORMAT is Claude Code's subagent format: YAML frontmatter, then a
// markdown body that is the role's brief. That is deliberate — it means a role
// written for Claude Code loads here, and a role written here loads there, so
// existing agent packs can be adapted instead of every role being written from
// scratch. Claude Code ignores frontmatter keys it does not know, which is what
// lets the LogBridge-specific fields below travel in the same file.
//
// EVERY LogBridge field is optional and has a fallback, because a file borrowed
// from someone else's pack will have none of them.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRole, type OfficeCategory } from "../view.js";

export interface RoleDefinition {
  /** Filename-stable identifier. Arbitrary — NOT the office category. */
  name: string;
  /** One line: when this role should be used. Shown in the Add Agent picker. */
  description: string;
  /** The role's brief — the markdown body, injected into the agent's prompt. */
  body: string;
  /** Reads as English in "you are the ___ on this floor". Falls back to name. */
  noun: string;
  /** Which office room-group this role maps to. Falls back to normalizeRole(). */
  category: OfficeCategory;
  /** Routing capabilities. Default [] — no constraint. */
  capabilities: string[];
  /** Default allowTools at creation. Claude Code's `tools`. */
  tools: string[];
  /** Default denyPaths at creation. Claude Code's `disallowedTools`. */
  disallowedTools: string[];
  /** Preferred model, if the role has an opinion. */
  model: string | null;
  /** Which layer it came from — for debugging "why did I get that prompt". */
  source: "builtin" | "global" | "project";
  /** Absolute path, so an operator can go and edit the thing they are reading. */
  path: string;
}

/**
 * Minimal YAML frontmatter parser.
 *
 * Deliberately NOT a YAML dependency: this project keeps very few, and the
 * subset a role file needs is three shapes —
 *   key: value
 *   key: [a, b]
 *   key:
 *     - a
 * Anything more exotic is not worth a parser we would then have to keep.
 */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } {
  if (!src.startsWith("---")) return { data: {}, body: src.trim() };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: src.trim() };

  const head = src.slice(src.indexOf("\n") + 1, end);
  const body = src.slice(end + 4).trim();
  const data: Record<string, string | string[]> = {};

  let listKey: string | null = null;
  for (const raw of head.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Continuation of a block list started by a previous "key:" line.
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;

    if (rest === "") {           // "key:" — a block list may follow
      listKey = key;
      data[key] = [];
      continue;
    }
    listKey = null;
    if (rest.startsWith("[")) {  // "key: [a, b]"
      data[key] = rest.replace(/^\[|\]$/g, "")
        .split(",").map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      data[key] = unquote(rest);
    }
  }
  return { data, body };
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, "").trim();

const asArray = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];

const asString = (v: string | string[] | undefined): string | null =>
  typeof v === "string" && v ? v : null;

/** "security-auditor" -> "security auditor", so it reads in a sentence. */
function nounFrom(name: string): string {
  return name.replace(/[-_]+/g, " ").trim() || "agent";
}

export function parseRoleFile(
  src: string, path: string, source: RoleDefinition["source"]
): RoleDefinition | null {
  const { data, body } = parseFrontmatter(src);
  const name = asString(data.name);
  // Same rule Claude Code uses: no name means it is documentation, not a role.
  if (!name) return null;

  return {
    name,
    description: asString(data.description) ?? "",
    body,
    noun: asString(data.noun) ?? nounFrom(name),
    // The one place normalizeRole earns its keep: it maps an ARBITRARY role
    // name onto one of the office's six room-groups. It was a lossy accident
    // when roles were an enum; here it is the deliberate fallback.
    category: (asString(data.category) as OfficeCategory | null) ?? normalizeRole(name),
    capabilities: asArray(data.capabilities),
    tools: asArray(data.tools),
    disallowedTools: asArray(data.disallowedTools),
    model: asString(data.model),
    source,
    path,
  };
}

/** Built-in definitions ship next to this file and are read at runtime. */
const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)));

/** Lowest priority first — a later layer with the same `name` wins. */
export function roleSearchPath(projectFolder?: string | null): Array<{ dir: string; source: RoleDefinition["source"] }> {
  const layers: Array<{ dir: string; source: RoleDefinition["source"] }> = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: join(homedir(), ".logbridge", "roles"), source: "global" },
  ];
  if (projectFolder) layers.push({ dir: join(projectFolder, "hive", "roles"), source: "project" });
  return layers;
}

// Cached by directory mtime: editing a role file must take effect without a
// server restart, but re-reading every file on every agent spawn would not.
const cache = new Map<string, { mtimeMs: number; roles: RoleDefinition[] }>();

function readDir(dir: string, source: RoleDefinition["source"]): RoleDefinition[] {
  if (!existsSync(dir)) return [];
  let mtimeMs = 0;
  try { mtimeMs = statSync(dir).mtimeMs; } catch { return []; }

  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.roles;

  const roles: RoleDefinition[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || file.toUpperCase() === "README.MD") continue;
      const path = join(dir, file);
      try {
        const role = parseRoleFile(readFileSync(path, "utf8"), path, source);
        if (role) roles.push(role);
      } catch { /* one unreadable role must not hide the rest */ }
    }
  } catch { return []; }

  cache.set(dir, { mtimeMs, roles });
  return roles;
}

/** Every role visible to this project, later layers overriding earlier ones. */
export function listRoles(projectFolder?: string | null): RoleDefinition[] {
  const byName = new Map<string, RoleDefinition>();
  for (const { dir, source } of roleSearchPath(projectFolder)) {
    for (const role of readDir(dir, source)) byName.set(role.name, role);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One role by name, or null. Matching is case-insensitive. */
export function loadRole(name: string | null | undefined, projectFolder?: string | null): RoleDefinition | null {
  if (!name) return null;
  const want = name.toLowerCase();
  return listRoles(projectFolder).find((r) => r.name.toLowerCase() === want) ?? null;
}

/** Test seam — the mtime cache would otherwise persist across cases. */
export function resetRoleCache(): void {
  cache.clear();
}

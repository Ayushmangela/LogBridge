// Role definitions are files, so the things that can go wrong are file things:
// a borrowed file that has none of our fields, a project file that should beat
// a built-in, a role body that quietly grows into a token bill. Each is pinned
// below.
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter, parseRoleFile, listRoles, loadRole, resetRoleCache,
} from "./roles/loader.js";
import { buildEmployeeHivePrompt } from "./hivePrompt.js";

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "roles");

let tmp = "";
function projectWithRole(file: string, contents: string): string {
  tmp = mkdtempSync(join(tmpdir(), "lb-roles-"));
  const dir = join(tmp, "hive", "roles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), contents, "utf8");
  return tmp;
}

beforeEach(() => resetRoleCache());
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  resetRoleCache();
});

describe("frontmatter parsing", () => {
  test("reads scalars, inline arrays and block lists", () => {
    const { data, body } = parseFrontmatter(
      `---\nname: auditor\ndescription: "Finds holes"\ntools: [Read, Grep]\ncapabilities:\n  - audit\n  - report\n---\n\n## Mission\nBody text.\n`
    );
    expect(data.name).toBe("auditor");
    // Quotes are stripped — a value the author quoted must not arrive quoted.
    expect(data.description).toBe("Finds holes");
    expect(data.tools).toEqual(["Read", "Grep"]);
    expect(data.capabilities).toEqual(["audit", "report"]);
    expect(body.startsWith("## Mission")).toBe(true);
  });

  test("a file with no frontmatter is all body, not a parse error", () => {
    const { data, body } = parseFrontmatter("# Just notes\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just notes");
  });

  test("a comment line inside the frontmatter is ignored, not read as a key", () => {
    const { data } = parseFrontmatter(`---\n# this explains the next line\nname: x\n---\nbody`);
    expect(Object.keys(data)).toEqual(["name"]);
  });
});

describe("a file borrowed from another agent pack still loads", () => {
  // The whole reason for using Claude Code's format: someone else's subagent
  // file has `name`/`description`/`tools` and none of the LogBridge keys.
  const borrowed = `---\nname: security-auditor\ndescription: Reviews code for vulnerabilities\ntools: [Read, Grep, Glob]\n---\n\nYou audit code for security problems.\n`;

  test("every LogBridge field falls back rather than failing", () => {
    const r = parseRoleFile(borrowed, "/x/security-auditor.md", "project")!;
    expect(r).not.toBeNull();
    expect(r.capabilities).toEqual([]);   // no routing constraint
    expect(r.model).toBeNull();
    // "security-auditor" has to read as English in "you are the ___".
    expect(r.noun).toBe("security auditor");
  });

  test("an arbitrary role name still gets an office category", () => {
    // normalizeRole maps it onto one of the six room-groups, so the agent has
    // a desk to stand at even though nothing declared one.
    const r = parseRoleFile(borrowed, "/x/security-auditor.md", "project")!;
    expect(["developer", "research", "qa", "review", "docs", "planner"]).toContain(r.category);
  });

  test("a file with no name is documentation, not a role", () => {
    expect(parseRoleFile("---\ndescription: notes\n---\nhi", "/x/notes.md", "project")).toBeNull();
  });
});

describe("resolution order", () => {
  test("a project file beats the built-in of the same name", () => {
    const folder = projectWithRole(
      "developer.md",
      `---\nname: developer\ndescription: This project's own developer\nnoun: house developer\n---\n\nProject-specific brief.\n`
    );
    const r = loadRole("developer", folder)!;
    expect(r.source).toBe("project");
    expect(r.noun).toBe("house developer");
    expect(r.body).toContain("Project-specific brief.");
  });

  test("built-ins are still visible alongside a project's own roles", () => {
    const folder = projectWithRole(
      "security-auditor.md",
      `---\nname: security-auditor\ndescription: Finds holes\n---\n\nAudit.\n`
    );
    const names = listRoles(folder).map((r) => r.name);
    expect(names).toContain("security-auditor");
    expect(names).toContain("qa");
  });

  test("no project folder means built-ins only", () => {
    expect(listRoles(null).every((r) => r.source !== "project")).toBe(true);
  });

  test("an unknown name resolves to null rather than throwing", () => {
    expect(loadRole("no-such-role", null)).toBeNull();
    expect(loadRole(null, null)).toBeNull();
  });
});

describe("built-in definitions", () => {
  const files = readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".md"));

  test("every built-in .md parses as a role", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = parseRoleFile(readFileSync(join(BUILTIN_DIR, f), "utf8"), f, "builtin");
      expect(r, `${f} failed to parse`).not.toBeNull();
      expect(r!.description, `${f} has no description — the picker would show a blank`).not.toBe("");
    }
  });

  test("the body of a role stays within its token budget", () => {
    // The body is injected in full on every cold start. This is the guard that
    // stops a role file growing into a bill nobody notices; raise it on
    // purpose, in a commit that says why, or not at all.
    for (const r of listRoles(null)) {
      expect(r.body.length, `${r.name} body is ${r.body.length} chars`).toBeLessThan(2000);
    }
  });
});

describe("the prompt an agent actually receives", () => {
  test("no role definition means the prompt is unchanged from before role files existed", () => {
    const base = { agentId: "a", agentName: "n", folder: "/tmp/p", role: "developer" };
    expect(buildEmployeeHivePrompt({ ...base, roleDef: null }))
      .toBe(buildEmployeeHivePrompt(base));
  });

  test("a definition replaces the built-in brief and keeps the floor protocol", () => {
    const roleDef = parseRoleFile(
      `---\nname: security-auditor\ndescription: d\nnoun: security auditor\n---\n\nYou audit code for security problems.\n`,
      "/x.md", "project"
    );
    const p = buildEmployeeHivePrompt({
      agentId: "a", agentName: "Nia", folder: "/tmp/p", role: "developer", roleDef,
    });
    expect(p).toContain("Nia\", the security auditor");
    expect(p).toContain("You audit code for security problems.");
    // The category's built-in brief must NOT also be in there — two briefs is
    // how an agent ends up doing the job it was not given.
    expect(p).not.toContain("You implement.");
    // ...but everything about the floor still is.
    expect(p).toContain("$AGENT_DIR/inbox/");
    expect(p).toContain("BEFORE YOU FINISH");
  });

  test("the same agent row always produces the same prompt", () => {
    // needsIdentity() fingerprints this string. If it were not deterministic,
    // every reseed would look stale and re-push the identity into a working
    // session — the exact bug that made restarted agents abandon their work.
    const opts = { agentId: "a", agentName: "n", folder: "/tmp/p", role: "qa" };
    expect(buildEmployeeHivePrompt(opts)).toBe(buildEmployeeHivePrompt(opts));
  });
});

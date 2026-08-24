// Turning a goal into tasks (PLANNING.md).
//
// The orchestrator decides WHO runs a task; this decides WHAT tasks exist —
// the thing `ORCHESTRATOR.md` listed as impossible while no LLM was wired in.
// A real CLI can now do it, so a "plan" is just a normal task whose *output*
// happens to be a list of other tasks.
//
// Everything here is server-side and pure. The runner needs no changes: it
// runs the planning task like any other, and the server reads the output it
// already logs.

/** The prompt handed to the agent. Deliberately rigid about the output shape —
 *  a model given latitude produces prose, and prose is not a task list. */
export function planPrompt(goal: string, maxTasks = 6): string {
  return [
    `Break this goal into 2-${maxTasks} concrete engineering tasks.`,
    "",
    `Goal: ${goal}`,
    "",
    "Reply with ONLY a JSON array, no prose. Each element:",
    '{"title": "<short imperative task>", "capability": "<one lowercase word or null>"}',
  ].join("\n");
}

export interface PlannedTask {
  title: string;
  capability: string | null;
}

const MAX_TASKS = 12;      // a plan longer than this is a runaway, not a plan
const MAX_TITLE = 140;

/**
 * Pull a task list out of whatever the CLI actually said.
 *
 * Verified against a real `claude` decomposition (test-support/
 * claude-plan.sample.txt), which returned a bare JSON array. The other shapes
 * handled here — fenced blocks, prose wrapped around JSON, a markdown list —
 * are defensive: models are not consistent between runs, and the cost of
 * guessing wrong is a silently empty plan.
 *
 * Returns [] when nothing usable is found. The caller must treat that as a
 * failed plan rather than an empty one.
 */
export function parsePlan(raw: string): PlannedTask[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  for (const candidate of jsonCandidates(text)) {
    const tasks = fromJson(candidate);
    if (tasks.length) return tasks;
  }
  // Last resort: a markdown list. Worse than JSON — no capabilities — but a
  // plan with no capabilities still routes, it just routes to anyone.
  return fromMarkdownList(text);
}

/** Substrings that might be JSON, best first. */
function* jsonCandidates(text: string): Generator<string> {
  // ```json … ``` or ``` … ```
  const fenced = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fenced) yield m[1];

  yield text;

  // Prose around a bare array: take the outermost [ … ].
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first !== -1 && last > first) yield text.slice(first, last + 1);
}

function fromJson(candidate: string): PlannedTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.trim());
  } catch {
    return [];
  }
  // Some models wrap the array in an object: {"tasks": [...]}.
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.tasks)
      ? (parsed as any).tasks
      : null;
  if (!arr) return [];

  return normalise(
    arr.map((t: any) => ({
      // Accept the obvious synonyms rather than dropping a whole plan over
      // a key name.
      title: t?.title ?? t?.task ?? t?.name ?? (typeof t === "string" ? t : ""),
      capability: t?.capability ?? t?.cap ?? null,
    }))
  );
}

function fromMarkdownList(text: string): PlannedTask[] {
  const items = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+[.)])\s+/.test(l))
    .map((l) => ({ title: l.replace(/^([-*]|\d+[.)])\s+/, ""), capability: null }));
  return normalise(items);
}

function normalise(items: { title: unknown; capability: unknown }[]): PlannedTask[] {
  const seen = new Set<string>();
  const out: PlannedTask[] = [];
  for (const it of items) {
    const title = String(it.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue; // a model repeating itself isn't two tasks
    seen.add(key);

    let capability: string | null = null;
    const c = it.capability;
    if (typeof c === "string" && c.trim() && c.trim().toLowerCase() !== "null") {
      capability = c.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
    }
    out.push({ title, capability });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

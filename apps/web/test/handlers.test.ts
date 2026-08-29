// A safety net for splitting the browser bundle.
//
// `apps/web/js/app.js` is ~8,000 lines and has no behavioural tests, which
// makes breaking it apart risky: the markup and the app itself both wire
// buttons with inline `onclick="foo()"`, and those resolve against `window`.
// Module scope is NOT global scope, so the moment a function moves into a
// module it stops being reachable unless something assigns it to `window`.
//
// That is not hypothetical — extracting the script out of index.html broke
// the "Open Office" button exactly this way, and nothing caught it but a
// human clicking. These tests catch that whole class statically, so the file
// can be split further without each move being a gamble.
//
// They are deliberately structural, not behavioural. Real interaction
// coverage needs a browser (Playwright); this is the cheap part that pays for
// itself immediately.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const js = readFileSync(join(webRoot, "js", "app.js"), "utf8");

/** Identifiers invoked from an inline handler attribute. */
function handlersIn(source: string): Set<string> {
  const names = new Set<string>();
  // onclick="foo(...)" and onclick="if (x) foo(...)"
  for (const m of source.matchAll(/on[a-z]+\s*=\s*\\?["'`]\s*(?:if\s*\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(m[1]);
  }
  return names;
}

const RESERVED = new Set(["if", "return", "function", "for", "while", "switch", "typeof", "new", "await"]);

function isReachable(name: string): boolean {
  // Assigned to window somewhere, in any of the shapes the file uses.
  return (
    new RegExp(`window\\.${name}\\s*=`).test(js) ||
    new RegExp(`window\\[["']${name}["']\\]\\s*=`).test(js)
  );
}

describe("every inline handler resolves at runtime", () => {
  test("handlers used in index.html are on window", () => {
    const missing = [...handlersIn(html)].filter((n) => !RESERVED.has(n) && !isReachable(n));
    expect(missing, `these are wired in markup but never assigned to window: ${missing.join(", ")}`).toEqual([]);
  });

  test("handlers in markup the app generates are on window", () => {
    // The app builds HTML with inline handlers too (project cards, roster
    // rows, trigger lists). Those are the easiest to miss, because they only
    // fail when that particular list is rendered.
    const missing = [...handlersIn(js)].filter((n) => !RESERVED.has(n) && !isReachable(n));
    expect(missing, `generated markup calls these, but they are not on window: ${missing.join(", ")}`).toEqual([]);
  });

  test("the check itself is not vacuous", () => {
    // If the regex silently stopped matching, both tests above would pass
    // while proving nothing.
    expect(handlersIn(html).size).toBeGreaterThan(20);
    expect(isReachable("setView"), "setView is definitely wired from markup").toBe(true);
    expect(isReachable("thisFunctionDoesNotExist")).toBe(false);
  });
});

describe("the bundle stays split", () => {
  test("index.html is markup, not a program", () => {
    // It was 9,855 lines with ~8,000 of inline JS. Re-inlining would undo the
    // split silently; this fails loudly instead.
    expect(html.split("\n").length).toBeLessThan(1500);
    expect(html).toContain("/js/app.js");
    expect(html).toContain("/css/app.css");
  });

  test("no stray inline <script> body crept back in", () => {
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    const substantial = inline.filter((m) => m[1].trim().split("\n").length > 5);
    expect(substantial.length, "put new code in js/, not back in index.html").toBe(0);
  });
});

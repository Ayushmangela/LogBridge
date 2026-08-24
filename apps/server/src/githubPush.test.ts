// Push reconstruction. Polling can only see commits, never pushes, so a push
// is INFERRED from runs of consecutive commits by one author inside a time
// window. That inference is the risky part — these tests pin its edges,
// including where it is deliberately wrong.
import { describe, expect, test } from "vitest";
import { groupCommitsIntoPushes, type Commit } from "./github.js";

const T0 = Date.parse("2026-01-01T12:00:00Z");
// Commits arrive newest-first from the API, which is why order matters here.
const c = (sha: string, author: string, minutesAfterT0: number, message = "msg"): Commit => ({
  sha, author, message, at: new Date(T0 + minutesAfterT0 * 60_000).toISOString(),
});

const shas = (groups: Commit[][]) => groups.map((g) => g.map((x) => x.sha));

describe("groupCommitsIntoPushes", () => {
  test("no commits is no pushes", () => {
    expect(groupCommitsIntoPushes([])).toEqual([]);
  });

  test("one commit is one push", () => {
    expect(shas(groupCommitsIntoPushes([c("a", "sam", 0)]))).toEqual([["a"]]);
  });

  test("commits close together by one author are a single push, oldest first", () => {
    // newest-first input, as the API returns it
    const input = [c("c", "sam", 4), c("b", "sam", 2), c("a", "sam", 0)];
    expect(shas(groupCommitsIntoPushes(input))).toEqual([["a", "b", "c"]]);
  });

  test("a different author starts a new push even seconds later", () => {
    const input = [c("b", "maya", 1), c("a", "sam", 0)];
    expect(shas(groupCommitsIntoPushes(input))).toEqual([["a"], ["b"]]);
  });

  test("a gap wider than the window splits the push", () => {
    const input = [c("b", "sam", 30), c("a", "sam", 0)];
    expect(shas(groupCommitsIntoPushes(input))).toEqual([["a"], ["b"]]);
  });

  test("the window is inclusive at its edge", () => {
    const win = 10 * 60_000;
    expect(shas(groupCommitsIntoPushes([c("b", "sam", 10), c("a", "sam", 0)], win))).toEqual([["a", "b"]]);
    expect(shas(groupCommitsIntoPushes([c("b", "sam", 11), c("a", "sam", 0)], win))).toEqual([["a"], ["b"]]);
  });

  test("interleaved authors never merge", () => {
    const input = [c("d", "sam", 3), c("c", "maya", 2), c("b", "sam", 1), c("a", "maya", 0)];
    expect(shas(groupCommitsIntoPushes(input))).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  test("groups come out oldest-first so the feed reads chronologically", () => {
    const input = [c("late", "sam", 60), c("early", "sam", 0)];
    const g = groupCommitsIntoPushes(input);
    expect(g[0][0].sha).toBe("early");
    expect(g[1][0].sha).toBe("late");
  });

  test("KNOWN APPROXIMATION: two real pushes inside the window merge into one", () => {
    // Polling cannot distinguish these — there is no push boundary in the
    // commits API. Documented in github.ts rather than pretended away; this
    // test exists so the limitation is explicit rather than discovered.
    const input = [c("b", "sam", 1), c("a", "sam", 0)];
    expect(groupCommitsIntoPushes(input)).toHaveLength(1);
  });

  test("an unparseable timestamp doesn't crash the grouping", () => {
    const bad = { sha: "x", author: "sam", message: "m", at: "not-a-date" } as Commit;
    expect(() => groupCommitsIntoPushes([bad, c("a", "sam", 0)])).not.toThrow();
  });
});

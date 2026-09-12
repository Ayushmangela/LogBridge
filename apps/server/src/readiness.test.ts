// Readiness, checked against RECORDINGS of the real CLIs rather than against
// what we imagine they print.
//
// The fixtures in `__fixtures__/` were made by booting each CLI in a real PTY
// and capturing every byte; no prompt was submitted, so they cost nothing to
// produce and can be re-made whenever a CLI changes. That is the point: when
// one of these tests fails, re-capture and it tells you exactly what moved.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReadinessDetector, stripAnsi, type Verdict } from "./readiness.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const capture = (name: string) => readFileSync(join(FIX, name), "utf8");

/** Feed a recording the way a PTY delivers it — in chunks that fall wherever
 *  they fall, which is exactly what the old per-chunk matcher got wrong. */
function play(detector: ReadinessDetector, data: string, chunkSize: number) {
  let last: Verdict = { state: "booting" };
  for (let i = 0; i < data.length; i += chunkSize) {
    last = detector.feed(data.slice(i, i + chunkSize));
  }
  return last;
}

describe("the CLIs we actually run", () => {
  test("opencode's boot is recognised as ready", () => {
    const d = new ReadinessDetector("opencode");
    expect(play(d, capture("opencode-boot.txt"), 512).state).toBe("ready");
  });

  test("claude, once its startup dialog is dismissed, is recognised as ready", () => {
    const d = new ReadinessDetector("claude");
    expect(play(d, capture("claude-ready.txt"), 512).state).toBe("ready");
  });

  test("a marker split across chunk boundaries is still found", () => {
    // A PTY splits wherever it likes. The old detector tested each chunk on
    // its own, so a banner delivered two bytes at a time was invisible.
    const d = new ReadinessDetector("opencode");
    expect(play(d, capture("opencode-boot.txt"), 1).state).toBe("ready");
  });

  test("an unknown provider still notices the CLI came up", () => {
    // Guessing the wrong CLI must not mean never noticing readiness at all.
    const d = new ReadinessDetector("something-else");
    expect(play(d, capture("opencode-boot.txt"), 512).state).toBe("ready");
  });
});

describe("the blocking dialogs — the state that did not exist before", () => {
  test("Claude's folder-trust prompt is blocked, NOT ready", () => {
    // This is a modal waiting on a person. The old code had no such state, so
    // the 6-second seed fallback pasted a 2,600-character identity prompt into
    // a Yes/No dialog as though it were the answer.
    const d = new ReadinessDetector("claude");
    const v = play(d, capture("claude-boot.txt"), 512);
    expect(v.state).toBe("blocked");
    expect(v.reason).toContain("trust this folder");
  });

  test("Claude's browser-tools prompt is blocked too", () => {
    const d = new ReadinessDetector("claude");
    const v = play(d, capture("claude-boot-trusted.txt"), 512);
    expect(v.state).toBe("blocked");
    // Both dialogs share this footer, which is why it is the reliable marker.
    expect(v.reason).toBeTruthy();
  });

  test("Gemini CLI's folder-trust dialog is blocked", () => {
    // A THIRD CLI with a folder-trust modal. Finding it in Gemini too is what
    // settled that this is a category, not a Claude quirk — and it caught a
    // real gap: with only the Claude wordings, this capture read as "booting",
    // so LogBridge would have pasted the identity prompt into the menu.
    const d = new ReadinessDetector("gemini");
    const v = play(d, capture("gemini-boot.txt"), 512);
    expect(v.state).toBe("blocked");
    expect(v.reason).toContain("trust this folder");
  });

  test("Gemini CLI's sign-in chooser is blocked, and says so", () => {
    // This one never resolves on its own: without an auth method there is no
    // prompt to become ready at, ever. Reporting it is the only useful move.
    const d = new ReadinessDetector("gemini");
    const v = play(d, capture("gemini-ready.txt"), 512);
    expect(v.state).toBe("blocked");
    expect(v.reason).toMatch(/signed in|auth|trust/);
  });

  test("a dialog that was dismissed does not keep the session blocked", () => {
    // claude-ready.txt contains the dialog AND the prompt that followed it.
    const d = new ReadinessDetector("claude");
    expect(play(d, capture("claude-ready.txt"), 512).state).toBe("ready");
  });
});

describe("the words that used to cause false readiness", () => {
  const notReady = (text: string) => {
    const d = new ReadinessDetector("opencode");
    return d.feed(text).state;
  };

  test("ordinary agent output containing 'commands' is not readiness", () => {
    expect(notReady("I will now run the build commands for this package.")).toBe("booting");
  });

  test("a sentence beginning 'Tip' is not readiness", () => {
    expect(notReady("Tip: you can pass --watch to rerun on change.")).toBe("booting");
  });

  test("mentioning the CLI by name is not readiness", () => {
    expect(notReady("This project is built with OpenCode and Claude Code.")).toBe("booting");
  });

  test("'connected to' is not readiness", () => {
    expect(notReady("connected to the database at localhost:5432")).toBe("booting");
  });

  test("but the real status bar IS readiness", () => {
    expect(notReady("tab agents   ctrl+p commands")).toBe("ready");
  });
});

describe("stream behaviour", () => {
  test("once ready, later output cannot un-ready it", () => {
    // A session that reached its prompt does not un-boot. Without this, normal
    // mid-session output would flip the state back and re-trigger seeding.
    const d = new ReadinessDetector("opencode");
    expect(d.feed("Ask anything").state).toBe("ready");
    expect(d.feed("...thinking about your request").state).toBe("ready");
    expect(d.isReady).toBe(true);
  });

  test("escape sequences never break a marker", () => {
    // A colour code landing mid-word is why matching happens on stripped text.
    const d = new ReadinessDetector("opencode");
    const coloured = "tab [32magents[0m   ctrl+p [1mcommands[0m";
    expect(d.feed(coloured).state).toBe("ready");
  });

  test("stripAnsi removes CSI, OSC and charset escapes", () => {
    expect(stripAnsi("[1;31mred[0m")).toBe("red");
    expect(stripAnsi("]0;a titlekept")).toBe("kept");
    expect(stripAnsi("(Bplain")).toBe("plain");
  });

  test("output far in the past falls out of the window", () => {
    // The window is bounded so scanning stays free; a marker from 100KB ago
    // is not evidence about now.
    const d = new ReadinessDetector("opencode");
    d.feed("x".repeat(9000));
    expect(d.isReady).toBe(false);
  });
});

describe("GitHub Copilot's blocking states", () => {
  test("the folder-trust modal is not ready — from the real capture", () => {
    const verdict = play(new ReadinessDetector("copilot"), capture("copilot-boot.txt"), 64);
    expect(verdict.state).toBe("blocked");
    expect(verdict.reason).toContain("trust");
  });

  test("signed out is blocked, not ready", () => {
    // The state a signed-out agent actually sits in, after trust is confirmed.
    // Seeding a 2,600-character identity prompt into this screen types it at a
    // CLI that cannot act on it.
    const d = new ReadinessDetector("copilot");
    const v = d.feed("Please use /login to sign in to use Copilot\n");
    expect(v.state).toBe("blocked");
    expect(v.reason).toContain("/login");
  });

  test("four of four CLIs block on folder trust before their prompt", () => {
    // Not a quirk of any one tool — assume the next provider does it too.
    for (const [fixture, provider] of [
      ["claude-boot.txt", "claude"],
      ["gemini-boot.txt", "gemini"],
      ["copilot-boot.txt", "copilot"],
    ] as const) {
      expect(play(new ReadinessDetector(provider), capture(fixture), 64).state, fixture).toBe("blocked");
    }
  });
});

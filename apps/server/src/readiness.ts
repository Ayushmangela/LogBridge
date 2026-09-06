// Is this CLI actually ready for input?
//
// WHAT WAS WRONG. The old test was `data.includes(m)` over this list:
//
//   "Ask anything", "ctrl+p", "OpenCode", "tab agents", "connected to",
//   "What would you like", "Tip Run /connect", "Tip", "commands"
//
// Four of those are words that appear in ordinary agent output. "commands"
// matches "running commands". "Tip" matches any sentence beginning with it.
// "OpenCode" is a brand name the agent may simply mention. So a CLI could be
// declared ready in the middle of printing something, and the ~2,600-character
// identity prompt would be typed into a terminal that was not at a prompt.
//
// It was also wrong in the other direction: markers were checked per raw
// chunk, and a PTY delivers arbitrary chunk boundaries, so a marker split
// across two reads was never seen at all.
//
// WHERE THESE MARKERS COME FROM. Real captures, in `__fixtures__/`, made by
// booting each CLI in a real PTY and recording every byte — no prompt
// submitted, so no tokens spent. `readiness.test.ts` asserts the detector
// against those recordings, which is the point: when a CLI changes its banner,
// re-capture and the test tells you what broke.
//
// THE THIRD STATE. Both CLIs can open on a modal that BLOCKS input — Claude
// Code asks "is this a project you trust?" in a new folder, and asks again
// about browser tools. Neither is ready, and neither is booting: they are
// waiting for a person. The old code had no such state, so after the 6-second
// seed fallback the identity prompt was pasted into a Yes/No dialog as if it
// were an answer to it.

const ESC = "\u001b";

/** Terminal escapes: OSC, CSI, charset selects, and lone two-byte sequences.
 *  Stripped before matching because a colour code can land mid-word and
 *  silently break a marker. */
export function stripAnsi(s: string): string {
  return s
    // OSC ... terminated by BEL or ST
    .replace(new RegExp(`${ESC}\\][^${ESC}]*(?:\\u0007|${ESC}\\\\)`, "g"), "")
    // CSI
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    // charset selection, keypad modes, and any other two-byte escape
    .replace(new RegExp(`${ESC}[()][A-B0-2]`, "g"), "")
    .replace(new RegExp(`${ESC}[=><]`, "g"), "")
    .replace(new RegExp(`${ESC}[@-Z\\\\-_]`, "g"), "");
}

export type ReadyState = "booting" | "ready" | "blocked";

export interface Verdict {
  state: ReadyState;
  /** For "blocked": what the CLI is waiting for, in words a human can act on. */
  reason?: string;
}

/**
 * Phrases that only appear once the input prompt is up.
 *
 * Every one is multi-word and taken from a capture. Single generic words are
 * deliberately absent — that was the original bug.
 */
const READY: Record<string, string[]> = {
  // __fixtures__/opencode-boot.txt
  opencode: ["Ask anything", "tab agents", "ctrl+p commands", "Tip Run /connect"],
  // __fixtures__/claude-ready.txt
  claude: ["shift+tab to cycle", "auto mode on", 'Try "'],
  // Gemini CLI has NO verified ready markers here on purpose. Reaching its
  // prompt requires choosing an auth method and completing a sign-in, which is
  // not something this project should automate, so there is no capture to
  // derive them from. Inventing plausible strings is exactly the mistake the
  // original list made. Until someone signs in and re-captures, a gemini
  // session falls through to READY_ANY and, failing that, to the 45s ceiling —
  // and its BLOCKED states are detected, which is the case that actually bites.
};

/** Checked when the provider is unknown, or as a second chance for a CLI that
 *  is not the one we thought it was. */
const READY_ANY = [...new Set(Object.values(READY).flat())];

/**
 * A modal is up and a person has to answer it.
 *
 * "Enter to confirm" is the footer BOTH Claude dialogs share, which makes it
 * the reliable one; the trust wording is kept because it is the case an
 * operator will actually hit, and naming it produces a message they can act on
 * rather than "something is blocked".
 */
const BLOCKED: Array<{ match: string; reason: string }> = [
  // Claude Code — __fixtures__/claude-boot.txt
  {
    match: "Is this a project you created or one you trust",
    reason: "Claude Code is asking whether you trust this folder",
  },
  {
    match: "Yes, I trust this folder",
    reason: "Claude Code is asking whether you trust this folder",
  },
  // Gemini CLI — __fixtures__/gemini-boot.txt. A THIRD CLI with a folder-trust
  // modal, which is what settled that this is a category and not a Claude
  // quirk: every one of these tools now guards against being pointed at a
  // hostile directory, and every one of them does it before the prompt.
  {
    match: "Do you trust the files in this folder",
    reason: "Gemini CLI is asking whether you trust this folder",
  },
  // Gemini CLI — __fixtures__/gemini-ready.txt. Not signed in, so it cannot
  // reach a prompt at all until a person chooses an auth method and completes
  // a sign-in. An agent on this screen will never become ready on its own.
  {
    match: "No authentication method selected",
    reason: "Gemini CLI is not signed in and is asking for an auth method",
  },
  // Generic modal footers, last so a specific reason wins when one applies.
  {
    match: "Enter to confirm",
    reason: "the CLI is waiting on a confirmation dialog",
  },
  {
    match: "(Use Enter to select)",
    reason: "the CLI is waiting on a menu selection",
  },
];

/**
 * Whitespace-insensitive comparison.
 *
 * NOT a nicety. A TUI positions each word with a cursor move instead of
 * emitting spaces, so Claude Code's trust dialog arrives on the wire as
 * "Isthisaprojectyoucreatedoroneyoutrust" — the phrase is there, the spaces
 * are not. Matching the literal sentence found nothing. Both sides are
 * squashed so a marker matches however the terminal chose to lay it out.
 */
function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Enough to hold a marker split across several chunks, small enough that
 *  scanning it on every read stays free. A TUI redraws the whole screen, so
 *  the window regularly contains the entire prompt banner. */
const WINDOW = 4096;

/**
 * Feed it every chunk the PTY produces; it tells you what state the CLI is in.
 *
 * Stateful on purpose: readiness is a property of the stream, not of one
 * chunk, and treating each read independently is what made a split marker
 * invisible.
 */
export class ReadinessDetector {
  private window = "";
  /** The same window with whitespace removed — see squash(). */
  private squashed = "";
  private markers: string[];
  private settled: ReadyState = "booting";

  constructor(provider?: string | null) {
    const key = String(provider ?? "").toLowerCase();
    // An unknown provider gets every marker rather than none: a wrong guess
    // about WHICH cli is running must not mean we never notice it came up.
    this.markers = READY[key] ?? READY_ANY;
  }

  /** The state after this chunk. Once ready, always ready — a CLI that has
   *  reached its prompt does not un-boot, and later output would otherwise
   *  flip it back to "booting" mid-session. */
  feed(chunk: string): Verdict {
    if (this.settled === "ready") return { state: "ready" };

    this.window = (this.window + stripAnsi(chunk)).slice(-WINDOW);
    this.squashed = squash(this.window);

    // Ready wins over blocked: a dismissed dialog and the prompt banner can
    // sit in the same window, and in that order the dialog is already answered.
    const hit = (m: string) =>
      this.window.includes(m) || this.squashed.includes(squash(m));
    if (this.markers.some(hit) || READY_ANY.some(hit)) {
      this.settled = "ready";
      return { state: "ready" };
    }

    const blocked = BLOCKED.find((b) => hit(b.match));
    if (blocked) return { state: "blocked", reason: blocked.reason };

    return { state: "booting" };
  }

  /** For callers that just want the old boolean. */
  get isReady(): boolean {
    return this.settled === "ready";
  }
}

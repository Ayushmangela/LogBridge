// Disk-backed outbox: while the socket is down, outbound envelopes queue
// here instead of vanishing. Flushed in order on reconnect, truncated after.
// This — plus the server's lease sweep and late-result reconciliation — is
// the entire offline story. See SYSTEM.md §3d.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class Outbox {
  private path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "outbox.jsonl");
  }

  push(envelope: unknown) {
    appendFileSync(this.path, JSON.stringify(envelope) + "\n");
  }

  drain(): unknown[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    if (!raw.trim()) return [];
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  clear() {
    writeFileSync(this.path, "");
  }
}

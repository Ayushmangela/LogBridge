// Node identity verification: trust-on-first-sight, pubkey pinned after that.
//
// A machine proves it holds the private key for the pubkey it claims by
// signing a server-issued random nonce. First time we see a machine id, we
// register it with whatever pubkey it presents (TOFU). Every time after
// that, the pubkey must match what we stored — otherwise someone is trying
// to impersonate an already-known machine, and we reject the connection.
import { randomBytes, verify as cryptoVerify } from "node:crypto";

export function makeChallenge(): string {
  return randomBytes(32).toString("base64");
}

export function verifySignature(pubkeyPem: string, nonce: string, signatureB64: string): boolean {
  try {
    return cryptoVerify(
      null, // Ed25519: algorithm is implied by the key type
      Buffer.from(nonce, "utf8"),
      pubkeyPem,
      Buffer.from(signatureB64, "base64")
    );
  } catch {
    return false;
  }
}

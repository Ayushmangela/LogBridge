// Node identity: an Ed25519 keypair generated once, on this machine, and
// never transmitted. See SYSTEM.md §3a and PLAN.md's "no automatic access"
// principle — this key is what the server's trust-on-first-sight pins to.
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  machineId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  /** X25519 key for opening sealed payloads (SEALED.md). Never transmitted. */
  sealingPrivateKey: KeyObject;
  /** The matching public key, base64 SPKI DER — this one IS published. */
  sealingPublicKeyB64: string;
  sign(nonce: string): string;
}

// Loads a persisted key or generates one, writing it 0600. Same treatment
// for both keys — a sealing key that regenerated on restart would silently
// make every message anyone had already sealed to this machine unopenable.
function loadOrCreateKey(path: string, type: "ed25519" | "x25519"): KeyObject {
  if (existsSync(path)) return createPrivateKey(readFileSync(path, "utf8"));
  const pair = generateKeyPairSync(type as "ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(path, pem, { mode: 0o600 });
  chmodSync(path, 0o600); // belt and suspenders on platforms that ignore the mode above
  return pair.privateKey;
}

export function loadOrCreateIdentity(dataDir: string, machineId: string): Identity {
  mkdirSync(dataDir, { recursive: true });

  // Two keys, deliberately separate: Ed25519 proves *who this machine is*,
  // X25519 lets others encrypt *to* it. Reusing one key for both signing and
  // key agreement is a well-known footgun, and Ed25519->X25519 conversion is
  // subtle enough not to be worth it when a second keypair is free.
  const privateKey = loadOrCreateKey(join(dataDir, "key.pem"), "ed25519");
  const sealingPrivateKey = loadOrCreateKey(join(dataDir, "sealing-key.pem"), "x25519");

  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
  const sealingPublicKeyB64 = (
    createPublicKey(sealingPrivateKey).export({ type: "spki", format: "der" }) as Buffer
  ).toString("base64");

  return {
    machineId,
    privateKey,
    publicKeyPem,
    sealingPrivateKey,
    sealingPublicKeyB64,
    sign: (nonce: string) => cryptoSign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64"),
  };
}

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
  sign(nonce: string): string;
}

export function loadOrCreateIdentity(dataDir: string, machineId: string): Identity {
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, "key.pem");

  let privateKey: KeyObject;
  if (existsSync(keyPath)) {
    privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  } else {
    const pair = generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(keyPath, pem, { mode: 0o600 });
    chmodSync(keyPath, 0o600); // belt and suspenders on platforms that ignore the mode above
    privateKey = pair.privateKey;
  }

  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;

  return {
    machineId,
    privateKey,
    publicKeyPem,
    sign: (nonce: string) => cryptoSign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64"),
  };
}

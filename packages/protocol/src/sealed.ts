// End-to-end sealed payloads for agent-to-agent messages (SEALED.md).
//
// The shape is HPKE base mode: an ephemeral X25519 keypair per message,
// ECDH against the recipient's long-term public key, HKDF-SHA256 to a
// 256-bit key, AES-256-GCM to encrypt. Node's own crypto only — no deps.
//
// WHY THE ENVELOPE STAYS PLAINTEXT: D2 routes all cross-machine traffic
// through the server and justifies that by the server being "the one log";
// D4 and D11 then render the office from those logged events. A fully
// opaque message would break all three. So this seals the *body* and
// leaves the envelope's metadata (who, whom, which type, which task)
// readable: the server can route, log and draw the office, but cannot read
// what an agent actually sent. The metadata is bound into the ciphertext as
// AES-GCM additional data, so the server also cannot re-address or relabel
// a payload without the recipient's decryption failing.
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

const HKDF_INFO = Buffer.from("logbridge-sealed-v1");
const NONCE_BYTES = 12; // 96-bit, the GCM standard
const KEY_BYTES = 32;

export const SealedPayload = z.object({
  alg: z.literal("x25519-hkdf-sha256-aes256gcm"),
  epk: z.string(), // ephemeral public key, base64 SPKI DER
  nonce: z.string(), // base64
  ct: z.string(), // base64 ciphertext
  tag: z.string(), // base64 GCM auth tag
});

export type SealedPayloadT = z.infer<typeof SealedPayload>;

/** Long-term X25519 keypair for receiving sealed payloads. Separate from the
 *  Ed25519 identity key: signing and key-agreement keys should not be reused
 *  for each other, and Ed25519->X25519 conversion is a footgun we don't need. */
export function generateSealingKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey,
    publicKeyB64: (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
  };
}

export function publicKeyFromB64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

export function publicKeyToB64(key: KeyObject): string {
  return (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

// Both sides must derive the same key, so the salt has to be reproducible
// from what the recipient sees: the two public keys, in a fixed order.
function deriveKey(shared: Buffer, epkDer: Buffer, recipientDer: Buffer): Buffer {
  const salt = Buffer.concat([epkDer, recipientDer]);
  return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, KEY_BYTES));
}

/**
 * Encrypt `plaintext` so only the holder of `recipientPublicKeyB64`'s private
 * key can read it. `aad` is authenticated but not encrypted — pass the
 * envelope metadata so a relabelled message fails to open.
 */
export function seal(recipientPublicKeyB64: string, plaintext: string, aad: string): SealedPayloadT {
  const recipientKey = publicKeyFromB64(recipientPublicKeyB64);
  const recipientDer = recipientKey.export({ type: "spki", format: "der" }) as Buffer;

  // Fresh keypair per message: once it's discarded, later compromise of the
  // *sender's* long-term key cannot recover this message. (The recipient's
  // key still can — see SEALED.md, this is not a ratchet.)
  const eph = generateKeyPairSync("x25519");
  const epkDer = eph.publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
  const key = deriveKey(shared, epkDer, recipientDer);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    alg: "x25519-hkdf-sha256-aes256gcm",
    epk: epkDer.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a sealed payload. Throws if the ciphertext, the tag, or the `aad`
 * doesn't match — there is no "partially valid" result to act on.
 */
export function open(recipientPrivateKey: KeyObject, sealed: SealedPayloadT, aad: string): string {
  const parsed = SealedPayload.parse(sealed);
  const epk = publicKeyFromB64(parsed.epk);
  const recipientDer = createPublicKey(recipientPrivateKey).export({ type: "spki", format: "der" }) as Buffer;

  const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: epk });
  const key = deriveKey(shared, Buffer.from(parsed.epk, "base64"), recipientDer);

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.nonce, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]).toString("utf8");
}

/**
 * The metadata bound into every sealed payload. Order is fixed and every
 * field is routing-relevant: if the server rewrites any of them to redirect
 * or relabel a message, the recipient's open() fails instead of silently
 * accepting a payload meant for someone else.
 */
export function sealAad(env: { id: string; type: string; project: string; from: { id: string }; to: { id: string } }): string {
  return [env.id, env.type, env.project, env.from.id, env.to.id].join("|");
}

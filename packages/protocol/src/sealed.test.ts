// Sealed payloads (SEALED.md). Crypto tests earn their keep by proving the
// FAILURE cases: anyone can write a roundtrip test, but the reason to seal a
// payload at all is that the wrong reader, a tampered ciphertext, or a
// re-addressed envelope must not produce plaintext.
import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  generateSealingKeypair, open, publicKeyFromB64, publicKeyToB64, seal, sealAad, SealedPayload,
} from "./sealed.js";

const AAD = sealAad({
  id: "env_1", type: "delegate.request", project: "prj_a",
  from: { id: "agt_a" }, to: { id: "agt_b" },
});

describe("sealed payloads", () => {
  test("the intended recipient — and only they — can read it", () => {
    const bob = generateSealingKeypair();
    const eve = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "run the integration suite on your branch", AAD);

    expect(open(bob.privateKey, sealed, AAD)).toBe("run the integration suite on your branch");
    expect(() => open(eve.privateKey, sealed, AAD)).toThrow();
  });

  test("the ciphertext never contains the plaintext", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "SUPERSECRET", AAD);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain("SUPERSECRET");
    expect(Buffer.from(sealed.ct, "base64").toString("utf8")).not.toContain("SUPERSECRET");
  });

  test("a re-addressed envelope fails to open — the server cannot redirect a payload", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "the secret plan", AAD);

    // Same ciphertext, but the server rewrites the recipient in the envelope.
    const redirected = sealAad({
      id: "env_1", type: "delegate.request", project: "prj_a",
      from: { id: "agt_a" }, to: { id: "agt_mallory" },
    });
    expect(() => open(bob.privateKey, sealed, redirected)).toThrow();

    // ...and likewise for relabelling the type or moving it between projects.
    for (const tampered of [
      sealAad({ id: "env_1", type: "review.request", project: "prj_a", from: { id: "agt_a" }, to: { id: "agt_b" } }),
      sealAad({ id: "env_1", type: "delegate.request", project: "prj_other", from: { id: "agt_a" }, to: { id: "agt_b" } }),
      sealAad({ id: "env_1", type: "delegate.request", project: "prj_a", from: { id: "agt_impostor" }, to: { id: "agt_b" } }),
      sealAad({ id: "env_2", type: "delegate.request", project: "prj_a", from: { id: "agt_a" }, to: { id: "agt_b" } }),
    ]) {
      expect(() => open(bob.privateKey, sealed, tampered)).toThrow();
    }
  });

  test("flipping a single bit of ciphertext, tag or nonce is detected", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "a payload long enough to have bits to flip", AAD);

    for (const field of ["ct", "tag", "nonce", "epk"] as const) {
      const buf = Buffer.from(sealed[field], "base64");
      buf[0] ^= 0x01;
      const tampered = { ...sealed, [field]: buf.toString("base64") };
      expect(() => open(bob.privateKey, tampered, AAD), `${field} tampering must be caught`).toThrow();
    }
  });

  test("truncating the ciphertext is detected", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "the full message, all of it", AAD);
    const ct = Buffer.from(sealed.ct, "base64");
    const truncated = { ...sealed, ct: ct.subarray(0, ct.length - 4).toString("base64") };
    expect(() => open(bob.privateKey, truncated, AAD)).toThrow();
  });

  test("every message uses a fresh ephemeral key and nonce", () => {
    const bob = generateSealingKeypair();
    const seals = Array.from({ length: 16 }, () => seal(bob.publicKeyB64, "identical plaintext", AAD));

    // Same key, same plaintext, same aad -> must still be 16 distinct
    // ciphertexts, or the scheme is leaking equality of messages.
    expect(new Set(seals.map((s) => s.epk)).size).toBe(16);
    expect(new Set(seals.map((s) => s.nonce)).size).toBe(16);
    expect(new Set(seals.map((s) => s.ct)).size).toBe(16);
    // ...and all of them still decrypt.
    for (const s of seals) expect(open(bob.privateKey, s, AAD)).toBe("identical plaintext");
  });

  test("a payload sealed to one key cannot be opened with a key of the wrong type", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "x", AAD);
    const ed = generateKeyPairSync("ed25519"); // the identity key, not a sealing key
    expect(() => open(ed.privateKey, sealed, AAD)).toThrow();
  });

  test("the wire shape is validated, so a malformed payload is rejected not guessed at", () => {
    const bob = generateSealingKeypair();
    const sealed = seal(bob.publicKeyB64, "x", AAD);
    expect(SealedPayload.safeParse(sealed).success).toBe(true);
    expect(SealedPayload.safeParse({ ...sealed, alg: "rot13" }).success).toBe(false);
    expect(SealedPayload.safeParse({ ...sealed, tag: undefined }).success).toBe(false);
  });

  test("round-trips a realistic delegation body, including unicode and newlines", () => {
    const bob = generateSealingKeypair();
    const body = JSON.stringify({
      capability: "run_integration_tests",
      inputs: { branch: "feat/café", note: "line one\nline two\ttabbed — ✅" },
      acceptance: "all green",
    });
    const sealed = seal(bob.publicKeyB64, body, AAD);
    expect(JSON.parse(open(bob.privateKey, sealed, AAD))).toEqual(JSON.parse(body));
  });

  test("public keys survive the base64 round trip used on the wire", () => {
    const bob = generateSealingKeypair();
    const viaB64 = publicKeyToB64(publicKeyFromB64(bob.publicKeyB64));
    expect(viaB64).toBe(bob.publicKeyB64);
    // and it still works as a recipient key
    expect(open(bob.privateKey, seal(viaB64, "ok", AAD), AAD)).toBe("ok");
  });
});

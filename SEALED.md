# End-to-end sealed messages

Agent-to-agent payloads are encrypted end to end (X25519 / AES-256-GCM),
fitted to LogBridge's server-in-the-middle architecture.

The claim: **machine A can hand work to machine B through the server, and the
server — which routes it, logs it, and draws the office from it — cannot read
what was sent.**

`apps/runner/src/sealedDelegation.test.ts` asserts exactly that by dumping every
table in the server's database and grepping for the plaintext.

## The scheme

HPKE base mode, using only Node's built-in crypto:

```
ephemeral X25519 keypair (fresh per message)
  -> ECDH against the recipient's long-term X25519 public key
  -> HKDF-SHA256(shared, salt = epk‖recipientPk, info = "logbridge-sealed-v1")
  -> AES-256-GCM(key, random 96-bit nonce, aad = envelope metadata)
```

Two keys per machine, deliberately separate: **Ed25519** proves *who a machine
is* (the existing handshake, D23), **X25519** lets others encrypt *to* it.
Reusing one key for both signing and key agreement is a known footgun, and
Ed25519→X25519 conversion is subtle enough not to be worth it when a second
keypair is free.

## Why the envelope stays plaintext

This is the central design decision, and it is a genuine tension.

D2 routes all cross-machine traffic through the server, justified by the server
being *"the one log"*. D4 and D11 then build on that: state is server-authoritative
and the office is a pure function of logged events. A fully opaque message would
break all three at once — an unreadable payload cannot be routed, logged
meaningfully, or drawn.

So the split falls between **metadata** and **content**:

| Plaintext (server reads) | Sealed (only the recipient reads) |
|---|---|
| who sent it, who it's for | the task inputs |
| message type, project, task id | the acceptance criteria |
| capability being requested | the context notes |
| budget | the returned findings |

The server learns *that* `dev-a@alice-mbp` asked `dev-b@bob-mbp` to
`run_integration_tests`. It does not learn what it was asked to run.

**The metadata is bound into the ciphertext** as AES-GCM additional
authenticated data (`sealAad()` — envelope id, type, project, from, to). This
is not decoration: it means the server cannot re-address a sealed payload to a
different agent, relabel its type, or move it between projects. Any of those
makes the recipient's `open()` throw instead of silently accepting a message
meant for someone else. There are tests for each case.

## Consent: the machine owner decides, once

A machine does **not** run other people's work by default. `acceptDelegations`
is off unless the owner turns it on (`--accept-delegations`). A delegation to a
machine that hasn't opted in is refused, and nothing executes.

On top of that machine-level gate there is now **per-request consent**: the
first time an owner's capability is asked for by a given other owner, the
server holds the request (unread) and posts the question to the room. The
owner answers once (`approve`), forever (`always` — a row in `grants`), or
refuses. `never` becomes a standing rule; later requests are denied without
asking again. Held requests expire unanswered after ten minutes rather than
running by default.

**The consent trade-off, stated plainly.** The server cannot read the sealed
payload, so it cannot show the owner what the work actually *is*. Two honest
options existed: display the prompt only on the receiving machine after
decryption, or have the requester include a plaintext `summary` beside the
sealed body. LogBridge takes the second: the question must be answerable from
any browser — an inbox you can only read at the target machine's terminal
defeats being an inbox. The cost is that the server learns the requester's own
description of intent ("run the integration suite") for held requests. It
still never learns inputs, acceptance criteria or findings; the summary is
written by the requester before anything is sealed, and the grep test still
passes because it never contains payload text. If a future threat model
considers even intent metadata sensitive, flip to receiving-side-only display;
the hold-and-forward machinery here is what makes either UI possible.

## What this is NOT

**No forward secrecy for the recipient.** The ephemeral sender key means
compromising *A's* long-term key later cannot decrypt past messages A sent.
Compromising *B's* long-term key **can** decrypt every message ever sealed to
B. Real forward secrecy needs a double ratchet (Signal-style), which needs
session state both sides agree on — a much larger feature. This is sealed-box
encryption, not a ratchet, and it should not be described as one.

**No sender authentication from the encryption itself.** Anyone holding B's
public key can seal a payload to B. What actually authenticates the sender is
the transport: every node proved possession of its Ed25519 identity key during
the handshake (D23), and the server only forwards envelopes whose `from`
matches the authenticated socket. Take away the server's authentication and the
sealing alone would not tell B who sent something.

**Key rotation invalidates old payloads.** If a machine presents a new sealing
key, the server re-pins it and logs a warning. Anything sealed to the old key
becomes unopenable. There is no key history and no re-encryption.

**The server is still trusted for routing and availability.** It can refuse to
deliver, delay, or drop messages, and it sees the full communication graph
(who talks to whom, how often, about which capability). Encryption addresses
confidentiality of content, not metadata privacy or censorship.

## Files

| Path | What |
|---|---|
| `packages/protocol/src/sealed.ts` | `seal()`, `open()`, `sealAad()`, key helpers |
| `packages/protocol/src/sealed.test.ts` | tamper / wrong-key / re-address / nonce-reuse tests |
| `apps/runner/src/identity.ts` | both keypairs, persisted 0600 |
| `apps/server/src/nodeGateway.ts` | TOFU pinning, peer directory, sealed routing |
| `apps/runner/src/connection.ts` | `delegate()`, `handleDelegateRequest()` |
| `apps/runner/src/sealedDelegation.test.ts` | the end-to-end claim, incl. the server-can't-read test |

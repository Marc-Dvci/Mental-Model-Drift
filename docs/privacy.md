# Privacy

This product listens to a person's working day through a wearable and then tells them they are
wrong about something. Both halves of that sentence are a reason to be careful, and the care has to
be in the code rather than in a policy page.

Four principles, each one implemented rather than promised, with the file to check.

---

## 1. It is the wearer's own mental model, and nobody else's

There is no team view. There is no manager view. There is no endpoint that returns another user's
anything, and there is no aggregate over people.

The obvious next feature — *"a dashboard showing which of my engineers have the worst mental
models"* — is the feature that turns this into surveillance, and it is deliberately not built and
not designed for. The store is keyed by user; the API has no parameter that selects a user;
`apps/server/src/api.ts` has no route that projects across users.

The single honest quality signal in the product points the other way: **"No, not my belief"** is a
button, it resolves the card, and it is recorded as a resolution rather than as a score against
anyone.

> **Check:** `apps/server/src/api.ts`, `packages/engine/src/store/types.ts`

---

## 2. As little transcript as possible leaves Bee

What is stored is:

- the candidate assertion, typed: subject, property, value;
- the conversation id;
- **one sentence** — the utterance the claim came from, because a card that tells you that you are
  wrong without showing what you said is not reviewable;
- timestamps;
- evidence rows: source, locator, value, status, hash.

What is **not** stored: transcripts, conversation bodies, summaries, audio, anything about the
people who were in the room. Longitudinal context stays in Bee and is fetched, as the owner, at the
moment it is needed — `recurrence.ts` searches Bee and keeps only the matching excerpt, re-grounded
with the same rules used at capture.

There is no API route that returns a transcript, and a test asserts there is not
(`tests/e2e/server.test.ts`).

> **Check:** `packages/engine/src/pipeline.ts`, `packages/engine/src/recurrence.ts`

---

## 3. Secrets are removed before anything leaves the machine

`redact()` runs on every utterance before extraction, before any model call, and before storage. It
is a deterministic pattern scan over eleven shapes: AWS access key ids and secret keys, GitHub
tokens, Slack tokens, Anthropic and OpenAI keys, JWTs, bearer headers, PEM private-key blocks,
`password=`/`api_key=` assignments, and connection strings with inline credentials.

This runs on **ambient audio**. People read tokens aloud while pairing and narrate what they are
pasting. That is the reason this is not optional and not a setting.

It is a pattern scan, so it catches shapes it knows and nothing else. It is applied *in addition to*
principle 2, never instead of it: the strongest protection is that the transcript was never kept.

> **Check:** `packages/engine/src/redact.ts`, `tests/unit/redact.test.ts` (11 tests)

---

## 4. No competency score, ever

The product measures **knowledge that changed**. It does not measure the quality of an engineer.

There is no accuracy percentage, no streak, no trend line over a person, and no severity that rolls
up to a human being. Severity attaches to *a belief about a property* and is computed from an
integer lattice whose largest term is the registry's declared blast radius for that property, which
a human wrote down in advance.

`priorOccurrences` — the count that makes the product's best argument — is per belief, not per
person. "You have said this five times" is a statement about a belief's entrenchment. "You are wrong
23% of the time" would be a statement about a person, and the number would be quoted in a
performance review within a month of anyone building it.

> **Check:** `packages/drift-spec/src/severity.ts`

---

## Where data actually goes

| | leaves the machine? | |
|---|---|---|
| Bee conversations | no | read from `bee proxy` on loopback, or the `bee` CLI |
| the utterance text | **only** if `MMD_PROPOSERS` includes `bedrock` | redacted first; sent to Bedrock in your own AWS account |
| extraction with the grammar proposer | no | no network at all |
| source reads | to the sources you named | AppConfig, Sentry, GitHub — the registry lists every one |
| the correction | to Bee | `facts create`, as a confirmed fact belonging to the wearer |
| a documentation patch | nowhere, until you press the button | prepared locally; pushing needs `MMD_ALLOW_PR=1` **and** a click |

The server binds to `127.0.0.1` by default. Exposing it on a network interface requires setting
`MMD_HOST` deliberately, because this process holds derived fragments of owner-encrypted Bee data
and that should not be a default anyone inherits.

The MCP server's one writing tool, `record_understanding`, is off unless `MMD_MCP_ALLOW_WRITES=1`,
and refuses any belief that could not be attributed to the wearer.

---

## What this cannot protect you from

Stated plainly, because the list above is more reassuring than the situation deserves:

- **Other people in the room did not consent to a verification tool.** Diarisation keeps their
  sentences from being attributed to the wearer, and the card asks before acting, but their words
  still passed through the pipeline. The mitigation is that nothing about them is stored and nothing
  about them is shown.
- **Redaction is a pattern scan.** A secret with an unusual shape survives it.
- **A registry is a list of things you have decided to be corrected about.** Adding a property is a
  deliberate act, and `pnpm corpus` exists so you can see exactly what a registry change made the
  system newly willing to speak about, before it speaks.

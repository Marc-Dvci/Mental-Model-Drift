# Limitations

What this build does not do, and what has not been run. Stated in one place, completely, so that
nothing elsewhere in the repository has to be read as a hedge.

---

## 1. The Bee instance in the demo is a local emulator, not a physical device

**What that means.** The recorded conversations in `demo/conversations/` are authored fixtures, and
they are served by `tools/bee-sim`, a local process that implements Bee's `/v1` surface. No audio
was captured by a Bee wearable or by an Apple Watch running Bee for any material in this repository
or in the demo video.

**What is not affected.** Every line of code that talks to Bee. `packages/bee/src/client.ts` is the
only file that does, it speaks the documented `/v1` surface and nothing else, and it does not know
what is on the other end of the socket. Pointing `BEE_PROXY_URL` at a real `bee proxy` changes
nothing else:

```bash
npm i -g @beeai/cli && bee login && bee proxy      # terminal 1
BEE_PROXY_URL=http://127.0.0.1:8787 pnpm doctor    # terminal 2
```

**Why the emulator is worth trusting anyway.** Because it is held to Bee's format by Bee's own code
rather than by my reading of the documentation — see [`conformance.md`](conformance.md).
`tests/conformance/bee-wire.test.ts` opens a raw socket to the emulator, keeps the literal bytes,
and feeds them to `parseSSEBuffer` copied verbatim out of `@beeai/cli` 0.7.3. Every frame has to
come back out of Bee's parser, named. That check has already caught two real defects that a
device-free integration test could not: the emulator was writing frames with no SSE `event:` line —
which Bee's parser silently discards, returning zero events — and it was treating the `all` wildcard
as a literal event name.

**What the emulator does not simulate**, because nothing in the product depends on it:
transcription, diarisation quality, and fact extraction. Its `--neural` search is IDF-weighted token
overlap, not an embedding model; it is named that way in the source rather than dressed up.

**The residual risk.** An undocumented behaviour of the real service that differs from the
documented one *and* is not visible in `@beeai/cli`'s source. `pnpm doctor` exists to surface that
class of surprise in one run rather than in production: it exercises all four capabilities over the
live transport and reports each one.

---

## 2. AWS is synthesized, not deployed

`cd infrastructure/cdk && npx cdk synth` succeeds and produces 35 resources, with the Lambda
handlers bundled by esbuild from the same `packages/` source the tests run against. Nothing has been
deployed to a live account: no DynamoDB table exists, no Lambda has executed, and the CloudWatch
dashboard and alarms are declarations rather than observations.

The AppConfig, DynamoDB and CloudWatch adapters are written against the real AWS SDK clients and are
covered by the adapter failure matrix (34 tests) against local doubles, including timeout, 403,
malformed document, absent property and sources that disagree. Every one of those produces
`INCONCLUSIVE` rather than a drift claim.

---

## 3. Bedrock has not been called

`BedrockProposer` (`packages/engine/src/extract/bedrock.ts`) is written against
`@anthropic-ai/bedrock-sdk` and is selectable with `MMD_PROPOSERS=grammar,bedrock`, but no request
has been made to a live Bedrock endpoint.

Consequently **every published number is the grammar proposer alone** — no model in the loop at all.
That is the honest floor rather than the ceiling: 100% candidate precision, 0% false positives and
89.2% recall on 204 labelled utterances come from a registry-driven grammar. The second proposer can
only raise recall, because both proposers feed the same deterministic grounding gate and a candidate
that cannot be grounded in the spoken words is discarded whichever proposer suggested it.

The evaluation harness already supports the comparison (`pnpm eval --proposers grammar,bedrock`); it
prints one column today because only one proposer has been run.

---

## 4. The documentation pull request is prepared, not opened

"Create docs PR" composes a real patch against the file that still states the old value, and shows
the diff. It does not push a branch or open a pull request; `GITHUB_TOKEN` is read but the write
path is off by default (`MMD_ALLOW_GITHUB_WRITE=1`). A product whose entire premise is that it
should not act on your behalf without asking has to be off by default in the one place it can write
to somebody else's repository.

---

## 5. Scope the product deliberately does not cover

These are design decisions rather than unfinished work, recorded here so they are not mistaken for
gaps:

- **No competency scoring.** The system never aggregates how often a person was wrong, and there is
  no per-person metric anywhere in the store. See [`privacy.md`](privacy.md).
- **Only the wearer's own beliefs.** Utterances that cannot be attributed to the wearer produce a
  card marked `UNKNOWN` ownership, and write actions stay locked until a human says otherwise.
- **Five property types, not open-domain fact-checking.** Configuration values, feature state,
  schema facts, deployment versions and release identifiers — each one a property some system can
  be asked about directly. A claim outside the registry produces `UNSUPPORTED_TYPE`, not a guess.
- **Silence over recall.** Eleven of 204 corpus utterances are missed extractions, left in
  deliberately. Each is a phrasing outside the registry's declared vocabulary, and the alternative —
  loosening the grounding gate — trades a missed opportunity for telling somebody they are wrong
  about something they did not say.

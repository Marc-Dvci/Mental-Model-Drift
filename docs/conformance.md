# Wire conformance

**How wire format conformance is verified against Bee's format using Bee's own parser code.**

---

## The problem this solves

The automated integration tests in this repository run against `tools/bee-sim`, a test fixture
implementing the documented `/v1` surface. When building client tooling, the failure mode to avoid
is a test staying green while both sides share the same misconception.

That is not hypothetical here. It happened three times, and every time the tests passed:

1. **The test fixture wrote frames with no SSE `event:` line**, and the client read only `data:` lines
   and guessed each frame's type from its payload. Both halves agreed, and the product was guessing
   types it had been told, getting three of them wrong.
2. **A unit test asserted that `{conversation: {short_summary}}` is an
   `update-conversation-summary` frame.** Bee does not send that shape for that event — the real
   payload is flat, `{conversation_id, short_summary}`. The test was green and meaningless.
3. **The test fixture and the client were both written from the documentation's examples.** Frames
   with a `speaker` and no `type`, utterance id or `spoken_at`; conversation records with a uuid and
   a flat `utterances` list; ISO times; a changefeed cursor under `meta`. Every test agreed. Against
   an account, the same client would have read every transcript as empty, never advanced its
   cursor, and never matched a live sentence to its conversation. The API's real shapes are the
   ones `@beeai/cli` declares for its answers (`sources/resources/conversations/index.ts`,
   `sources/commands/changed/index.ts`) and the ones published live frames show.

None would have been caught by writing more tests of the same kind. All three were caught by asking a
different question: *would the real thing accept this, and is this what the real thing sends?*

---

## The check

`tests/conformance/bee-wire.test.ts`:

1. Contains `parseSSEBuffer` **copied verbatim** from `@beeai/cli` 0.7.3,
   `sources/commands/stream/index.ts` (MIT). It is the function `bee stream` itself uses to turn
   socket bytes into events, reproduced rather than imported so that what runs is Bee's parser,
   unmodified.
2. Opens a **raw TCP socket** — not `fetch`, which would normalise the framing —
   requests `/v1/stream`, and keeps every literal byte the server writes.
3. Strips HTTP chunked framing (the transport's, not Bee's) and feeds the remainder to that parser.
4. Asserts that what comes back is the events that were sent, each carrying its name.

The assertion that matters is not "the shapes look right". It is that **Bee's parser emits an event
at all.** `parseSSEBuffer` only pushes an event once it has seen both an `event` field and a `data`
field; a frame written as `data:` alone is discarded with no error and no warning.

Reintroducing it makes the check fail with `expected 0 to be greater than 0` — Bee's parser reading
the whole stream and finding no events in it. That is the guard doing its job, and it has been run
in that state deliberately to confirm it can fail.

---

## What is covered

| | |
|---|---|
| the `event:` line is present on every frame, including `connected` | asserted on the literal bytes |
| a `new-utterance` frame carries `type`, `conversation_uuid`, the utterance's `id`, `sample_id`, `start`/`end` and an ISO `spoken_at`, and no `speaker` | asserted on the parsed frame |
| a `--json` line (the `data:` line alone) classifies by its own `type`, with nothing inferred | through `classifyEvent` |
| a conversation read is `{conversation, timezone}`: numeric id, no uuid, epoch-ms times, words under `transcriptions[]`, every speaker `"Unknown"` | asserted on the response body |
| a live frame joins its conversation through the utterance id in the realtime transcription | resolved by the client, uuid never read from a record |
| processing replaces the realtime transcription with a final one under new ids | and the reconciler still finds nothing new (`capture.test.ts`) |
| `/v1/changes` returns bare ids with `next_cursor` at the top level; `bee changed --json`'s `meta` shape reads the same | both shapes through `readChangeBatch` |
| all 13 event types in `SUPPORTED_EVENT_TYPES` round-trip | emitted, parsed, and classified back to themselves |
| payload shapes per type | taken from `bee stream`'s own `formatEvent` switch |
| the three non-disjoint payloads | `update-conversation-summary`, `delete-conversation`, `journal-deleted` |
| `:`-prefixed keep-alive comments are not read as fields | both parsers, same input |
| the `all` wildcard means "no filter", not an event name | filter behaviour, matched to `bee stream --types all` |
| `GET /v1/conversations/:id/related` answers, in conversation-record shape | and returns records, not the `{id, score}` hits `/v1/search/*` returns |
| `related()` works with no CLI installed | the regression that silently returned `[]` on proxy-only runs |
| the four capabilities: `/v1/changes` cursor, neural search, facts read, facts write | over the real client |

---

## What it does not cover

Conformance is about **format**, not behaviour. What is claimed is checkable: the client adheres strictly to the wire format Bee expects.

`pnpm doctor` is the end-to-end check: it runs the client over whichever Bee transport is configured and reports each capability, including whether the last realtime frame arrived named and carrying its utterance id, and whether a transcript read returns any utterances at all.

---

## Running it

```bash
pnpm test tests/conformance     # the wire check alone
pnpm doctor                     # the same capabilities, against Bee
```

Upstream source used, for anyone reproducing this:
[`bee-computer/bee-cli`](https://github.com/bee-computer/bee-cli), MIT: `parseSSEBuffer` from
`e67032d` (0.7.3), and the API response types from `fa9580d` (21 October 2026).

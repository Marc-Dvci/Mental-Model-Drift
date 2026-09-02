# Wire conformance

**How the local Bee is held to Bee's format by Bee's own code, rather than by my reading of the
documentation.**

---

## The problem this solves

Every integration test in this repository runs the product against `tools/bee-sim`. That proves the
product agrees with the emulator. On its own it is worth nothing, because I wrote both, and the
failure mode is not a test that goes red — it is a test that stays green while both sides share the
same misconception.

That is not hypothetical here. It happened twice, and both times the tests passed:

1. **The emulator wrote frames with no SSE `event:` line**, and the client read only `data:` lines
   and guessed each frame's type from its payload. Both halves agreed. Against a real device the
   product would have been guessing types it had been told, and getting three of them wrong.
2. **A unit test asserted that `{conversation: {short_summary}}` is an
   `update-conversation-summary` frame.** Bee does not send that shape for that event — the real
   payload is flat, `{conversation_id, short_summary}`. The test was green and meaningless.

Neither would have been caught by writing more tests of the same kind. Both were caught by asking a
different question: *would the real thing accept this?*

---

## The check

`tests/conformance/bee-wire.test.ts`:

1. Contains `parseSSEBuffer` **copied verbatim** from `@beeai/cli` 0.7.3,
   `sources/commands/stream/index.ts` (MIT). It is the function `bee stream` itself uses to turn
   socket bytes into events, reproduced rather than imported so that what runs is Bee's parser,
   unmodified.
2. Opens a **raw TCP socket** to the emulator — not `fetch`, which would normalise the framing —
   requests `/v1/stream`, and keeps every literal byte the server writes.
3. Strips HTTP chunked framing (the transport's, not Bee's) and feeds the remainder to that parser.
4. Asserts that what comes back is the events that were sent, each carrying its name.

The assertion that matters is not "the shapes look right". It is that **Bee's parser emits an event
at all.** `parseSSEBuffer` only pushes an event once it has seen both an `event` field and a `data`
field; a frame written as `data:` alone is discarded with no error and no warning. So an emulator
with that bug is invisible to any client that has the same bug, and produces nothing whatsoever
against a real device.

Reintroducing it makes the check fail with `expected 0 to be greater than 0` — Bee's parser reading
the whole stream and finding no events in it. That is the guard doing its job, and it has been run
in that state deliberately to confirm it can fail.

---

## What is covered

| | |
|---|---|
| the `event:` line is present on every frame, including `connected` | asserted on the literal bytes |
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

Conformance is about **format**, not behaviour. The emulator's search ranking, its transcription
(there is none), and its diarisation (there is none) are not Bee's and are not claimed to be. What
is claimed is narrower and checkable: a client that works against this emulator is not working
against a wire format Bee would reject.

The residual risk is an undocumented behaviour of the live service that differs from the documented
one *and* is not visible in `@beeai/cli`'s source. `pnpm doctor` is the answer to that: it runs the
same client over whichever Bee is configured and reports each capability, including whether the last
realtime frame arrived carrying its event name.

---

## Running it

```bash
pnpm test tests/conformance     # the wire check alone
pnpm doctor                     # the same capabilities, against a live Bee
```

Upstream source used, for anyone reproducing this:
[`bee-computer/bee-cli`](https://github.com/bee-computer/bee-cli) at `e67032d`, MIT.

# Architecture

The whole product is one sentence with a shape:

> Bee hears a claim → a deterministic gate decides it *is* a claim → a named system settles it →
> Bee's own history says how long it has been believed → the correction goes back where the person
> will meet it.

Everything below is about where the boundaries sit and why each one is where it is. The interesting
decisions are all refusals: what a language model is not allowed to do, what a stream is not allowed
to be, and what a binary verdict is not allowed to hide.

---

## 1. The pipeline

```
                       ┌──────────────────────────── Bee ───────────────────────────┐
   realtime  SSE  ─────┤  /v1/stream        the fast path, at-most-once             │
   reconcile cursor ───┤  /v1/changes       the reliable path, the actual record    │
   recall    search ───┤  /v1/search/…      "have they said this before?"           │
   correct   facts  ───┤  /v1/facts         where the correction has to land        │
                       └────────────────────────────────────────────────────────────┘
                                              │
                      ┌───────────────────────▼───────────────────────┐
                      │  capture.ts       one utterance, exactly once │
                      │  redact.ts        secrets never leave here    │
                      └───────────────────────┬───────────────────────┘
                                              │
                      ┌───────────────────────▼───────────────────────┐
                      │  speech-act.ts    is this clause an assertion?│
                      │  extract/         two proposers, independently│
                      │  grounding.ts     the deterministic gate      │
                      └───────────────────────┬───────────────────────┘
                                              │  a typed Claim, or nothing
                      ┌───────────────────────▼───────────────────────┐
                      │  adapters/  appconfig · sentry · github       │
                      │  drift-spec/compare.ts   four verdicts        │
                      └───────────────────────┬───────────────────────┘
                                              │  SUPPORTED → stored, silent
                                              │  DRIFTED   → a card
                      ┌───────────────────────▼───────────────────────┐
                      │  recurrence.ts    Bee search, re-grounded     │
                      │  severity.ts      an integer lattice          │
                      │  docs-pr.ts       a patch, not a push         │
                      └───────────────────────┬───────────────────────┘
                                              │
                       dashboard (a person)  ·  MCP (an agent next to them)
```

`packages/drift-spec` sits underneath all of it and contains no I/O, no model and no Bee. It is the
types, the comparator, the severity lattice and the registry validator: the half of this that is
useful to someone verifying a different kind of claim against a different kind of source.

---

## 2. Boundary: a model may answer exactly one question

**Which registry property is this sentence about?**

Not *is it true* — nothing in this system asks a model that, because a model's answer to that
question is a fluent guess and this product's whole value is that its answers are checkable.

Two proposers run independently:

| | |
|---|---|
| `GrammarProposer` | registry-driven, no model at all. Aliases, property lexemes, value literals, polarity, units. |
| `BedrockProposer` | Claude on Bedrock, constrained to the registry's own vocabulary. |

Agreement between them is recorded as corroboration and is worth **+0.07** confidence. The grammar
proposer is never dropped when Bedrock is available: it is the corroborating second opinion, the
offline path, and the measurement baseline the evaluation numbers are quoted from.

**Everything a proposer produces then goes through a gate no model takes part in** (`grounding.ts`):

1. the **subject alias** must appear in the utterance;
2. a **lexeme for the property** must appear in the utterance;
3. a **literal for the value** must appear in the utterance;
4. all of it must sit inside a clause that **asserts**, rather than asking, hypothesising, planning,
   or reporting a belief the speaker has already marked as past;
5. adjacency counts: a value literal within `PROXIMITY_CHARS` (25) of the property lexeme is worth
   +0.15, because "retries three times" and "three services and retries" are not the same sentence.

A proposer that invents a number cannot get past step 3. That is the point of the gate.

### Speech acts are per clause, not per utterance

The flagship sentence of the whole demo is:

> *"It's probably fine. Checkout retries failed jobs three times anyway."*

Scored as one utterance, that is hedged, and a product that respects hedging drops it. Scored per
clause, it is a hedge followed by a flat assertion — and the flat assertion is exactly the belief
that is about to stop someone investigating a real alert. `speech-act.ts` splits first, classifies
each clause, and grounds within the clause that asserts.

---

## 3. Boundary: the stream is the fast path and never the record

Bee documents realtime delivery as **at most once**. Events that happen while a client is
disconnected are not replayed. That single sentence forces the entire second ingestion path:

| | fast path | reliable path |
|---|---|---|
| transport | SSE, `/v1/stream` | `bee changed --cursor` / `/v1/changes` |
| latency | seconds | the reconcile interval |
| guarantee | at most once | eventually complete |
| what it is for | the card arriving while the decision is still being made | the record |

The subtlety, and the bug that shipped in an earlier build of this project: **reconciling on
disconnect recovers nothing.** The conversation you are about to miss has not happened yet at the
moment the stream drops. The gap has to be closed again **on reconnect**, and only the reconnect
pass recovers anything.

`packages/engine/src/capture.ts` owns this, so the server and the standalone relay cannot drift
apart, and `tests/e2e/capture.test.ts` genuinely cuts the stream, plays a conversation into the void
and asserts the claim is found anyway.

### Identity, since Bee frames carry none

Realtime frames have no event id, so one is derived:

- `realtimeFingerprint` — conversation + speaker + normalised text + a **coarse 10-second bucket**,
  so the same physical utterance arriving twice collapses while two genuinely repeated sentences
  minutes apart stay distinct;
- `reconciledFingerprint` — conversation + utterance index + normalised text, because a transcript
  read has a stable index and no arrival time at all;
- `contentKey` — conversation + normalised text, which is what deduplicates **across** the two
  paths, and is the reason an utterance streamed live and then re-read during reconciliation is
  processed exactly once.

Normalisation keeps a period between digits (`4.12` is a value) and drops it everywhere else,
because Bee re-punctuates an utterance between the live frame and the stored transcript. Found by a
test, not by luck.

---

## 4. Boundary: four verdicts, never two

```
SUPPORTED          the authoritative source agrees.        stored, no card, counted
DRIFTED            it disagrees.                           a card
INCONCLUSIVE       the source could not be read, or two    no card, and it says why
                   sources disagree with each other
UNSUPPORTED_TYPE   nothing in the registry can settle it   no card
```

A binary true/false forces a connector failure to masquerade as drift, which is the single worst
thing a product that tells people they are wrong can do. `tests/adapters/adapters.test.ts` walks the
failure matrix — timeout, 403, malformed document, absent property, unreachable source, two sources
that disagree — and every one of them produces `INCONCLUSIVE`.

The comparator is typed rather than textual: `4.12` and `4.12.0` are compared as semantic versions,
`"3"` and `3` as integers, `enabled`/`on`/`true` as one boolean. `packages/drift-spec/src/compare.ts`.

---

## 5. Boundary: authoritative vs historical sources

Each registry property names up to three sources, and their roles never overlap:

| role | answers | example |
|---|---|---|
| `authoritative_source` | **what the system is.** Decides SUPPORTED / DRIFTED. | AWS AppConfig, Sentry release |
| `historical_source` | **what the system was**, and when it stopped being that. Explains, never decides. | the git history of `config/checkout.yaml` |
| `documents` | the prose that still says the old thing | `docs/architecture.md` in the same repo |

This split is what makes the product's best sentence possible: *the value is 1, you said 3, and 3
was right until 23 August.* The engineer was not careless; the software moved. A design where one
source does both jobs cannot say that, and saying it is most of the reason anyone would keep the
tool installed.

Locators bind at verification time: `${scope.region}` and `${object}` come from the claim, so a
statement about the EU rollout is checked against the EU value. `validateRegistry` refuses a
registry that declares a scope its locator never binds — an earlier build verified a US claim
against the EU value and produced a confident, wrong card.

---

## 6. Ownership is diarisation, not identity

Bee gives speaker labels (`speaker_1`), not identities, and this product never tries to turn one
into the other.

- one speaker in the window ⇒ `LIKELY_USER`;
- more than one ⇒ `UNKNOWN`, and the card asks *"was this your understanding?"* before it will
  unlock any write action.

`record_understanding` over MCP refuses outright a belief that could not be attributed to the
wearer. The failure this guards against is correcting someone for something a colleague said in the
same room, which is both wrong and unpleasant.

---

## 7. Severity is an integer lattice

```
+3 / +2 / +1   the registry's declared impact for this property (HIGH / MEDIUM / LOW)
+1             the belief has been restated at least once since the value changed
+1             it has been stated in three or more conversations in total
+1             it was last spoken within the last seven days

score >= 5  HIGH      score >= 3  MEDIUM      otherwise  LOW
```

The recency factor is scored against the last time the belief was **spoken**, never against the
moment it was checked. An earlier version compared the detection time against a set that contained
the detection time, which made "in active use within the last seven days" structurally always true.
It looked right in every card.

Counted, not estimated. There is no probability because there is nothing honest to compute one from,
and a made-up number here would be the most quoted output of the whole system. Impact is the only
subjective input and it is set by a human, in the registry file, in the open.

---

## 8. Storage

One store interface, two implementations: `JsonStore` for a single machine, `DynamoStore` for the
deployed topology (single table, `pk`/`sk`, one GSI, TTL on dedupe markers).

What is stored is deliberately thin: the candidate assertion, the conversation id, the one sentence
it came from, timestamps, evidence rows. **Not transcripts.** Historical context stays in Bee and is
fetched, as the owner, when it is needed. See [`privacy.md`](privacy.md).

Evidence rows are append-only and content-hashed. Re-verifying a claim adds a row; it never edits
one. The hash covers *what was read* and not *when*, so two readings of the same value hash the same
and the hash can answer the only question it is asked: has the source's answer changed?

---

## 9. Two front ends, one engine

**The dashboard** is for the person: the drift cards, the evidence, the mental-model timeline, the
live capture panel that shows every rejection with its reason, and the *Heard* tab that exists so
the silence is on the record.

**The MCP server** is for the agent sitting next to them. A coding agent handed "the worker retries
three times, so a slow consumer isn't the problem" will write a confident patch on a premise that
stopped holding three weeks ago, and defend it, because it reasoned correctly from what it was
given. `check_assumption` is the door in the wall. Five tools; the only one that writes is off
unless `MMD_MCP_ALLOW_WRITES=1`.

Both go through `DriftEngine`. `extractOnly()` and `recallOccurrences()` exist because an agent
asking "is this even a checkable claim" must not create a claim record, and must not have its own
question counted as something the wearer said.

---

## 10. Deployed topology

`infrastructure/cdk` synthesizes 35 resources: DynamoDB (single table + `gsi1`), SQS with a DLQ,
three Lambdas built by `NodejsFunction` from the same `packages/` source the tests run against, an
HTTP API, AppConfig application/environment/profiles, Secrets Manager, and a CloudWatch dashboard
with two alarms.

The relay (`apps/relay`) is the piece that has to live next to `bee proxy`, because the proxy is
loopback-only by design. Everything downstream of it is stateless.

**This has been synthesized and never deployed.** See "What is not done" in the README; the numbers
quoted anywhere in this repository come from the local run, not from an AWS account.

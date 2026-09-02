# Mental Model Drift

**Detects when what an engineer believes about a system no longer matches what the system is,
using a Bee wearable to hear the claim and the deployed configuration to check it.**

We already monitor configuration drift, infrastructure drift and schema drift. This monitors the
one system nobody instruments: the engineer's understanding.

Amazon Developer Hackathon — **Bee track** (developer experience) · **AWS Builder** · **Open Source**

---

## The problem, in one sentence someone actually said

> "It's probably fine. Checkout retries failed jobs three times anyway."

That was true in July. On 23 August the retry count was cut from 3 to 1 after a duplicate-charge
incident. Nobody told the person wearing the Bee, because nobody tells anybody: the commit was
reviewed, the config was deployed, and the change never reached the mental model of the engineer
who is, right now, deciding not to investigate an alert.

Sixty seconds later the dashboard says what changed, when, which commit did it, and that the same
belief has been stated in **five conversations since 14 July** — four of them while three was still
the right answer, and this one, which is not. Two hours after that the same person repeats it to
another team in a corridor, while the stream happens to be down, and the product catches that too.

## What it does

1. **Hears** the claim through Bee's realtime `new-utterance` stream.
2. **Decides it is a claim at all** — deterministically. Questions, opinions, hypotheses, plans and
   beliefs the speaker has already marked as past are dropped before anything is checked.
3. **Verifies** it against the source the registry names as authoritative: AWS AppConfig for
   deployed configuration and feature state, Sentry for the running release, the checked-in schema
   for structural facts.
4. **Explains** it: reconstructs the commit that moved the value, and searches the wearer's own Bee
   history for every earlier time they said the same thing.
5. **Corrects** it: writes the verified value back into Bee's memory as a confirmed fact, and
   prepares a documentation pull request against the file that still says the old number.

And, most of the time, does nothing at all. Across 115 utterances of recorded conversation, 17
contain a checkable claim; they are about five registered properties, and three of those no longer
match production. The other 98 utterances produce nothing, ever. Silence is the feature, and the
dashboard's **Heard** tab shows the survey so it is measured rather than claimed (`pnpm corpus`).

## Four ways Bee is used, not one

| | Bee capability | Why this product needs it |
|---|---|---|
| **CAPTURE** | realtime stream, `new-utterance` | the claim as spoken, while the decision is still being made |
| **RECALL** | `search --neural` over past conversations | one wrong sentence is a slip; the same one across six weeks is a mental model |
| **RECONCILE** | `changed --cursor` | the stream is documented at-most-once, so it cannot be the record |
| **CORRECT** | `facts create` / `update` | the correction has to land where the wearer's assistant will read it next |

`packages/bee/src/client.ts` is the only file that talks to Bee. It uses the documented surface and
nothing else: `bee proxy`'s `/v1/*` endpoints and SSE stream, plus the `bee` CLI for the reads the
proxy does not expose (`conversations related`, `conversations transcript --since`).

## Quick start

```bash
pnpm install
pnpm demo
```

That seeds a demo repository with real backdated commits, starts a faithful local Bee emulator,
starts the server, plays the 09:02 conversation into the live stream one sentence at a time, cuts
the stream to provoke Bee's documented at-most-once loss, and lets cursor reconciliation recover it.
The dashboard is on <http://127.0.0.1:4310>.

**Or watch the whole thing narrate itself.** `pnpm tour` brings the same stack up and hands the
remote control to the browser:

```bash
pnpm tour            # then open http://127.0.0.1:4310/?tour=1
```

Fourteen beats, two minutes, and it is the real pipeline throughout: the tour plays conversations
into Bee, cuts the stream, clicks the product's own buttons. It is also exactly what the demo video
is a recording of — see [`docs/demo-script.md`](docs/demo-script.md).

**With a real Bee device** it is the same run with one variable changed:

```bash
npm i -g @beeai/cli && bee login && bee proxy        # terminal 1
BEE_PROXY_URL=http://127.0.0.1:8787 MMD_STREAM=1 pnpm server   # terminal 2
```

Unset `BEE_PROXY_URL` and the client shells out to the `bee` CLI instead. Nothing else changes;
`BeeClient.describeTransport()` reports which path is live and the dashboard shows it.

## Why this is not an LLM wrapper

**A model is never asked whether a statement is true.** It is asked one question only — *which
registry property is this sentence about?* — and its answer is then passed through a deterministic
gate before any source is read. Truth comes from AppConfig, Sentry and the repository.

**Two independent proposers.** `GrammarProposer` is registry-driven with no model at all;
`BedrockProposer` is Claude on Bedrock. Agreement between them is recorded as corroboration and
worth +0.07 confidence. The grammar proposer is never dropped when Bedrock is available: it is the
corroborating second opinion, the offline path, and the measurement baseline.

**Every candidate must be grounded in the words that were spoken.** The subject alias, a lexeme for
the property and a literal for the value all have to appear in the utterance, in a clause that
asserts rather than asks. A proposer that invents a number cannot get past it:

```
"The checkout worker retries a bunch of times."   proposed max_attempts = 3
  rejected: the asserted value does not appear literally in the utterance
```

**Four verdicts, never two.** `SUPPORTED` / `DRIFTED` / `INCONCLUSIVE` / `UNSUPPORTED_TYPE`. A binary
true/false forces a connector failure to masquerade as drift, which is the single worst thing a
product that tells people they are wrong can do. There are 34 adapter tests, and every failure mode
in them — timeout, 403, malformed document, absent property, sources that disagree — produces
`INCONCLUSIVE`.

## Measured, not asserted

```bash
pnpm eval --verdicts
```

204 labelled utterances: 51 supported claims, 51 drifted claims, 51 technical-but-unverifiable
statements, 51 non-claims (questions, opinions, hypotheses, directives, past beliefs, reported
speech, small talk).

| | grammar proposer, no model | target |
|---|---|---|
| candidate precision | **100.0%** | > 95% |
| recall | 89.2% | |
| false-positive rate | **0.0%** | |
| subject / property mapping | **100.0%** | > 95% |
| value extraction | **100.0%** | > 98% |
| verdict accuracy | **100.0%** | |
| latency | 2.9 ms / utterance | |

Recall is the number deliberately left imperfect. The eleven misses are phrasings outside the
registry's declared vocabulary and values too far from their property lexeme to be trusted; each one
is a missed opportunity, and each false positive avoided is a person not being told they are wrong
about something they never said. `pnpm eval --errors` prints all eleven.

Building that corpus found six real defects, all now fixed and pinned by tests: `on`/`off` read as
polarity words inside prepositional phrases (which *inverted* a claim), a number regex that lost
every value spoken at the end of a sentence, negation that only looked backwards so "has no user
agent column" read as the opposite, a unit-blind reader that turned "backs off five seconds" into a
retry count of five, deontic "should" scored as an assertion, and a legitimate negated assertion
being dropped. See `docs/friction-log.md`.

## Run everything

```bash
pnpm verify        # typecheck, 205 tests, evaluation harness
pnpm test          # 205 tests: unit, adapter failure matrix, 12 golden scenarios, MCP,
                   #            the corpus gate, the server over real HTTP
pnpm eval          # extraction metrics against the golden corpus
pnpm corpus        # dry-run the registry over recorded conversations: what would this speak about?
pnpm corpus --bee  # ...the same, read from a live Bee instead of the fixtures
pnpm demo          # the whole thing, end to end
pnpm tour          # the same, narrated in the browser at /?tour=1
pnpm mcp           # the Assumption Firewall over MCP
```

## The Assumption Firewall (MCP)

The dashboard is for the person. The MCP server is for the agent sitting next to them.

A coding agent is handed human context constantly and has no way to tell a fact from a memory. Told
"the worker retries three times, so a slow consumer isn't the problem", it will write a confident
patch on a premise that stopped holding three weeks ago, and defend it, because it reasoned
correctly from what it was given.

```bash
claude mcp add mental-model-drift -- npx tsx apps/mcp/src/main.ts
```

```
check_assumption("The checkout worker retries three times, so a slow consumer is not the problem.")

  DRIFTED -- Checkout retry attempts
    stated 3, actually 1
    changed 2026-08-23 -- Reduce checkout retries to 1 after duplicate-charge incident
    severity HIGH
    restated in 6 earlier conversation(s), 2 of them after the change
    Act on the actual value, and tell the human what changed and when rather than
    silently correcting them.
    evidence: AWS_APPCONFIG OK appconfig://ecommerce/production/checkout-worker$.retry.max_attempts (local)
```

Five tools: `check_assumption`, `belief_history`, `list_verifiable_properties`, `open_drifts`,
`record_understanding`. The last one writes to Bee memory and is off unless
`MMD_MCP_ALLOW_WRITES=1`; it also refuses any belief that could not be attributed to the wearer.
14 tests drive it through a real MCP client.

## AWS

| service | used for | where |
|---|---|---|
| **AppConfig** + **AppConfigData** | authoritative deployed configuration and feature state; hosted version history reconstructs when a value changed | `packages/engine/src/adapters/appconfig.ts` |
| **Bedrock** (Claude, via `@anthropic-ai/bedrock-sdk`) | the second extraction proposer; asked only which registry property a sentence is about | `packages/engine/src/extract/bedrock.ts` |
| **DynamoDB** | single-table store: claims, evidence, drifts, cursor, dedupe markers with TTL | `packages/engine/src/store/dynamo-store.ts` |
| **CloudWatch** | the metrics that matter: how much was heard, how little was acted on, how often a card was dismissed | `infrastructure/lambda/index.ts` |
| **SQS**, **Lambda**, **API Gateway**, **Secrets Manager** | the deployed topology | `infrastructure/cdk/` |

`cd infrastructure/cdk && npx cdk synth` synthesizes 35 resources and bundles the handlers with
esbuild from the same `packages/` source the tests run against. **It has not been deployed** — see
"What is not done" below.

## Layout

```
packages/drift-spec/      types · adjudication · severity · registry validation   [the OSS artifact]
packages/bee/             Bee client · event classification · fingerprints        [the track hook]
packages/engine/          registry · speech acts · grounding · polarity · extraction
                          adapters (appconfig, github, sentry) · store · recurrence
                          pipeline · reconcile · capture · docs-pr · config
apps/server/              HTTP API, SSE, dashboard host
apps/dashboard/           drift cards, evidence panel, mental-model timeline, "Heard" tab
apps/relay/               the local process that sits next to `bee proxy`
apps/mcp/                 the Assumption Firewall
apps/dashboard/src/Tour.tsx   the guided tour: /?tour=1, and the demo video's script
tools/bee-sim/            a faithful local `bee proxy` emulator, with failure injection
tools/eval/               the golden corpus and the metrics harness
tools/demo/               one-command demo, corpus audit, repo seeding
infrastructure/           CDK stack and Lambda handlers
tests/                    205 tests
```

`packages/drift-spec` has no I/O, no model and no Bee: it is the portable half, and it is the piece
intended to be useful to anyone building this kind of verification for a different source.

## The demo video

`demo_video/mmd-demo.mp4` — 2:15, and every frame of it is the product. The narration is the guided
tour's own captions, read out of the running page so the words a viewer hears and the words on
screen cannot disagree; the visuals are paced to the measured length of each spoken sentence.
`docs/demo-script.md` has the beat sheet and the three commands that reproduce it.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the pipeline, and why each boundary is where it is
- [`docs/privacy.md`](docs/privacy.md) — what is stored, what is never stored, and what leaves the machine
- [`docs/threat-model.md`](docs/threat-model.md) — including the ways this product could hurt someone
- [`docs/source-registry.md`](docs/source-registry.md) — how to point it at your own systems
- [`docs/demo-script.md`](docs/demo-script.md) — the two-minute walkthrough, beat by beat, and how it is recorded
- [`docs/friction-log.md`](docs/friction-log.md) — building against Bee, AWS and MCP: what worked, what did not
- [`docs/product-feedback.md`](docs/product-feedback.md) — the submission's feedback answers

## What is not done

Stated plainly, because a reviewer will find it anyway:

- **No physical Bee device.** Every Bee call is written against the documented surface and exercised
  against `tools/bee-sim`, a local emulator that implements `/v1/me`, `/v1/changes`, `/v1/stream`,
  `/v1/conversations`, `/v1/search/conversations{,/neural}` and `/v1/facts`, including deliberate
  stream loss. Switching to a real device is one environment variable.
- **AWS is synthesized, not deployed.** The adapters, the store and the Bedrock proposer are written
  against the real SDKs, and `cdk synth` succeeds, but nothing has been run against a live account.
- **Bedrock has not been run.** The evaluation numbers above are the grammar proposer alone, which
  is the honest floor. `MMD_PROPOSERS=grammar,bedrock` adds the second opinion.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

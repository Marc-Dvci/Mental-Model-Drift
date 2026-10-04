# Mental Model Drift

**Detects when what an engineer believes about a system no longer matches what the system is,
using Bee on a wearable or Apple Watch to hear the claim and the deployed configuration to check it.**

We already monitor configuration drift, infrastructure drift and schema drift. This monitors the
one system nobody instruments: the engineer's understanding.

Amazon Developer Hackathon — **Bee track** (developer experience) · **AWS Builder** · **Open Source**

**Mental Model Drift has used data recorded and processed through an Apple Watch running Bee
software, accessed through an authenticated `bee proxy`.**

No private Bee conversation data is included in this repository. The checked-in `tools/bee-sim`
provides deterministic, non-private fixtures so judges and developers can reproduce the workflow
without access to the entrant's personal Bee data. Its search and Facts store are test doubles;
Bee's own neural search and persistent memory are used when connected to the authenticated proxy.

**Explore the dashboard: <https://mental-model-drift.onrender.com>** — a public instance using those
non-private fixtures. Open a card's **View evidence** for the source, the
locator and the timestamp; the **Conversation review** tab for everything the product decided *not* to speak
about; the **Agent check** tab to hand it a sentence of your own and get the verdict an agent would get.
It sleeps when idle, so the first load takes a few seconds to wake.

---

## The problem, in one sentence

> "It's probably fine. Checkout retries failed jobs three times anyway."

In the reproducible checkout scenario, that was true in July. On 23 August the retry count was cut
from 3 to 1 after a duplicate-charge
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

And, most of the time, does nothing at all. Across 115 utterances in the checked-in fixture corpus, 17
contain a checkable claim; they are about five registered properties, and three of those no longer
match the reference configuration. The other 98 utterances produce nothing. Silence is the feature, and
the
dashboard's **Conversation review** tab shows the survey so it is measured rather than claimed (`pnpm corpus`).

## Four ways Bee is used, not one

| | Bee capability | Why this product needs it |
|---|---|---|
| **CAPTURE** | realtime stream, `new-utterance` | the claim as spoken, while the decision is still being made |
| **RECALL** | `search --neural` over past conversations | one wrong sentence is a slip; the same one across six weeks is a mental model |
| **RECONCILE** | `changed --cursor` | the stream is documented at-most-once, so it cannot be the record |
| **CORRECT** | `facts create` / `update` | the correction has to land where the wearer's assistant will read it next |

`packages/bee/src/client.ts` is the only file that talks to Bee. It uses the documented surface and
nothing else: `bee proxy`'s `/v1/*` endpoints and its SSE stream, with the `bee` CLI as the fallback
for machines with no proxy running.

Two details in there are worth a reviewer's thirty seconds, because both were bugs first:

- **A realtime frame's type is its SSE `event:` name.** Bee's own client discards any frame that
  arrives without one, and three real event types have payloads that a shape-guesser reads as each
  other. The name is now read as authoritative, and anything inferred is marked as inferred.
- **`bee proxy` is a transparent pass-through, not a subset of the CLI.** Every `/v1` path is
  forwarded upstream, so `GET /v1/conversations/:id/related` works over the proxy and no capability
  quietly disappears on a machine without the CLI installed.

Neither is stated in Bee's published documentation; both came out of reading `@beeai/cli`'s source,
and both are written up in [`docs/friction-log.md`](docs/friction-log.md).

## Quick start

Requires Node.js 22+ and pnpm 9.15.9. Install and build from the repository root:

```bash
pnpm install
pnpm dashboard:build
```

### Connect your Bee account

Record a conversation through your Bee device or Apple Watch running Bee software, then start the
authenticated proxy in one terminal:

```bash
npm i -g @beeai/cli
bee login
bee proxy
```

In a second terminal, run the server against that proxy. Keep personal derived state separate from
fixture state:

```bash
BEE_PROXY_URL=http://127.0.0.1:8787 BEE_ALLOW_CLI=0 MMD_STATE=.bee-account/store.json MMD_STREAM=1 pnpm server
```

For PowerShell:

```powershell
$env:BEE_PROXY_URL = 'http://127.0.0.1:8787'
$env:BEE_ALLOW_CLI = '0'
$env:MMD_STATE = '.bee-account/store.json'
$env:MMD_STREAM = '1'
pnpm server
```

Open <http://127.0.0.1:4310>. `pnpm doctor` checks the configured Bee connection; `pnpm corpus --bee`
reads recorded conversations directly through it. Facts writes happen only after the user confirms
ownership and chooses **Update my understanding**. `pnpm doctor --write` separately exercises a
diagnostic Facts write.

Point `MMD_REGISTRY` at the properties you want checked and configure the corresponding source
adapters; see [source-registry.md](docs/source-registry.md). Bee transport and source configuration
are independent: `MMD_MODE=live` selects live AppConfig, GitHub and Sentry adapters, and each can be
selected separately as described below. The defaults use the checked-in source fixtures; run
`pnpm demo:seed` once to create the checkout reference repository if you use that example registry.

Unset `BEE_PROXY_URL` and set `BEE_ALLOW_CLI=1` to use the authenticated `bee` CLI. The dashboard
reports the configured transport.

### Reproduce without personal data

`pnpm demo` runs the engine and dashboard with the deterministic fixture proxy on
<http://127.0.0.1:4310>. It exercises extraction, verification, recurrence, Facts interactions and
disconnect recovery without a Bee account. It does not capture wearable audio or modify a Bee account.
Use a separate terminal so personal environment settings are not inherited by the fixture runner.

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
| recall | 90.2% (93.1% with the Bedrock proposer beside it) | |
| false-positive rate | **0.0%** | |
| subject / property mapping | **100.0%** | > 95% |
| value extraction | **100.0%** | > 98% |
| verdict accuracy | **100.0%** | |
| latency | 2.9 ms / utterance | |

Recall is the number deliberately left imperfect. The ten misses are phrasings outside the
registry's declared vocabulary and values too far from their property lexeme to be trusted; with a
model beside the grammar, seven remain, and every one of those is the grounding gate declining on
purpose. Each is a missed opportunity, and each false positive avoided is a person not being told
they are wrong about something they never said. `pnpm eval --errors` prints them.

Building that corpus found six real defects, all now fixed and pinned by tests: `on`/`off` read as
polarity words inside prepositional phrases (which *inverted* a claim), a number regex that lost
every value spoken at the end of a sentence, negation that only looked backwards so "has no user
agent column" read as the opposite, a unit-blind reader that turned "backs off five seconds" into a
retry count of five, deontic "should" scored as an assertion, and a legitimate negated assertion
being dropped. See `docs/friction-log.md`.

## Run everything

```bash
pnpm verify        # typecheck, 226 tests, evaluation harness
pnpm test          # 226 tests: unit, adapter failure matrix, 12 golden scenarios, MCP,
                   #            wire conformance, the corpus gate, the server over real HTTP
pnpm doctor        # Bee preflight; add --write to exercise a diagnostic Facts write
pnpm eval          # extraction metrics against the golden corpus
pnpm corpus        # dry-run the registry over the demo conversations: what would this speak about?
pnpm corpus --bee  # ...the same, read straight from `bee proxy`
pnpm server        # the pipeline and dashboard, using your configured Bee account
pnpm demo          # deterministic reproduction with non-private fixtures
pnpm mcp           # the Assumption Firewall over MCP
```

`pnpm doctor` is the preflight. It runs the client over the configured transport and prints one
row per capability — including whether the last realtime frame arrived carrying its SSE event name,
which is the difference between reading Bee's stream and guessing at it.

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
    evidence: AWS_APPCONFIG OK appconfig://ecommerce/production/checkout-worker$.retry.max_attempts
```

Five tools: `check_assumption`, `belief_history`, `list_verifiable_properties`, `open_drifts`,
`record_understanding`. The last one writes to Bee memory and is off unless
`MMD_MCP_ALLOW_WRITES=1`; it also refuses any belief that could not be attributed to the wearer.
14 tests drive it through a real MCP client.

## Three surfaces, one engine

Bee's own integration story is three doors — the CLI, MCP, and Agent Skills — and the same question
is worth asking through all three, because the audiences are different and they arrive at different
moments.

| surface | who it is for | when |
|---|---|---|
| the **dashboard** | the person | after the fact, with the timeline and the evidence |
| the **MCP server** | an agent that speaks MCP | mid-task, before it writes the patch |
| **`mmd`** + the **Agent Skill** | an agent with a shell, or a shell script | mid-task, with no transport and no session |

```bash
mmd check "the checkout worker retries three times, so a slow consumer isn't the problem"
# DRIFTED -- Checkout retry attempts ...
echo $?   # 1
```

The exit code is the contract: `0` supported or nothing checkable, `1` drifted, `2` inconclusive.
Those are three codes rather than two on purpose — a connector that could not be read must never
look like a person being wrong, and an agent trusting `!= 0` would conflate them. `tests/e2e/cli.test.ts`
asserts each from outside the process, where an agent would see it.

[`skills/mental-model-drift/SKILL.md`](skills/mental-model-drift/SKILL.md) is the Agent Skill: it
composes with [`bee-computer/bee-skill`](https://github.com/bee-computer/bee-skill) over the same
`bee login` session, and most of it is about *how to say it*. Silently substituting the right number
is the worst outcome — the person keeps the old one and repeats it in an hour, next to someone
else, where nothing is checking. And they were usually not wrong: four of the five earlier times
they said "three retries", three was the correct answer. The software moved. Nobody told them. The
skill's job is to get an agent to say that, in one sentence, and then carry on with the real value.

## AWS

| service | used for | where |
|---|---|---|
| **AppConfig** + **AppConfigData** | authoritative deployed configuration and feature state; hosted version history reconstructs when a value changed | `packages/engine/src/adapters/appconfig.ts` |
| **Bedrock** (Claude via `@anthropic-ai/bedrock-sdk`, any other family via the API endpoint's chat completions) | the second extraction proposer; asked only which registry property a sentence is about. Over the corpus, beside the grammar: recall 90.2% → 93.1%, precision 100% | `packages/engine/src/extract/bedrock.ts` |
| **DynamoDB** | single-table store: claims, evidence, drifts, cursor, dedupe markers with TTL | `packages/engine/src/store/dynamo-store.ts` |
| **CloudWatch** | the metrics that matter: how much was heard, how little was acted on, how often a card was dismissed | `infrastructure/lambda/index.ts` |
| **SQS**, **Lambda**, **API Gateway**, **Secrets Manager** | the deployed topology | `infrastructure/cdk/` |

`cd infrastructure/cdk && npx cdk synth` synthesizes 35 resources and bundles the handlers with
esbuild from the same `packages/` source the tests run against.

Each source is switched on its own. `MMD_MODE=live` turns all three live; `MMD_APPCONFIG`,
`MMD_GITHUB` and `MMD_SENTRY` take `live` or `local` and override one, so the deployed
configuration can be read from AWS while the repository is the local clone:

```bash
AWS_REGION=us-east-1 MMD_APPCONFIG=live pnpm mmd check "the checkout worker retries three times"
MMD_DYNAMO_TABLE=mmd-dev pnpm demo                        # the store is the table
MMD_BEDROCK_MODEL_ID=openai.gpt-oss-120b pnpm eval --proposers grammar,bedrock
```

The first two lines and the third were run against the real services on 18 September;
`docs/product-feedback.md` quotes what came back, and friction-log entries A4 to A6 are the four
defects that running them found.

## Layout

```
packages/drift-spec/      types · adjudication · severity · registry validation   [the OSS artifact]
packages/bee/             Bee client · event classification · fingerprints        [the track hook]
packages/engine/          registry · speech acts · grounding · polarity · extraction
                          adapters (appconfig, github, sentry) · store · recurrence
                          pipeline · reconcile · capture · docs-pr · config
apps/server/              HTTP API, SSE, dashboard host
apps/dashboard/           drift cards, evidence panel, mental-model timeline, conversation review
apps/relay/               the local process that sits next to `bee proxy`
apps/mcp/                 the Assumption Firewall
tools/bee-sim/            wire-conformant test proxy for protocol conformance and failure injection
tools/doctor/             the Bee preflight: every capability, over the live transport
tools/cli/                `mmd` -- the command the Agent Skill drives; verdict in the exit code
skills/mental-model-drift/    the Agent Skill, composing with bee-computer/bee-skill
tools/eval/               the golden corpus and the metrics harness
tools/demo/               fixture runner, corpus audit, reference repository seeding
infrastructure/           CDK stack and Lambda handlers
tests/conformance/        wire format verification through Bee's own SSE parser
tests/                    226 tests
```

`packages/drift-spec` has no I/O, no model and no Bee: it is the portable half, and it is the piece
intended to be useful to anyone building this kind of verification for a different source.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the pipeline, and why each boundary is where it is
- [`docs/privacy.md`](docs/privacy.md) — what is stored, what is never stored, and what leaves the machine
- [`docs/threat-model.md`](docs/threat-model.md) — including the ways this product could hurt someone
- [`docs/source-registry.md`](docs/source-registry.md) — how to point it at your own systems
- [`docs/friction-log.md`](docs/friction-log.md) — building against Bee, AWS and MCP: what worked, what did not
- [`docs/conformance.md`](docs/conformance.md) — wire format verification against Bee's protocol
- [`docs/product-feedback.md`](docs/product-feedback.md) — the submission's feedback answers

## Licence

Apache-2.0. See [LICENSE](LICENSE).

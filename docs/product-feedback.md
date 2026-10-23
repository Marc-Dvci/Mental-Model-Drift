# Product feedback

The submission's mandatory feedback answers, per tool. The detailed, reproducible version of the
"what needs work" column is [`friction-log.md`](friction-log.md); this is the summary a product team
can read in five minutes.

Written after building one project end to end: 244 tests, a 204-utterance labelled corpus, an MCP
server, a CDK stack and a working dashboard.

---

## Bee

Mental Model Drift has used data recorded and processed through an Apple Watch running Bee
software, accessed through an authenticated `bee proxy`. Private recordings are not included in
the repository.

### What I used it for

Four distinct things, which is the part I would want a Bee PM to notice, because a project that uses
one of them is a notification relay and a project that uses all four is a product:

| | surface | why the product needs it |
|---|---|---|
| **CAPTURE** | `GET /v1/stream` (SSE), `new-utterance` | the claim as spoken, while the decision is still being made |
| **RECALL** | `POST /v1/search/conversations/neural`, `bee search --neural` | one wrong sentence is a slip; the same one across six weeks is a mental model |
| **RECONCILE** | `GET /v1/changes?cursor=`, `bee changed --cursor` | realtime is at-most-once, so it cannot be the record |
| **CORRECT** | `POST /v1/facts`, `PUT /v1/facts/{id}` | the correction has to land where the wearer's assistant reads it next |

Plus `bee proxy` as the transport, `GET /v1/conversations/{id}/related` for adjacent discussions, and
`GET /v1/me` and `/v1/conversations` for health and the coverage survey. The `bee` CLI is the
fallback transport for machines with no proxy running.

And all three of Bee's integration doors, because they serve different audiences at different
moments: the **CLI**, an **MCP server** for an agent that speaks MCP mid-task, and an **Agent
Skill** (`skills/mental-model-drift/SKILL.md`) that composes with `bee-computer/bee-skill` over the
same `bee login` session.

One file talks to Bee: `packages/bee/src/client.ts`. `BeeClient.describeTransport()` reports which
transport is live, the dashboard shows it, and `pnpm doctor` exercises every capability over it.

### What worked well

- **The two delivery paths are the right design, and they are documented honestly.** Saying
  "at most once" plainly, in the docs, rather than implying reliability, is what made me build the
  cursor path at all. A vaguer promise would have produced a product that loses conversations in the
  field and never in testing.
- **`bee proxy` is the right shape for a local integration.** A loopback HTTP surface means an
  integration does not hold the user's token, which for a product that reads someone's whole working
  day is exactly the boundary you want. It also made a wire-conformant test proxy harness for the test suite possible, which is how this
  project has 244 tests.
- **Neural search over conversations is the feature that makes this product exist.** Without it, the
  best this could say is "you are wrong". With it, it can say "you have said this in five
  conversations since July, and four of them were before the value changed", which is a completely
  different sentence and the only one worth interrupting someone for.
- **`facts` closes the loop.** Writing a correction back as a confirmed fact means the wearer's own
  assistant is the thing that stops repeating the stale number. That is a much better ending than a
  notification.

### What needs work

Full detail with steps and severity in the friction log; six headlines:

1. **The documented payloads leave out the fields a client keys on.** The realtime documentation's
   `new-utterance` example has no `type`, no utterance `id` and no time, and shows a `speaker`. A
   live frame is the other way round: `type` in the payload as well as on the SSE `event:` line, an
   utterance `id`, `spoken_at`, and no speaker. Written to the examples, my client guessed types it
   did not need to guess, derived a fingerprint where an id exists, and treated `bee stream --json`
   as a transport that loses the type, which it does not. One real frame per event type in the docs,
   with the thirteen names in `SUPPORTED_EVENT_TYPES`, is the highest-value fix on this list.
   *(friction log B1.)*
2. **The reconnect obligation is not documented, and the wrong implementation looks right.**
   Reconciling on *disconnect* recovers nothing, because the conversation you are about to miss has
   not happened yet. I shipped that version and it passed all my tests. One sentence in the docs —
   "reconcile on reconnect, not on disconnect" — would save every integrator this bug. *(B2)*
3. **The read shapes are not documented, and the obvious guesses read nothing.** A conversation's
   words are under `transcriptions[]`, a realtime pass and then a final one with new ids and new
   punctuation, so `conversation.utterances` is always empty. `GET /v1/changes` returns bare ids
   with its cursor at the top level, while `bee changed --json` moves it into `meta`, so a proxy
   client reading `meta.next_cursor` never advances. Every time is epoch milliseconds except the
   stream's `spoken_at`. *(B5, B6, B7)*
4. **A live frame names its conversation by a uuid that no record carries.** The join is the
   utterance id, which matches the capturing conversation's realtime transcription. It works, but
   only someone who has compared a frame with a record will find it; `conversation_id` in the frame
   would remove the step. *(B3)*
5. **Every speaker is "Unknown".** One distinct label is the absence of diarisation, so a speaker
   count cannot attribute a sentence to the wearer, and the product asks before every write.
   bee-cli issue #19 reports the same across 15,578 utterances. *(B8)*
6. **Nothing says `bee proxy` is a full pass-through, and the docs' shape implies it is not.** It
   forwards every `/v1` path upstream with the token attached; there is no route list because there
   is no routing. But Bee is presented to integrators as a set of *commands*, with `bee proxy` a
   one-line entry under "Utility Commands", so I read `conversations related` as a CLI feature and
   built a hybrid client that shelled out for it — reintroducing exactly the token boundary the
   proxy exists to remove, and silently losing the capability on any machine without the CLI. One
   sentence would have prevented it, and a published OpenAPI document for `/v1` would prevent the
   whole class. *(B4)*

### Onboarding

Reading the developer docs to a working mental model of the API took under an hour, which is good.
The gap between "I understand the endpoints" and "I have a correct client" was much larger, and
almost all of it is items 1, 3 and 4 above: all three are about what a frame or a record actually
contains, all three are invisible until you build something that has to be exactly-once, and none
is hard to fix in documentation.

The one thing I would tell another integrator: **do not trust an integration test against your own
test double.** It proves your client agrees with your test double, and it is most convincing exactly
when both share a misconception — which is how items 1, 3, 4 and 6 above survived a full test suite:
my test proxy was written from the same examples as my client. What caught them was comparing both
with what Bee itself does: running my wire bytes through `parseSSEBuffer` copied out of `@beeai/cli`
([`conformance.md`](conformance.md)), and reading the response types the CLI declares for the API
against published live frames. That the CLI is MIT-licensed and readable is, quietly, one of the
most useful things about this platform, and it is doing work that documentation should be doing
instead.

### Would I build with it again?

**Yes.** The four-capability shape — hear, recall, reconcile, correct — is genuinely unusual. Almost
every other "AI wearable" surface I have looked at gives you a transcript and stops, and a
transcript is not a product. What makes this one interesting is the *history*: being able to ask
"has this person said this before, and when" is what turns an observation into a diagnosis. I would
build the next thing on `search --neural` and `facts` specifically.

---

## AWS

### What I used, and where

| service | used for | file |
|---|---|---|
| **AppConfig** + **AppConfigData** | the authoritative value of deployed configuration and feature state; hosted version history reconstructs *when* a value changed | `packages/engine/src/adapters/appconfig.ts` |
| **Bedrock** (`@anthropic-ai/bedrock-sdk` for Claude; the Bedrock API endpoint's chat completions for every other family) | the second extraction proposer, asked only which registry property a sentence is about — never whether it is true | `packages/engine/src/extract/bedrock.ts` |
| **DynamoDB** | single-table store: claims, evidence, drifts, cursor, dedupe markers with TTL | `packages/engine/src/store/dynamo-store.ts` |
| **CloudWatch** | the metrics that matter for this product: how much was heard, how little was acted on, how often a card was dismissed as "not my belief" | `infrastructure/lambda/index.ts` |
| **SQS + DLQ**, **Lambda**, **API Gateway (HTTP API)**, **Secrets Manager** | the deployed topology | `infrastructure/cdk/lib/mental-model-drift-stack.ts` |
| **CDK** (TypeScript) | all of the above, 35 resources, handlers bundled by `NodejsFunction` from the same `packages/` source the tests run against | `infrastructure/cdk/` |

### What was run, on 18 September

Three of the services in the runtime path were exercised against the real thing, from this
repository, with the results below quoted from the transcripts.

- **AppConfig.** An application `ecommerce`, environment `production`, profiles `checkout-worker`
  and `feature-flags`, two hosted versions of the retry configuration deployed in order. With
  `MMD_APPCONFIG=live`, `mmd check "the checkout worker retries three times"` returned `DRIFTED,
  stated 3, actually 1, evidence: AWS_APPCONFIG OK appconfig://ecommerce/production/checkout-worker$.retry.max_attempts`,
  and the feature flag read `SUPPORTED` for EU. The adapter's `history()` returned the change 3 → 1,
  dated by the deployment that shipped it, with the deployment's own description. The whole 09:02
  conversation was then played through the engine with every AppConfig read live: three drifts,
  the same three the local mirror produces.
- **Bedrock.** The proposer ran over the full 204-utterance corpus alongside the grammar:
  recall **90.2% → 93.1%**, precision **100%** on both runs, zero false positives, 2.2 s a call.
  Claude is not available to the account this was built with, so the model was
  `openai.gpt-oss-120b`, asked the identical question over the endpoint's chat completions with
  the same JSON schema; the proposer folds that answer into the same registry and quotation gates,
  and nothing downstream can tell which family answered. That is the architecture doing what it
  was built to do.
- **DynamoDB.** The demo conversation, into a real table: 34 items, every counter incremented
  atomically, the drifts read back through the same API the dashboard uses.

Running them found four defects the tests could not, all fixed and written up as friction-log
entries A4 to A6: hosted versions carry no timestamp (the deployment does, and is the better
source); the endpoint prefixes a schema-constrained answer with a stray token a third of the time;
two proposers spelling one value two ways tripped the ambiguity rule; and `getMetrics` on the
DynamoDB store was a stub.

### What worked well

- **AppConfig's deployment history is the quiet hero of this project.** It is what lets the product
  say "that was the value until 23 August" instead of only "you are wrong". I went looking for that
  capability in git and found it in AppConfig, already there, already versioned, with the deployment
  that changed it. The first live run corrected one thing about that sentence: the *version* is not
  dated, the *deployment* is, and the deployment is the right unit anyway, because a version that
  was never deployed never changed production.
- **The Bedrock API endpoint answers the right question when a model is not available.**
  `permission_error: anthropic.claude-opus-5 is not available for this account`, naming the model.
  `InvokeModel` through the SDK answers the same situation with `ValidationException: Operation not
  allowed`, which reads as a malformed request and cost an hour on the request body.
- **`NodejsFunction` bundled a pnpm workspace using Node subpath imports (`#spec`, `#engine`) with no
  configuration at all.** `projectRoot` + `depsLockFilePath` and it worked. This was the one thing I
  had budgeted a painful afternoon for, and it took none.
- **CDK's synth-time validation caught real mistakes** (a missing IAM grant, a DLQ with no
  redrive policy) before anything was deployed.

### What needs work

1. **`FunctionOptions#logRetention` is deprecated in favour of `logGroup` with no migration path in
   the message and no codemod**, and the warning prints four times per `synth`. The message should
   name the replacement construct and show the two lines. *(friction log A2)*
2. **AppConfigData's "empty configuration body means unchanged" semantics is a footgun.** A poller
   that treats an empty body as an empty document silently reports a property as absent. It is
   documented; it is also the opposite of what every other read API does. *(A1)*
3. **`cdk synth` succeeding tells you almost nothing about whether `cdk deploy` will.** The class
   of error synth cannot see, quotas, model availability per region, account-level enablement, only
   shows up at deploy time, and `cdk diff` does not preview it either.
4. **A hosted configuration version carries no creation time.** `ListHostedConfigurationVersions`
   returns a number, a description and a content type. The date is on `ListDeployments`, one call
   over, and nothing in the guide on tracking changes says so. *(A4)*
5. **Strict `response_format` on the endpoint's chat completions is not strict.** One answer in
   three arrived as a stray `{` or `[]` followed by the object. Every one of those answers was
   correct about the sentence, and every one failed `JSON.parse`. *(A5)*
6. **Three states look like "Bedrock works" and only the last one does.** Credentials resolve;
   STS accepts them; the account is entitled to the model. `list-foundation-models` returns ninety
   model ids whichever state you are in, because it describes the catalogue rather than the caller,
   and `get-foundation-model-availability` is the call that answers and the one nobody reaches for.

### Onboarding

CDK zero-to-synth was about twenty minutes, most of it bootstrap reading. The AppConfig data plane
took longer than the control plane, because the two-call session/token dance is not obvious from the
API reference alone.

`cdk synth` produces 35 resources and a 1.5 MB bundle from the same `packages/` source the tests
run against. The grammar proposer alone is the floor, at 90.2% recall and 100% precision; with the
Bedrock proposer beside it the corpus reads 93.1% and 100%, because both feed the same
deterministic grounding gate and the gate is what holds precision. The seven utterances still
missed are the gate declining on purpose: a negated clause, or a sentence with no lexeme for the
property, which is the strictness the false-positive rate is bought with.

### Would I build with it again?

**Yes**, and specifically I would reach for AppConfig again for anything that needs "what is the
value now, and when did it stop being the old one". Bedrock's role here is deliberately small, and I
would keep it small: the value of this architecture is that the model answers one narrow question
and a deterministic gate decides whether to believe it.

---

## Model Context Protocol — TypeScript SDK 1.30

### What I used it for

`apps/mcp` — the "Assumption Firewall". Five tools (`check_assumption`, `belief_history`,
`list_verifiable_properties`, `open_drifts`, `record_understanding`) over stdio, or Streamable HTTP
with `--http`. It exists because a coding agent is handed human context constantly and has no way to
tell a fact from a memory: told "the worker retries three times, so a slow consumer isn't the
problem", it will write a confident patch on a premise that stopped holding three weeks ago, and
defend it, because it reasoned correctly from what it was given.

### What worked well

- **`registerTool` with a Zod schema is a good API.** Tool definition, validation and the typed
  handler in one place, and the generated schema is what the client actually sees.
- **`InMemoryTransport.createLinkedPair()` is what makes an MCP server testable in-process.** All 14
  MCP tests drive a real `Client` against a real `Server` with no subprocess and no port. This is the
  single most useful thing in the SDK and it is easy to miss.
- **Adding Streamable HTTP alongside stdio was a transport swap and nothing else.**

### What needs work

1. **Argument-validation failures come back as a *result* with `isError: true`, not as a rejected
   promise.** A test written as `await expect(...).rejects.toThrow()` fails misleadingly, and worse,
   a client that only catches exceptions treats a validation failure as success. The README should
   say this in the first tool example. *(friction log M1)*
2. **`InMemoryTransport` is under-advertised.** It belongs in the testing section of the README, with
   the six lines it takes.

### Onboarding

Zero to a working stdio server with one tool: about fifteen minutes. Zero to a *tested* one: another
hour, most of it discovering item 2.

### Would I build with it again?

**Yes.** The interesting realisation from this project is that MCP is the right shape for a
*negative* capability — a tool whose job is to stop an agent acting on something — and I have not
seen many of those. `check_assumption` returns not just the corrected value but the instruction to
tell the human what changed and when, rather than silently correcting them.

---

## Everything else, briefly

| tool | used for | verdict |
|---|---|---|
| **Node 22 / TypeScript 5.7** | the whole product, strict mode with `noUncheckedIndexedAccess` | Yes. The strictest settings found three real defects the first time `tsc --noEmit` ran. |
| **Vitest 3** | 244 tests | Yes. Upgrading from 2.1 to 3.2 to clear a critical advisory took one command and broke nothing. |
| **Vite 6 + React 18** | the dashboard | Yes. 15 kB of CSS, 175 kB of JS, a 360 ms build. |
| **pnpm 9** | workspace | Yes, with one sharp edge: a `package.json` script named `audit` is silently shadowed by pnpm's own command, so the README documented a command that printed a vulnerability report instead of the product's tool. *(friction log P1)* |
| **Playwright** | recording the demo against the real running product | Yes. One trap: `page.evaluate` awaits a returned promise, so returning the tour's `start()` puts the recording window over the end screen. *(PW1)* |
| **GitHub CLI** | credential for the docs pull request, via `gh auth token` | Yes. |
| **Node on Windows** | — | The one genuine platform problem: there is no way to spawn an npm `.cmd` shim that Node does not object to. `ENOENT` without a shell, `DEP0190` with one, and `EINVAL` if you resolve the path and skip the shell. Three cases, all needed. *(N1)* |

# Product feedback

The submission's mandatory feedback answers, per tool. The detailed, reproducible version of the
"what needs work" column is [`friction-log.md`](friction-log.md); this is the summary a product team
can read in five minutes.

Written after building one project end to end: 220 tests, a 204-utterance labelled corpus, an MCP
server, a CDK stack and a recorded demo.

---

## Bee

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
  day is exactly the boundary you want. It also made a faithful emulator possible, which is how this
  project has 220 tests.
- **Neural search over conversations is the feature that makes this product exist.** Without it, the
  best this could say is "you are wrong". With it, it can say "you have said this in five
  conversations since July, and four of them were before the value changed", which is a completely
  different sentence and the only one worth interrupting someone for.
- **`facts` closes the loop.** Writing a correction back as a confirmed fact means the wearer's own
  assistant is the thing that stops repeating the stale number. That is a much better ending than a
  notification.
- **Diarisation without identity is the right call**, and it is what let me build ownership handling
  that asks rather than assumes.

### What needs work

Full detail with steps and severity in the friction log; five headlines:

1. **The stream's event type is the SSE `event:` name, and this is not written down anywhere a
   client author reads.** It is not in the developer docs, not in `bee-skill`'s SKILL.md, and not in
   `bee stream --help`; I found it in `@beeai/cli`'s source, after shipping a client that inferred
   each frame's type from its payload instead. Inference is not merely inelegant, it is wrong:
   `update-conversation-summary` is flat and has no `conversation` key to look inside,
   `delete-conversation` is shape-identical to `new-conversation`, and `journal-deleted` carries
   `journalId` rather than `journal`. And the failure is silent in both directions — `parseSSEBuffer`
   discards any frame lacking an `event` line, so a client that ignores the name and a server that
   never sends one agree perfectly and deliver nothing.

   One paragraph in the streaming documentation, listing the thirteen names already present in
   `SUPPORTED_EVENT_TYPES`, is the highest-value fix on this list. *(friction log B1.)* Relatedly,
   `bee stream --json` prints the payload alone and drops the name, so the one mode intended for
   programs is the one mode that cannot say what it received. *(B1b.)* There is still no event **id**,
   so every client invents its own fingerprint and will get the deduplication window wrong
   differently.
2. **The reconnect obligation is not documented, and the wrong implementation looks right.**
   Reconciling on *disconnect* recovers nothing, because the conversation you are about to miss has
   not happened yet. I shipped that version and it passed all my tests. One sentence in the docs —
   "reconcile on reconnect, not on disconnect" — would save every integrator this bug. *(B2)*
3. **Realtime frames key conversations by `uuid`; read endpoints key by `id`.** Every client needs a
   resolve step. *(B3)*
4. **Nothing says `bee proxy` is a full pass-through, and the docs' shape implies it is not.** It
   forwards every `/v1` path upstream with the token attached; there is no route list because there
   is no routing. But Bee is presented to integrators as a set of *commands*, with `bee proxy` a
   one-line entry under "Utility Commands", so I read `conversations related` as a CLI feature and
   built a hybrid client that shelled out for it — reintroducing exactly the token boundary the
   proxy exists to remove, and silently losing the capability on any machine without the CLI. One
   sentence would have prevented it, and a published OpenAPI document for `/v1` would prevent the
   whole class. *(B4)*
5. **Utterance text is re-punctuated between the live frame and the stored transcript.** Content-key
   deduplication has to normalise punctuation or the same sentence produces two identical cards.
   Worth a line in the docs. *(B5)*

### Onboarding

Reading the developer docs to a working mental model of the API took under an hour, which is good.
The gap between "I understand the endpoints" and "I have a correct client" was much larger, and
almost all of it is items 1 and 2 above: both are about identity and delivery, both are invisible
until you build something that has to be exactly-once, and neither is hard to fix in documentation.

The conditions this feedback was gathered under, and everything this build has and has not run
against, are set out in [`limitations.md`](limitations.md).

The one thing I would tell another integrator: **do not trust an integration test against your own
simulator.** It proves your client agrees with your simulator, and it is most convincing exactly
when both share a misconception — which is how items 1 and 4 above survived a full test suite. What
caught them was copying `parseSSEBuffer` out of `@beeai/cli` and running my own wire bytes through
Bee's parser ([`conformance.md`](conformance.md)). That the CLI is MIT-licensed and readable is,
quietly, one of the most useful things about this platform, and it is doing work that documentation
should be doing instead.

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
| **Bedrock** (Claude, `@anthropic-ai/bedrock-sdk`) | the second extraction proposer, asked only which registry property a sentence is about — never whether it is true | `packages/engine/src/extract/bedrock.ts` |
| **DynamoDB** | single-table store: claims, evidence, drifts, cursor, dedupe markers with TTL | `packages/engine/src/store/dynamo-store.ts` |
| **CloudWatch** | the metrics that matter for this product: how much was heard, how little was acted on, how often a card was dismissed as "not my belief" | `infrastructure/lambda/index.ts` |
| **SQS + DLQ**, **Lambda**, **API Gateway (HTTP API)**, **Secrets Manager** | the deployed topology | `infrastructure/cdk/lib/mental-model-drift-stack.ts` |
| **CDK** (TypeScript) | all of the above, 35 resources, handlers bundled by `NodejsFunction` from the same `packages/` source the tests run against | `infrastructure/cdk/` |

### What worked well

- **AppConfig's hosted configuration version history is the quiet hero of this project.** It is what
  lets the product say "that was the value until 23 August" instead of only "you are wrong". I went
  looking for that capability in git and found it in AppConfig, already there, already versioned,
  with the deployment that changed it.
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
3. **`cdk synth` succeeding tells you almost nothing about whether `cdk deploy` will.** That is a
   known gap and not news, but it is the reason this submission has a synthesized stack and not a
   deployed one.

### Onboarding

CDK zero-to-synth was about twenty minutes, most of it bootstrap reading. The AppConfig data plane
took longer than the control plane, because the two-call session/token dance is not obvious from the
API reference alone.

**Honest caveat:** the AWS credentials available to me during the build returned
`InvalidClientTokenId`, so **nothing has been deployed and Bedrock has never actually been called**.
`cdk synth` succeeds (35 resources, 1.5 MB bundle) and the adapters and the Bedrock proposer are
written against the real SDKs, but every number quoted in this repository comes from the local run
with the grammar proposer alone, which is the honest floor. This is stated in the README as well,
because a reviewer will find it anyway and should find it from me first.

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
| **Vitest 3** | 220 tests | Yes. Upgrading from 2.1 to 3.2 to clear a critical advisory took one command and broke nothing. |
| **Vite 6 + React 18** | the dashboard | Yes. 15 kB of CSS, 175 kB of JS, a 360 ms build. |
| **pnpm 9** | workspace | Yes, with one sharp edge: a `package.json` script named `audit` is silently shadowed by pnpm's own command, so the README documented a command that printed a vulnerability report instead of the product's tool. *(friction log P1)* |
| **Playwright** | recording the demo against the real running product | Yes. One trap: `page.evaluate` awaits a returned promise, so returning the tour's `start()` puts the recording window over the end screen. *(PW1)* |
| **Edge TTS** | narration, measured per sentence so the visuals pace themselves to the voice | Yes. |
| **GitHub CLI** | credential for the docs pull request, via `gh auth token` | Yes. |
| **Node on Windows** | — | The one genuine platform problem: there is no way to spawn an npm `.cmd` shim that Node does not object to. `ENOENT` without a shell, `DEP0190` with one, and `EINVAL` if you resolve the path and skip the shell. Three cases, all needed. *(N1)* |

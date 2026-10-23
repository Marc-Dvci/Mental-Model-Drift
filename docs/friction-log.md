# Friction log

Every entry here is something that actually happened while building Mental Model Drift, with the
step that produced it and the workaround that got past it. Nothing is invented, and the entries
where the tool was right and I was wrong are marked as such, because those are the ones that say
something useful about the documentation.

Severity is what it cost *this* project: **high** means it silently produced wrong behaviour,
**medium** means it cost an hour or forced a design change, **low** means it was noise.

---

## Bee

### B1 — The documented stream payloads leave out the fields a client keys on

**Severity: high** (two conclusions I built on were wrong, because of what the examples leave out)

**Task.** Subscribe to `new-utterance`, tie each frame to its conversation, and process each one once.

**Steps.** Wrote the reader from the realtime documentation's example payload,
`{"utterance":{"text":"…","speaker":"speaker_1"},"conversation_uuid":"…"}`. It has no type field, no
utterance id and no time, so I concluded that a frame carries no discriminator and no identity of
its own. Reading `@beeai/cli`, `sources/commands/stream/index.ts`, then showed that `bee stream`
keys on the SSE `event:` line: its `parseSSEBuffer` drops any frame without one, and `formatEvent`
switches on the name across a fixed list of thirteen types. So I made the `event:` line the only
authority, treated `bee stream --json` (which prints the `data:` line alone) as a transport that
loses the type, and derived a fingerprint for identity.

**Expected.** Example payloads that show what a frame contains.

**Actual.** A live frame carries what the examples leave out, and lacks what they show:

```
event: new-utterance
data: {"type":"new-utterance","conversation_uuid":"…","utterance":{"id":3676590930,"sample_id":"…",
       "start":12.47,"end":16.27,"text":"…","spoken_at":"2026-09-01T09:02:13.000Z"}}
```

The type is in the payload as well as on the `event:` line, so `--json` loses nothing. The utterance
has an id and a `spoken_at`. There is no `speaker`. Each of my three conclusions was an artefact of
the examples, not of Bee.

Guessing a type from a payload's shape is still wrong where a frame arrives with no name at all,
because the payloads are not disjoint:

| event | payload | what a shape-guesser does |
|---|---|---|
| `update-conversation-summary` | `{conversation_id, short_summary}` | misses it entirely — there is no `conversation` key to look inside |
| `delete-conversation` | `{conversation:{…}}` | indistinguishable from `new-conversation` |
| `journal-deleted` | `{journalId, reason}` | does not match the other journal events, which carry `journal` |

**Workaround.** `packages/bee/src/events.ts` reads the name from the `event:` line, then from the
frame's own `type`, and only then from the shape, marking a shape guess `nameWasInferred` so it is
never mistaken downstream for something Bee said. It reads the utterance id and `spoken_at` off every
frame; the id is what joins a frame to its conversation (B3). `tests/conformance/bee-wire.test.ts`
runs the test proxy's literal socket bytes through Bee's own `parseSSEBuffer`, copied verbatim, and
pins every field of the frame.

**Suggestion.** Publish one real frame per event type in the realtime documentation, with `type`,
the utterance `id` and `spoken_at` in it, and say that `speaker` is absent. The thirteen names in
`SUPPORTED_EVENT_TYPES` belong there too.

---

### B2 — At-most-once delivery is documented; the reconnect obligation is not

**Severity: high** (the wrong implementation looks correct and recovers nothing)

**Task.** Lose no utterance when the laptop sleeps mid-conversation.

**Steps.** Read the delivery semantics — events that occur while disconnected are not received —
and built the obvious thing: treat every disconnect as a gap and run `changed --cursor` immediately.

**Expected.** That closes the gap.

**Actual.** It closes almost none of it. The conversation you miss is the one that happens *while*
you are disconnected, and at the moment you disconnect it has not been recorded yet. Reconciling on
disconnect pulls in what Bee already had, which by definition excludes everything you are about to
miss. The implementation passed every test I had, and recovered nothing.

**Workaround.** Reconcile from both ends of the gap: on disconnect *and* on reconnect. The reconnect
pass is the one that actually recovers anything. This is now one shared module
(`packages/engine/src/capture.ts`) used by both entry points, and `tests/e2e/capture.test.ts` cuts a
real stream to prove it.

**Suggestion.** One paragraph in the streaming docs: "reconciling when the stream drops recovers
what we already had; reconciling when it comes back is what recovers what you missed." The failure
is invisible in testing because a test that plays events *before* cutting the stream passes.

---

### B3 — A live frame names its conversation by a uuid no read endpoint knows

**Severity: high** (the live and the recovered copy of a sentence never met, so a card could be raised twice)

**Task.** Fetch the conversation an incoming utterance belongs to, for the preceding sentences, and
file the claim under the same conversation the reconciliation pass will later read.

**Steps.** Took `conversation_uuid` from the frame and looked for it among the recent conversation
records, falling back to using the uuid itself as the conversation's name.

**Expected.** A conversation record with that uuid on it.

**Actual.** A conversation record has no uuid field. `@beeai/cli` declares what
`GET /v1/conversations/:id` returns — a numeric `id`, times, state, summaries, `transcriptions` — and
a uuid is not among them. So the lookup could never match, and the fallback filed every live claim
under a name the reconciler never uses. The content-key dedupe saw two different conversations, and
the card's own conversation came back from the history search as an earlier statement of itself.

**Workaround.** The utterance joins them. The id a live frame gives its utterance is the id of the
same utterance in the capturing conversation's realtime transcription. `resolveConversationId()`
reads the conversations still being captured and returns the one holding that id, falls back to the
sentence's text, and caches the answer per uuid. Every live claim is filed under the numeric id, and
dedupe keys on it. `packages/engine/src/live.ts` is the one path the server, the relay's backend and
the tests take.

**Suggestion.** Put `conversation_id` in `new-utterance` frames, or `uuid` on conversation records.

---

### B4 — `bee proxy` forwards everything, and I assumed it was a subset

**Severity: medium** (self-inflicted, but the documentation invites it)

**Task.** Use one transport for everything.

**Steps.** Moved the client onto `bee proxy`, then went looking for a proxy endpoint behind
`bee conversations related`. The Skill's capability map presents Bee as a list of *commands*, and
lists `bee proxy` at the bottom under "Utility Commands" with a one-line signature and no
description of what it forwards. Reading that, `related` looks like a CLI feature. I built the
client as a hybrid — proxy where the proxy "has an endpoint", CLI for the rest — and gave `related()`
an early return of `[]` whenever the `bee` binary was absent.

**Expected.** A documented route list for the proxy.

**Actual.** There is no route list, because there is no routing. `startProxy` is a transparent
pass-through: anything whose path starts with `/v1` gets the owner's bearer token attached and is
forwarded upstream verbatim, and anything else is a 404. So the proxy's surface is *the API's*
surface, which is a superset of what the CLI exposes as subcommands.
`GET /v1/conversations/:id/related` — the endpoint the `related` subcommand reads — works through
the proxy exactly as it works through the CLI.

The cost was real and silent: a proxy-only deployment (a container, a judge's laptop, the demo)
lost Bee's related-conversations capability entirely, and returned an empty list rather than an
error, so nothing looked broken.

**Workaround.** The client is now proxy-only whenever a proxy is configured, and shells out to the
binary only when there is no proxy at all. One transport, one code path, no capability that
disappears depending on how the process was started. `pnpm doctor` exercises every endpoint over
whichever transport is configured and prints a table, so this class of silent gap shows up as a row
rather than as an empty array.

**Suggestion.** One sentence where `bee proxy` is documented: *"the proxy forwards every `/v1` path
to the Bee API with your token attached; it is not limited to the endpoints the CLI has subcommands
for."* Presenting the surface as commands rather than as an API is what made me draw the wrong
boundary, and a published OpenAPI document for `/v1` would have prevented all of it.

---

### B5 — Neither the utterance id nor the exact text survives processing

**Severity: medium** (would have been a duplicate card in production)

**Task.** Process an utterance exactly once when the live stream and the reconciliation pass both
deliver it.

**Steps.** Looked for something the live frame and the reconciled read of the same sentence share.

**Expected.** The utterance id, now that the frame carries one (B1).

**Actual.** While a conversation is being captured, its words sit in a `realtime: true`
transcription under the ids the stream sent. Once Bee has processed it, a `realtime: false`
transcription replaces it, with new ids and its own sentence punctuation. A sentence streamed live
and read back after processing can carry two different ids and end in two different ways.

**Workaround.** Deduplication keys on the conversation's numeric id plus normalised text.
Normalisation strips sentence punctuation but keeps a period between digits, so `4.12` survives as a
value. `tests/e2e/capture.test.ts` completes the conversations after the live run and requires the
reconciliation pass to find nothing new.

**Suggestion.** Document the two transcriptions, and whether a realtime utterance id maps to a final
one. A `realtime_id` on final utterances would let clients key on ids.

---

### B6 — A conversation's words are under `transcriptions[]`, not a flat list

**Severity: high** (every transcript read came back empty, and an empty transcript looks like a quiet conversation)

**Task.** Read the verbatim utterances of one conversation.

**Steps.** Read `conversation.utterances`, the shape the documentation's `bee now` example shows:
each conversation with its `utterances` directly underneath.

**Expected.** The utterances.

**Actual.** `GET /v1/conversations/:id` returns `{conversation, timezone}`, and the words are in
`conversation.transcriptions[].utterances`, one transcription per pass (B5). `bee now` is the CLI's
own rendering, not the API's shape. Every time on the record is epoch milliseconds; an utterance's
`start` and `end` are seconds into the recording; `spoken_at` is the wall-clock time; and the API
does not return utterances in spoken order. `bee conversations transcript --json` is no shortcut:
it returns `{conversationId, transcript, note}` with every transcription flattened into one list,
so a conversation still being processed comes back with each sentence twice.

**Workaround.** `pickTranscript()` (`packages/bee/src/read.ts`) takes the final transcription, else
the realtime one, sorted by `spoken_at`, then offset, then id — the rule `bee conversations get`
applies. `pnpm doctor` fails its transcript row on zero utterances.

**Suggestion.** Document the conversation response, field by field, with the units of each time.

---

### B7 — `/v1/changes` and `bee changed --json` answer in different shapes

**Severity: high** (on the proxy the cursor would never have advanced)

**Task.** Persist the changefeed cursor after each processed batch.

**Steps.** Read `meta.next_cursor` and a list of conversation objects, the shape `bee changed --json`
prints.

**Expected.** The same answer from the API, which the CLI command wraps.

**Actual.** The API returns bare ids — `{conversations:[…], facts:[], …, next_cursor, since, until,
updated, timezone}` — with the cursor at the top level. It is the CLI that fetches each id and moves
the cursor into a `meta` object (`sources/commands/changed/index.ts`). A client on `bee proxy`
reading `meta.next_cursor` never stores a cursor, and re-reads the same 24-hour window on every pass.

**Workaround.** `readChangeBatch()` reads either shape into one batch of ids, with the fetched
records when the CLI already has them; the reconciler reads each conversation by id, and holds the
cursor back if any read fails. The conformance test pins both shapes.

**Suggestion.** Document the API's shape, and say the CLI reshapes it.

---

### B8 — Every speaker is "Unknown"

**Severity: medium** (forced a design change in how a sentence is attributed to the wearer)

**Task.** Act on a belief without asking only when it is the wearer's own.

**Steps.** Counted the distinct speaker labels in the conversation: one label meant one speaker,
and one speaker meant the wearer.

**Expected.** Diarisation labels that tell people apart.

**Actual.** Every utterance is `"speaker": "Unknown"` (bee-cli issue #19 reports 15,578 utterances
across 133 conversations, all "Unknown", with the wearer's voice enrolled), and a live frame has no
speaker at all. One distinct label is the absence of diarisation, not a monologue. Counted as one
speaker, it would have attributed every sentence in a meeting to the wearer.

**Workaround.** `labelledSpeakerCount()` counts real labels only, and none means the count is
unknown. The claim is then UNKNOWN-ownership, and the card asks "Was this your understanding?"
before any write to Bee is possible.

**Suggestion.** A stable label per speaker, and a flag on the wearer's own utterances.

---

## AWS

### A1 — AppConfig's empty configuration body means "unchanged", not "empty"

**Severity: medium**

**Task.** Read the deployed value for one property.

**Steps.** `StartConfigurationSession`, then `GetLatestConfiguration`, then poll again on the next
claim.

**Expected.** A configuration body each time.

**Actual.** A second poll with an unchanged configuration returns an *empty* `Configuration` field.
Read naively, that is "this property does not exist" — which in this product means a claim would be
adjudicated against nothing.

**Workaround.** An empty body invalidates the cached session token and re-reads once, guarded against
recursion. The adapter would otherwise report `NOT_FOUND`, and `NOT_FOUND` is a verdict a user sees.

**Suggestion.** The behaviour is documented, but it is documented as an optimisation rather than as a
correctness hazard. A one-line warning in the API reference would help.

---

### A2 — `logRetention` is deprecated with no migration path in the message

**Severity: low**

**Task.** Set a retention on the Lambda log groups.

**Steps.** `logRetention: logs.RetentionDays.ONE_MONTH` on the function props, as most examples still
show.

**Expected.** Either it works or the deprecation tells me what to do.

**Actual.** Works, and prints `aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated. use
'logGroup' instead` four times per synth. `logGroup` takes a construct, not an enum, so the fix is
not the one-line substitution the message implies.

**Workaround.** A small `logGroupFor()` helper creating a `logs.LogGroup` per function.

**Suggestion.** Put the three-line replacement in the deprecation message.

---

### A3 — `NodejsFunction` handled Node subpath imports with no configuration

**This one is a compliment, and it is the entry I expected to be a complaint.**

**Task.** Bundle Lambda handlers that import `#spec`, `#bee` and `#engine` — Node subpath imports,
resolved from the root `package.json`, in a repository with no build step.

**Expected.** A fight with esbuild resolution, and probably a custom bundler command.

**Actual.** `entry` plus `projectRoot` plus `depsLockFilePath` was enough. `cdk synth` produced a
1.5 MB bundle of the real engine source on the first attempt.

**Suggestion.** The subpath-imports case is worth an example in the `NodejsFunction` docs; it is the
modern alternative to a monorepo build step and it is not obvious that it just works.

---

### A4 — A hosted configuration version has no timestamp; the deployment does

**Severity: high** (the product's central sentence, "that was the value until 23 August", read as
"until just now" on the first live run)

**Task.** Reconstruct when `retry.max_attempts` changed in production, from AppConfig alone, with
the adapter's `history()` running against a real application for the first time.

**Expected.** `ListHostedConfigurationVersions` to carry a creation time per version, the way every
other versioned store does.

**Actual.** It carries `VersionNumber`, `Description`, `ContentType` and a KMS ARN. No date. The
adapter had filled the gap with `new Date()`, so every change was stamped with the moment the
question was asked, and the timeline the product is built around collapsed to a single instant.
The test fixtures carry dates, so nothing offline could have shown this.

The date lives one call over: `ListDeployments` returns `StartedAt`, `CompletedAt` and the version
each deployment shipped. That turns out to be the *right* source, not a substitute. A version that
was authored and never deployed never changed what production was running, and the old code would
have reported it as a change. The adapter now walks deployments, in order, and reads each shipped
version once.

**Suggestion.** A `CreatedAt` on hosted versions would be welcome, but the documentation fix is the
bigger one: the AppConfig guide on "tracking configuration changes" should say that the deployment,
not the version, is the unit of history for an environment. `MaxResults` on `ListDeployments` also
caps at 50 and rejects 100 with a validation error, which the API reference states and the SDK's
types do not.

---

### A5 — Bedrock's chat-completions endpoint, given a JSON schema, prefixes the object with a stray token

**Severity: high** (a model that was right on every utterance was scored as adding no recall at all)

**Task.** Run the Bedrock proposer against the corpus. Claude is not available in the account this
was built with, on either the SDK path or the Bedrock API endpoint, so `openai.gpt-oss-120b` is
asked the same question over `/v1/chat/completions` with the claim schema as `response_format`.

**Expected.** `message.content` to be the schema's object.

**Actual.** About one answer in three came back as `{` + newline + the object, or `[]` + the object,
or the object inside a one-element array. Each of those fails `JSON.parse`, the proposer swallowed
the failure as "no claims", and the first corpus run reported grammar + Bedrock at exactly the
grammar's own 89.2% recall, with the same eleven misses. Reading the raw content is what showed the
model had named the right subject, property and value every time. The parser now finds the object
by its `"claims"` key and reads it from the brace that opens it, and recall went to 93.1% with
precision still 100%.

Two further things surfaced only because a second proposer was finally producing proposals. The
grammar reads `4.13` off a sentence and a model answers `4.13.0`; keyed raw, that is two values
for one property, and the extractor's ambiguity rule rejected both, so corroboration was acting as
a veto. Values are now normalised to the catalogue type before anything compares them. And the
"two systems in one sentence is ambiguous" rule lived inside the grammar proposer, so a model that
happily split the sentence walked straight past it; it now sits in the extractor, where every
proposer's output passes.

**Suggestion.** Strict `response_format` should mean strict. Until it does, the endpoint's
documentation should say that the content may carry a prefix, so that a caller knows to locate the
object rather than parse the string.

---

### A6 — `getMetrics` was a stub, and the atomic counters were fine

**Severity: medium** (the coverage panel, the product's "silence is the feature" evidence, read zero
against the real store)

**Task.** Play the demo conversation into the engine with `MMD_DYNAMO_TABLE` set, for the first
time against a real table.

**Actual.** Thirty-four items landed: five claims, five evidence rows, three drifts, three
histories, eleven dedupe markers, a cursor, and six counters incremented by `ADD`. Then the demo
printed `heard 0 · reconciled 0 · deduplicated 0`, because the store's `getMetrics()` returned `{}`
with a comment saying the deployed dashboard would read CloudWatch instead. The dashboard reads the
store. The table double the tests use never exposed this because it kept its counters in a map.

**Workaround.** The counter names are a closed set the pipeline increments, so one `BatchGet` on
those keys answers without a scan.

**Suggestion.** None for AWS; this one is on me. It is here because it is the same shape as A4: a
read path written to a design that was never run, next to a write path that worked.

---

## MCP TypeScript SDK 1.30

### M1 — Argument-validation failures resolve, they do not reject

**Severity: low**

**Task.** Assert that an MCP tool rejects a too-short argument.

**Steps.** `await expect(client.callTool({...})).rejects.toThrow()`.

**Expected.** A rejected promise, since this is a protocol-level `-32602`.

**Actual.** The call resolves with `{ isError: true, content: [{ text: "MCP error -32602: Input
validation error: ..." }] }`. The test failed for the wrong reason and read as though validation was
missing entirely.

**Workaround.** Assert on `isError` and the message.

**Suggestion.** Say in the client docs which failures reject and which resolve with `isError`; it
determines how every test around a tool is written.

---

### M2 — `InMemoryTransport` is the thing that makes a server testable, and it is easy to miss

**Severity: low**

**Task.** Test the MCP surface without spawning a process and speaking stdio to it.

**Steps.** Looked for a testing section; found the transports list; nearly wrote a subprocess
harness.

**Actual.** `InMemoryTransport.createLinkedPair()` exists and is exactly right: the 14 tests in
`tests/e2e/mcp.test.ts` drive the real server through a real `Client`, exercising discovery,
validation and structured content, with no process management.

**Suggestion.** Put it in the README under a "testing your server" heading. It is the difference
between a tested MCP server and an untested one.

---

## Node on Windows

### N1 — There is no way to spawn a `.cmd` shim that Node does not object to

**Severity: low** (noise, but noise in the middle of a demo)

**Task.** Shell out to `bee` and `gh` on Windows without printing a deprecation warning into the
product's own output.

**Steps.** `spawn('bee', args)`. Then `spawn('bee', args, { shell: true })`. Then resolve the shim's
real path and spawn that with `shell: false`.

**Expected.** One of those three works cleanly.

**Actual.** All three have a catch, and they interact:

1. `spawn('bee', args)` fails with `ENOENT`: `bee` is installed by npm as `bee.cmd`, and Windows
   `CreateProcess` does not apply `PATHEXT`.
2. `spawn('bee', args, { shell: true })` works, and Node 22 prints `DEP0190: Passing args to a child
   process with shell option true can lead to security vulnerabilities` for every call.
3. Resolving `bee.cmd` on `PATH` and spawning that path with `shell: false` fails with `EINVAL`.
   Since Node 20.19 / 22.x this is deliberate, from the fix for CVE-2024-27980: a `.cmd` cannot be
   spawned without a shell at all.

There is also a trap in (3). Searching `PATH` for the bare name first finds
`C:\Program Files\nodejs\npx`, an extensionless shell script Windows cannot execute, and the
spawn then fails with `ENOENT` pointing at a file that demonstrably exists.

**Workaround.** `packages/bee/src/bin.ts` splits the cases, because Windows does:

- a real executable (`gh.exe`) is resolved on `PATH` and spawned by its full path with no shell;
- a `.cmd` shim (`bee`) is spawned by its bare name with `shell: true`, which is the only thing that
  works, and letting the shell do the lookup avoids a path with a space in it having to survive
  argument concatenation;
- anything that is really Node in a costume (`npx tsx`) is not launched through a shim at all.
  `tools/demo/src/run.ts` and `tests/e2e/server.test.ts` spawn `process.execPath` with
  `node_modules/tsx/dist/cli.mjs`, which is warning-free and faster.

`pnpm demo` now runs with no deprecation warning anywhere in its output.

**Suggestion.** `child_process` could expose the resolution it already does internally — something
like `spawn(cmd, args, { windowsShim: true })` that finds the shim and runs it through `cmd.exe`
with properly escaped arguments. Every cross-platform Node tool re-derives the three cases above,
and the middle one is the one everybody ships.

---

## pnpm

### P1 — A script named `audit` is shadowed by pnpm's own command, silently

**Severity: medium** (the README told a reader to run a command that did something else entirely)

**Task.** Ship `pnpm audit` as the command that dry-runs the registry over recorded conversations.

**Steps.** Added `"audit": "tsx tools/demo/src/audit.ts"` to `package.json` scripts, documented it in
the README, ran it.

**Expected.** Either my script runs, or pnpm refuses the name.

**Actual.** pnpm ran its own dependency-vulnerability audit and printed five advisories. No warning,
no mention that a script of that name exists and was skipped. A judge following the README would
have seen a security report where the product's own tool was promised. (`pnpm run audit` does run
the script, but nobody types `run`.)

**Workaround.** Renamed to `pnpm corpus`.

**Suggestion.** When a `package.json` script collides with a built-in command, say so on stderr:
`ignoring script "audit"; pnpm audit is a built-in (use \`pnpm run audit\`)`. npm has the same
behaviour and the same silence.

---

## What this project got wrong, not the tools

Kept here because a friction log that only blames tooling is not a useful document.

- **`tsc --noEmit` had never been run** on a strict, `noUncheckedIndexedAccess` codebase. Three real
  errors, one of which was an `Evidence` object whose `version` was `null` where the type said
  `string | undefined` — a shape the DynamoDB store would have written.
- **The severity model had a factor that could never be false.** "In active use within the last 7
  days" compared the detection time against a set containing the detection time. Writing the test
  that asserted it could be false is what exposed it.
- **Two copies of the polarity vocabulary had already diverged** between the proposer and the
  grounding gate. A value one could read and the other could not is a claim that silently
  disappears. They are one module now.
- **Building the golden corpus found six extraction defects in an afternoon**, including one that
  *inverted* a claim (`the DLQ on the checkout worker is inactive` → `enabled = true`, because `on`
  was read as a polarity word inside a prepositional phrase). None of them would have been found by
  more unit tests written by the same person who wrote the code; they were found by writing down 204
  sentences a real engineer might say and checking the answers.
- **The evidence hash included the time of the reading.** `evidenceHash` is documented as the
  content hash of what a source said, and the test that two readings of the same value hash the same
  passed only when both landed in the same millisecond. It failed on a slower run, which is the only
  reason it was found. A hash that changes when nothing changed cannot answer the one question it is
  asked, and it would have made every re-verification look like a new fact.
- **The live capture panel was empty for anyone who arrived late.** Events were pushed to connected
  clients and never kept, so running `pnpm demo` and then opening the browser showed three drift
  cards and no trace of the reasoning that produced them — which is the half of the interface that
  justifies the other half. The server now keeps the last 250 events and replays them, marked as
  history.
- **I documented limitations of Bee that were not real** (B1, B3 and B4 above), and built around
  them. Each began the same way: I looked for something in the documentation's examples, did not
  find it, and wrote down that it does not exist. The stream *does* carry its type in the payload,
  an utterance id and a time; the proxy *is* a full pass-through. My test proxy was written from the
  same examples, so it agreed with every one of those conclusions, and with a flat transcript list,
  a uuid on every record and a cursor under `meta`, none of which the API has. All of it was real
  code, shipped, with tests asserting the wrong behaviour — and one of those tests asserted a
  payload shape (`{conversation: {short_summary}}` for a summary update) that Bee never sends, so it
  was green and meaningless.

  The general lesson, and the reason this entry is here rather than in the Bee section: **an
  integration test against your own test double proves your client agrees with your test double.** It
  says nothing about the real service, and it is at its most convincing exactly when both sides
  share a misconception. What fixed it was holding the test double to Bee itself:
  `tests/conformance/bee-wire.test.ts` runs literal wire socket bytes through Bee's own SSE parser,
  copied verbatim, and pins every field of a frame, a conversation read and the changefeed to the
  response types `@beeai/cli` declares and to published live frames. Those tests are worth more
  than the rest combined for the one question that matters here, because they are the only ones
  whose failure mode is "the real thing would not send or accept this".

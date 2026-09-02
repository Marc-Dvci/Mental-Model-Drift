# Friction log

Every entry here is something that actually happened while building Mental Model Drift, with the
step that produced it and the workaround that got past it. Nothing is invented, and the entries
where the tool was right and I was wrong are marked as such, because those are the ones that say
something useful about the documentation.

Severity is what it cost *this* project: **high** means it silently produced wrong behaviour,
**medium** means it cost an hour or forced a design change, **low** means it was noise.

---

## Bee

### B1 — The event type is the SSE `event:` line, and nothing in the docs says so

**Severity: high** (I built the wrong thing, believed it, and caught it only by reading Bee's source)

**Task.** Subscribe to `new-utterance` and process each frame exactly once.

**Steps.** Connected to `GET /v1/stream?types=new-utterance` on `bee proxy`, read the SSE frames,
looked in the JSON payload for a discriminator and did not find one. The payload really is
`{ utterance: {…}, conversation_uuid: "…" }`, with no type field anywhere in it. So I concluded
there was no discriminator, wrote a classifier that guesses the event type from which keys are
present, put it in one tested module, and moved on.

**Expected.** Either a `type` field in the payload, or a documented statement that there is none.

**Actual.** Both wrong. The discriminator exists and it is the SSE frame's own `event:` line:

```
event: new-utterance
data: {"utterance":{"text":"…","speaker":"speaker_1"},"conversation_uuid":"…"}
```

I found it only by reading `@beeai/cli` 0.7.3, `sources/commands/stream/index.ts`. Its
`parseSSEBuffer` requires **both** an `event` field and a `data` field before it emits anything, and
`formatEvent` switches on the name across a fixed list of thirteen types. So the name is not
incidental — it is how Bee's own client reads Bee's own stream. I could not find it stated in the
developer documentation, in `bee-skill`'s SKILL.md, or in `bee stream --help`; the Skill's
capability map does not mention `bee stream` at all.

Guessing from the payload is not merely inelegant, it is **wrong**, because the payloads are not
disjoint. Three real cases:

| event | payload | what a shape-guesser does |
|---|---|---|
| `update-conversation-summary` | `{conversation_id, short_summary}` | misses it entirely — there is no `conversation` key to look inside |
| `delete-conversation` | `{conversation:{…}}` | indistinguishable from `new-conversation` |
| `journal-deleted` | `{journalId, reason}` | does not match the other journal events, which carry `journal` |

**Workaround.** `packages/bee/src/events.ts` now reads the `event:` line and treats it as
authoritative; the structural reader survives only as a fallback for transports that drop the name,
and anything it produces is marked `nameWasInferred`, so a guess is never mistaken downstream for
something Bee actually said. `tests/conformance/bee-wire.test.ts` pins it by copying Bee's own
`parseSSEBuffer` verbatim and running the local emulator's literal socket bytes through it.
Reintroducing the bug makes that parser return **zero** events, which is the whole danger: a client
that drops the name and a server that never sends it agree perfectly with each other, and produce
nothing at all against a real device.

There is still no event **id**, so identity stays derived: a fingerprint over conversation + speaker
+ normalised text + a coarse 10-second bucket, so the same utterance arriving twice collapses while
two genuinely repeated sentences minutes apart stay distinct.

**Suggestion.** Two things, in order. (1) State in the streaming documentation that the event type
is the SSE event name, and list the thirteen names — `SUPPORTED_EVENT_TYPES` is already in the CLI
source, it is just not in anything a client author reads. This is the single highest-value paragraph
Bee could add for integrators. (2) Add a stable `event_id`; without one, every serious client
re-implements the same fingerprint, differently.

---

### B1b — `bee stream --json` discards the event name

**Severity: medium** (the machine-readable mode is the one that cannot tell you what it received)

**Task.** Support the CLI as a transport on a machine with no proxy running.

**Steps.** Piped `bee stream --json --types new-utterance` and parsed one JSON object per line.

**Expected.** The same information the SSE stream carries.

**Actual.** `--json` prints `event.data` and nothing else, so the `event:` name — the frame's type,
per B1 — is dropped. `--agent` keeps the name, but only inside English prose
(`"Event new-utterance: …"`), and `pretty` colourises it for a human. The one mode meant for
programs is the one mode that loses the type.

**Workaround.** The proxy is now the preferred transport and the CLI is the fallback. Frames
arriving through the CLI are marked `nameWasInferred`, and `pnpm doctor` reports which transport is
live and whether the last frame arrived named.

**Suggestion.** Have `--json` emit the envelope — `{"event":"new-utterance","data":{…}}` — or add a
`--json-envelope` flag. It is a small change in `handleEvent` and it makes the mode usable for the
purpose it exists for.

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

### B3 — Realtime frames key conversations by `uuid`, read endpoints key by `id`

**Severity: medium**

**Task.** Fetch the transcript of the conversation an incoming utterance belongs to, to get the
preceding sentences and the speaker count.

**Steps.** Took `conversation_uuid` from the frame and called
`GET /v1/conversations/{conversation_uuid}`.

**Expected.** The conversation.

**Actual.** Not found. The read endpoints are keyed by the numeric `id`; the stream carries the
`uuid`.

**Workaround.** `BeeClient.resolveConversationId()` tries the reference directly, falls back to a
lookup by uuid across recent conversations, and caches the mapping — a live conversation produces
many utterances and this would otherwise be a list call per sentence.

**Suggestion.** Accept either key on the read endpoints, or include both identifiers in stream
frames.

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

The `transcript --since` half of my original assumption was wrong in a different way: that flag does
not exist on the CLI either. `bee conversations transcript` takes an id and `--json`, nothing else.
I had invented it.

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

### B5 — Utterance text is re-punctuated between the live frame and the stored transcript

**Severity: medium** (found by a test, would have been a duplicate card in production)

**Task.** Process an utterance exactly once when the live stream and the reconciliation pass both
deliver it.

**Steps.** Keyed deduplication on conversation plus normalised text, since the two paths share
nothing else — the live frame has an arrival time and no index, the reconciled read has an index and
no arrival time.

**Expected.** The same sentence to normalise to the same key.

**Actual.** Sentence-final punctuation differs between the two, so `"It retries three times."` and
`"It retries three times"` produced different keys, and the wearer would have seen the same drift
card twice.

**Workaround.** Normalisation strips punctuation but keeps a period between digits, so `4.12` still
survives as a value. Pinned by a test.

**Suggestion.** Document that transcript text is normalised after a conversation completes, so
clients key on content rather than assuming byte equality.

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
`C:\Program Files
odejs
px`, an extensionless shell script Windows cannot execute, and the
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

## Playwright

### PW1 — `page.evaluate` awaits a returned promise, which is not what a recorder wants

**Severity: low**

**Task.** Start the dashboard's guided tour from Playwright and record the window while it plays.

**Steps.** `page.evaluate(() => window.MentalModelDriftTour.start())`, then record for the
narration's duration.

**Expected.** The call starts the tour and returns.

**Actual.** `evaluate` serialises and awaits a returned promise, and `start()` resolves only when the
tour finishes. The recording window therefore began *after* the demonstration had already played,
and captured two minutes of the end screen. This is documented, and it is still the wrong default to
have in your head at midnight.

**Workaround.** Return nothing: `page.evaluate(() => { window.MentalModelDriftTour.start(); })`. The
braces are the entire fix, which is what makes it worth writing down.

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
- **The narration described a conversation that does not exist.** The first cut of the demo script
  said "eight sentences, and six of them produce nothing", and the CLI demo had said the same for
  weeks. The real number is four. Counting them against the product's own output rather than against
  the design document was the fix, and it is now the rule for every number spoken in the video: it
  has to be visible on screen in the same shot.
- **The live capture panel was empty for anyone who arrived late.** Events were pushed to connected
  clients and never kept, so running `pnpm demo` and then opening the browser showed three drift
  cards and no trace of the reasoning that produced them — which is the half of the interface that
  justifies the other half. The server now keeps the last 250 events and replays them, marked as
  history.
- **I documented two limitations of Bee that were not real** (B1 and B4 above), and built around
  both. Each began the same way: I looked for something, did not find it, and wrote down that it
  does not exist. Neither conclusion survived twenty minutes with `@beeai/cli`'s source, which is
  MIT-licensed and one `gh repo clone` away. The stream *does* carry an event discriminator; the
  proxy *is* a full pass-through. Both of my workarounds were real code, shipped, with tests
  asserting the wrong behaviour — and one of those tests asserted a payload shape
  (`{conversation: {short_summary}}` for a summary update) that Bee never sends, so it was green and
  meaningless.

  The general lesson, and the reason this entry is here rather than in the Bee section: **an
  integration test against your own simulator proves your client agrees with your simulator.** It
  says nothing about the real service, and it is at its most convincing exactly when both sides
  share a misconception. What fixed it was `tests/conformance/bee-wire.test.ts`, which runs the
  emulator's literal socket bytes through Bee's own SSE parser, copied verbatim. That test is worth
  more than the other 213 combined for the one question that matters here, because it is the only
  one whose failure mode is "the real thing would not accept this".

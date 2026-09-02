# Friction log

Every entry here is something that actually happened while building Mental Model Drift, with the
step that produced it and the workaround that got past it. Nothing is invented, and the entries
where the tool was right and I was wrong are marked as such, because those are the ones that say
something useful about the documentation.

Severity is what it cost *this* project: **high** means it silently produced wrong behaviour,
**medium** means it cost an hour or forced a design change, **low** means it was noise.

---

## Bee

### B1 — Realtime frames carry no event type and no event id

**Severity: high** (silently wrong behaviour if you assume otherwise)

**Task.** Subscribe to `new-utterance` and process each frame exactly once.

**Steps.** Connected to `GET /v1/stream?types=new-utterance` on `bee proxy`, read the SSE frames,
tried to switch on an event-type field.

**Expected.** A discriminator — `{"type": "new-utterance", ...}` — and a stable id per event, the
way most event streams are shaped.

**Actual.** Frames are payload-shaped: an utterance frame is `{ utterance: {...},
conversation_uuid: "..." }` with no top-level type and no id anywhere. Clients have to discriminate
structurally, and there is no identifier to deduplicate on.

**Workaround.** All classification lives in one tested module (`packages/bee/src/events.ts`) rather
than being repeated at call sites, and event identity is *derived*: a realtime fingerprint over
conversation + speaker + normalised text + a coarse 10-second time bucket, so the same physical
utterance arriving twice collapses while two genuinely repeated sentences minutes apart stay
distinct.

**Suggestion.** Add a stable `event_id` and a `type` field to stream frames. Both are cheap, and
without them every serious client re-implements the same fingerprint, differently.

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

### B4 — `bee proxy` exposes a strict subset of the CLI

**Severity: medium**

**Task.** Use one transport for everything.

**Steps.** Moved the client onto `bee proxy`, then went looking for `conversations related` and
`conversations transcript --since`.

**Expected.** The proxy to cover the CLI's read surface.

**Actual.** Neither has a proxy endpoint. `related` is useful precisely for this product (adjacent
discussions of the same system), and `transcript --since` is the cheap way to page a long
conversation.

**Workaround.** The client is a hybrid: the proxy where the proxy has an endpoint, the CLI for the
rest, with `BeeClient.describeTransport()` reporting which paths are live so the dashboard can show
it honestly. Containers without the CLI set `BEE_ALLOW_CLI=0` and lose only those two reads.

**Suggestion.** Bring the proxy to parity with the CLI's read commands, or document the gap so
nobody discovers it after committing to a transport.

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

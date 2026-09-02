# Threat model

Two kinds of threat, and the second kind is the one that matters more.

The first is ordinary: someone attacks the software. The second is that the software works exactly
as designed and hurts somebody anyway. A product whose output is *"you are wrong about this, and
here is how long you have been wrong"* has a duty to have thought about the second kind first.

---

## Part 1 — Ways this product could hurt someone while working correctly

### T1. Someone else reads the cards

**The harm.** A manager, a lead, or anyone who walks past the laptop sees a list of things this
person has believed incorrectly, with dates and a count. That is a performance review nobody agreed
to, assembled by a tool the person installed to help themselves.

**What is done.** There is no team view, no aggregation across people, and no route that returns
another user's data — see [`privacy.md`](privacy.md) §1. The server binds to loopback unless
`MMD_HOST` is set deliberately. There is no competency score to read, so the worst a shoulder-surfer
gets is a worklist of beliefs, not a verdict on a colleague.

**What is not done, and cannot be.** Nothing stops the wearer's own screen being read. If this were
a product rather than a hackathon entry, the drift list would be behind the same lock as the rest of
the machine and would blank on idle, and there would be an explicit refusal to build the export that
some buyer would eventually ask for.

---

### T2. Someone is corrected for a sentence a colleague said

**The harm.** Two people are talking. The other one says "checkout retries three times". A card
appears telling the wearer they are wrong about something they never said, and — worse — a
correction is written into their assistant's memory as their belief.

**What is done.** Ownership is diarisation, never identity. One speaker in the window ⇒
`LIKELY_USER`; more than one ⇒ `UNKNOWN`, `confirmationRequired` is set, and the card asks *"was
this your understanding?"* before it will unlock any write action. `record_understanding` over MCP
refuses outright a belief not attributed to the wearer. **"No, not my belief"** is a first-class
button on every card, not buried in a menu.

**Residual.** Diarisation is imperfect, and a single-speaker window during a phone call is still
someone else's voice. The design answer is that everything destructive is gated behind an explicit
human confirmation, and the confirmation question is *whose belief was it*, not *is it true*.

---

### T3. The product is right, and being right is the problem

**The harm.** A confident, well-evidenced correction delivered in the middle of an incident is an
interruption at the worst possible moment, and being told you are wrong by a machine in front of
other people is worse than being told by a person.

**What is done.** There is **no real-time notification**. No push, no on-wrist buzz, no card that
appears over what someone is doing. Drift lands in a list the person opens when they choose to. The
product's own copy says this: silence is the feature, and the *Heard* tab exists so the silence is
inspectable.

---

### T4. It makes someone doubt something they were right about

**The harm.** A false positive here is not a wasted minute. It is a person no longer trusting their
own knowledge of a system, which is expensive and slow to repair.

**What is done.** This is why the extraction gate is deterministic and why the measured number the
project leads with is **false-positive rate: 0.0%** over 204 labelled utterances, with recall left
at 89.2% rather than tuned up. Each miss is a missed opportunity; each false positive is a person
told they are wrong about something they never said. Those are not symmetric and the thresholds are
not set as if they were.

Four verdicts rather than two exist for the same reason: a connector failure must never be able to
present itself as drift.

---

### T5. The correction is wrong because the *source* is wrong

**The harm.** The registry names AppConfig as authoritative for a retry count. Someone changed the
running value with a console override and never touched AppConfig. The product now confidently
corrects a person who was right.

**What is done.** Every card names its source, its exact locator, and the time it was read, and the
evidence panel is one click away. **Report as a false positive** is on the drawer. When two sources
disagree, the verdict is `INCONCLUSIVE` and no card is raised.

**Residual, and honestly the biggest one.** The product is exactly as correct as the registry's
choice of authority. That choice is a human act, written in a file, in the open, reviewable — see
[`source-registry.md`](source-registry.md). That is the mitigation: not that it cannot be wrong, but
that being wrong is visible in a diff.

---

### T6. The agent takes the correction and acts on it alone

**The harm.** The MCP server tells a coding agent the retry count is 1. The agent silently rewrites
code and the human never learns that their model of the system changed.

**What is done.** `check_assumption` returns, in the tool result itself, the instruction: *act on
the actual value, and tell the human what changed and when rather than silently correcting them.*
The response carries the change date and the commit, so the agent has something to say. The only
writing tool is off by default.

---

## Part 2 — Ordinary security

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| S1 | **Secrets spoken aloud** reach a model or a store | `redact()` before extraction, model call and storage: 11 patterns, deterministic, always on (`redact.ts`, 11 tests) | pattern scan only; an unusual shape survives |
| S2 | **A model is prompt-injected** by something a person said, and invents a claim | a proposal cannot pass the grounding gate unless the subject alias, a property lexeme and the value literal all appear literally in the spoken words, inside an asserting clause. An invented value has nothing to match | a proposer could still mislabel *which* real property a real value belongs to; the registry's type check and the comparator catch the mismatched types |
| S3 | **A malicious source document** contains instructions | source content is never fed to a model. Adapters do a typed read at a fixed JSON path and return a value | none material: the value is compared, not interpreted |
| S4 | **Path traversal** into the repository or the static root | `readPath` implements a deliberately small JSONPath subset with no filters or wildcards; `serveStatic` normalises before joining and refuses anything outside the root | |
| S5 | **The server exposed on a LAN** | binds `127.0.0.1`; `MMD_HOST` must be set on purpose | no authentication if you do set it — do not |
| S6 | **The guided-tour controls used to inject utterances** | `/api/tour/*` returns 403 unless the process was started with `MMD_TOUR=1`, and proxies only to the emulator URL the server already holds. A test asserts the 403 | |
| S7 | **An unwanted pull request** opened against a real repository | preparing a patch and pushing one are separate actions. Pushing needs `MMD_ALLOW_PR=1` **and** a click, and the branch is created from the current head with a single file change | |
| S8 | **Credentials** for AppConfig, Sentry, GitHub | never in the registry; taken from the environment, Secrets Manager in the deployed stack, or `gh auth token` | |
| S9 | **Evidence tampering** | evidence rows are append-only and content-hashed; re-verification appends, never edits | the hash proves the row was not edited in place, not that the source was honest |
| S10 | **Dependency supply chain** | `pnpm audit` clean at the time of writing; runtime dependencies are the AWS SDK, the MCP SDK, `yaml` and `zod` | |

---

## What an attacker gains

Very little, which is the point of storing almost nothing. Compromising this process yields typed
assertions about a handful of registered configuration properties, one sentence each, and evidence
rows naming systems the attacker would have had to already know about. It does not yield transcripts,
because they were never here, and it does not yield Bee credentials, because the proxy holds them.

The Bee token, if `bee proxy` is not in use, is the one credential worth protecting: it is read from
the environment and never logged, and `describeTransport()` reports the transport in use without
revealing it.

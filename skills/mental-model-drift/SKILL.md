---
name: mental-model-drift
description: "Verify what a human told you about a software system against that system's authoritative source before acting on it. Use this skill whenever the user states a configuration value, feature-flag state, deployed version or schema fact that your next action depends on — 'it retries three times', 'that flag is on in the EU', 'we're running 4.12', 'the events table has a source IP column' — and whenever you are about to write, debug or advise based on a premise you were given rather than one you read. It answers with the deployed value, the commit that changed it, and how long the person has believed the old one, using their Bee conversation history. Also use it to review open drift at the start of a task, or when a user's reasoning is sound but its conclusion contradicts what you observe."
---

# Mental Model Drift

Software changes faster than the understanding of the people who work on it. When a human hands you
a premise — *"it retries three times, so a slow consumer isn't the problem"* — you have no way to
tell a fact from a memory. Reason correctly from a premise that stopped holding three weeks ago and
you produce a confident, wrong patch, and defend it, because your reasoning was fine.

This skill gives you a way to check.

## What it can settle, and what it cannot

It answers one question: **does the deployed system still match what this person said about it?**

Truth comes from deterministic connectors — AWS AppConfig for configuration and feature state,
Sentry for the running release, the checked-in schema for structural facts — named per property in a
registry. No model is ever asked whether a statement is true.

Run this first, once, and remember the answer for the session:

```bash
mmd properties
```

Anything outside that list is `UNSUPPORTED`. This is not a general fact-checker; do not use it to
verify claims about the world, about people, or about code it has no registered source for.

## When to call it

Call `mmd check` **before you act**, not after:

- The user states a value your next edit, diagnosis or recommendation depends on.
- You are about to explain why something is safe, and the reason is something you were told.
- A user's reasoning is internally sound but its conclusion contradicts what you can observe. That
  is the signature of a correct inference from a stale premise, and it is exactly this skill's case.

```bash
mmd check "the checkout worker retries three times, so a slow consumer isn't the problem"
```

Pass the sentence **as it was said**. Do not normalise it, do not extract the value yourself, and do
not rephrase it into registry vocabulary: the grounding gate requires the subject, the property and
the value to appear literally in the words, and it is what stops an invented number being checked as
though a human had said it. If the statement refers to a subject established earlier, pass the
earlier sentence too rather than editing it in:

```bash
mmd check --context "we were looking at the checkout worker" "it retries three times"
```

Add `--json` when you are going to parse the answer rather than read it.

## Reading the answer

Four verdicts, never two. A source that could not be read must never look like a person being wrong.

| verdict | exit | what to do |
|---|---|---|
| `SUPPORTED` | 0 | The premise holds. Act on it, say nothing about it. |
| `DRIFTED` | 1 | **Use the actual value.** Then tell the human what changed and when. |
| `INCONCLUSIVE` | 2 | A source failed. Treat as neither confirmed nor refuted; say the check did not complete. |
| `UNSUPPORTED` | 0 | Nothing checkable was said. Carry on; do not mention the check. |

On `DRIFTED` the output carries the change that made it wrong and how often the belief was restated:

```
DRIFTED -- Checkout retry attempts
  stated 3, actually 1
  changed 2026-08-23 -- Reduce checkout retries to 1 after duplicate-charge incident
  severity HIGH
  restated in 5 earlier conversation(s), 1 of them after the change
  evidence: AWS_APPCONFIG OK appconfig://ecommerce/production/checkout-worker$.retry.max_attempts
```

## How to say it

This is the part that matters, and the part most likely to go wrong.

**Do not silently correct the user.** Substituting the right number and continuing is the worst
outcome: they walk away still believing the old value and will act on it again in an hour, next to
someone else, where nothing is checking.

**Do not tell them they were wrong.** They very likely were not. `restated in 5 earlier
conversations` with a source change on 23 August means four of those five were *correct when they
were said*. The system moved; nobody told them. Say that:

> Worth flagging before I change anything: checkout retries were cut from 3 to 1 on 23 August, after
> a duplicate-charge incident. Three was right until then. That changes the diagnosis here — with a
> single attempt, a slow consumer *is* a plausible cause.

Lead with the correction's consequence for the task at hand, give the date and the reason, and keep
it to a sentence or two. Then continue the work using the real value.

**On `INCONCLUSIVE`, say so and stop leaning on the premise.** "I couldn't reach AppConfig to
confirm the retry count" is a useful sentence. Quietly proceeding as though the check had passed is
not.

## Digging further

```bash
mmd history checkout-worker retry.max_attempts    # every time they stated it, and every source change
mmd open                                          # stale beliefs already found, worth reading at task start
```

`mmd history` is the difference between a slip and a mental model. One occurrence is a misspoken
number. The same sentence across six weeks is something the person is *working from*, and is worth
raising even when it is not blocking the current task.

`mmd open` at the start of a session tells you which premises in this codebase are already known to
be stale. If what you are about to change depends on one, say so before you write anything.

## Where the history comes from

The recurrence counts and excerpts come from the user's own Bee recordings, read through Bee's
neural conversation search — this skill composes with
[`bee-cli`](https://github.com/bee-computer/bee-skill), and the same `bee login` session serves both.
Bee data is owner-encrypted and intensely personal: what comes back here are excerpts of the user's
private conversations. Quote at most the one sentence that carries the belief, never a surrounding
transcript, and never repeat a conversation excerpt into a file, a commit message or a pull request.

If a statement cannot be attributed to the wearer — more than one speaker, no diarisation match —
the result is marked `UNKNOWN` ownership. Do not act on a belief that may be somebody else's, and
never write a correction back to Bee memory on their behalf.

## Setup

```bash
git clone https://github.com/Marc-Dvci/Mental-Model-Drift && cd Mental-Model-Drift
pnpm install
alias mmd="pnpm --silent mmd"

pnpm doctor          # confirm Bee answers on all four capabilities
```

Point it at your own systems by editing `demo/source-registry.yaml`; the format is documented in
`docs/source-registry.md`. If you speak MCP rather than shell, the same engine is available as five
tools:

```bash
claude mcp add mental-model-drift -- npx tsx apps/mcp/src/main.ts
```

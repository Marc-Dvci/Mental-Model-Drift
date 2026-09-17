# Scope

What this build deliberately does not do. These are design decisions rather than unfinished work,
recorded in one place so they are not mistaken for gaps.

---

## 1. The documentation pull request is prepared, not opened

"Create docs PR" composes a real patch against the file that still states the old value, and shows
the diff. It does not push a branch or open a pull request; `GITHUB_TOKEN` is read but the write
path is off by default (`MMD_ALLOW_PR=1`). A product whose entire premise is that it
should not act on your behalf without asking has to be off by default in the one place it can write
to somebody else's repository.

---

## 2. Writes to Bee memory are gated

`record_understanding` over MCP is off unless the server is started with `MMD_MCP_ALLOW_WRITES=1`,
and it refuses any belief that could not be attributed to the wearer. In the dashboard, **Update my
understanding** stays locked on a card whose ownership is `UNKNOWN` until the wearer confirms the
belief is theirs.

---

## 3. What the product does not cover

- **No competency scoring.** The system never aggregates how often a person was wrong, and there is
  no per-person metric anywhere in the store. See [`privacy.md`](privacy.md).
- **Only the wearer's own beliefs.** Utterances that cannot be attributed to the wearer produce a
  card marked `UNKNOWN` ownership, and write actions stay locked until a human says otherwise.
- **Five property types, not open-domain fact-checking.** Configuration values, feature state,
  schema facts, deployment versions and release identifiers — each one a property some system can
  be asked about directly. A claim outside the registry produces `UNSUPPORTED_TYPE`, not a guess.
- **Silence over recall.** Eleven of 204 corpus utterances are missed extractions, left in
  deliberately. Each is a phrasing outside the registry's declared vocabulary, and the alternative —
  loosening the grounding gate — trades a missed opportunity for telling somebody they are wrong
  about something they did not say.
- **No real-time notification.** No push, no on-wrist buzz. Drift lands in a list the person opens
  when they choose to; see [`threat-model.md`](threat-model.md) T3.

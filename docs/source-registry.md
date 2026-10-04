# The source registry

`demo/source-registry.yaml` is the boundary of what this product is willing to have an opinion on.
Nothing outside it is checked. Nothing in it is decided by a language model.

Point it at your own systems by writing your own file and setting `MMD_REGISTRY=/path/to/it`.

Every entry answers one question:

> If someone says something about this property, **which system decides whether they are right?**

---

## Shape

```yaml
version: 1

systems:
  checkout-worker:                       # the system key
    label: Checkout worker
    aliases:                             # every way a person says it out loud
      - checkout
      - checkout worker
      - payment worker
      - the worker
    properties:
      retry.max_attempts:                # the property key
        label: Checkout retry attempts   # what a card is titled
        type: integer                    # integer | boolean | semver | string | presence
        impact: HIGH                     # HIGH | MEDIUM | LOW -- blast radius, set by a human
        claimType: CONFIG_VALUE
        lexemes:                         # the words that point at this property in speech
          - retries
          - retry
          - max attempts
          - attempts
          - redelivers

        authoritative_source:            # what the system IS. Decides SUPPORTED vs DRIFTED.
          adapter: aws_appconfig
          authoritative: true
          locator:
            application: ecommerce
            environment: production
            profile: checkout-worker
            json_path: $.retry.max_attempts

        historical_source:               # what the system WAS. Explains, never decides.
          adapter: github
          authoritative: false
          locator:
            repository: Marc-Dvci/mmd-checkout-demo
            path: config/checkout.yaml
            json_path: $.retry.max_attempts

        documents:                       # the prose that still says the old number
          - adapter: github
            locator:
              repository: Marc-Dvci/mmd-checkout-demo
              path: docs/architecture.md
```

---

## The three source roles never overlap

| role | answers | may set a verdict |
|---|---|---|
| `authoritative_source` | what the system **is** right now | yes — this is the only thing that can |
| `historical_source` | what it **was**, and when it stopped being that | never |
| `documents` | which prose is now stale | never; it is only a patch target |

This split is the reason the product can say the sentence that makes it worth installing: *the value
is 1, you said 3, and 3 was right until 23 August.* The engineer was not careless. The software
moved. A registry where one source did both jobs could not say that.

`validateRegistry` refuses a `historical_source` marked `authoritative: true`, at load time, with
the message that it explains the past and does not define the present.

---

## Lexemes are the interesting part

A property is only findable through the words people actually use for it. `retries`, `retry`,
`retried`, `retrying`, `max attempts`, `redelivers` are all the same property; `attempts` on its own
is deliberately in the list and `tries` deliberately is not, because *"I tried three times"* is
about a person.

Two rules from the golden corpus, both learned the hard way:

- **A lexeme that is also a common English word costs recall or costs precision, never neither.**
  `has`, `contains`, `stores` are in the schema property's list because that is how people describe
  a column, and they only survive because the grounding gate additionally requires an object alias
  (`source_ip`) and an asserting clause.
- **Polarity words are not lexemes.** `on` and `off` used to be in a feature flag's list, and
  *"the DLQ **on** the checkout worker is inactive"* inverted the claim. Polarity is now one shared
  module with its own tests, and prepositional `on`/`off` is excluded there rather than per registry.

Run `pnpm corpus` after every lexeme change. It prints exactly what the change made the system newly
willing to speak about, over your recorded history, without reading a source or writing anything.

---

## Scopes: one property, several instances

A feature flag is not one value. It is a value per region, and a claim about Europe must never be
checked against the US.

```yaml
        scopes:
          region:
            EU:  [europe, eu, emea, the eu]
            US:  [the us, north america, states]
            APAC: [apac, asia]
        authoritative_source:
          locator:
            json_path: $.new_checkout.regions.${scope.region}
```

The region is resolved from the spoken words, then bound into the locator by `bindLocator` before
the source is read. `${object}` works the same way for object-shaped properties such as a column
name.

**`validateRegistry` refuses a registry that declares a scope its locator never binds.** That rule
exists because an earlier build declared `region` and wrote a fixed `json_path`, so a claim about
the US rollout was verified against the EU value and produced a confident, wrong card. A registry
that can be silently wrong in that way now fails to load.

---

## Adapters available

| adapter | reads | locator keys |
|---|---|---|
| `aws_appconfig` | the deployed configuration and feature state, plus hosted version history for "when did this change" | `application`, `environment`, `profile`, `json_path` |
| `sentry` | the release running in an environment | `organization`, `project`, `environment` |
| `github` | a checked-in file at a JSON path or a SQL schema, and its git history | `repository`, `path`, `json_path` |

`github` runs in two modes: `localgit` against a clone (the default, and what the demo uses) and
`api` against `api.github.com`, chosen by `MMD_MODE`. Both implement the same `Verifier` interface:

```ts
interface Verifier {
  readonly source: string;
  verify(claim: Claim, ref: SourceRef): Promise<Evidence>;
  history?(claim: Claim, ref: SourceRef): Promise<HistoricalChange[]>;
}
```

To add your own — Consul, LaunchDarkly, a Kubernetes ConfigMap, a Terraform state file — implement
those two methods and register it in `buildEngine`. The contract that matters is the failure
contract: **a verifier that cannot read its source returns `Evidence` with a non-`OK` status and an
error string. It never throws, and it never guesses.** That is what keeps a connector outage from
presenting itself as drift. `tests/adapters/adapters.test.ts` is the matrix every new adapter should
be added to.

---

## Value types

| type | comparison |
|---|---|
| `integer` | numeric, after spoken-number normalisation (`three` → `3`) |
| `boolean` | `enabled` / `disabled` / `on` / `off` / `true` / `false`, polarity-aware |
| `semver` | semantic, so `4.12` and `4.12.0` agree and `4.12` and `4.13.0` do not |
| `string` | exact, case-insensitive |
| `presence` | does this named object exist (a column, a queue, an index) |

Getting these wrong is how a product like this loses trust in one demo: a textual comparator reports
drift between `4.12` and `4.12.0`, which is a lie, and the person stops reading the cards.

---

## Validation

`validateRegistry` runs at load and refuses, with every problem listed at once:

- an unsupported `version`;
- an alias claimed by two systems (`checkout` cannot mean two things);
- a system with no properties, or a property with no lexemes;
- an unknown `type`, `claimType`, or an `impact` outside HIGH/MEDIUM/LOW;
- an `authoritative_source` that is not marked authoritative;
- a `historical_source` that is;
- a declared scope the locator never binds.

Alias resolution matches **longest first** and claims the character span, so `new checkout`,
`checkout service` and `checkout` resolve to three different systems from the same sentence without
fighting over the word they share.

# NotNativeReviewer — DSH adapter

The DeepSeek Harness attachment of NotNativeReviewer. The judgment lives in the shared
core (`src/nnr/`); this directory holds only the DSH wiring.

## What it does

- **Authority.** The user's own words arrive as `user/message` session events whose
  `source.kind` is `user`. DSH stamps every producer's kind on its messages, so an
  injected context (a guard's reminder, a cron notice, a skill) carries a kind that is
  not `user` and is refused as authority. This is the same authority rule the OpenCode
  adapter enforces, answered here by the producer rather than by a role flag.
- **The full gate.** Every tool call runs the same core evaluation the OpenCode adapter
  runs: the read floor (plain reads and all-reader pipelines pass without a model), the
  deterministic catastrophe deny, the read-before-write ledger, the unreadable-script
  deny, and the reviewer. A `bash` or `pwsh` call carries its command text, so all the
  shell rules apply unchanged; any other tool carries its arguments as JSON.
- **The reviewer.** When the operator configures a provider and model (below), the
  reviewer judges each call against the recorded user request through DSH's `llm`
  runtime (`prepareCall` + `stream`). `approve` lets the call run, `deny_with_guidance`
  and `hard_deny` deny, and `escalate_to_operator` becomes DSH's native `ask`, which
  routes to the approval seam and degrades to a deny when no seam is mounted — the
  gate fails closed either way. Without a configured model the fallback is the
  floor-first behaviour: catastrophe denied, everything else asked.
- **Persistence and telemetry.** The package survives a reload (no clock, until the
  user speaks again), and the audit log is written beside the core with no content in
  it, as everywhere else.

## Attach (development)

From the DeepSeek Harness checkout, with the NotNativeReviewer repository beside it,
load the adapter through a patch file:

```yaml
# cordis-nnr.yml
insert:
  - id: notnativereviewer
    name: /absolute/path/to/notnativereviewer/hosts/dsh/plugin/index.js
    config:
      provider: deepseek
      model: deepseek-chat
```

```sh
pnpm dsh web --patch ./cordis-nnr.yml
```

`provider` and `model` name the reviewer's model through the host's own llm runtime —
the same conversation model the user already configured. Without them the gate still
runs its deterministic layers and asks the operator for the rest. `deadlineMs` is
optional (default 120000).

Bundling (the npm `dsh` bundle field) would inline the core import; until the core is
marked external, attach unbundled through the patch path.

## Tests

```sh
node tools/test-dsh.mjs
```

Runs the adapter against a mock context and a mock llm runtime: registration, the
authority rule, the event mapping, the deterministic floor, and the wired reviewer —
approve delegates to the host, deny-with-guidance denies with the reviewer's message,
a malformed answer fails closed, and a call with no user authority never reaches the
reviewer.

## Next

Live verification on a running `dsh` (step 3c): confirm the llm runtime is reached
exactly as documented, confirm `agent.id` is the same identity the session events
carry, and probe delegation — whether a DSH subagent's session can name its parent —
before any reliance on a hierarchy.

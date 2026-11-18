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
- **The reviewer.** The reviewer judges each call against the recorded user request
  through DSH's `llm` runtime (`prepareCall` + `stream`). Its model is resolved
  **live, per conversation**: the session stream's `model/selection` (the user's
  choice) and `assistant/message` (what actually ran) are followed, so a mid-stream
  model switch — including a switch away from a dead provider — is picked up by the
  very next review, and two conversations on two models are each reviewed with their
  own. The config's `provider`/`model` is only the fallback for a session that has
  shown no selection. `approve` lets the call run, `deny_with_guidance` and
  `hard_deny` deny, and `escalate_to_operator` becomes DSH's native `ask`, which
  routes to the approval seam and degrades to a deny when no seam is mounted — the
  gate fails closed either way. A conversation with no known model at all gets the
  floor-first fallback: catastrophe denied, everything else asked.
- **Persistence and telemetry.** The package survives a reload (no clock, until the
  user speaks again), and the audit log is written beside the core with no content in
  it, as everywhere else.

## Attach

**The installer attaches.** Run `./install.ps1 -Harness dsh` from the NotNativeReviewer
repository (or omit the pin and choose from the detected harnesses). The installer
stages the package into the central home (`%LOCALAPPDATA%\notnativereviewer\dsh\
notnativereviewer` on Windows), then attaches it to **every profile that exists** in
the user's `DSH_HOME` — the Desktop app's, the CLI's `web`, headless, custom — by
writing one row into each profile's own `cordis.patch.yml` and linking the package
through the profile's `node_modules`:

```yaml
- insert:
    - id: notnativereviewer
      name: ./node_modules/notnativereviewer/index.js
      config:
        provider: "sparkcluster"
        model: "GoldenGirls/spark"
```

The shape is load-bearing and field-verified: the patch layer's plain rows are
id-targeted overrides of entries the base bundle already defines, so a **new** plugin
must be an `insert` row — a plain row is silently dropped. The relative module name
resolves because the loader anchors its import base at the profile directory.
`-DshProfile <name>` pins one profile or a comma list.

`provider` and `model` are only the reviewer's fallback for a conversation that has
shown no model selection yet — the live value always comes from the conversation's
own `model/selection` and `assistant/message` events. The installer pre-fills them
from the profile's `agent-default-model` row. `deadlineMs` is optional (default
120000). **Uninstalling** the plugin means removing that row and the junction —
the app's own plugin-page Uninstall button does not own this attachment.

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

## Verified live

The adapter runs inside the Desktop application (which boots its harness inside the
Electron process, not a separate `node`): the plugin loads and activates, user
messages arrive as authority, reads and searches pass the floor without a model, and
a real file write was reviewed over the conversation's own model and approved with
cited anchors (`consolidated_file_is_the_requested_deliverable`). The audit trail
names the resolved reviewer model per call, so a live lookup is distinguishable from
the config fallback.

## Next

Non-blocking probes from ordinary use: whether `agent.id` is the same identity the
session events carry (the live model lookup depends on it), the delegation probe —
whether a DSH subagent's session can name its parent — and egress classification for
DSH's fetch-family tool names.

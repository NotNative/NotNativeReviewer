# NotNativeReviewer — DSH adapter

The DeepSeek Harness attachment of NotNativeReviewer. The judgment lives in the shared
core (`src/nnr/`); this directory holds only the DSH wiring.

## Milestone: floor-first

The reviewer agent call is **not wired yet**. What this adapter does today:

- **Authority.** The user's own words arrive as `user/message` session events whose
  `source.kind` is `user`. DSH stamps every producer's kind on its messages, so an
  injected context (a guard's reminder, a cron notice, a skill) carries a kind that is
  not `user` and is refused as authority. This is the same authority rule the OpenCode
  adapter enforces, answered here by the producer rather than by a role flag.
- **The floor.** A `bash` or `pwsh` call that destroys a system root (`rm -rf /`, a
  drive format, `dd` to a device, a fork bomb) is denied deterministically, with no
  model and no operator.
- **Everything else asks.** Every other tool call returns `{ kind: "ask" }`, which
  routes to DSH's approval seam; with no seam mounted, DSH itself degrades `ask` to a
  deny, so the gate fails closed either way.
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
```

```sh
pnpm dsh web --patch ./cordis-nnr.yml
```

Bundling (the npm `dsh` bundle field) would inline the core import; until the core is
marked external, attach unbundled through the patch path.

## Tests

```sh
node tools/test-dsh.mjs
```

Runs the adapter against a mock context: registration, the authority rule (a direct
user message in, an injected `user`-role message refused), the catastrophe deny, and
the waterfall contract (a decision never delegates).

## Next

The reviewer agent call (judge each call against the recorded user request), then the
delegation probe: whether a DSH subagent's session can name its parent, which decides
how the delegation hierarchy maps onto this host.

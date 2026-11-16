# Telemetry

NotNativeReviewer writes a local log of what it does. The log is an audit trail: it lets the
operator see, after the fact, whether the gate ran, what it decided, and why.

**The log holds no content.** It holds steps, counts, short codes, digests, and durations.
It never holds the text of a prompt, a file, a tool result, or a model reply.

---

## 1. Why the log has no content

The log must be readable by an operator, and by anyone the operator sends it to, without
sharing the conversation. A log that holds prompt text is a log that leaks whatever the
user typed, which may include a credential or a private sentence.

The rule is enforced in code. Every value that the gate records passes through a sanitiser
that:

- keeps a number, a boolean, or a short string of 48 characters or fewer;
- replaces a longer string with its length and a short digest;
- reduces an array to a count, keeping the items only when there are 16 or fewer and each
  is a short string;
- reduces an object to a count of its keys.

A caller therefore cannot leak content by passing a message. The sanitiser catches it.

## 2. The record

One JSON object per line:

```json
{"seq":18,"ts":"2026-11-14T21:19:03.412Z","step":"floor.classified","ok":true,"v":1,"s":"0551b410","data":{"class":"egress","reason":"egress_tool","isEgress":true}}
```

| Field | Meaning |
| --- | --- |
| `seq` | A counter, so a reader can see a missing record |
| `ts` | The time |
| `step` | One value from the step list (§3) |
| `ok` | False when the step reports a failure |
| `v` | Format version; this document describes version 1 |
| `s` | A digest of the session identifier |
| `data` | The step's measurements, after the sanitiser |

The session identifier is digested, so a raw session ID does not travel into the log.
Records from one session share the same `s`, so the chain is still readable.

## 3. The steps

The step list is closed. A step outside the list is a defect and is recorded as
`ungoverned`.

| Step | When it is written |
| --- | --- |
| `setup` | The plugin's setup ran |
| `hook.registered` | One hook registration, with `registered` true or false |
| `prompt.admitted` | The prompt hook recorded a user input |
| `package.updated` | A user input was appended to the package |
| `context.observed` | The context hook saw the message list |
| `event.observed` | The event stream delivered an event |
| `evaluate.start` | A permission evaluation began |
| `floor.classified` | The call was classified |
| `projection.built` | The reviewer request was assembled |
| `reviewer.called` | A reviewer call began |
| `reviewer.answered` | A reviewer call returned, timed out, or failed |
| `decision.validated` | A decision was parsed and validated |
| `decision.repaired` | The first attempt failed and a second was made |
| `decision.applied` | An effect was written to the host |
| `evaluate.end` | The evaluation finished |
| `fail.closed` | A failure path denied the call |
| `ledger.append` | A read-before-write check was recorded |
| `ungoverned` | A degradation, or a step outside the list |

## 4. Reading a chain

A denial that the reviewer made looks like this:

```
evaluate.start
floor.classified        class=egress
projection.built        packageItems=3 validAnchors=2
reviewer.called         deadlineMs=20000
reviewer.answered       replyBytes=210
decision.validated      outcome=deny_with_guidance confidence=0.8
decision.applied        effect=deny
evaluate.end
```

A read records what it saw, and passes:

```
evaluate.start
floor.classified        class=safe
ledger.append           check=read verdict=recorded
decision.applied        reason=floor_safe
evaluate.end
```

A denial that came from the read-before-write check looks like this:

```
evaluate.start
floor.classified        class=consequential
ledger.append           check=read_before_write verdict=unread
decision.applied        reason=write_unread
evaluate.end
```

The verdict is `unread` when the session never read the file, `stale` when the file changed
after the read, and `unnamed_target` when a file-changing call named no file at all.

A write records what it left, so a later edit needs no read. The check is `write`:

```
ledger.append           check=write verdict=recorded
```

A call that arrived twice is answered once, and the second arrival records `duplicate_call`:

```
evaluate.start
decision.applied        outcome=joined reason=duplicate_call
evaluate.end            reason=duplicate_call
```

`projection.built` records `hasLatestUser`, which says whether the selected package carried
a user record. A `false` there means the reviewer had no user input to judge against, which
happens only when the session holds no user-authored record; the gate then denies without a
reviewer call.

A denial that came from the catastrophe check has no reviewer records, because no model
was asked:

```
evaluate.start
floor.classified        class=consequential catastrophe=catastrophic_delete
decision.applied        reason=catastrophic_command
evaluate.end
```

A degradation looks like this:

```
hook.registered         hook=session.prompt registered=false
```

That `false` is the visible ungoverned state for one hook. The gate did not crash, and the
operator can see that one of its inputs is missing.

## 5. Where the log goes

The default sink is a file next to the plugin:

```
<config-dir>/plugins/notnativereviewer/notnativereviewer-telemetry.jsonl
```

One JSON record on each line. The gate appends to it, so the file grows across restarts.

Why a file and not the console: the host runs as `opencode serve --stdio`, where stdout is
the protocol channel. A record written with `console.log` would go into the wire, and it
would not appear in the host log. It would also risk corrupting the transport. The sink
therefore writes a file.

When the host provides no file writer, the sink falls back to `stderr` with the prefix
`[notnativereviewer] `. `stderr` carries no protocol data.

A sink failure does not change a decision. A logging failure must never turn an approval
into a denial, or a denial into an approval.

To read the newest records:

```sh
tail -n 50 <config-dir>/plugins/notnativereviewer/notnativereviewer-telemetry.jsonl
```

## 5.1 Every call is recorded

Every permission decision writes three records, whatever the outcome:

| Record | Meaning |
| --- | --- |
| `evaluate.start` | a call arrived, with its action, host effect and resource count |
| `decision.applied` | the outcome, the effect and the reason |
| `evaluate.end` | the effect and the duration |

A call that the floor passes without a model call still writes all three, with reason
`floor_safe`. Thus the file accounts for every tool call, not only the calls that reached
the reviewer.

## 6. What the log proves, and what it does not

The log proves that a step ran, and it records that step's measurements.

It does not prove content, because content is not there:

- a digest proves that a text did not change, not what the text said;
- a count proves how many records a lane held, not which ones;
- a duration proves how long a call took, not why the model answered as it did.

To read the content, read the conversation. The log and the conversation together give the
full account. Each alone does not.

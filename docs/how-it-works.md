# How NotNativeReviewer works

This document describes the gate's design: what it inspects, where it decides, and what it
cannot do. It is written for an operator who wants to know what they installed.

---

## 1. The one question

The gate asks one question about a tool call:

> Does this call match what the user asked for?

It does not ask "is this call risky?". A risky call that the user asked for is approved. A
harmless call that the user did not ask for is denied. The judgement is **alignment**.

## 2. The threat model

The gate exists for instructions that arrive from outside the conversation:

- a web page that the agent fetched;
- a document or source file that the agent read;
- text in an image caption;
- the model's own drift away from the user's request.

In each case the agent has no reliable way to tell the user's words from other words. The
gate is a second look, made by an agent that reads only the user's words and the call.

The gate does not protect the user from themselves. A destructive call that the user asked
for is approved.

## 3. Where the gate attaches

The gate uses hooks that OpenCode already provides. There is no fork and no patch of
OpenCode or OpenChamber.

| Hook | What the gate does there |
| --- | --- |
| `tool.execute.before` | **The enforcement point.** Runs before a tool executes. A throw stops the call. |
| `permission.evaluate` | A second, narrower point. The host runs it only for a call that reaches the permission assert path. |
| `session.prompt` | Records a user prompt in the package. |
| `session.context` | Records agent text in the package as evidence. Agent text is never authority. |
| `tool.execute.after` | Records the digest a write leaves, and appends a page answer. |
| event stream | Appends question answers, and learns a delegated session's parent. It forgets nothing. |

### 3.1 Why the gate blocks at `tool.execute.before`

The host triggers `permission.evaluate` from one place, the permission assert path. A tool
call that the configuration already allows does not assert, so it never reaches that hook.
A gate that attached only there would let most calls through.

`tool.execute.before` runs for every tool call. The host composes it as an Effect, and binds
the tool execution to its result:

```js
f = (tool, input, call) => hooks.trigger("tool", "execute.before", { tool, input, ...call })
run = (tool, input, call) => f(tool, input, call).pipe(bind((result) => execute(tool, result.input)))
```

A failure in `f` short-circuits the bind, so `execute` is never called. The block is
pre-execution by construction. This is the property that the gate needs: no bytes leave the
workspace because the gate was consulted after the fact.

The gate registers both hooks. `tool.execute.before` carries the enforcement, and
`permission.evaluate` covers a call that reaches the assert path.

An explicit `deny` in the OpenCode configuration is final, and does not reach either hook. The
gate therefore only ever sees a decision to allow or to ask, and it can only tighten it.

## 4. The three layers

### 4.1 The deterministic floor

The floor classifies a call by its declared effect, not by its name:

| Class | Example | Reaches review? |
| --- | --- | --- |
| Safe | `read`, `glob`, `grep`, a plain shell read | No. Passes with no model call. |
| Consequential | `write`, `edit`, `patch`, any other `shell` command | Yes. |
| Egress | `webfetch`, `websearch` | Yes, always. Even a `GET`. |

A `GET` is egress because a URL can carry data in its query string. The floor never
approves an egress call.

The floor skips the **review**. It does not skip the **record**: every call, including a
safe call, is written to the ledger.

#### 4.1.1 A tool whose name does not settle the answer

Some tools are safe for one action and dangerous for another. `openchamber_knowledge` can
list notes and it can delete them. Classifying that tool by its name would either review
every list or pass every delete, so the gate reads the sub-action that the call names and
checks it against a closed list of safe sub-actions.

The list names what is safe. Anything else is consequential, including a sub-action this
gate has never seen and a value the model invented:

| Tool | Safe sub-actions | The rest |
| --- | --- | --- |
| `openchamber_knowledge` | `knowledge.list` | `save`, `delete`, `show` |
| `openchamber_memory` | `memory.read`, `memory.list` | `save`, `delete` |
| `openchamber_usage` | `usage.read` | — |
| `openchamber_workflow` | `workflow.check`, `status`, `result`, `list` | `run`, `stop`, `save` |
| `openchamber` | `projects.list`, `models.list`, `models.search`, `session.list`, `session.status`, `session.messages`, `wait.list`, `schedule.status`, `schedule.list` | `create`, `send`, `fork`, `moveToWorktree`, `delete`, `toggle`, `run` |

Three tools never take the safe path, even for a call that looks like a read, because each
can move data out of the workspace:

- **`openchamber_render`** draws a page in the chat. A page can name a remote image, and the
  user's own interface then fetches that URL. The call looks local and the egress is real.
- **`openchamber_web`** drives a browser.
- **`openchamber_notify`** reaches the user, and **`openchamber_secret`** takes a credential.

#### 4.1.2 One review per call

The host can send one tool call to the gate twice: once through `tool.execute.before`, and
again through `permission.evaluate` when the tool asserts its own permission inside
`execute`. The two arrive together, and both name the same call.

The gate reviews the first arrival and answers the second with that same decision. A
duplicate can therefore never be looser than the original: a deny stays a deny and an ask
stays an ask. A call is held for 15 seconds and claimed once, so a third sighting is a new
call and is reviewed again. Without this, one call cost two model calls and twice the
latency; a measured session showed 2.19 evaluations per tool result.

#### 4.1.3 A shell read passes on the floor

Reading is knowledge, and the user does not have to authorize knowledge. Native read tools
already pass on the floor. A shell command is the one call that carries no declared effect,
so the floor reads the command text itself against a closed grammar:

| Condition | Example |
| --- | --- |
| No chaining, redirection, expansion, or substitution | `git status --short` |
| Every stage's verb only reads: file readers, search, listing, `git` inspection | `rg --files plugin` |
| No flag that writes, deletes, or runs another command | `find . -delete` fails here |

Anything outside the grammar reaches review, where a write belongs. That asymmetry is the
point: the exception can open a read and can never open a write. Quoting counts, so a search
for `"a|b"` is a read because the bar is inside a literal string, while `"a$(id)"` is not. A
pager is absent from the verb list because `less` can run a shell command from its own prompt.

A pipeline is judged as one piece. The text is split on an unquoted pipe, and **every** stage
must be a reader with no write or exec flag:

| Pipeline | Floor |
| --- | --- |
| `Get-Content log \| Select-String error` | read |
| `git log --oneline -20 \| Select-String gate` | read |
| `Get-Content log \| Remove-Item x` | review |
| `Get-Content log \| Select-String x \| sh` | review |

One stage outside the list carries the whole command to review. Approving the first stage and
letting the rest ride is exactly how a write would arrive dressed as a read.

A read passes even when the session has no package, which removes a class of
`package_unavailable` denial from the moment a gate is installed.

### 4.2 The reviewer

The reviewer is an agent that NotNativeReviewer defines:

- its own prompt, written for this one question;
- a fresh context, which holds the conversation text and the call;
- a closed output grammar;
- no tools, so it cannot act and cannot read on its own.

Its **model** comes from the conversation. That is deliberate: an operator with one local
model must be able to use the gate. The separation is not the model. The separation is the
fresh prompt and the trust labels: user text is authority, agent text is evidence, and the
reviewer does not see tool results or the agent's hidden reasoning.

#### 4.2.1 The reviewer approves ordinary work

The gate judges alignment, not thoroughness. A user who asks for a fix does not name each
line, each file, or each entry in a list that the fix touches. A reviewer that demanded that
naming would stop the work for a reason the user never intended to supply.

So the prompt says, in this order:

| Rule | What it prevents |
| --- | --- |
| Escalate only when a genuine ambiguity has a high consequence | An escalation for an ordinary unstated detail |
| Adding or removing code is part of changing that code | An edit held up because the user named a problem, not a line |
| Allow any routine, proportionate action that finishes the request | A demand that the user pre-approve every step |
| Reading and listing are always allowed | A denial that stops the agent from looking at the code it was asked to change |
| Do not require the user to name an intermediate command, a helper, or a file | A demand that the user name the route |
| Decide by meaning, not by keyword overlap | A denial because the request and the file share no words |

An escalation is for a real decision that needs the user. It is not a way for the reviewer
to say that it was unsure. The gate would rather approve a proportionate step than stop a
session to ask a question that the request already answered.

The prompt keeps the rules that make the gate worth having: the agent's text is evidence
and never authority, a deny needs no permission, and egress needs the request to justify it.

#### 4.2.2 A change is shown as a change

The reviewer sees the text that a call removes and adds, each on its own line, and not as
an escaped JSON string:

```
change:
  remove:
    'mcp_cancelled',
  add:
    'mcp_cancelled',
    'test_environment_isolation_required',
```

A change is easier to judge as a change. The escaped form made the reviewer decode a
string before it could judge the work, and it judged the change abstractly as a result.

The gate calls the model with `temperature: 0` and a hard deadline of 120 seconds. The
deadline is a cap, not a target: a slow local model can spend much of it on pre-fill, and
a reviewer that answers sooner is used at once. The reviewer returns one JSON object with
these fields:

| Field | Meaning |
| --- | --- |
| `outcome` | `approve`, `deny_with_guidance`, `hard_deny`, or `escalate_to_operator` |
| `confidence` | 0.0 to 1.0 |
| `reason_code` | A short lower-case code |
| `guidance` | Text for the model, capped |
| `authority_anchors` | Record identifiers from the user's own text |
| `effect_assessment` | `read_only`, `state_changing`, or `unknown` |

The gate validates every field. An unknown field is a defect. An anchor that names text the
user did not write is a defect. A defect gets one repair attempt with the valid anchors
listed, and then the call is denied.

### 4.3 The outcome mapping

| Outcome | Effect applied |
| --- | --- |
| `approve` | The host decision is left unchanged |
| `deny_with_guidance` | `deny`, with the guidance as the message |
| `hard_deny` | `deny`, with a short reason |
| `escalate_to_operator` | `ask`, so the human decides |

The gate never turns `ask` into `allow`, and never turns `deny` into `allow`.

### 4.4 The catastrophe check

One shell deny does not use the model. A command that destroys a system root is
denied at once, before the reviewer is called.

The gate reads the command, looks for a catastrophic target, and stops. The
reason code is `catastrophic_command`. The message says which target matched and
says that no model decided it.

| What it matches | Example |
| --- | --- |
| A root, with a recursive force delete | `rm -rf /`, `rm -fr /*`, `sudo rm -rf /` |
| A whole home tree | `rm -rf ~`, `rm -rf $HOME`, `rm -rf /home`, `rm -rf /Users` |
| A system directory | `rm -rf /etc`, `/usr`, `/var`, `/bin`, `/boot`, `/root` |
| A drive root | `rm -rf C:\`, `format C:` |
| A whole partition | `mkfs.ext4 /dev/sda1`, `dd of=/dev/sda`, `diskpart` |
| A fork bomb | `:(){ :|:& };:` |

The check is narrow on purpose. It matches a **catastrophic target**, not a
destructive verb:

| Command | Result |
| --- | --- |
| `rm -rf ./build` | Reaches the reviewer |
| `rm -rf node_modules` | Reaches the reviewer |
| `rm -rf /tmp/scratch` | Reaches the reviewer |
| `rm -rf ~/Downloads/tmp` | Reaches the reviewer |
| `git clean -fdx` | Reaches the reviewer |
| `dd if=/dev/zero of=./image.bin` | Reaches the reviewer |

**The boundary is a system root, not a user directory.** The user may ask to
delete a directory. The user will not ask to delete `/`. So `rm -rf /home/user`
is not auto-denied: it stays a reviewer decision. Section 8 gives the limits of
this check.

## 5. What the reviewer is given

The gate gives the reviewer two bounded inputs:

1. **The conversation.** The user's inputs and the agent's replies, in order. User records
   are authority; agent records are evidence. Records carry a trust class:
   - `user_authored`: the user's own words, including a question or page answer. This can
     authorise a call.
   - `user_assented`: agent text that the user approved. This can authorise a call.
   - `agent_delegated`: the task that another agent gave a delegated session. It can
     authorise work inside that session, but only within the primary conversation, and it
     can never outrank the user (§5.4).
   - `model_utterance`, `synthetic`: the agent's proposals and context. This cannot
     authorise a call.
   Tool calls and tool results are not in the package. The reviewer sees what the user saw:
   the conversation, not the plumbing.
2. **The file content for the call.** When a call writes a file or runs a script, the gate
   reads the content and puts it in front of the reviewer. The reviewer judges content, not
   a path string. This matters most for a shell call that runs a script: the gate reads the
   script, so the reviewer sees what it will do, including a network call the user did not
   ask for.

### 5.1 How a shell call is presented

A shell call carries a command string, not a file path. The first target is therefore the
command itself, and the gate treats it that way:

1. The command text always reaches the reviewer, so an inline command is reviewed as
   written.
2. The gate also finds the file paths that the command names. A token counts as a path
   when it holds a path separator, a leading `./`, or a script or data extension such as
   `.sh`, `.ps1`, `.py`, `.js`, or `.json`.
3. The gate reads the directory that the command states, so a relative path resolves where
   the command would resolve it. `git -C /repo rm -q src/x.js` names `src/x.js` under
   `/repo`, not under the gate's own directory:

   | Form | Example |
   | --- | --- |
   | `-C <dir>` | `git -C /repo rm -q src/x.js` |
   | `cd <dir>` | `cd /repo && rm src/x.js` |
   | `Set-Location <dir>` | `Set-Location /repo; Remove-Item src/x.js` |
   | `--prefix=<dir>` | `git --prefix=/repo rm src/x.js` |

4. The gate reads up to three of those files and puts the content in the payload excerpt,
   each under a `### file: <path>` heading.
5. When the gate cannot read a named file, it shows the command and says the content is
   unavailable. An empty section would read as "nothing here", and a reviewer that cannot
   see a file will deny a call that it simply could not read.

This last point matters more than it looks. A file whose name does not repeat the words of
the request looks unrelated on its name alone: a call deleting `src/update-platform.js`
looks unexplained by a request about the "desktop surface". The link is inside the file,
which calls `nna desktop status`. Without the content the reviewer judges a filename, and a
filename is not evidence.

This is a reader, not a shell parser. It does not expand a variable, follow a pipe, or
resolve a path built at run time. A script named through a variable is not read. The gate
reports what it read, and the reviewer judges from that.

The caps are 32 records with 4,096 bytes each for the conversation, and 16,384 bytes in
total. The reviewer sees 16,384 bytes of file content at most, shared across the script
files it reads.

### 5.2 Intent survives a long session

A session can start as a comparison of two repositories and turn into a change to one of
them. The gate does not decide which ask governs. It gives the reviewer the conversation
in order, so a proposal, the user's "ok", and the call that follows stay next to each
other.

The reviewer is told four things:

1. The conversation is in order. User records are authority; agent records are evidence.
2. A user record confirms or authorizes the agent text immediately before it, even when the
   words are short or the user selected an option.
3. Read the whole conversation for general intent. The newest user input is the strongest
   signal, but earlier input and confirmations remain context.
4. A destructive call is approved when the conversation authorizes it. Only a system root
   is blocked before review.

The package keeps the newest records under the caps and drops the oldest. It presents them
in conversation order, so adjacency is preserved. A question or page answer appends like
any other user input; it does not start a new authority window.

User and agent text stay interleaved on purpose. A short "ok" only means something next to
the proposal it answers, so the gate never separates the user's lines from the agent's.

### 5.3 The package is created by user input, and only by user input

A package exists because the user spoke. A prompt or a question or page answer creates it.
Agent text only appends to a package that already exists; a transcript made only of agent
text carries no authority and is not reviewable.

Nothing in the host event stream removes a package. An idle parent, a finished subagent, or
a reconnecting client must not delete the evidence behind a live call, because the call it
would block is one the user already asked for.

Packages are held per session and never shared. A prompt or an answer in one session cannot
read, replace, or reset another session's package or its snapshot, so concurrent sessions
and subagents review against their own conversation.

Every user input also takes a snapshot of the package as it stands at that input. If the
current package later has no user record, the reviewer uses the snapshot instead of denying.
`projection.built` names which one answered in `packageSource`, and a fallback also writes
`package.fallback`.

When neither the package nor its snapshot holds a user record, the gate denies with
`package_unavailable` and tells the model to ask the user a short clarifying question about
what they want done. It asks for the goal, not for permission, and it does not invite a
retry.

### 5.4 A delegated session runs inside the user's intent

A subagent is a separate session, and its task text is written by another agent. That text is
not the user's instruction, so the gate gives a delegated session two layers:

| Layer | Source | Authority |
| --- | --- | --- |
| Primary | The conversation that delegated the session, captured when the link is known | The user's own request. Highest authority |
| Delegated | The task text in the subagent's session, and that agent's own text | Subordinate. It can carry out the primary conversation, never extend it |

The gate reads the link from the host's own session surface: `ctx.session.get({sessionID})`
returns the child's record, and the record carries its `parentID`. One read, when the child's
first prompt arrives, and the hierarchy is in force from the first call. The SDK client is a
fallback with the same record under a different path. The prompt hook's own event carries no
parent, and `session.created` does not fire for a child on this host, so the record is the
source that works; `delegation.observed` names it as `via: "context"`. A lookup that fails
leaves the session top-level, which is the behaviour of a session the user opened directly. A
prompt recorded before a late link is reclassified as delegated, so an event race cannot
leave agent text holding user authority.

The reviewer receives both layers, with the policy that the delegated task cannot override
the primary conversation, and that a conflict is a denial. The gate also enforces the
hierarchy in the grammar: **an approval from a delegated session must cite at least one
anchor from the primary conversation.** A decision that cites only the subagent's task is
rejected, repaired once, and then denied. A denial needs no anchor, so a subagent can always
refuse.

A nested delegation keeps the deeper user layer, so a chain of agents still traces back to
the user and not to the agent in the middle.

If a delegated session has no primary conversation, the gate denies with
`primary_unavailable` and asks the agent to tell the user what it was asked to do, and to
request the overall goal. It does not review the task on its own authority.

### 5.5 What counts as part of the request

The gate asks whether a call serves the user's request, not whether the user named the call.
The reviewer is given one scope rule and two concrete scopes, not a catalogue of allowed
actions:

> Scope is the user's request plus what it implies. Allow any routine, proportionate action
> that finishes it, whether or not the user named it; deny what reaches beyond it, even when
> it would help.

| Situation | What the scope allows | What it denies |
| --- | --- | --- |
| Any read: a file, a listing, a search, a log, a `git` inspection | Everything; knowledge needs no authority | Nothing |
| Verify, check, test, or confirm; the work is reported done or live; a short "ok" | The commands, logs, and inspections the check needs | Work the request does not cover |
| Audit, review, or investigation | Reading the code or document, and a new report, summary, or notes file | Any change to the code or document under review |
| A settings change | Investigating the impact of that setting | Changing any other setting |
| A new capability nobody asked for | Nothing; it is outside the request | The capability itself, however useful |

The table illustrates the rule; it is not a list the reviewer checks one by one. That keeps
the prompt small as new kinds of request appear, and keeps the reviewer judging scope rather
than matching vocabulary.

Reading is the one row that does not depend on the request at all. The gate lets a read pass
on the floor, so the reviewer is rarely asked, and the user never has to authorize knowledge
(§4.1.3). The scrutiny belongs to what the agent does with what it read.

### 5.6 The package survives a reload until the user speaks again

An install or a restart unloads the plugin, and the package and the read ledger go with it.
For a session the user is watching that is only an inconvenience: the next message re-anchors
it. For an unattended run it is the end of the run, because the gate's own test cycle installs
again and the second install would deny for want of a conversation.

So the gate writes a state file beside its audit log and reads it once, at setup:

| What is written | Why |
| --- | --- |
| The user records of each session, with their timestamps | This is the authority; nothing else has to survive |
| A session's parent link | A subagent is still a subagent after a reload |
| The read ledger, with content digests | A write after a reload is checked against what the session actually saw |

Agent text is not written. It is evidence, and the gate sees it again as the session
continues; authority is the thing a reload would otherwise lose.

There is no clock on that authority. A restored session stays valid across any number of
reloads, and the next input from the user replaces the record and becomes the authority. Two
consequences follow, and both are intended:

- A session from yesterday still restores, and its newest words are the ones that count.
- Nothing refreshes the record except the user. A long agent run does not.

Four rules keep the file from becoming a master key:

- Only user records are written, never agent text.
- The file is read once, at setup. Nothing in the event stream can restore a package, so a
  running session cannot conjure authority by asking for it.
- An operator who wants a clock can set `NNR_STATE_TTL_MINUTES` in `nnr.env` to a number of
  minutes. `0` turns persistence off, and then every reload is a cold start.
- A defect restores nothing: a truncated write, an unknown version, a record with no
  timestamp, or a timestamp a day ahead of the clock. The gate then behaves exactly as it
  does after a cold start.

The file holds the user's own words, so it is gitignored. An install carries it forward, and
an uninstall deletes it, because removing the gate should not leave that copy behind.
Telemetry records `state.restored` at every setup with the age and the counts, so restored
authority is never invisible.

## 6. Read before write

A call that changes an existing file must follow a read of that same file, and the file
must not have changed since the read. The gate keeps its own ledger of every read.

The ledger is the gate's own record. It does not come from the host, and it does not come
from the conversation, because a tool result in the conversation is text that the model
can read and that anything the model read can influence. The ledger holds one entry per
file: the digest of the content at the moment the gate saw it.

| The call | What the ledger records |
| --- | --- |
| `read` of a file that exists | The digest of the content |
| `write` or `edit` that succeeded | The digest of the result, read back from disk |
| `grep`, `glob`, `list` | Nothing. These name a pattern, not a file |
| A file the gate could not read | Nothing. The gate saw no content to promise |

A `read` records its entry before the call passes, because a read is the only place the
gate learns what a file holds.

A `write` or an `edit` records its entry **after** the call succeeded, and reads the file
back rather than trusting the arguments. The arguments say what the model intended; the
file says what happened. That entry is what lets an agent edit the same file again without
reading it first. A call that failed changed nothing, so it records nothing.

| Condition | Result |
| --- | --- |
| The target does not exist (a create) | No read is required |
| The session read the file, and its digest matches | Continue to alignment review |
| The session never read the file | Deny, `write_unread` |
| The file changed since the read | Deny, `write_stale` |
| A file-changing call that names no file | Deny, `write_unread` |

That last row matters. A call that names no file cannot be checked, and the tool name is
not a path. Reading the tool name as a path would make the file look absent, the call look
like a create, and the call would pass. The gate denies instead.

A stale write is a deny, not a warning. An edit may be line-specific: the agent planned to
change line 24. If another process inserted six lines since the read, that edit lands at
line 30 and corrupts the file. The gate does not guess what moved. It denies, and the agent
reads the file again.

A file has one key, however the call names it. A tool names a file as `path`. A permission
event names it as a resource, which can be a `file://` URL with a trailing wildcard. The
gate reduces both to one key, so a read through one shape matches a write through the
other. A path it cannot resolve keeps its raw form, and a mismatch denies rather than
allows.

Writes arrive one at a time. A tool call runs through a serialized effect, so the gate never
writes the state file while another write is in flight (§5.6). Concurrent sessions are what
change the file's *contents*, not its order: each save rewrites every session it holds, so a
later save carries the earlier session's records. A save cannot lose a session that is still
in memory, because only the newest input of each session is written, and the in-memory store
is the source for all of them.

## 7. Every failure denies

| Condition | Result |
| --- | --- |
| The reviewer is unreachable | Deny, `reviewer_unavailable` |
| The deadline passes | Deny, `reviewer_timeout` |
| The output is malformed twice | Deny, `reviewer_output_malformed` |
| The reviewer cites text the user did not write | Deny, `reviewer_anchor_invalid` |
| No user record in the package or its snapshot | Deny, `package_unavailable`; the model is told to ask a clarifying question |
| The state file holds nothing restorable after a reload | The same `package_unavailable` denial, as though the file were absent (§5.6) |
| A delegated session whose parent conversation is unknown | Deny, `primary_unavailable`; the model is told to ask for the overall goal |
| A delegated approval that cites only the subagent's task | Deny, `reviewer_anchor_invalid` |
| A modify of a file the session never read | Deny, `write_unread` |
| A modify where the file changed since the read | Deny, `write_stale` |

The gate does not fall back to the host decision when the reviewer is unavailable. An
unreachable reviewer that permits is not governance.

## 8. What the gate cannot do

These are limits of the host hooks, not defects that a later version can remove:

- **A create is reviewable but not protected by a read.** OpenCode's `write` takes no
  precondition, so a file can change between the gate's read and the write.
- **A session has no reset hook.** The gate never forgets a session on a lifecycle event,
  because a mis-timed event would delete a live request. It keeps the 64 most recently used
  sessions and evicts the least recent when a new one arrives. A session that the host
  drops and later resumes may therefore arrive with no package, which reads as
  `package_unavailable` and asks the user to restate the goal.
- **The gate cannot see a configured `deny`.** That decision is final and does not reach
  the hook, which is why the gate can only tighten.
- **Hook order is plugin load order.** A plugin that loads before this one can change the
  prompt that the gate records. A plugin that loads after can change the call further.
- **The gate reads only the first target of a multi-file call** for the file content it
  hands to the reviewer. The read-before-write check covers every target.
- **The ledger records a read only when the gate itself sees it.** A file that the agent
  read before the plugin loaded, or through a shell command, has no entry, so the first
  edit of it denies. The agent reads it again, which costs one call.
- **Text beyond the package caps is omitted.** The package keeps the newest 32 records
  within 16,384 bytes and drops the oldest. The gate reports the omission; it does not
  silently present the conversation as complete.
- **The catastrophe check reads one command string.** It does not expand a variable,
  follow a pipe into a second shell, or read a script that the command runs. A command
  that builds a destructive path at run time is not caught by it. Section 4.4 gives the
  exact set of matches.
- **A shell read passes only in its plain form.** A command whose stages are not all listed
  readers — a pipe into `bash`, a pager, a redirect, a substitution, or a verb the list does
  not hold — reaches review, where it can be denied. The floor can prove the listed form and
  cannot prove the rest, and it accepts that cost to keep the read exception narrow.
- **A host may keep a session's parent to itself.** The harness knows a subagent's parent and
  stores it, and the gate reads it from the session record (`via: "context"` in the log). A
  host that exposes neither the record nor the client leaves the link unknown, and the child
  is then reviewed as a top-level session. The prompt hook's event carries no parent on this
  host, so the record is the one source that works here.
- **Restored authority has no clock of its own.** After a reload the gate restores what the
  user said, and that stays valid until the user speaks again (§5.6). An operator can add a
  clock with `NNR_STATE_TTL_MINUTES`, but by default a conversation from yesterday still
  counts. The state file also holds those words in plain text, which is why an uninstall
  deletes it.

## 9. What is not proven yet

The gate has run on a live OpenCode instance: the plugin loaded, all hooks registered, the
reviewer answered with the session's own model, and decisions applied to tool calls. These
points remain unconfirmed:

- whether OpenCode discovers a plugin under `OPENCODE_CONFIG_DIR` (only the default global
  config path has been exercised);
- whether the permission hook fires for a call that a rule already allows (the gate uses
  `tool.execute.before` for this reason);
- whether the hook supplies resolved absolute paths;
- whether the plugin's `setup` writes a line that the operator can see.

Each one changes how much of this document holds. See [install.md](install.md) §8.

## 11. A host in skip-start mode loads no plugin

This section records a condition that makes the gate absent, not weak. It is the first
thing to check when a call passes that the gate should have closed.

OpenChamber has two modes. In **managed** mode it starts its own OpenCode server. In
**skip-start** mode it starts nothing, and connects to an OpenCode server that another
program runs.

The mode is an environment variable of the OpenChamber process:

| Setting | Value | Result |
| --- | --- | --- |
| `OPENCODE_SKIP_START` | `true` | skip-start mode |
| `OPENCODE_HOST` | a URL | the server to connect to |
| `OPENCODE_SERVER_PASSWORD` | a secret | the credential for that server |

In skip-start mode, OpenChamber never loads a plugin from the config directory. The
operator sees a working host. The plugins directory looks correct. No gate runs.

The failure is silent and it looks like a gate defect:

- a call passes that the gate should have closed;
- no `setup` record appears in the log;
- the plugins directory holds the right files.

A stale binding produces this state. `OPENCODE_SKIP_START=true` with a host at a port where
nothing listens leaves the host attached to a dead address. NNA writes that binding, and its
own `status` command reports the mismatch: `configured: true`, `runtime.running: false`,
`environment.skip_start: "true"`.

To clear it, run `nna opencode disable`, then start OpenCode again. To confirm, ask NNA for
its status and check that `environment.skip_start` is absent.

Before an install, check the mode. A plugin that is installed into a host that ignores
plugins gives a false assurance, which is worse than an install that refuses to run.

## 12. Test postures

The gate has two test postures, so that an operator can confirm that the gate closes a call
without relying on a model to decide.

| Posture | Setting | Effect |
| --- | --- | --- |
| Forced close | `NNR_FORCE_DENY=1` | denies every call |
| Forced open | `NNR_FORCE_ALLOW=1` | allows every call |
| State across a reload | `NNR_STATE_TTL_MINUTES` (absent by default) | restores the package and ledger until the user speaks again; a number of minutes adds a clock, `0` turns it off (§5.6) |

The settings are in the file `nnr.env`, in the plugin directory. To set a posture,
change that file and restart OpenCode. The file is read once, at setup.

```
<config-dir>/plugins/notnativereviewer/nnr.env
```

The shipped file sets both postures to `0`, so the reviewer decides each call. To confirm
that the gate closes a call, set `NNR_FORCE_DENY=1` and restart OpenCode. Set it back to
`0` to let the reviewer decide each call again.

Format of the file:

- One `KEY=VALUE` pair on each line.
- A `#` starts a comment. An empty line is ignored.
- Only the exact value `1` enables a posture. Any other value leaves the gate in its normal
  state, so a typo cannot put the gate into a test state.
- An unknown key is ignored, so an old file still loads.
- A missing file is not an error.
- An explicit option that the caller passes wins over the file. A value of `undefined` is
  not a value, so the file value stays.

The gate reads the process environment as a fallback, so a CI run can set a posture without
a file. The file wins over the environment.

Rules for the postures:

- A posture applies to every call. It runs before the floor split, so it also covers a
  call that the floor classifies as safe. The purpose is to show that the gate controls
  every call, so a posture that skipped a call would not be a test.
- A posture makes no model call.
- A forced close denies with the reason `reviewer_unavailable`, so a log reader can see that
  the denial came from a posture and not from a failure.
- A forced close applies to every action, including `read`, `glob`, `grep` and `list`, and to
  an action this gate does not know.
- A forced open never loosens a host decision. The gate still applies its strictness order.
- A posture does not override a configured `deny` in the host, because the host does not
  call the hook for a configured deny.
- A forced close wins when both settings are `1`. The setup record reports
  `postureConflict: true` when both are on, so the conflict is visible.

To test a forced close:

1. Set `NNR_FORCE_DENY=1` in `nnr.env`.
2. Restart OpenCode.
3. Ask the agent to tour the codebase. Every call is denied, including the reads.
4. Set the value back to `0` and restart to return to the normal gate.

The setup record states the active postures and the source: `postureSource` is
`nnr.env`, `environment`, or `defaults`. When the setup record says `defaults` but
you set a value, the file was not read. Look for a `settings` error record.

Do not use the file for production settings. A posture is for a test.

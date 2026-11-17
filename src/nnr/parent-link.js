/**
 * Parent link — where a session's parent id comes from (docs/how-it-works.md §5.4).
 *
 * A delegated session must be judged inside the conversation that delegated it, so the gate
 * needs the child's parent id before its first prompt is recorded. Two surfaces can hold it,
 * and both are reads of one record, never inference:
 *
 *   1. The host's own session surface: `ctx.session.get({sessionID})`. The host's validation
 *      errors named the key, and the record carries the parent as a field.
 *   2. The SDK client: `ctx.client.session.get({path:{id}})`, whose record nests `info`.
 *
 * A lookup that fails, or a record without a parent, returns null. The caller then reviews
 * the session as a top-level one, which is the behaviour of a session the user opened.
 *
 * No imports.
 */

/**
 * Read a session's parent id, from the host surface first, then the SDK client.
 *
 * @param {object} ctx the host context
 * @param {string} sessionID the child session
 * @returns {Promise<{ parentID: string | null, via: string }>}
 */
export async function readParentID(ctx, sessionID) {
  const host = await fromSessionGet(ctx, sessionID);
  if (host) return { parentID: host, via: "context" };
  const client = await fromClient(ctx, sessionID);
  if (client) return { parentID: client, via: "client" };
  return { parentID: null, via: "none" };
}

/** Call the host's own session surface, which takes `{sessionID}`. */
async function fromSessionGet(ctx, sessionID) {
  try {
    const session = ctx && ctx.session;
    if (!session || typeof session.get !== "function") return null;
    const reply = await session.get({ sessionID });
    return readParentField(reply, sessionID);
  } catch {
    return null;
  }
}

/** Call the SDK client, whose session.get takes `{path:{id}}`. */
async function fromClient(ctx, sessionID) {
  try {
    const client = ctx && ctx.client;
    if (!client || !client.session || typeof client.session.get !== "function") return null;
    const reply = await client.session.get({ path: { id: sessionID } });
    return readParentField(reply, sessionID);
  } catch {
    return null;
  }
}

/**
 * Find a parent id in a session record, or null.
 *
 * The id must name a session other than the child, and the field must say `parentID`, so a
 * stray session id in an unrelated field can never become a parent link.
 */
function readParentField(reply, sessionID) {
  if (!reply || typeof reply !== "object") return null;
  const layers = [reply, reply.data, reply.info, reply.data && reply.data.info, reply.info && reply.info.info];
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    const parentID = layer.parentID;
    if (typeof parentID === "string" && parentID !== "" && parentID !== sessionID) return parentID;
  }
  return null;
}

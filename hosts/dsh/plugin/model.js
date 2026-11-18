/**
 * Model transport for the DSH adapter.
 *
 * The core's reviewer contract is one function: given `{prompt, temperature,
 * maxTokens}`, return the reply text. OpenCode provides it through
 * `ctx.experimental.generate.text`; DSH provides it through the `llm` runtime:
 * `prepareCall(provider, model)` resolves a config-bound call, and its
 * `stream(options)` yields chunks whose `text-delta` members are the answer.
 *
 * The provider and model are resolved LIVE, per conversation, not from config:
 * the session stream carries `model/selection` when a model is chosen and
 * `assistant/message` whose source names the provider and model that actually
 * ran. A user who switches models mid-stream — or because a provider died — is
 * followed by the next review, and two conversations on two models are each
 * reviewed with their own. A config value is only the fallback for a session
 * that has shown no selection yet.
 */

/**
 * Build the reviewer caller factory for this host.
 *
 * @param {object} ctx the plugin context
 * @returns {((target: {provider: string, model: string}, args: {prompt: string,
 *   temperature: number, maxTokens: number}) => Promise<string>)}
 */
export function buildDshCaller(ctx) {
  return async (target, args) => {
    const llm = resolveLlm(ctx);
    let prepared;
    try {
      prepared = await llm.prepareCall(target.provider, target.model);
    } catch (error) {
      throw new Error(`NotNativeReviewer: llm prepareCall failed: ${error && error.message}`);
    }
    let stream;
    try {
      stream = prepared.stream({
        provider: target.provider,
        model: target.model,
        messages: [{ role: "user", content: [{ type: "text", text: String(args.prompt || "") }] }],
        temperature: typeof args.temperature === "number" ? args.temperature : 0,
        maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 512,
      });
    } catch (error) {
      throw new Error(`NotNativeReviewer: llm stream failed to open: ${error && error.message}`);
    }
    let text = "";
    try {
      for await (const chunk of stream) {
        if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      }
    } catch (error) {
      throw new Error(`NotNativeReviewer: llm stream failed mid-answer: ${error && error.message}`);
    }
    return text;
  };
}

/**
 * Find the host's llm runtime. The service is reached by property or by `ctx.get`;
 * a Typert remote service may answer with a proxy whose methods are dispatched
 * dynamically, so the runtime is chosen by presence, not by probing for a method —
 * a wrong guess here would send every review down the failure path silently.
 *
 * @param {object} ctx
 * @returns {object} the llm runtime
 */
function resolveLlm(ctx) {
  const byProperty = ctx && ctx.llm;
  if (byProperty && typeof byProperty === "object") return byProperty;
  const byGet = ctx && typeof ctx.get === "function" ? safeGet(ctx, "llm") : null;
  if (byGet && typeof byGet === "object") return byGet;
  throw new Error("NotNativeReviewer: the host exposes no llm runtime for the reviewer");
}

/** Read one service from the context without letting an unknown name throw. */
function safeGet(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return null;
  }
}

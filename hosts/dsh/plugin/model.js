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
    const prepared = await llm.prepareCall(target.provider, target.model);
    const stream = prepared.stream({
      provider: target.provider,
      model: target.model,
      messages: [{ role: "user", content: [{ type: "text", text: String(args.prompt || "") }] }],
      temperature: typeof args.temperature === "number" ? args.temperature : 0,
      maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 512,
    });
    let text = "";
    for await (const chunk of stream) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    }
    return text;
  };
}

/**
 * Find the host's llm runtime. The service is reached by property or by `ctx.get`,
 * depending on how the host mounts it; a runtime with neither shape is a hard error,
 * because a silent miss would send every review down the failure path.
 *
 * @param {object} ctx
 * @returns {object} the llm runtime
 */
function resolveLlm(ctx) {
  const byProperty = ctx && ctx.llm;
  if (byProperty && typeof byProperty.prepareCall === "function") return byProperty;
  const byGet = ctx && typeof ctx.get === "function" ? ctx.get("llm") : null;
  if (byGet && typeof byGet.prepareCall === "function") return byGet;
  throw new Error("NotNativeReviewer: the host exposes no llm runtime for the reviewer");
}

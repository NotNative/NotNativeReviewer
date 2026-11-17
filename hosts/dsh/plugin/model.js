/**
 * Model transport for the DSH adapter.
 *
 * The core's reviewer contract is one function: given `{prompt, temperature,
 * maxTokens}`, return the reply text. OpenCode provides it through
 * `ctx.experimental.generate.text`; DSH provides it through the `llm` runtime:
 * `prepareCall(provider, model)` resolves a config-bound call, and its
 * `stream(options)` yields chunks whose `text-delta` members are the answer.
 *
 * The caller is only built when the operator names a provider and a model in the
 * plugin config. Without them there is no reviewer, and the gate falls back to the
 * floor-first behaviour: the operator decides every consequential call.
 */

/**
 * Build the reviewer caller for this host, or null when no model is configured.
 *
 * @param {object} ctx the plugin context
 * @param {{provider?: string, model?: string}} [config]
 * @returns {((args: {prompt: string, temperature: number, maxTokens: number}) => Promise<string>) | null}
 */
export function buildDshCaller(ctx, config) {
  if (!config || typeof config.provider !== "string" || typeof config.model !== "string") return null;
  if (config.provider === "" || config.model === "") return null;
  const provider = config.provider;
  const model = config.model;
  return async (args) => {
    const llm = resolveLlm(ctx);
    const prepared = await llm.prepareCall(provider, model);
    const stream = prepared.stream({
      provider,
      model,
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

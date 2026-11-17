/**
 * Core loader for the DSH adapter — the one place this adapter knows where the NNR
 * core lives. The layouts mirror the OpenCode adapter's: this repository during
 * development, then an installed plugin directory. A core that cannot be found is
 * a loud error, never a silent ungated host (plan invariant 2).
 */

/** The layouts that are tried, in order: this repository, then an installed plugin. */
const CORE_LAYOUTS = ["../../../src/nnr/", "./nnr/"];

/** The modules that make up the core, and the keys they answer to. */
const CORE_MODULES = [
  ["bytes", "bytes.js"],
  ["dedupe", "dedupe.js"],
  ["evaluate", "evaluate.js"],
  ["files", "files.js"],
  ["floor", "floor.js"],
  ["grammar", "grammar.js"],
  ["ledger", "ledger.js"],
  ["observation", "observation.js"],
  ["package", "package.js"],
  ["parentLink", "parent-link.js"],
  ["payload", "payload.js"],
  ["questions", "questions.js"],
  ["readGrammar", "read-grammar.js"],
  ["reviewer", "reviewer.js"],
  ["settings", "settings.js"],
  ["state", "state.js"],
  ["telemetry", "telemetry.js"],
  ["version", "version.js"],
];

/**
 * Find the directory that holds the core, and prove it by loading its version module.
 *
 * @returns {Promise<string>} the base URL that the core modules load from
 */
async function findCoreBase() {
  const tried = [];
  for (const layout of CORE_LAYOUTS) {
    const base = new URL(layout, import.meta.url).href;
    try {
      await import(`${base}version.js`);
      return base;
    } catch (error) {
      tried.push(`${layout} (${error && error.message})`);
    }
  }
  throw new Error(`NotNativeReviewer core not found; tried: ${tried.join("; ")}`);
}

/**
 * Load the core, with each module under its own key. `import` caches by URL, so the
 * modules are shared with any other adapter in the process.
 *
 * @returns {Promise<object>} a namespace per core module, keyed by CORE_MODULES
 */
export async function loadCore() {
  const base = await findCoreBase();
  const loaded = await Promise.all(
    CORE_MODULES.map(async ([key, file]) => [key, await import(`${base}${file}`)]),
  );
  return Object.fromEntries(loaded);
}

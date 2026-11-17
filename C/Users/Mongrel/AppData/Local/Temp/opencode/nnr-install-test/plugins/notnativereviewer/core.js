/**
 * Core loader — the one place the host adapter knows where the NNR core lives.
 *
 * The adapter ships as a few files in the host's plugin directory, and the core it
 * judges with lives beside it, in `nnr/`. In this repository the core sits at
 * `src/nnr/`, two levels up. Both layouts are tried, in that order, so the same
 * adapter files run in the repository under test and in an installed directory.
 *
 * A core that cannot be found is a broken installation, and a gate that is not there
 * cannot fail closed. The error is therefore loud and names every path that was tried,
 * so the operator sees exactly what is missing rather than a host that runs ungated
 * in silence (plan: multi-host architecture, invariant 2).
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
 * Load the core, with each module under its own key.
 *
 * `import` caches by URL, so two adapters in one process share the same module
 * instances and no state is duplicated.
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

/**
 * Version — the product version.
 *
 * The version uses the format `yyyymmdd-<increment>`, for example `20261114-1`.
 * `tools/bump-version.mjs` writes this file and `package.json` together, so the two
 * cannot disagree. This file exists because the plugin cannot import `package.json` in
 * a discovery directory, where no JSON import support is guaranteed.
 *
 * Do not edit this value by hand. Run the bump tool.
 */

export const VERSION = "20261116-10";

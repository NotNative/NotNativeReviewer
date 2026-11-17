/**
 * Bytes — byte measurement and text trimming with no imports.
 *
 * Three modules need to measure a string in UTF-8 bytes, and two need to trim a string
 * to a byte budget. Keeping one copy avoids the modules disagreeing about a cap.
 *
 * No imports. A Buffer is not used, because the plugin loads where no node modules are
 * installed (docs/coding-discipline.md §3).
 */

/** The UTF-8 byte length of a string. */
export function byteLength(text) {
  if (typeof text !== "string") return 0;
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Trim a string to a byte budget without splitting a character.
 * @returns {string} the trimmed text, or the text unchanged when it fits
 */
export function trimToBytes(text, limit) {
  if (byteLength(text) <= limit) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = byteLength(ch);
    if (used + size > limit) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Trim a string to a byte budget and report whether it was trimmed.
 * @returns {{ text: string, truncated: boolean }}
 */
export function budgetText(text, limit) {
  const bytes = byteLength(text);
  if (bytes <= limit) return { text, truncated: false };
  return { text: trimToBytes(text, limit), truncated: true };
}

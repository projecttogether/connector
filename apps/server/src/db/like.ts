/** Escapes `%`, `_` and `\` so text matches itself in `like` and `ilike` patterns. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

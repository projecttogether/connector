/**
 * The part of SCIM filters (RFC 7644, 3.4.2.2) that identity systems use to
 * find people and groups: `<attribute> eq "<value>"`, joined by `and`.
 * Attribute names are case-insensitive; values compare case-insensitively
 * for userName and emails, exactly otherwise.
 */
export type ScimCondition = { attribute: string; value: string };

export class ScimFilterError extends Error {
  override name = "ScimFilterError";
}

const CONDITION =
  /^\s*([A-Za-z][\w.:$-]*(?:\[[^\]]*\])?(?:\.[A-Za-z]\w*)?)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false|null)\s*$/i;

export function parseFilter(filter: string | undefined): ScimCondition[] {
  if (!filter || filter.trim() === "") return [];
  if (filter.length > 500) throw new ScimFilterError("The filter is too long");
  return splitAnd(filter).map((part) => {
    const match = CONDITION.exec(part);
    if (!match) throw new ScimFilterError(`Unsupported filter: ${part.trim().slice(0, 100)}`);
    const raw = match[2]!;
    const value = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.toLowerCase();
    return { attribute: normalizeAttribute(match[1]!), value };
  });
}

/** Splits at `and` outside quotes and brackets ("Research and Development" stays whole). */
function splitAnd(filter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < filter.length; index += 1) {
    const char = filter[index]!;
    if (char === "\\" && quoted) {
      current += char + (filter[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "[") depth += 1;
    else if (!quoted && char === "]") depth -= 1;
    const rest = filter.slice(index);
    if (!quoted && depth === 0 && /^\s+and\s+/i.test(rest)) {
      parts.push(current);
      current = "";
      index += /^\s+and\s+/i.exec(rest)![0].length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** `emails[type eq "work"].value` → `emails.value`; schema URNs and case removed. */
export function normalizeAttribute(attribute: string): string {
  return attribute
    .trim()
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, "")
    .replace(/\[[^\]]*\]/g, "")
    .toLowerCase();
}

/**
 * Canonical comparison for Calendar's JSON-like value model.
 * Object key order is irrelevant and optional properties whose value is undefined
 * are equivalent to absence. Array order remains significant.
 */
export function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameCanonicalValue(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && rightRecord[key] !== undefined
    && sameCanonicalValue(leftRecord[key], rightRecord[key]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

/** Stable JSON representation for signatures/fingerprints over validated JSON-like values. */
export function canonicalValueString(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  return encoded === undefined ? "undefined" : encoded;
}

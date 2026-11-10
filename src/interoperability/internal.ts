import type { CalendarTemporalKind, CalendarTemporalSpec } from "../core/types.js";

/** Stable compact hash used only for deterministic local interoperability identities. */
export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function temporalSpec(kind: CalendarTemporalKind, timeZone?: string): CalendarTemporalSpec {
  return kind === "zoned" ? { kind, timeZone: timeZone ?? "UTC" } : { kind };
}

export function withoutNullishEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

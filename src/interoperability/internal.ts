import type { CalendarTemporalKind, CalendarTemporalSpec } from "../core/types.js";

function stableHash32(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable compact hash used only for deterministic local interoperability identities. */
export function stableHash(value: string): string {
  return stableHash32(value, 2166136261).toString(36);
}

/** Deterministic base32hex token for provider IDs that restrict their alphabet. */
export function stableBase32HexToken(value: string): string {
  return [2166136261, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed, index) => stableHash32(`${index}:\u0000${value}`, seed).toString(32).padStart(7, "0"))
    .join("");
}

export function temporalSpec(kind: CalendarTemporalKind, timeZone?: string): CalendarTemporalSpec {
  return kind === "zoned" ? { kind, timeZone: timeZone ?? "UTC" } : { kind };
}

export function withoutNullishEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

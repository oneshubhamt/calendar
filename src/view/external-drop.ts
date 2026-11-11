import type {
  CalendarId,
  CalendarItemKind,
  CalendarMetadata,
  CalendarMetadataValue,
  CalendarTemporalForm,
} from "../core/types.js";
import type { CalendarSelection } from "./types.js";

export const CALENDAR_EXTERNAL_DROP_MIME = "application/x-director-calendar-item+json";

const MAX_TITLE_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 65_536;
const MAX_ID_LENGTH = 512;
const MAX_KIND_LENGTH = 120;
const MAX_METADATA_DEPTH = 12;
const MAX_METADATA_NODES = 4_096;
const MAX_METADATA_STRING_LENGTH = 65_536;
const MAX_METADATA_KEY_LENGTH = 256;
const MAX_DECODER_TYPES = 16;
const MAX_MIME_LENGTH = 256;
const MIME_TYPE = /^[A-Za-z0-9!#const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
^_.+-]+\/[A-Za-z0-9!#const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
^_.+-]+$/u;
const EXTERNAL_TEMPLATE_KEYS = new Set([
  "title",
  "calendarId",
  "description",
  "location",
  "kind",
  "durationMinutes",
  "durationDays",
  "temporalForm",
  "metadata",
]);

export interface CalendarExternalDropTemplate {
  readonly title: string;
  readonly calendarId?: CalendarId | undefined;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly kind?: CalendarItemKind | undefined;
  /** Timed-target duration override. Omitted means use the target selection duration. */
  readonly durationMinutes?: number | undefined;
  /** All-day-target duration override. Omitted means use the target selection day span. */
  readonly durationDays?: number | undefined;
  /** Point is supported only on timed targets. */
  readonly temporalForm?: CalendarTemporalForm | undefined;
  readonly metadata?: CalendarMetadata | undefined;
}

export interface CalendarExternalDropDecoder {
  /**
   * MIME types this decoder owns. Declaring types is required because browsers may
   * hide DataTransfer bytes during dragover even though type names remain visible.
   */
  readonly types: readonly string[];
  /** Must synchronously decode and return owned/template-like data. */
  decode(dataTransfer: DataTransfer): CalendarExternalDropTemplate | null | undefined;
}

export interface ResolvedCalendarExternalDropDecoder {
  readonly types: readonly string[];
  decode(dataTransfer: DataTransfer): CalendarExternalDropTemplate | null | undefined;
}

function boundedRequiredText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function boundedOptionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= max ? (text || undefined) : null;
}

function positiveInteger(value: unknown, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= max ? Number(value) : null;
}

function ownMetadata(value: unknown): CalendarMetadata | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seen = new WeakSet<object>();
  let nodes = 0;

  const clone = (current: unknown, depth: number, inObject: boolean): CalendarMetadataValue | undefined => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) throw new Error("metadata limit exceeded");
    if (current === undefined) {
      if (inObject) return undefined;
      throw new Error("undefined array value");
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("non-finite metadata number");
      return current;
    }
    if (typeof current === "string") {
      if (current.length > MAX_METADATA_STRING_LENGTH) throw new Error("metadata string too long");
      return current;
    }
    if (typeof current !== "object") throw new Error("unsupported metadata value");
    if (seen.has(current)) throw new Error("metadata cycle");
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new Error("metadata object must be plain");
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map(entry => {
          const owned = clone(entry, depth + 1, false);
          if (owned === undefined) throw new Error("undefined array value");
          return owned;
        });
      }
      const output = Object.create(null) as Record<string, CalendarMetadataValue>;
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (!key || key.length > MAX_METADATA_KEY_LENGTH) throw new Error("metadata key is invalid");
        const owned = clone(entry, depth + 1, true);
        if (owned !== undefined) output[key] = owned;
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };

  try {
    return clone(value, 0, true) as CalendarMetadata;
  } catch {
    return null;
  }
}

/** Own and validate untrusted template-like data. Invalid input returns undefined. */
export function normalizeCalendarExternalDropTemplate(value: unknown): CalendarExternalDropTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !EXTERNAL_TEMPLATE_KEYS.has(key))) return undefined;
  const title = boundedRequiredText(raw.title, MAX_TITLE_LENGTH);
  const calendarId = boundedOptionalText(raw.calendarId, MAX_ID_LENGTH);
  const description = boundedOptionalText(raw.description, MAX_TEXT_LENGTH);
  const location = boundedOptionalText(raw.location, MAX_TEXT_LENGTH);
  const kind = boundedOptionalText(raw.kind, MAX_KIND_LENGTH);
  const durationMinutes = positiveInteger(raw.durationMinutes, 7 * 24 * 60);
  const durationDays = positiveInteger(raw.durationDays, 366);
  const temporalForm = raw.temporalForm === undefined
    ? undefined
    : ["interval", "point"].includes(String(raw.temporalForm))
      ? raw.temporalForm as CalendarTemporalForm
      : null;
  const metadata = ownMetadata(raw.metadata);

  if (
    !title
    || calendarId === null
    || description === null
    || location === null
    || kind === null
    || durationMinutes === null
    || durationDays === null
    || temporalForm === null
    || metadata === null
  ) return undefined;

  return Object.freeze({
    title,
    ...(calendarId ? { calendarId } : {}),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(kind ? { kind } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(durationDays !== undefined ? { durationDays } : {}),
    ...(temporalForm !== undefined ? { temporalForm } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

/** Write the standard Calendar external-drop payload to an arbitrary DOM drag source. */
export function setCalendarExternalDropData(
  dataTransfer: DataTransfer,
  template: CalendarExternalDropTemplate,
): void {
  const normalized = normalizeCalendarExternalDropTemplate(template);
  if (!normalized) throw new TypeError("Calendar external-drop template is invalid");
  dataTransfer.setData(CALENDAR_EXTERNAL_DROP_MIME, JSON.stringify(normalized));
  dataTransfer.effectAllowed = "copy";
}

/** Decode only Calendar's standard external-drop MIME payload. Malformed payloads fail closed. */
export function decodeCalendarExternalDropData(
  dataTransfer: DataTransfer | null,
): CalendarExternalDropTemplate | undefined {
  if (!dataTransfer || !dataTransferHasType(dataTransfer, CALENDAR_EXTERNAL_DROP_MIME)) return undefined;
  let text = "";
  try {
    text = dataTransfer.getData(CALENDAR_EXTERNAL_DROP_MIME);
  } catch {
    return undefined;
  }
  if (!text || text.length > 262_144) return undefined;
  try {
    return normalizeCalendarExternalDropTemplate(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function dataTransferHasType(dataTransfer: DataTransfer | null, type: string): boolean {
  if (!dataTransfer) return false;
  const expected = type.trim().toLowerCase();
  if (!expected) return false;
  try {
    return Array.from(dataTransfer.types ?? []).some(candidate => candidate.toLowerCase() === expected);
  } catch {
    return false;
  }
}

export function resolveCalendarExternalDropDecoder(
  decoder: CalendarExternalDropDecoder | undefined,
): ResolvedCalendarExternalDropDecoder | undefined {
  if (decoder === undefined) return undefined;
  if (!decoder || typeof decoder !== "object" || typeof decoder.decode !== "function" || !Array.isArray(decoder.types)) {
    throw new TypeError("Calendar external-drop decoder is invalid");
  }
  const types = [...new Set(decoder.types.map(type => {
    const text = boundedRequiredText(type, MAX_MIME_LENGTH)?.toLowerCase();
    return text && MIME_TYPE.test(text) ? text : undefined;
  }))];
  if (
    types.length === 0
    || types.length > MAX_DECODER_TYPES
    || types.some(type => type === undefined)
  ) throw new TypeError("Calendar external-drop decoder MIME types are invalid");
  return Object.freeze({
    types: Object.freeze(types as string[]),
    decode: decoder.decode.bind(decoder),
  });
}

export interface CalendarExternalDropTargetActions {
  canAcceptExternalDrop(dataTransfer: DataTransfer | null): boolean;
  dropExternal(dataTransfer: DataTransfer | null, selection: CalendarSelection): Promise<boolean>;
}

/**
 * Bind one Calendar-owned drop target. Hover checks MIME types only; payload decoding
 * remains deferred until drop, where Calendar synchronously owns the payload first.
 */
export function bindCalendarExternalDropTarget(
  element: HTMLElement,
  resolveSelection: (event: DragEvent) => CalendarSelection | undefined,
  actions: CalendarExternalDropTargetActions,
): () => void {
  const clear = () => element.classList.remove("is-external-drop-target");
  const dragOver = (event: DragEvent) => {
    if (!actions.canAcceptExternalDrop(event.dataTransfer)) {
      clear();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    element.classList.add("is-external-drop-target");
  };
  const dragLeave = (event: DragEvent) => {
    const related = event.relatedTarget;
    if (related instanceof Node && element.contains(related)) return;
    clear();
  };
  const drop = (event: DragEvent) => {
    if (!actions.canAcceptExternalDrop(event.dataTransfer)) {
      clear();
      return;
    }
    const selection = resolveSelection(event);
    clear();
    if (!selection) return;
    event.preventDefault();
    void actions.dropExternal(event.dataTransfer, selection);
  };
  element.addEventListener("dragenter", dragOver);
  element.addEventListener("dragover", dragOver);
  element.addEventListener("dragleave", dragLeave);
  element.addEventListener("drop", drop);
  return () => {
    element.removeEventListener("dragenter", dragOver);
    element.removeEventListener("dragover", dragOver);
    element.removeEventListener("dragleave", dragLeave);
    element.removeEventListener("drop", drop);
    clear();
  };
}

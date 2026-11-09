import type { CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarRepository } from "../core/types.js";
import type { PracticeDeskAttempt, PracticeDeskDueCard, PracticeDeskPlannedMock } from "../adapters/practice-desk.js";
import { projectPracticeDesk } from "../adapters/practice-desk.js";

export const PRACTICE_DESK_BRIDGE_DECISION = Object.freeze({
  mode: "explicit-portable-artifact" as const,
  reason: "Practice Desk currently runs from file:// and cannot share IndexedDB or BroadcastChannel state with the hosted Study Director origin. Cross-origin postMessage from an opaque file origin is deliberately not used as a durable trust boundary.",
  upgradePath: "If Practice Desk later moves to the same trusted HTTPS origin, replace the artifact transport with a direct adapter or same-origin BroadcastChannel while preserving this payload contract.",
});

export interface PracticeDeskCalendarBridgePayload {
  readonly attempts?: readonly PracticeDeskAttempt[];
  readonly dueCards?: readonly PracticeDeskDueCard[];
  readonly plannedMocks?: readonly PracticeDeskPlannedMock[];
}

export interface PracticeDeskCalendarBridgeEnvelope {
  readonly format: "director-calendar.practice-bridge";
  readonly version: 1;
  readonly producer: "practice-desk" | "study-director";
  readonly exportedAt: string;
  readonly payload: PracticeDeskCalendarBridgePayload;
}

const MAX_RECORDS = 50_000;
const MAX_TEXT = 1_000;

function finiteDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedText(value: unknown, required = true): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT && (!required || value.length > 0);
}

function assertArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error(`${label} is invalid or exceeds the bridge limit.`);
}

export function createPracticeDeskBridge(
  producer: PracticeDeskCalendarBridgeEnvelope["producer"],
  payload: PracticeDeskCalendarBridgePayload,
  exportedAt = new Date().toISOString(),
): PracticeDeskCalendarBridgeEnvelope {
  if (!finiteDate(exportedAt)) throw new Error("Bridge export timestamp is invalid.");
  return { format: "director-calendar.practice-bridge", version: 1, producer, exportedAt, payload };
}

export function encodePracticeDeskBridge(envelope: PracticeDeskCalendarBridgeEnvelope): string {
  validatePracticeDeskBridge(envelope);
  return JSON.stringify(envelope);
}

export function decodePracticeDeskBridge(text: string): PracticeDeskCalendarBridgeEnvelope {
  if (typeof text !== "string" || text.length > 32 * 1024 * 1024) throw new Error("Practice Desk bridge file is too large.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Practice Desk bridge file is not valid JSON."); }
  return validatePracticeDeskBridge(parsed);
}

export function validatePracticeDeskBridge(value: unknown): PracticeDeskCalendarBridgeEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Practice Desk bridge envelope is invalid.");
  const raw = value as Record<string, unknown>;
  if (raw.format !== "director-calendar.practice-bridge" || raw.version !== 1 || (raw.producer !== "practice-desk" && raw.producer !== "study-director") || !finiteDate(raw.exportedAt)) {
    throw new Error("Unsupported Practice Desk bridge envelope.");
  }
  if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) throw new Error("Practice Desk bridge payload is invalid.");
  const payload = raw.payload as Record<string, unknown>;
  if (payload.attempts !== undefined) {
    assertArray(payload.attempts, "Bridge attempts");
    for (const value of payload.attempts) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge attempt is invalid.");
      const row = value as Record<string, unknown>;
      if (!boundedText(row.id) || !boundedText(row.examId) || !boundedText(row.paperId) || (row.title !== undefined && !boundedText(row.title, false)) ||
          !(finiteTimestamp(row.startedAt) || finiteDate(row.startedAt)) || !(row.finishedAt === null || finiteTimestamp(row.finishedAt)) ||
          (row.elapsedMs !== undefined && (typeof row.elapsedMs !== "number" || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0))) throw new Error("Bridge attempt fields are invalid.");
    }
  }
  if (payload.dueCards !== undefined) {
    assertArray(payload.dueCards, "Bridge due cards");
    for (const value of payload.dueCards) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge due card is invalid.");
      const row = value as Record<string, unknown>;
      if (!boundedText(row.id) || !boundedText(row.examId) || !boundedText(row.paperId) || !boundedText(row.title) || !finiteDate(row.dueAt) ||
          (row.topic !== undefined && !boundedText(row.topic, false))) throw new Error("Bridge due-card fields are invalid.");
    }
  }
  if (payload.plannedMocks !== undefined) {
    assertArray(payload.plannedMocks, "Bridge planned mocks");
    for (const value of payload.plannedMocks) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge planned mock is invalid.");
      const row = value as Record<string, unknown>;
      if (!boundedText(row.id) || !boundedText(row.examId) || !boundedText(row.paperId) || !boundedText(row.title) || !finiteDate(row.start) ||
          typeof row.durationMinutes !== "number" || !Number.isFinite(row.durationMinutes) || row.durationMinutes <= 0 || row.durationMinutes > 10_080) throw new Error("Bridge planned-mock fields are invalid.");
    }
  }
  return value as PracticeDeskCalendarBridgeEnvelope;
}


export class PracticeDeskBridgeProjection implements CalendarProjectionProvider {
  public readonly id = "practice-desk-bridge";
  public constructor(private envelope: PracticeDeskCalendarBridgeEnvelope) { validatePracticeDeskBridge(envelope); }
  public replace(envelope: PracticeDeskCalendarBridgeEnvelope): void { this.envelope = validatePracticeDeskBridge(envelope); }
  public project(_range: CalendarRange): readonly CalendarItem[] {
    return projectPracticeDesk(this.envelope.payload);
  }
}

export function plannedMocksFromCalendar(repository: CalendarRepository): PracticeDeskPlannedMock[] {
  return repository.read().items
    .filter(item => item.calendarId === "practice-desk:plan" && item.metadata?.app === "practice-desk")
    .map(item => {
      const examId = item.metadata?.examId, paperId = item.metadata?.paperId;
      if (typeof examId !== "string" || typeof paperId !== "string") throw new Error(`Scheduled Practice Desk item ${item.id} is missing source identity.`);
      return {
        id: item.id, examId, paperId, title: item.title, start: item.start,
        durationMinutes: Math.max(1, Math.round((Date.parse(item.end) - Date.parse(item.start)) / 60_000)),
      };
    });
}

export function createStudyDirectorPracticeBridge(repository: CalendarRepository, exportedAt = new Date().toISOString()): PracticeDeskCalendarBridgeEnvelope {
  return createPracticeDeskBridge("study-director", { plannedMocks: plannedMocksFromCalendar(repository) }, exportedAt);
}

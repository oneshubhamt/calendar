import type { CalendarItem, CalendarItemId, CalendarMetadata, CalendarMetadataValue, ISODateTime } from "../core/types.js";
import { canonicalValueString } from "../core/canonical-value.js";

export type ExternalCalendarProvider = string;
export type CalendarSyncMode = "overlay" | "import" | "publish" | "two-way";
export type SyncConflictPolicy = "manual" | "prefer-local" | "prefer-remote";
export type SyncLinkStatus = "clean" | "pending-local" | "pending-remote" | "conflict" | "deleted";

export interface ExternalEventIdentity {
  readonly provider: ExternalCalendarProvider;
  readonly connectionId: string;
  readonly externalCalendarId: string;
  readonly eventId: string;
  readonly iCalUid?: string | undefined;
  readonly recurringEventId?: string | undefined;
  readonly originalStart?: string | undefined;
  readonly etag?: string | undefined;
  readonly sequence?: number | undefined;
  readonly updatedAt?: ISODateTime | undefined;
}

export interface ExternalEventSnapshot {
  readonly identity: ExternalEventIdentity;
  readonly item?: CalendarItem | undefined;
  readonly deleted: boolean;
  readonly fingerprint: string;
}

export interface CalendarSyncLink {
  readonly localItemId: CalendarItemId;
  readonly identity: ExternalEventIdentity;
  readonly baseLocalFingerprint: string;
  readonly baseRemoteFingerprint: string;
  /** Last canonical remote projection, used to fold incremental recurring-instance changes without refetching the entire series. */
  readonly baseRemoteItem?: CalendarItem | undefined;
  readonly status: SyncLinkStatus;
  readonly lastSyncedAt: ISODateTime;
}

export interface CalendarSyncConnectionState {
  readonly provider: ExternalCalendarProvider;
  readonly connectionId: string;
  readonly mode: CalendarSyncMode;
  readonly externalCalendarId: string;
  readonly localCalendarId: string;
  readonly syncToken?: string | undefined;
  readonly links: readonly CalendarSyncLink[];
  readonly lastFullSyncAt?: ISODateTime | undefined;
  readonly lastIncrementalSyncAt?: ISODateTime | undefined;
}

export interface SyncConflict {
  readonly id: string;
  readonly connectionId: string;
  readonly localItemId: CalendarItemId;
  readonly identity: ExternalEventIdentity;
  readonly reason: "both-modified" | "local-modified-remote-deleted" | "remote-modified-local-deleted" | "precondition-failed";
  readonly local?: CalendarItem | undefined;
  readonly remote?: ExternalEventSnapshot | undefined;
  readonly detectedAt: ISODateTime;
}

export interface SyncStateStore {
  read(connectionId: string): Promise<CalendarSyncConnectionState | null> | CalendarSyncConnectionState | null;
  write(state: CalendarSyncConnectionState): Promise<void> | void;
  remove(connectionId: string): Promise<void> | void;
}

export class MemorySyncStateStore implements SyncStateStore {
  private readonly states = new Map<string, CalendarSyncConnectionState>();
  public read(connectionId: string): CalendarSyncConnectionState | null {
    const state = this.states.get(connectionId);
    return state ? structuredClone(state) : null;
  }
  public write(state: CalendarSyncConnectionState): void { this.states.set(state.connectionId, structuredClone(state)); }
  public remove(connectionId: string): void { this.states.delete(connectionId); }
}

export interface SyncDecision {
  readonly action: "none" | "rebase" | "apply-remote" | "push-local" | "delete-local" | "delete-remote" | "conflict";
  readonly conflict?: SyncConflict | undefined;
}

export function fingerprintCalendarItem(item: CalendarItem | undefined): string {
  if (!item) return "<deleted>";
  return canonicalValueString({
    calendarId: item.calendarId,
    title: item.title,
    description: item.description ?? null,
    location: item.location ?? null,
    start: item.start,
    end: item.end,
    allDay: item.allDay ?? false,
    precision: item.precision ?? null,
    temporal: item.temporal ?? null,
    kind: item.kind,
    recurrence: item.recurrence ?? null,
    reminders: item.reminders ?? null,
  });
}

export function decideSync(
  link: CalendarSyncLink,
  local: CalendarItem | undefined,
  remote: ExternalEventSnapshot | undefined,
  policy: SyncConflictPolicy = "manual",
  now: ISODateTime = new Date().toISOString(),
): SyncDecision {
  const localFingerprint = fingerprintCalendarItem(local);
  const remoteFingerprint = remote?.fingerprint ?? "<deleted>";
  const localChanged = localFingerprint !== link.baseLocalFingerprint;
  const remoteChanged = remoteFingerprint !== link.baseRemoteFingerprint;
  const remoteDeleted = !remote || remote.deleted;
  const localDeleted = !local;

  // A failed checkpoint can leave both sides already converged while the persisted
  // baselines still describe the older state. Rebase that stale checkpoint instead
  // of manufacturing a both-modified conflict on retry.
  if ((localChanged || remoteChanged) && localFingerprint === remoteFingerprint) return { action: "rebase" };
  if (!localChanged && !remoteChanged) return { action: "none" };
  if (localDeleted && remoteDeleted) return { action: "none" };
  if (localDeleted && remoteChanged && !remoteDeleted) {
    if (policy === "prefer-local") return { action: "delete-remote" };
    if (policy === "prefer-remote") return { action: "apply-remote" };
    return { action: "conflict", conflict: conflict(link, local, remote, "remote-modified-local-deleted", now) };
  }
  if (remoteDeleted && localChanged && !localDeleted) {
    if (policy === "prefer-local") return { action: "push-local" };
    if (policy === "prefer-remote") return { action: "delete-local" };
    return { action: "conflict", conflict: conflict(link, local, remote, "local-modified-remote-deleted", now) };
  }
  if (localChanged && remoteChanged) {
    if (policy === "prefer-local") return { action: "push-local" };
    if (policy === "prefer-remote") return { action: "apply-remote" };
    return { action: "conflict", conflict: conflict(link, local, remote, "both-modified", now) };
  }
  if (remoteChanged) return remoteDeleted ? { action: "delete-local" } : { action: "apply-remote" };
  if (localChanged) return { action: "push-local" };
  return { action: "none" };
}

export interface CalendarInteropMetadata {
  readonly [key: string]: CalendarMetadataValue;
  readonly provider: ExternalCalendarProvider;
  readonly connectionId: string;
  readonly externalCalendarId: string;
  readonly eventId: string;
  readonly iCalUid?: string;
  readonly recurringEventId?: string;
  readonly originalStart?: string;
  readonly etag?: string;
  readonly sequence?: number;
  readonly updatedAt?: ISODateTime;
  readonly reminderMode?: string;
  readonly transparency?: string;
  readonly fingerprint?: string;
}

export const CALENDAR_INTEROP_METADATA_KEY = "calendarInterop" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function calendarInteropMetadata(itemOrMetadata: CalendarItem | CalendarMetadata | undefined): CalendarInteropMetadata | null {
  const candidate = itemOrMetadata as CalendarItem | undefined;
  const isItem = Boolean(candidate && typeof candidate.id === "string" && typeof candidate.calendarId === "string" && typeof candidate.start === "string" && typeof candidate.end === "string");
  const metadata: CalendarMetadata | undefined = isItem ? candidate?.metadata : itemOrMetadata as CalendarMetadata | undefined;
  const raw = asRecord(metadata?.[CALENDAR_INTEROP_METADATA_KEY]);
  if (!raw || typeof raw.provider !== "string" || typeof raw.connectionId !== "string" || typeof raw.externalCalendarId !== "string" || typeof raw.eventId !== "string") return null;
  return {
    provider: raw.provider, connectionId: raw.connectionId, externalCalendarId: raw.externalCalendarId, eventId: raw.eventId,
    ...(typeof raw.iCalUid === "string" ? { iCalUid: raw.iCalUid } : {}),
    ...(typeof raw.recurringEventId === "string" ? { recurringEventId: raw.recurringEventId } : {}),
    ...(typeof raw.originalStart === "string" ? { originalStart: raw.originalStart } : {}),
    ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
    ...(typeof raw.sequence === "number" ? { sequence: raw.sequence } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.reminderMode === "string" ? { reminderMode: raw.reminderMode } : {}),
    ...(typeof raw.transparency === "string" ? { transparency: raw.transparency } : {}),
    ...(typeof raw.fingerprint === "string" ? { fingerprint: raw.fingerprint } : {}),
  };
}

export function linkedExternalMetadata(identity: ExternalEventIdentity, extras: Partial<Pick<CalendarInteropMetadata, "reminderMode" | "transparency" | "fingerprint">> = {}): NonNullable<CalendarItem["metadata"]> {
  const interop: CalendarInteropMetadata = {
    provider: identity.provider,
    connectionId: identity.connectionId,
    externalCalendarId: identity.externalCalendarId,
    eventId: identity.eventId,
    ...(identity.iCalUid ? { iCalUid: identity.iCalUid } : {}),
    ...(identity.recurringEventId ? { recurringEventId: identity.recurringEventId } : {}),
    ...(identity.originalStart ? { originalStart: identity.originalStart } : {}),
    ...(identity.etag ? { etag: identity.etag } : {}),
    ...(identity.sequence !== undefined ? { sequence: identity.sequence } : {}),
    ...(identity.updatedAt ? { updatedAt: identity.updatedAt } : {}),
    ...extras,
  };
  return { [CALENDAR_INTEROP_METADATA_KEY]: interop };
}

export function externalIdentityFromMetadata(itemOrMetadata: CalendarItem | CalendarMetadata | undefined): ExternalEventIdentity | null {
  const value = calendarInteropMetadata(itemOrMetadata);
  if (!value) return null;
  return {
    provider: value.provider, connectionId: value.connectionId, externalCalendarId: value.externalCalendarId, eventId: value.eventId,
    ...(value.iCalUid ? { iCalUid: value.iCalUid } : {}), ...(value.recurringEventId ? { recurringEventId: value.recurringEventId } : {}),
    ...(value.originalStart ? { originalStart: value.originalStart } : {}), ...(value.etag ? { etag: value.etag } : {}),
    ...(value.sequence !== undefined ? { sequence: value.sequence } : {}), ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

export function mergeSyncMetadata(item: CalendarItem, identity: ExternalEventIdentity, extras: Partial<Pick<CalendarInteropMetadata, "reminderMode" | "transparency" | "fingerprint">> = {}): CalendarItem {
  return { ...item, metadata: { ...(item.metadata ?? {}), ...linkedExternalMetadata(identity, extras) } };
}

export function linkAfterSync(
  localItem: CalendarItem,
  remote: ExternalEventSnapshot,
  now: ISODateTime = new Date().toISOString(),
): CalendarSyncLink {
  return {
    localItemId: localItem.id,
    identity: remote.identity,
    baseLocalFingerprint: fingerprintCalendarItem(localItem),
    baseRemoteFingerprint: remote.fingerprint,
    ...(remote.item ? { baseRemoteItem: remote.item } : {}),
    status: "clean",
    lastSyncedAt: now,
  };
}

function conflict(
  link: CalendarSyncLink,
  local: CalendarItem | undefined,
  remote: ExternalEventSnapshot | undefined,
  reason: SyncConflict["reason"],
  detectedAt: ISODateTime,
): SyncConflict {
  return {
    id: `sync-conflict:${link.identity.provider}:${link.identity.connectionId}:${link.identity.eventId}:${Date.parse(detectedAt)}`,
    connectionId: link.identity.connectionId,
    localItemId: link.localItemId,
    identity: link.identity,
    reason,
    ...(local ? { local } : {}),
    ...(remote ? { remote } : {}),
    detectedAt,
  };
}


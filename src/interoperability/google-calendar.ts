import type {
  CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarRecurrence, CalendarReminder,
  CalendarRepository, CalendarTemporalKind, ISODateTime,
} from "../core/types.js";
import { plainToInstant, parsePlainDateTime } from "../core/temporal.js";
import { parseRRule, serializeRRule } from "./ics.js";
import {
  calendarInteropMetadata, decideSync, externalIdentityFromMetadata, fingerprintCalendarItem, linkAfterSync, linkedExternalMetadata, mergeSyncMetadata,
  type CalendarSyncConnectionState, type CalendarSyncLink, type CalendarSyncMode,
  type ExternalEventIdentity, type ExternalEventSnapshot, type SyncConflict, type SyncConflictPolicy,
  type SyncStateStore,
} from "./sync.js";
import { stableHash, temporalSpec, withoutNullishEntries } from "./internal.js";

export interface GoogleEventDateTime {
  readonly date?: string | undefined;
  readonly dateTime?: string | undefined;
  readonly timeZone?: string | undefined;
}
export interface GoogleEventReminder { readonly method: "email" | "popup"; readonly minutes: number; }
export interface GoogleCalendarEvent {
  readonly id?: string | undefined;
  readonly iCalUID?: string | undefined;
  readonly etag?: string | undefined;
  readonly status?: "confirmed" | "tentative" | "cancelled" | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly start?: GoogleEventDateTime | undefined;
  readonly end?: GoogleEventDateTime | undefined;
  readonly recurrence?: readonly string[] | undefined;
  readonly recurringEventId?: string | undefined;
  readonly originalStartTime?: GoogleEventDateTime | undefined;
  readonly updated?: ISODateTime | undefined;
  readonly sequence?: number | undefined;
  readonly reminders?: { readonly useDefault?: boolean | undefined; readonly overrides?: readonly GoogleEventReminder[] | undefined } | undefined;
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>> | undefined; readonly shared?: Readonly<Record<string, string>> | undefined } | undefined;
  readonly transparency?: "opaque" | "transparent" | undefined;
}

export interface GoogleEventsPage {
  readonly items: readonly GoogleCalendarEvent[];
  readonly nextPageToken?: string | undefined;
  readonly nextSyncToken?: string | undefined;
}

export interface GoogleCalendarTransport {
  listEvents(request: {
    readonly calendarId: string;
    readonly pageToken?: string | undefined;
    readonly syncToken?: string | undefined;
    readonly timeMin?: string | undefined;
    readonly timeMax?: string | undefined;
    readonly singleEvents?: boolean | undefined;
    readonly showDeleted?: boolean | undefined;
  }): Promise<GoogleEventsPage>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent>;
  listInstances(calendarId: string, recurringEventId: string, pageToken?: string): Promise<GoogleEventsPage>;
  insertEvent(calendarId: string, event: GoogleCalendarEvent): Promise<GoogleCalendarEvent>;
  updateEvent(calendarId: string, eventId: string, event: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent>;
  patchEvent(calendarId: string, eventId: string, patch: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void>;
}

export interface GoogleAccessToken { readonly accessToken: string; readonly expiresAt?: number | undefined; }
export interface GoogleAccessTokenProvider { token(): Promise<GoogleAccessToken>; }

export class GoogleCalendarHttpError extends Error {
  public constructor(public readonly status: number, message: string, public readonly body?: string) { super(message); this.name = "GoogleCalendarHttpError"; }
}
export class GoogleSyncTokenExpiredError extends Error { public constructor() { super("Google Calendar sync token expired; a new full sync is required."); this.name = "GoogleSyncTokenExpiredError"; } }

export class GoogleCalendarRestTransport implements GoogleCalendarTransport {
  public constructor(private readonly tokens: GoogleAccessTokenProvider, private readonly fetcher: typeof fetch = fetch) {}

  public async listEvents(request: Parameters<GoogleCalendarTransport["listEvents"]>[0]): Promise<GoogleEventsPage> {
    const params = new URLSearchParams();
    if (request.pageToken) params.set("pageToken", request.pageToken);
    if (request.syncToken) params.set("syncToken", request.syncToken);
    if (request.timeMin) params.set("timeMin", request.timeMin);
    if (request.timeMax) params.set("timeMax", request.timeMax);
    if (request.singleEvents !== undefined) params.set("singleEvents", String(request.singleEvents));
    if (request.showDeleted !== undefined) params.set("showDeleted", String(request.showDeleted));
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(request.calendarId)}/events?${params}`, { method: "GET" });
    if (response.status === 410 && request.syncToken) throw new GoogleSyncTokenExpiredError();
    return parseJson<GoogleEventsPage>(response);
  }

  public async getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent> {
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "GET" });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async listInstances(calendarId: string, recurringEventId: string, pageToken?: string): Promise<GoogleEventsPage> {
    const params = new URLSearchParams(); if (pageToken) params.set("pageToken", pageToken);
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(recurringEventId)}/instances?${params}`, { method: "GET" });
    return parseJson<GoogleEventsPage>(response);
  }

  public async insertEvent(calendarId: string, event: GoogleCalendarEvent): Promise<GoogleCalendarEvent> {
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(event), headers: { "Content-Type": "application/json" } });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async updateEvent(calendarId: string, eventId: string, event: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PUT", body: JSON.stringify(event), headers });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async patchEvent(calendarId: string, eventId: string, patch: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(patch), headers });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (etag) headers["If-Match"] = etag;
    await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const token = await this.tokens.token();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    const response = await this.fetcher(url, { ...init, headers });
    if (!response.ok && response.status !== 410) throw new GoogleCalendarHttpError(response.status, `Google Calendar API request failed (${response.status}).`, await response.text());
    return response;
  }
}

export interface GoogleIdentityServicesOptions {
  readonly clientId: string;
  readonly scope: string;
  readonly prompt?: "" | "consent" | "select_account";
}

/** Browser-only token provider for Google Identity Services. No client secret is used or stored. */
export function createGoogleIdentityServicesTokenProvider(options: GoogleIdentityServicesOptions): GoogleAccessTokenProvider {
  type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
  type TokenClient = { requestAccessToken: (request?: { prompt?: string }) => void };
  type GoogleGlobal = { accounts?: { oauth2?: { initTokenClient?: (input: { client_id: string; scope: string; callback: (response: TokenResponse) => void }) => TokenClient } } };
  let cached: GoogleAccessToken | null = null;
  let pending: Promise<GoogleAccessToken> | null = null;
  return {
    async token() {
      if (cached && (!cached.expiresAt || cached.expiresAt - Date.now() > 60_000)) return cached;
      if (pending) return pending;
      pending = new Promise<GoogleAccessToken>((resolve, reject) => {
        const google = (globalThis as { google?: GoogleGlobal }).google;
        const init = google?.accounts?.oauth2?.initTokenClient;
        if (!init) { reject(new Error("Google Identity Services is not available on this page.")); return; }
        const client = init({ client_id: options.clientId, scope: options.scope, callback: response => {
          pending = null;
          if (!response.access_token || response.error) { reject(new Error(response.error || "Google authorization failed.")); return; }
          cached = { accessToken: response.access_token, ...(response.expires_in ? { expiresAt: Date.now() + response.expires_in * 1000 } : {}) };
          resolve(cached);
        } });
        client.requestAccessToken({ prompt: options.prompt ?? "" });
      });
      return pending;
    },
  };
}

export const GOOGLE_CALENDAR_SCOPES = Object.freeze({
  overlay: "https://www.googleapis.com/auth/calendar.events.readonly",
  ownedEvents: "https://www.googleapis.com/auth/calendar.events.owned",
  allEvents: "https://www.googleapis.com/auth/calendar.events",
} as const);

export interface GoogleCalendarConnection {
  readonly id: string;
  readonly googleCalendarId: string;
  readonly localCalendarId: string;
  readonly mode: CalendarSyncMode;
  readonly conflictPolicy?: SyncConflictPolicy | undefined;
  /** Optional host mapping for pulled events. Defaults remain generic external/event values. */
  readonly importedKind?: CalendarItem["kind"] | undefined;
  readonly importedOwnership?: CalendarItem["ownership"] | undefined;
  readonly importedEditPolicy?: CalendarItem["editPolicy"] | undefined;
  readonly publishPredicate?: ((item: CalendarItem) => boolean) | undefined;
}

export interface GoogleSyncResult {
  readonly fullSync: boolean;
  readonly pulled: number;
  readonly pushed: number;
  readonly deletedLocal: number;
  readonly deletedRemote: number;
  readonly conflicts: readonly SyncConflict[];
  readonly warnings: readonly string[];
  readonly state: CalendarSyncConnectionState;
}

interface PullResult { readonly full: boolean; readonly events: ReadonlyMap<string, ExternalEventSnapshot>; readonly nextSyncToken: string; }

function isGooglePreconditionFailure(error: unknown): error is GoogleCalendarHttpError {
  return error instanceof GoogleCalendarHttpError && error.status === 412;
}

async function preconditionConflict(
  transport: GoogleCalendarTransport,
  connection: GoogleCalendarConnection,
  link: CalendarSyncLink,
  local: CalendarItem | undefined,
): Promise<SyncConflict> {
  let remote: ExternalEventSnapshot | undefined;
  try { remote = googleEventSnapshot(await transport.getEvent(connection.googleCalendarId, link.identity.eventId), connection, link.localItemId); }
  catch { remote = undefined; }
  const identity = remote?.identity ?? link.identity;
  return {
    id: `sync-conflict:google:${connection.id}:${link.identity.eventId}:precondition:${Date.now()}`,
    connectionId: connection.id,
    localItemId: link.localItemId,
    identity,
    reason: "precondition-failed",
    ...(local ? { local } : {}),
    ...(remote ? { remote } : {}),
    detectedAt: new Date().toISOString(),
  };
}

export class GoogleCalendarSyncAdapter {
  public constructor(
    private readonly transport: GoogleCalendarTransport,
    private readonly repository: CalendarRepository,
    private readonly states: SyncStateStore,
    private readonly connection: GoogleCalendarConnection,
  ) {}

  public async sync(): Promise<GoogleSyncResult> {
    let state = await this.states.read(this.connection.id) ?? initialState(this.connection);
    let pull: PullResult;
    try { pull = await this.pull(state); }
    catch (error) {
      if (!(error instanceof GoogleSyncTokenExpiredError)) throw error;
      state = { ...state, syncToken: undefined, links: state.links.map(link => ({ ...link, status: "pending-remote" as const })) };
      pull = await this.pull(state);
    }
    const links = new Map(state.links.map(link => [link.localItemId, link] as const));
    const remoteById = pull.events;
    let pulled = 0, pushed = 0, deletedLocal = 0, deletedRemote = 0;
    const conflicts: SyncConflict[] = [], warnings: string[] = [];
    const nextLinks: CalendarSyncLink[] = [];
    const snapshot = this.repository.read();
    const localById = new Map(snapshot.items.filter(item => item.calendarId === this.connection.localCalendarId).map(item => [item.id, item] as const));
    const linkedRemoteIds = new Set<string>();

    for (const link of state.links) {
      linkedRemoteIds.add(link.identity.eventId);
      const local = localById.get(link.localItemId);
      const changedRemote = remoteById.get(link.identity.eventId);
      if (!pull.full && !changedRemote) {
        if (!local) {
          if (canPush(this.connection.mode)) {
            try { await this.transport.deleteEvent(this.connection.googleCalendarId, link.identity.eventId, link.identity.etag); deletedRemote += 1; }
            catch (error) { if (!isGooglePreconditionFailure(error)) throw error; conflicts.push(await preconditionConflict(this.transport, this.connection, link, local)); nextLinks.push({ ...link, status: "conflict" }); }
          } else nextLinks.push(link);
        } else if (fingerprintCalendarItem(local) !== link.baseLocalFingerprint && canPush(this.connection.mode)) {
          try {
            const updated = await this.transport.patchEvent(this.connection.googleCalendarId, link.identity.eventId, itemToGoogleEvent(local), link.identity.etag);
            const exceptionWarnings = await syncReplacementExceptions(this.transport, this.connection.googleCalendarId, link.identity.eventId, local); warnings.push(...exceptionWarnings);
            const remote = googleEventSnapshot(updated, this.connection, local.id);
            nextLinks.push(linkAfterSync(mergeSyncMetadata(local, remote.identity), { ...remote, item: local, fingerprint: fingerprintCalendarItem(local) })); pushed += 1;
          } catch (error) {
            if (!isGooglePreconditionFailure(error)) throw error;
            conflicts.push(await preconditionConflict(this.transport, this.connection, link, local)); nextLinks.push({ ...link, status: "conflict" });
          }
        } else nextLinks.push(link);
        continue;
      }
      const remote = changedRemote ?? deletedSnapshot(link.identity);
      const decision = decideSync(link, local, remote, this.connection.conflictPolicy ?? "manual");
      if (decision.action === "none") { nextLinks.push(remote.deleted ? { ...link, status: "deleted" } : link); continue; }
      if (decision.action === "conflict") { if (decision.conflict) conflicts.push(decision.conflict); nextLinks.push({ ...link, status: "conflict" }); continue; }
      if (decision.action === "apply-remote" && remote.item && canPull(this.connection.mode)) {
        const item = remoteToLocal(remote, this.connection, link.localItemId);
        if (local) await this.repository.update(local.id, itemPatch(item)); else await this.repository.create(item);
        nextLinks.push(linkAfterSync(item, remote)); pulled += 1; continue;
      }
      if (decision.action === "delete-local" && local && canPull(this.connection.mode)) {
        await this.repository.remove(local.id); deletedLocal += 1; continue;
      }
      if (decision.action === "push-local" && local && canPush(this.connection.mode)) {
        try {
          const updated = await this.transport.patchEvent(this.connection.googleCalendarId, link.identity.eventId, itemToGoogleEvent(local), link.identity.etag);
          const exceptionWarnings = await syncReplacementExceptions(this.transport, this.connection.googleCalendarId, link.identity.eventId, local); warnings.push(...exceptionWarnings);
          const nextRemote = googleEventSnapshot(updated, this.connection, local.id);
          nextLinks.push(linkAfterSync(mergeSyncMetadata(local, nextRemote.identity), { ...nextRemote, item: local, fingerprint: fingerprintCalendarItem(local) })); pushed += 1;
        } catch (error) {
          if (!isGooglePreconditionFailure(error)) throw error;
          conflicts.push(await preconditionConflict(this.transport, this.connection, link, local)); nextLinks.push({ ...link, status: "conflict" });
        }
        continue;
      }
      if (decision.action === "delete-remote" && canPush(this.connection.mode)) {
        try { await this.transport.deleteEvent(this.connection.googleCalendarId, link.identity.eventId, link.identity.etag); deletedRemote += 1; }
        catch (error) { if (!isGooglePreconditionFailure(error)) throw error; conflicts.push(await preconditionConflict(this.transport, this.connection, link, local)); nextLinks.push({ ...link, status: "conflict" }); }
        continue;
      }
      nextLinks.push(link);
    }

    if (canPull(this.connection.mode)) for (const remote of remoteById.values()) {
      if (linkedRemoteIds.has(remote.identity.eventId) || remote.deleted || !remote.item || remote.identity.recurringEventId) continue;
      const existing = snapshot.items.find(item => { const identity = externalIdentityFromMetadata(item); return identity?.connectionId === this.connection.id && identity.eventId === remote.identity.eventId; });
      const local = remoteToLocal(remote, this.connection, existing?.id);
      if (existing) await this.repository.update(existing.id, itemPatch(local)); else await this.repository.create(local);
      nextLinks.push(linkAfterSync(local, remote)); pulled += 1;
    }

    if (canPush(this.connection.mode)) for (const local of snapshot.items) {
      const identity = externalIdentityFromMetadata(local);
      if (local.calendarId !== this.connection.localCalendarId || links.has(local.id) || identity?.connectionId === this.connection.id) continue;
      const publishable = this.connection.publishPredicate
        ? this.connection.publishPredicate(local)
        : local.editPolicy === "full";
      if (!publishable) continue;
      const created = await this.transport.insertEvent(this.connection.googleCalendarId, itemToGoogleEvent(local));
      if (!created.id) throw new Error("Google Calendar did not return an event id after insert.");
      const exceptionWarnings = await syncReplacementExceptions(this.transport, this.connection.googleCalendarId, created.id, local); warnings.push(...exceptionWarnings);
      const remote = googleEventSnapshot(created, this.connection, local.id);
      nextLinks.push(linkAfterSync(mergeSyncMetadata(local, remote.identity), { ...remote, item: local, fingerprint: fingerprintCalendarItem(local) })); pushed += 1;
    }

    const now = new Date().toISOString();
    const nextState: CalendarSyncConnectionState = {
      provider: "google", connectionId: this.connection.id, mode: this.connection.mode,
      externalCalendarId: this.connection.googleCalendarId, localCalendarId: this.connection.localCalendarId,
      // Do not advance past an unresolved manual conflict; replay the same incremental delta until the caller resolves it.
      syncToken: conflicts.length ? state.syncToken : pull.nextSyncToken, links: dedupeLinks(nextLinks),
      ...(pull.full ? { lastFullSyncAt: now } : { ...(state.lastFullSyncAt ? { lastFullSyncAt: state.lastFullSyncAt } : {}) }),
      lastIncrementalSyncAt: now,
    };
    await this.states.write(nextState);
    return { fullSync: pull.full, pulled, pushed, deletedLocal, deletedRemote, conflicts, warnings, state: nextState };
  }

  private async pull(state: CalendarSyncConnectionState): Promise<PullResult> {
    const syncToken = state.syncToken;
    let pageToken: string | undefined;
    let nextSyncToken = "";
    const raw: GoogleCalendarEvent[] = [];
    do {
      const page = await this.transport.listEvents({ calendarId: this.connection.googleCalendarId, ...(pageToken ? { pageToken } : {}), ...(syncToken ? { syncToken } : {}), showDeleted: true, singleEvents: false });
      raw.push(...page.items);
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    if (!nextSyncToken) throw new Error("Google Calendar sync response did not include nextSyncToken on the final page.");

    const events = new Map<string, ExternalEventSnapshot>();
    const instanceChanges = new Map<string, GoogleCalendarEvent[]>();
    for (const event of raw) {
      if (!event.id) continue;
      if (event.recurringEventId) {
        const list = instanceChanges.get(event.recurringEventId) ?? []; list.push(event); instanceChanges.set(event.recurringEventId, list);
      } else events.set(event.id, googleEventSnapshot(event, this.connection));
    }
    const baseByRemoteId = new Map(state.links.map(link => [link.identity.eventId, link.baseRemoteItem] as const));
    for (const [parentId, changes] of instanceChanges) {
      let parent = events.get(parentId);
      const prior = baseByRemoteId.get(parentId);
      if (!parent?.item && prior) parent = { identity: { provider: "google", connectionId: this.connection.id, externalCalendarId: this.connection.googleCalendarId, eventId: parentId }, item: prior, deleted: false, fingerprint: fingerprintCalendarItem(prior) };
      if (!parent?.item) {
        try { parent = googleEventSnapshot(await this.transport.getEvent(this.connection.googleCalendarId, parentId), this.connection); }
        catch { continue; }
      }
      if (parent.deleted || !parent.item) { events.set(parentId, parent); continue; }
      const baseItem = !syncToken ? parent.item : mergePriorExceptions(parent.item, prior);
      const item = applyGoogleInstanceChanges(baseItem, changes);
      events.set(parentId, { ...parent, item, fingerprint: fingerprintCalendarItem(item) });
    }
    // Incremental master updates omit unchanged detached instances; preserve their last known exception set.
    if (syncToken) for (const [eventId, snapshot] of events) {
      if (!snapshot.item || snapshot.deleted || instanceChanges.has(eventId)) continue;
      const prior = baseByRemoteId.get(eventId);
      if (prior) { const item = mergePriorExceptions(snapshot.item, prior); events.set(eventId, { ...snapshot, item, fingerprint: fingerprintCalendarItem(item) }); }
    }
    return { full: !syncToken, events, nextSyncToken };
  }
}

/** Read-only, range-bounded overlay. It does not persist sync tokens or mutate either side. */
export class GoogleCalendarOverlayProvider implements CalendarProjectionProvider {
  public readonly id: string;
  public constructor(private readonly transport: GoogleCalendarTransport, private readonly connectionId: string, private readonly googleCalendarId: string, private readonly calendarId: string) { this.id = `google-overlay:${connectionId}`; }
  public async project(range: CalendarRange): Promise<readonly CalendarItem[]> {
    const items: CalendarItem[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.transport.listEvents({ calendarId: this.googleCalendarId, ...(pageToken ? { pageToken } : {}), timeMin: range.start, timeMax: range.end, singleEvents: true, showDeleted: false });
      for (const event of page.items) {
        if (!event.id || event.status === "cancelled") continue;
        const snapshot = googleEventSnapshot(event, { id: this.connectionId, googleCalendarId: this.googleCalendarId, localCalendarId: this.calendarId, mode: "overlay" });
        if (snapshot.item) items.push(remoteToLocal(snapshot, { id: this.connectionId, googleCalendarId: this.googleCalendarId, localCalendarId: this.calendarId, mode: "overlay" }));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }
}

export function googleEventSnapshot(event: GoogleCalendarEvent, connection: GoogleCalendarConnection, localId?: string): ExternalEventSnapshot {
  const eventId = event.id ?? event.iCalUID ?? "unknown";
  const identity: ExternalEventIdentity = {
    provider: "google", connectionId: connection.id, externalCalendarId: connection.googleCalendarId, eventId,
    ...(event.iCalUID ? { iCalUid: event.iCalUID } : {}), ...(event.etag ? { etag: event.etag } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.originalStartTime ? { originalStart: googleDateValue(event.originalStartTime).value } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.updated ? { updatedAt: event.updated } : {}),
  };
  if (event.status === "cancelled") return { identity, deleted: true, fingerprint: "<deleted>" };
  const item = googleEventToCalendarItem(event, connection.localCalendarId, connection.id, localId, connection.googleCalendarId, {
    ...(connection.importedKind ? { kind: connection.importedKind } : {}),
    ...(connection.importedOwnership ? { ownership: connection.importedOwnership } : {}),
    editPolicy: connection.mode === "overlay" ? "readonly" : connection.importedEditPolicy ?? "full",
  });
  return { identity, item, deleted: false, fingerprint: fingerprintCalendarItem(item) };
}

export interface GoogleCalendarItemMapping {
  readonly kind?: CalendarItem["kind"];
  readonly ownership?: CalendarItem["ownership"];
  readonly editPolicy?: CalendarItem["editPolicy"];
}

export function googleEventToCalendarItem(event: GoogleCalendarEvent, calendarId: string, connectionId: string, localId?: string, externalCalendarId = calendarId, mapping: GoogleCalendarItemMapping = {}): CalendarItem {
  if (!event.id || !event.start || !event.end) throw new Error("Google event is missing id/start/end.");
  const start = googleDateValue(event.start), end = googleDateValue(event.end);
  const ruleLine = event.recurrence?.find(line => line.toUpperCase().startsWith("RRULE:"));
  const exdates = event.recurrence?.filter(line => line.toUpperCase().startsWith("EXDATE")) ?? [];
  const recurrence: CalendarRecurrence | undefined = ruleLine ? {
    rule: parseRRule(ruleLine.slice(ruleLine.indexOf(":") + 1), start.kind, start.timeZone),
    ...(exdates.length ? { exceptions: exdates.flatMap(line => parseGoogleExdate(line, start)).map(originalStart => ({ originalStart, cancelled: true })) } : {}),
  } : undefined;
  const reminders: CalendarReminder[] = event.reminders?.overrides?.map((reminder, index) => ({ id: `google-${index + 1}`, minutesBefore: reminder.minutes, channel: "external" as const })) ?? [];
  const googleReminderMode = event.reminders?.useDefault === true ? "default" : reminders.length ? "overrides" : "none";
  const identity: ExternalEventIdentity = {
    provider: "google", connectionId, externalCalendarId, eventId: event.id,
    ...(event.iCalUID ? { iCalUid: event.iCalUID } : {}), ...(event.etag ? { etag: event.etag } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...(event.updated ? { updatedAt: event.updated } : {}),
  };
  return {
    id: localId ?? `google:${stableHash(`${connectionId}|${event.id}`)}`,
    calendarId,
    title: event.summary ?? "Untitled event",
    ...(event.description ? { description: event.description } : {}), ...(event.location ? { location: event.location } : {}),
    start: start.value, end: end.value,
    allDay: start.kind === "date", precision: start.kind === "date" ? "date" : "minute", temporal: temporalSpec(start.kind, start.timeZone),
    kind: mapping.kind ?? "event", ownership: mapping.ownership ?? "external", editPolicy: mapping.editPolicy ?? "readonly",
    ...(recurrence ? { recurrence } : {}), ...(reminders.length ? { reminders } : {}),
    metadata: linkedExternalMetadata(identity, { transparency: event.transparency ?? "opaque", reminderMode: googleReminderMode }),
    ...(event.updated ? { updatedAt: event.updated } : {}),
  };
}

export function itemToGoogleEvent(item: CalendarItem): GoogleCalendarEvent {
  const start = itemTimeToGoogle(item.start, item), end = itemTimeToGoogle(item.end, item);
  const recurrence = item.recurrence ? [
    `RRULE:${serializeRRule(item.recurrence.rule, item)}`,
    ...googleExdateLines(item),
  ] : undefined;
  const overrides = (item.reminders ?? []).filter(reminder => reminder.enabled !== false && reminder.channel === "external").slice(0, 5).map(reminder => ({ method: "popup" as const, minutes: Math.max(0, Math.min(40320, Math.round(reminder.minutesBefore))) }));
  const interop = calendarInteropMetadata(item);
  const useGoogleDefaults = interop?.reminderMode === "default" && overrides.length === 0;
  const externalPrivate: Record<string, string> = { calendarItemId: item.id };
  return {
    summary: item.title, ...(item.description ? { description: item.description } : {}), ...(item.location ? { location: item.location } : {}),
    start, end, ...(recurrence?.length ? { recurrence } : {}),
    reminders: overrides.length ? { useDefault: false, overrides } : { useDefault: useGoogleDefaults },
    extendedProperties: { private: externalPrivate },
    ...(interop?.sequence !== undefined ? { sequence: interop.sequence } : {}),
    ...(interop?.transparency === "transparent" || interop?.transparency === "opaque" ? { transparency: interop.transparency } : {}),
  };
}

function mergePriorExceptions(fresh: CalendarItem, prior: CalendarItem | undefined): CalendarItem {
  if (!fresh.recurrence || !prior?.recurrence?.exceptions?.length) return fresh;
  const freshExceptions = fresh.recurrence.exceptions ?? [];
  const byOriginal = new Map([...prior.recurrence.exceptions, ...freshExceptions].map(exception => [exception.originalStart, exception] as const));
  return { ...fresh, recurrence: { ...fresh.recurrence, exceptions: [...byOriginal.values()] } };
}

function applyGoogleInstanceChanges(parent: CalendarItem, changes: readonly GoogleCalendarEvent[]): CalendarItem {
  if (!parent.recurrence) return parent;
  const exceptions = new Map((parent.recurrence.exceptions ?? []).map(exception => [exception.originalStart, exception] as const));
  for (const event of changes) {
    if (!event.originalStartTime) continue;
    const originalStart = googleDateValue(event.originalStartTime).value;
    if (event.status === "cancelled") { exceptions.set(originalStart, { originalStart, cancelled: true }); continue; }
    if (!event.start || !event.end) continue;
    const replacement = googleEventToCalendarItem(
      { ...event, id: event.id ?? `${event.recurringEventId}:${originalStart}` },
      parent.calendarId,
      calendarInteropMetadata(parent)?.connectionId ?? "google-instance",
      undefined,
      calendarInteropMetadata(parent)?.externalCalendarId ?? parent.calendarId,
    );
    exceptions.set(originalStart, { originalStart, replacement: {
      title: replacement.title,
      ...(replacement.description !== undefined ? { description: replacement.description } : {}),
      ...(replacement.location !== undefined ? { location: replacement.location } : {}),
      start: replacement.start, end: replacement.end, allDay: replacement.allDay, precision: replacement.precision, temporal: replacement.temporal,
      ...(replacement.reminders !== undefined ? { reminders: replacement.reminders } : {}),
    } });
  }
  return { ...parent, recurrence: { ...parent.recurrence, exceptions: [...exceptions.values()] } };
}

function googleDateValue(value: GoogleEventDateTime): { value: string; kind: CalendarTemporalKind; timeZone?: string } {
  if (value.date) return { value: value.date, kind: "date" };
  if (!value.dateTime) throw new Error("Google event date-time is missing date/dateTime.");
  if (value.timeZone) return { value: value.dateTime, kind: "zoned", timeZone: value.timeZone };
  return { value: value.dateTime, kind: "instant" };
}

function itemTimeToGoogle(value: string, item: CalendarItem): GoogleEventDateTime {
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? "instant" : "floating");
  if (kind === "date") return { date: value.slice(0, 10) };
  if (kind === "zoned") {
    const timeZone = item.temporal?.timeZone;
    if (!timeZone) throw new Error(`Zoned item ${item.id} is missing a time zone.`);
    if (/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return { dateTime: value, timeZone };
    const epoch = plainToInstant(parsePlainDateTime(value.slice(0, 19)), timeZone, item.temporal?.disambiguation ?? "compatible");
    return { dateTime: new Date(epoch).toISOString(), timeZone };
  }
  if (kind === "floating") return { dateTime: value };
  return { dateTime: new Date(value).toISOString() };
}

function parseGoogleExdate(line: string, start: ReturnType<typeof googleDateValue>): string[] {
  const colon = line.indexOf(":"); if (colon < 0) return [];
  const params = line.slice(0, colon); const values = line.slice(colon + 1).split(",");
  const date = /VALUE=DATE/i.test(params) || start.kind === "date";
  return values.map(value => date ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : basicToIso(value));
}

function googleExdateLines(item: CalendarItem): string[] {
  const cancelled = item.recurrence?.exceptions?.filter(exception => exception.cancelled).map(exception => exception.originalStart) ?? [];
  if (!cancelled.length) return [];
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return [`EXDATE;VALUE=DATE:${cancelled.map(value => value.slice(0, 10).replace(/-/g, "")).join(",")}`];
  if (kind === "zoned") return [`EXDATE;TZID=${item.temporal?.timeZone ?? "UTC"}:${cancelled.map(value => localBasic(value, item.temporal?.timeZone ?? "UTC")).join(",")}`];
  if (kind === "floating") return [`EXDATE:${cancelled.map(localBasicRaw).join(",")}`];
  return [`EXDATE:${cancelled.map(value => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")).join(",")}`];
}

function localBasic(value: string, zone: string): string {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return localBasicRaw(value);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}T${map.hour}${map.minute}${map.second}`;
}
function localBasicRaw(value: string): string { return value.slice(0, 19).replace(/[-:]/g, ""); }
function basicToIso(value: string): string {
  const z = value.endsWith("Z"); const raw = z ? value.slice(0, -1) : value;
  const iso = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(9,11)}:${raw.slice(11,13)}:${raw.slice(13,15)}`;
  return z ? `${iso}Z` : iso;
}
function remoteToLocal(remote: ExternalEventSnapshot, connection: GoogleCalendarConnection, localId?: string): CalendarItem {
  if (!remote.item) throw new Error("Remote event has no item.");
  return {
    ...mergeSyncMetadata(remote.item, remote.identity), id: localId ?? remote.item.id, calendarId: connection.localCalendarId,
    kind: connection.importedKind ?? remote.item.kind,
    ownership: connection.importedOwnership ?? remote.item.ownership,
    editPolicy: connection.mode === "overlay" ? "readonly" : connection.importedEditPolicy ?? "full",
  };
}
function itemPatch(item: CalendarItem) {
  return {
    calendarId: item.calendarId, title: item.title,
    ...(item.description !== undefined ? { description: item.description } : { description: null }),
    ...(item.location !== undefined ? { location: item.location } : { location: null }),
    start: item.start, end: item.end, allDay: item.allDay, precision: item.precision,
    ...(item.temporal !== undefined ? { temporal: item.temporal } : { temporal: null }),
    kind: item.kind, editPolicy: item.editPolicy,
    ...(item.recurrence !== undefined ? { recurrence: item.recurrence } : { recurrence: null }),
    ...(item.reminders !== undefined ? { reminders: item.reminders } : { reminders: null }),
    ...(item.display !== undefined ? { display: item.display } : { display: null }),
    ...(item.metadata !== undefined ? { metadata: item.metadata } : { metadata: null }),
  };
}
function initialState(connection: GoogleCalendarConnection): CalendarSyncConnectionState { return { provider: "google", connectionId: connection.id, mode: connection.mode, externalCalendarId: connection.googleCalendarId, localCalendarId: connection.localCalendarId, links: [] }; }
function canPull(mode: CalendarSyncMode): boolean { return mode === "import" || mode === "two-way"; }
function canPush(mode: CalendarSyncMode): boolean { return mode === "publish" || mode === "two-way"; }
function deletedSnapshot(identity: ExternalEventIdentity): ExternalEventSnapshot { return { identity, deleted: true, fingerprint: "<deleted>" }; }
function dedupeLinks(links: readonly CalendarSyncLink[]): CalendarSyncLink[] { return [...new Map(links.map(link => [link.localItemId, link] as const)).values()]; }
async function syncReplacementExceptions(transport: GoogleCalendarTransport, calendarId: string, masterId: string, item: CalendarItem): Promise<string[]> {
  const replacements = item.recurrence?.exceptions?.filter(exception => !exception.cancelled && exception.replacement) ?? [];
  if (!replacements.length) return [];
  const instances: GoogleCalendarEvent[] = []; let pageToken: string | undefined;
  do { const page = await transport.listInstances(calendarId, masterId, pageToken); instances.push(...page.items); pageToken = page.nextPageToken; } while (pageToken);
  const warnings: string[] = [];
  for (const exception of replacements) {
    const instance = instances.find(candidate => candidate.id && candidate.originalStartTime && recurrenceIdentityEqual(item, exception.originalStart, googleDateValue(candidate.originalStartTime).value));
    if (!instance?.id || !exception.replacement) { warnings.push(`Could not resolve Google recurring instance for ${item.title} at ${exception.originalStart}.`); continue; }
    const replacement = { ...item, ...withoutNullishEntries(exception.replacement as unknown as Record<string, unknown>), recurrence: undefined, id: item.id } as CalendarItem;
    await transport.patchEvent(calendarId, instance.id, itemToGoogleEvent(replacement), instance.etag);
  }
  return warnings;
}

function recurrenceIdentityEqual(item: CalendarItem, left: string, right: string): boolean {
  if (left === right) return true;
  const kind = item.temporal?.kind ?? (item.allDay ? "date" : "instant");
  if (kind === "date") return left.slice(0, 10) === right.slice(0, 10);
  if (kind === "zoned" && item.temporal?.timeZone) {
    try {
      const zone = item.temporal.timeZone;
      const toEpoch = (value: string) => /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : plainToInstant(parsePlainDateTime(value.slice(0, 19)), zone, "compatible");
      return toEpoch(left) === toEpoch(right);
    } catch { return false; }
  }
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(left) && /(?:Z|[+-]\d\d:\d\d)$/.test(right)) return Date.parse(left) === Date.parse(right);
  return left.slice(0, 19) === right.slice(0, 19);
}
async function parseJson<T>(response: Response): Promise<T> { if (!response.ok) throw new GoogleCalendarHttpError(response.status, `Google Calendar API request failed (${response.status}).`, await response.text()); return await response.json() as T; }

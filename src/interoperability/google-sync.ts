import type {
  CalendarItem,
  CalendarProjectionProvider,
  CalendarRange,
  CalendarRepository,
} from "../core/types.js";
import {
  createCalendarItemInState,
  removeCalendarItemFromState,
  updateCalendarItemInState,
  type CalendarStateCollections,
} from "../core/state-transitions.js";
import {
  decideSync,
  externalIdentityFromMetadata,
  fingerprintCalendarItem,
  linkAfterSync,
  mergeSyncMetadata,
  type CalendarSyncConnectionState,
  type CalendarSyncLink,
  type CalendarSyncMode,
  type ExternalEventIdentity,
  type ExternalEventSnapshot,
  type SyncConflict,
  type SyncStateStore,
} from "./sync.js";
import { stableBase32HexToken, withoutNullishEntries } from "./internal.js";
import {
  GoogleCalendarHttpError,
  GoogleSyncTokenExpiredError,
  type GoogleCalendarEvent,
  type GoogleCalendarTransport,
} from "./google-transport.js";
import {
  applyGoogleInstanceChanges,
  googleDateValue,
  googleEventSnapshot,
  itemPatch,
  itemToGoogleEvent,
  mergePriorExceptions,
  recurrenceIdentityEqual,
  remoteToLocal,
  type GoogleCalendarConnection,
} from "./google-mapping.js";

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

interface PullResult {
  readonly full: boolean;
  readonly events: ReadonlyMap<string, ExternalEventSnapshot>;
  readonly localItemHints: ReadonlyMap<string, string>;
  readonly nextSyncToken: string;
}

function isGooglePreconditionFailure(error: unknown): error is GoogleCalendarHttpError {
  return error instanceof GoogleCalendarHttpError && error.status === 412;
}

function publishedGoogleEventId(connection: GoogleCalendarConnection, localItemId: string): string {
  return `dcal${stableBase32HexToken(`${connection.id}\u0000${connection.googleCalendarId}\u0000${localItemId}`)}`;
}

function hintedPublishedLocalItem(
  snapshot: ReturnType<CalendarRepository["read"]>,
  connection: GoogleCalendarConnection,
  remoteEventId: string,
  localItemHint: string | undefined,
): CalendarItem | undefined {
  if (!localItemHint) return undefined;
  const local = snapshot.items.find(item => item.id === localItemHint && item.calendarId === connection.localCalendarId);
  return local && publishedGoogleEventId(connection, local.id) === remoteEventId ? local : undefined;
}

async function insertPublishedGoogleEvent(
  transport: GoogleCalendarTransport,
  connection: GoogleCalendarConnection,
  local: CalendarItem,
): Promise<GoogleCalendarEvent> {
  const eventId = publishedGoogleEventId(connection, local.id);
  const payload: GoogleCalendarEvent = { ...itemToGoogleEvent(local), id: eventId };
  try {
    const created = await transport.insertEvent(connection.googleCalendarId, payload);
    if (created.id !== eventId) throw new Error("Google Calendar returned an unexpected event id after deterministic insert.");
    return created;
  } catch (error) {
    if (!(error instanceof GoogleCalendarHttpError) || error.status !== 409) throw error;
    const existing = await transport.getEvent(connection.googleCalendarId, eventId);
    const owner = existing.extendedProperties?.private?.calendarItemId;
    if (existing.id !== eventId || owner !== local.id) {
      throw new Error("Google Calendar event id collision does not belong to the local Calendar item.");
    }
    return existing;
  }
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

type BrowserLockManager = {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

const localSyncTails = new Map<string, Promise<void>>();

async function withLocalSyncLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const previous = localSyncTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  localSyncTails.set(name, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (localSyncTails.get(name) === tail) localSyncTails.delete(name);
  }
}

async function withGoogleSyncLock<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
  const name = `director-calendar:google-sync:${connectionId}`;
  const manager = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { readonly locks?: BrowserLockManager }).locks;
  if (manager?.request) return await manager.request(name, { mode: "exclusive" }, operation);
  return await withLocalSyncLock(name, operation);
}

export class GoogleCalendarSyncAdapter {
  public constructor(
    private readonly transport: GoogleCalendarTransport,
    private readonly repository: CalendarRepository,
    private readonly states: SyncStateStore,
    private readonly connection: GoogleCalendarConnection,
  ) {}

  public async sync(): Promise<GoogleSyncResult> {
    return await withGoogleSyncLock(this.connection.id, () => this.syncExclusive());
  }

  private async syncExclusive(): Promise<GoogleSyncResult> {
    let state = await this.states.read(this.connection.id) ?? initialState(this.connection);
    let pull: PullResult;
    try { pull = await this.pull(state); }
    catch (error) {
      if (!(error instanceof GoogleSyncTokenExpiredError)) throw error;
      state = { ...state, syncToken: undefined, links: state.links.map(link => ({ ...link, status: "pending-remote" as const })) };
      pull = await this.pull(state);
    }
    const remoteById = pull.events;
    let pulled = 0, pushed = 0, deletedLocal = 0, deletedRemote = 0;
    const conflicts: SyncConflict[] = [], warnings: string[] = [];
    const nextLinks: CalendarSyncLink[] = [];
    const snapshot = this.repository.read();
    let stagedState: CalendarStateCollections = { sources: snapshot.sources, items: snapshot.items };
    let stagedLocalChange = false;
    const localById = new Map(snapshot.items.filter(item => item.calendarId === this.connection.localCalendarId).map(item => [item.id, item] as const));
    const stageCreate = (item: CalendarItem): void => {
      stagedState = createCalendarItemInState(stagedState, item);
      localById.set(item.id, item);
      stagedLocalChange = true;
    };
    const stageUpdate = (id: string, patch: Parameters<CalendarRepository["update"]>[1]): CalendarItem => {
      stagedState = updateCalendarItemInState(stagedState, id, patch);
      const updated = stagedState.items.find(item => item.id === id)!;
      localById.set(id, updated);
      stagedLocalChange = true;
      return updated;
    };
    const stageRemove = (id: string): void => {
      stagedState = removeCalendarItemFromState(stagedState, id);
      localById.delete(id);
      stagedLocalChange = true;
    };
    const linkedRemoteIds = new Set<string>();
    const linkedLocalIds = new Set(state.links.map(link => link.localItemId));

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
      if (decision.action === "rebase") {
        if (local && remote.item && !remote.deleted) nextLinks.push(linkAfterSync(local, remote));
        // If both sides are already deleted, the stale link has no remaining authority or identity value.
        continue;
      }
      if (decision.action === "none") {
        if (!local && remote.deleted) continue;
        // Google may emit a semantically unchanged event with a new etag/sequence. Refresh
        // provider identity even when the semantic fingerprint does not require data mutation.
        if (changedRemote && local && remote.item && !remote.deleted) nextLinks.push(linkAfterSync(local, remote));
        else nextLinks.push(remote.deleted ? { ...link, status: "deleted" } : link);
        continue;
      }
      if (decision.action === "conflict") { if (decision.conflict) conflicts.push(decision.conflict); nextLinks.push({ ...link, status: "conflict" }); continue; }
      if (decision.action === "apply-remote" && remote.item && canPull(this.connection.mode)) {
        const item = remoteToLocal(remote, this.connection, link.localItemId);
        const stagedItem = local ? stageUpdate(local.id, itemPatch(item)) : (stageCreate(item), item);
        nextLinks.push(linkAfterSync(stagedItem, remote)); pulled += 1; continue;
      }
      if (decision.action === "delete-local" && local && canPull(this.connection.mode)) {
        stageRemove(local.id); deletedLocal += 1; continue;
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
      const existing = snapshot.items.find(item => {
        const identity = externalIdentityFromMetadata(item);
        return identity?.connectionId === this.connection.id && identity.eventId === remote.identity.eventId;
      }) ?? hintedPublishedLocalItem(
        snapshot,
        this.connection,
        remote.identity.eventId,
        pull.localItemHints.get(remote.identity.eventId),
      );
      const local = remoteToLocal(remote, this.connection, existing?.id);
      const stagedItem = existing ? stageUpdate(existing.id, itemPatch(local)) : (stageCreate(local), local);
      nextLinks.push(linkAfterSync(stagedItem, remote));
      linkedLocalIds.add(stagedItem.id);
      pulled += 1;
    }

    if (canPush(this.connection.mode)) for (const local of snapshot.items) {
      const identity = externalIdentityFromMetadata(local);
      if (local.calendarId !== this.connection.localCalendarId || linkedLocalIds.has(local.id) || identity?.connectionId === this.connection.id) continue;
      const publishable = this.connection.publishPredicate
        ? this.connection.publishPredicate(local)
        : local.editPolicy === "full";
      if (!publishable) continue;
      const created = await insertPublishedGoogleEvent(this.transport, this.connection, local);
      if (!created.id) throw new Error("Google Calendar did not return an event id after insert.");
      const exceptionWarnings = await syncReplacementExceptions(this.transport, this.connection.googleCalendarId, created.id, local); warnings.push(...exceptionWarnings);
      const remote = googleEventSnapshot(created, this.connection, local.id);
      nextLinks.push(linkAfterSync(mergeSyncMetadata(local, remote.identity), { ...remote, item: local, fingerprint: fingerprintCalendarItem(local) })); pushed += 1;
    }

    if (stagedLocalChange) {
      await this.repository.replaceAtRevision(stagedState.items, snapshot.revision);
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
    const localItemHints = new Map<string, string>();
    const instanceChanges = new Map<string, GoogleCalendarEvent[]>();
    for (const event of raw) {
      if (!event.id) continue;
      if (event.recurringEventId) {
        const list = instanceChanges.get(event.recurringEventId) ?? []; list.push(event); instanceChanges.set(event.recurringEventId, list);
      } else {
        events.set(event.id, googleEventSnapshot(event, this.connection));
        const localItemHint = event.extendedProperties?.private?.calendarItemId;
        if (typeof localItemHint === "string" && localItemHint.trim()) localItemHints.set(event.id, localItemHint);
      }
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
    return { full: !syncToken, events, localItemHints, nextSyncToken };
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

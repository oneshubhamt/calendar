import type { CalendarItem, CalendarItemPatch, CalendarRepository, CalendarSnapshot, CalendarSource, CalendarSourcePatch } from "../core/types.js";
import { CalendarStaleRevisionError } from "../core/revision.js";
import { applyCalendarItemPatch, applyCalendarSourcePatch, assertCalendarStateIntegrity, materializeCalendarSnapshot } from "../core/store.js";

interface StoredEnvelope {
  readonly key: "snapshot";
  readonly revision: number;
  readonly items: CalendarItem[];
  readonly sources?: CalendarSource[];
}

function storedEnvelope(value: unknown): StoredEnvelope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored calendar snapshot is invalid");
  const raw = value as Record<string, unknown>;
  if (raw.key !== "snapshot" || !Number.isInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.items)) throw new Error("Stored calendar snapshot envelope is invalid");
  if (raw.sources !== undefined && !Array.isArray(raw.sources)) throw new Error("Stored calendar source collection is invalid");
  return raw as unknown as StoredEnvelope;
}


function openTransaction(db: IDBDatabase, storeName: string, mode: IDBTransactionMode): IDBTransaction {
  if (mode !== "readwrite") return db.transaction(storeName, mode);
  try {
    return db.transaction(storeName, mode, { durability: "strict" });
  } catch {
    return db.transaction(storeName, mode);
  }
}

export interface IndexedDbCalendarRepositoryOptions {
  readonly databaseName?: string;
  readonly storeName?: string;
  readonly sources: readonly CalendarSource[];
}

export class IndexedDbCalendarRepository implements CalendarRepository {
  private readonly dbName: string;
  private readonly storeName: string;
  private snapshotValue: CalendarSnapshot | undefined;
  private initialSources: readonly CalendarSource[];
  private loaded = false;
  private db: IDBDatabase | null = null;
  private channel: BroadcastChannel | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(snapshot: CalendarSnapshot) => void>();

  public constructor(options: IndexedDbCalendarRepositoryOptions) {
    this.dbName = options.databaseName ?? "calendar";
    this.storeName = options.storeName ?? "calendar";
    this.initialSources = materializeCalendarSnapshot(undefined, options.sources, [], 0).sources;
  }

  public async open(): Promise<void> {
    if (this.loaded) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: "key" });
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open calendar IndexedDB"));
      request.onsuccess = () => resolve(request.result);
    });
    const envelope = await this.readEnvelope();
    if (envelope) {
      const sources = envelope.sources ?? this.initialSources;
      this.snapshotValue = materializeCalendarSnapshot(undefined, sources, envelope.items, envelope.revision);
    } else {
      this.snapshotValue = materializeCalendarSnapshot(undefined, this.initialSources, [], 0);
    }
    this.loaded = true;
    this.openInvalidationChannel();
  }

  public read(): CalendarSnapshot {
    if (!this.loaded) throw new Error("IndexedDbCalendarRepository.open() must complete before read()");
    if (!this.snapshotValue) throw new Error("IndexedDbCalendarRepository.open() must complete before read()");
    return this.snapshotValue;
  }

  /** Release the browser database handle. The repository may be opened again later. */
  public close(): void {
    this.channel?.close();
    this.channel = null;
    this.db?.close();
    this.db = null;
    this.loaded = false;
    this.snapshotValue = undefined;
    this.refreshPromise = null;
  }

  public async create(item: CalendarItem): Promise<void> {
    this.assertLoaded();
    if (this.read().items.some(existing => existing.id === item.id)) throw new Error(`Duplicate calendar item: ${item.id}`);
    if (!this.read().sources.some(source => source.id === item.calendarId)) throw new Error(`Unknown calendar source: ${item.calendarId}`);
    const current = this.read();
    await this.commit([...current.items, item], current.sources, current.revision);
  }

  public async update(id: string, patch: CalendarItemPatch): Promise<void> {
    this.assertLoaded();
    const index = this.read().items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    const next = applyCalendarItemPatch(this.read().items[index]!, patch);
    if (!this.read().sources.some(source => source.id === next.calendarId)) throw new Error(`Unknown calendar source: ${next.calendarId}`);
    const current = this.read();
    await this.commit(current.items.map((item, i) => i === index ? next : item), current.sources, current.revision);
  }

  public async remove(id: string): Promise<void> {
    this.assertLoaded();
    const next = this.read().items.filter(item => item.id !== id);
    if (next.length === this.read().items.length) throw new Error(`Calendar item not found: ${id}`);
    const current = this.read();
    await this.commit(next, current.sources, current.revision);
  }

  public async replace(items: readonly CalendarItem[]): Promise<void> {
    this.assertLoaded();
    const current = this.read();
    assertCalendarStateIntegrity(current.sources, items);
    await this.commit(items, current.sources, current.revision);
  }

  public async replaceAtRevision(items: readonly CalendarItem[], expectedRevision: number): Promise<void> {
    this.assertLoaded();
    const current = this.read();
    assertCalendarStateIntegrity(current.sources, items);
    await this.commit(items, current.sources, expectedRevision);
  }

  public async createSource(source: CalendarSource): Promise<void> {
    this.assertLoaded();
    if (this.read().sources.some(existing => existing.id === source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    const current = this.read();
    await this.commit(current.items, [...current.sources, source], current.revision);
  }

  public async updateSource(id: string, patch: CalendarSourcePatch): Promise<void> {
    this.assertLoaded();
    const index = this.read().sources.findIndex(source => source.id === id);
    if (index < 0) throw new Error(`Calendar source not found: ${id}`);
    const next = this.read().sources.map((source, i) => i === index ? applyCalendarSourcePatch(source, patch) : source);
    const current = this.read();
    await this.commit(current.items, next, current.revision);
  }

  public async removeSource(id: string): Promise<void> {
    this.assertLoaded();
    const source = this.read().sources.find(row => row.id === id);
    if (!source) throw new Error(`Calendar source not found: ${id}`);
    if (source.removable !== true) throw new Error("Calendar source is not removable");
    if (this.read().items.some(item => item.calendarId === id)) throw new Error("Move or delete events from this calendar before removing it");
    const current = this.read();
    await this.commit(current.items, current.sources.filter(row => row.id !== id), current.revision);
  }

  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private assertLoaded(): void { if (!this.loaded || !this.db) throw new Error("IndexedDbCalendarRepository.open() must complete first"); }

  private async commit(
    items: readonly CalendarItem[],
    sources: readonly CalendarSource[],
    expectedRevision: number,
  ): Promise<void> {
    this.assertLoaded();
    assertCalendarStateIntegrity(sources, items);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Expected Calendar revision must be a non-negative integer");
    }

    const current = this.read();
    const revision = expectedRevision + 1;
    const envelope: StoredEnvelope = { key: "snapshot", revision, items: [...items], sources: [...sources] };
    let stale: CalendarStaleRevisionError | undefined;
    let validationFailure: unknown;

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = openTransaction(this.db!, this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const request = store.get("snapshot");
        request.onsuccess = () => {
          try {
            const persisted = storedEnvelope(request.result);
            const actualRevision = persisted?.revision ?? 0;
            if (actualRevision !== expectedRevision) {
              stale = new CalendarStaleRevisionError(expectedRevision, actualRevision);
              tx.abort();
              return;
            }
            store.put(envelope);
          } catch (error) {
            validationFailure = error;
            tx.abort();
          }
        };
        request.onerror = () => reject(request.error ?? new Error("Could not verify Calendar revision"));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(stale ?? validationFailure ?? tx.error ?? new Error("Calendar transaction aborted"));
        tx.onerror = () => { /* tx.onabort reports the durable failure once */ };
      });
    } catch (error) {
      if ((error as { readonly code?: unknown })?.code === "stale") {
        await this.reloadFromStorage();
      }
      throw error;
    }

    this.snapshotValue = materializeCalendarSnapshot(current, sources, items, revision);
    for (const listener of this.listeners) listener(this.snapshotValue);
    this.channel?.postMessage({ revision });
  }

  private openInvalidationChannel(): void {
    if (this.channel || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`@director/calendar:${this.dbName}:${this.storeName}`);
    channel.onmessage = event => {
      const value = event.data as { readonly revision?: unknown } | null;
      const revision = value && Number.isInteger(value.revision) ? Number(value.revision) : -1;
      if (!this.loaded || revision <= this.read().revision) return;
      void this.reloadFromStorage(revision);
    };
    this.channel = channel;
  }

  private async reloadFromStorage(minimumRevision = -1): Promise<void> {
    if (!this.loaded) return;
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = (async () => {
      const envelope = await this.readEnvelope();
      if (!this.loaded || !envelope) return;
      const current = this.read();
      if (envelope.revision <= current.revision || envelope.revision < minimumRevision) return;
      const sources = envelope.sources ?? this.initialSources;
      this.snapshotValue = materializeCalendarSnapshot(current, sources, envelope.items, envelope.revision);
      for (const listener of this.listeners) listener(this.snapshotValue);
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async readEnvelope(): Promise<StoredEnvelope | undefined> {
    return new Promise((resolve, reject) => {
      const tx = openTransaction(this.db!, this.storeName, "readonly");
      const request = tx.objectStore(this.storeName).get("snapshot");
      request.onsuccess = () => { try { resolve(storedEnvelope(request.result)); } catch (error) { reject(error); } };
      request.onerror = () => reject(request.error ?? new Error("Could not read calendar snapshot"));
    });
  }
}

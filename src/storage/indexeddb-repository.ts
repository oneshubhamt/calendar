import type { CalendarItem, CalendarItemPatch, CalendarRepository, CalendarSnapshot, CalendarSource, CalendarSourcePatch } from "../core/types.js";
import { applyCalendarItemPatch, applyCalendarSourcePatch, assertCalendarStateIntegrity } from "../core/store.js";

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
  private revision = 0;
  private items: CalendarItem[] = [];
  private sources: CalendarSource[];
  private loaded = false;
  private db: IDBDatabase | null = null;
  private readonly listeners = new Set<(snapshot: CalendarSnapshot) => void>();

  public constructor(options: IndexedDbCalendarRepositoryOptions) {
    this.dbName = options.databaseName ?? "calendar";
    this.storeName = options.storeName ?? "calendar";
    this.sources = [...options.sources];
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
      const sources = envelope.sources ?? this.sources;
      assertCalendarStateIntegrity(sources, envelope.items);
      this.revision = envelope.revision;
      this.items = envelope.items;
      this.sources = sources;
    } else assertCalendarStateIntegrity(this.sources, this.items);
    this.loaded = true;
  }

  public read(): CalendarSnapshot {
    if (!this.loaded) throw new Error("IndexedDbCalendarRepository.open() must complete before read()");
    return { sources: this.sources, items: this.items, revision: this.revision };
  }

  /** Release the browser database handle. The repository may be opened again later. */
  public close(): void {
    this.db?.close();
    this.db = null;
    this.loaded = false;
  }

  public async create(item: CalendarItem): Promise<void> {
    this.assertLoaded();
    if (this.items.some(existing => existing.id === item.id)) throw new Error(`Duplicate calendar item: ${item.id}`);
    if (!this.sources.some(source => source.id === item.calendarId)) throw new Error(`Unknown calendar source: ${item.calendarId}`);
    await this.commit([...this.items, item], this.sources);
  }

  public async update(id: string, patch: CalendarItemPatch): Promise<void> {
    this.assertLoaded();
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`Calendar item not found: ${id}`);
    const next = applyCalendarItemPatch(this.items[index]!, patch);
    if (!this.sources.some(source => source.id === next.calendarId)) throw new Error(`Unknown calendar source: ${next.calendarId}`);
    await this.commit(this.items.map((item, i) => i === index ? next : item), this.sources);
  }

  public async remove(id: string): Promise<void> {
    this.assertLoaded();
    const next = this.items.filter(item => item.id !== id);
    if (next.length === this.items.length) throw new Error(`Calendar item not found: ${id}`);
    await this.commit(next, this.sources);
  }

  public async replace(items: readonly CalendarItem[]): Promise<void> {
    this.assertLoaded(); assertCalendarStateIntegrity(this.sources, items); await this.commit([...items], this.sources);
  }

  public async createSource(source: CalendarSource): Promise<void> {
    this.assertLoaded();
    if (this.sources.some(existing => existing.id === source.id)) throw new Error(`Duplicate calendar source: ${source.id}`);
    await this.commit(this.items, [...this.sources, source]);
  }

  public async updateSource(id: string, patch: CalendarSourcePatch): Promise<void> {
    this.assertLoaded();
    const index = this.sources.findIndex(source => source.id === id);
    if (index < 0) throw new Error(`Calendar source not found: ${id}`);
    const next = this.sources.map((source, i) => i === index ? applyCalendarSourcePatch(source, patch) : source);
    await this.commit(this.items, next);
  }

  public async removeSource(id: string): Promise<void> {
    this.assertLoaded();
    const source = this.sources.find(row => row.id === id);
    if (!source) throw new Error(`Calendar source not found: ${id}`);
    if (source.removable !== true) throw new Error("Calendar source is not removable");
    if (this.items.some(item => item.calendarId === id)) throw new Error("Move or delete events from this calendar before removing it");
    await this.commit(this.items, this.sources.filter(row => row.id !== id));
  }

  public subscribe(listener: (snapshot: CalendarSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private assertLoaded(): void { if (!this.loaded || !this.db) throw new Error("IndexedDbCalendarRepository.open() must complete first"); }

  private async commit(items: CalendarItem[], sources: CalendarSource[]): Promise<void> {
    this.assertLoaded();
    assertCalendarStateIntegrity(sources, items);
    const revision = this.revision + 1;
    const envelope: StoredEnvelope = { key: "snapshot", revision, items, sources };
    await new Promise<void>((resolve, reject) => {
      const tx = openTransaction(this.db!, this.storeName, "readwrite");
      tx.objectStore(this.storeName).put(envelope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Calendar transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("Calendar transaction failed"));
    });
    this.revision = revision; this.items = items; this.sources = sources;
    const snapshot = this.read(); for (const listener of this.listeners) listener(snapshot);
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

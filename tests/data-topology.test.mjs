import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

test("D4 IndexedDB uses one normalized scalable durable topology rather than threshold modes",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.match(source,/interface StoredMetaRecord/);
  assert.match(source,/interface StoredItemRecord/);
  assert.match(source,/interface StoredSourceRecord/);
  assert.match(source,/changedEntities\(current\.items, items\)/);
  assert.match(source,/changedEntities\(current\.sources, sources\)/);
  assert.match(source,/store\.delete\(itemKey\(id\)\)/);
  assert.match(source,/store\.delete\(sourceKey\(id\)\)/);
  assert.match(source,/store\.put\(meta\)/);
  assert.doesNotMatch(source,/threshold|largeData|smallData|storageMode/i);
});

test("D4 IndexedDB has one current normalized schema and no migration path",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.doesNotMatch(source,/DATABASE_VERSION|FORMAT_VERSION|readonly format:|format: FORMAT_VERSION/);
  assert.doesNotMatch(source,/LEGACY_KEY|LegacyStoredEnvelope|legacyEnvelope|migrateLegacySnapshot/);
  assert.doesNotMatch(source,/upgradeVersion|openDatabaseRequest/);
});

test("D4 normalized writes retain CAS in the same IndexedDB transaction",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const commit=source.match(/private async commit\([\s\S]*?\n  }\n\n  private openInvalidationChannel/)?.[0] ?? "";
  assert.match(commit,/const metaRequest = store\.get\(META_KEY\)/);
  assert.match(commit,/actualRevision !== expectedRevision/);
  assert.match(commit,/new CalendarStaleRevisionError/);
  assert.match(commit,/tx\.abort\(\)/);
  assert.match(commit,/store\.put\(meta\)/);
});


test("D4 storage open is failure-clean and creates only the fixed current store",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const open=source.match(/public async open\(\): Promise<void> \{[\s\S]*?\n  }\n\n  public read/)?.[0] ?? "";
  assert.match(open,/catch \(error\)/);
  assert.match(open,/opened\?\.close\(\)/);
  assert.match(open,/this\.snapshotValue = undefined/);
  assert.match(open,/this\.loaded = false/);

  const openDb=source.match(/private async openDatabase\(\): Promise<IDBDatabase> \{[\s\S]*?\n  }\n\n  private async commit/)?.[0] ?? "";
  assert.match(openDb,/indexedDB\.open\(this\.dbName\)/);
  assert.match(openDb,/request\.onupgradeneeded/);
  assert.match(openDb,/db\.createObjectStore\(STORE_NAME/);
  assert.match(openDb,/Calendar IndexedDB store is missing/);
  assert.doesNotMatch(source,/openDatabaseRequest|upgradeVersion/);
});


test("D5 command history stores affected immutable item deltas rather than full item snapshots",async()=>{
  const source=await read("../src/core/commands.ts");
  assert.match(source,/interface HistoryItemChange/);
  assert.match(source,/interface HistoryRun/);
  assert.match(source,/readonly changes: readonly HistoryItemChange\[\]/);
  assert.match(source,/buildHistoryEntry/);
  assert.match(source,/applyHistoryEntry/);
  assert.doesNotMatch(source,/readonly before: readonly CalendarItem\[\]/);
  assert.doesNotMatch(source,/readonly after: readonly CalendarItem\[\]/);
  assert.doesNotMatch(source,/function cloneItems/);
  assert.doesNotMatch(source,/function cloneSources/);
  assert.doesNotMatch(source,/private async executeAtomic/);
  assert.match(source,/private async applyCommandToStaging/);
});


test("D2 cross-tab reload coordinator drains newer invalidations instead of dropping them",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const reload=source.match(/private async reloadFromStorage\([\s\S]*?\n  }\n\n  private async readPersistedState/)?.[0] ?? "";
  assert.match(source,/private requestedRefreshRevision = -1/);
  assert.match(reload,/Math\.max\(this\.requestedRefreshRevision, minimumRevision\)/);
  assert.match(reload,/while \(this\.loaded\)/);
  assert.match(reload,/this\.requestedRefreshRevision = -1/);
  assert.match(reload,/if \(this\.refreshPromise\) return await this\.refreshPromise/);
  assert.match(reload,/this\.requestedRefreshRevision <= currentRevision/);
});


test("stale command and revision errors share a semantic base without fake revision values",async()=>{
  const revision=await read("../src/core/revision.ts");
  const commands=await read("../src/core/commands.ts");
  assert.match(revision,/class CalendarStaleError extends Error/);
  assert.match(revision,/class CalendarStaleRevisionError extends CalendarStaleError/);
  assert.match(commands,/class CalendarCommandStaleError extends CalendarStaleError/);
  assert.doesNotMatch(commands,/super\(-1/);
});

test("queued reload drains newer invalidations without self-requeueing an impossible advertised revision",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const reload=source.match(/private async reloadFromStorage\([\s\S]*?\n  }\n\n  private async readPersistedState/)?.[0] ?? "";
  assert.match(reload,/const requestedRevision = this\.requestedRefreshRevision/);
  assert.match(reload,/this\.requestedRefreshRevision = -1/);
  assert.match(reload,/this\.requestedRefreshRevision <= currentRevision/);
  assert.doesNotMatch(reload,/requestedRevision > currentRevision/);
  assert.doesNotMatch(reload,/Math\.max\(this\.requestedRefreshRevision, requestedRevision\)/);
});


test("current public contracts contain no retained compatibility aliases",async()=>{
  const [types,ics,google,recurrenceEditor,eventEditor,personal,fixtures]=await Promise.all([
    read("../src/core/types.ts"),
    read("../src/interoperability/ics.ts"),
    read("../src/interoperability/google-calendar.ts"),
    read("../src/view/recurrence-editor.ts"),
    read("../src/view/event-editor.ts"),
    read("../src/features/personal.ts"),
    read("../src/fixtures/director.ts"),
  ]);
  const combined=[types,ics,google,recurrenceEditor,eventEditor,personal,fixtures].join("\n");
  assert.doesNotMatch(combined,/\bbyWeekday\b/);
  assert.doesNotMatch(ics,/readonly readOnly\?:|options\.readOnly/);
  assert.doesNotMatch(google,/publishOwnerships/);
});


test("mutable Calendar repositories require atomic revision-guarded replacement with no weak fallback",async()=>{
  const [types,commands]=await Promise.all([
    read("../src/core/types.ts"),
    read("../src/core/commands.ts"),
  ]);
  const repository=types.match(/export interface CalendarRepository[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(repository,/replaceAtRevision\(/);
  assert.doesNotMatch(types,/CalendarRevisionGuardedRepository/);
  assert.doesNotMatch(commands,/revisionGuarded|replaceAtExpectedRevision|Partial<CalendarRevisionGuardedRepository>/);
  assert.match(commands,/this\.repository\.replaceAtRevision\(stagedItems, beforeSnapshot\.revision\)/);
  assert.match(commands,/this\.repository\.replaceAtRevision\(next, current\.revision\)/);
});


test("current IndexedDB stores carry no application-level schema-version scaffolding",async()=>{
  const [calendarStorage,interopStorage]=await Promise.all([
    read("../src/storage/indexeddb-repository.ts"),
    read("../src/interoperability/storage.ts"),
  ]);
  assert.doesNotMatch(calendarStorage,/DATABASE_VERSION|FORMAT_VERSION|readonly format:|format:\s*FORMAT_VERSION/);
  assert.match(calendarStorage,/indexedDB\.open\(this\.dbName\)/);
  assert.doesNotMatch(interopStorage,/DB_VERSION|calendar\.interop\.v\d+/);
  assert.match(interopStorage,/const DB_NAME = "calendar\.interop"/);
  assert.match(interopStorage,/indexedDB\.open\(dbName\)/);
});


test("primary IndexedDB repository exposes one fixed object-store topology",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.match(source,/const STORE_NAME = "calendar"/);
  assert.doesNotMatch(source,/readonly storeName\?:|private readonly storeName|options\.storeName/);
  assert.match(source,/db\.createObjectStore\(STORE_NAME/);
});

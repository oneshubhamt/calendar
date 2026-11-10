import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

test("D4 IndexedDB uses one normalized scalable durable topology rather than threshold modes",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.match(source,/const FORMAT_VERSION = 1/);
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
  assert.match(source,/const DATABASE_VERSION = 1/);
  assert.match(source,/const FORMAT_VERSION = 1/);
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


test("D4 storage open is failure-clean and creates only the configured current store",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const open=source.match(/public async open\(\): Promise<void> \{[\s\S]*?\n  }\n\n  public read/)?.[0] ?? "";
  assert.match(open,/catch \(error\)/);
  assert.match(open,/opened\?\.close\(\)/);
  assert.match(open,/this\.snapshotValue = undefined/);
  assert.match(open,/this\.loaded = false/);

  const openDb=source.match(/private async openDatabase\(\): Promise<IDBDatabase> \{[\s\S]*?\n  }\n\n  private async commit/)?.[0] ?? "";
  assert.match(openDb,/indexedDB\.open\(this\.dbName, DATABASE_VERSION\)/);
  assert.match(openDb,/request\.onupgradeneeded/);
  assert.match(openDb,/db\.createObjectStore\(this\.storeName/);
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

test("queued reload retains an unmet requested revision before deciding it is caught up",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const reload=source.match(/private async reloadFromStorage\([\s\S]*?\n  }\n\n  private async readPersistedState/)?.[0] ?? "";
  const requeue=reload.indexOf("requestedRevision > currentRevision");
  const caughtUp=reload.indexOf("this.requestedRefreshRevision <= currentRevision");
  assert.ok(requeue>=0 && caughtUp>requeue);
  assert.match(reload,/Math\.max\(this\.requestedRefreshRevision, requestedRevision\)/);
});


test("current public contracts contain no retained compatibility aliases",async()=>{
  const [types,ics,google,recurrenceEditor,eventEditor,personal]=await Promise.all([
    read("../src/core/types.ts"),
    read("../src/interoperability/ics.ts"),
    read("../src/interoperability/google-calendar.ts"),
    read("../src/view/recurrence-editor.ts"),
    read("../src/view/event-editor.ts"),
    read("../src/features/personal.ts"),
  ]);
  const combined=[types,ics,google,recurrenceEditor,eventEditor,personal].join("\n");
  assert.doesNotMatch(combined,/\bbyWeekday\b/);
  assert.doesNotMatch(ics,/readonly readOnly\?:|options\.readOnly/);
  assert.doesNotMatch(google,/publishOwnerships/);
});

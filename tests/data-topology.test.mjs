import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = path => fs.readFile(new URL(path, import.meta.url), "utf8");

test("D4 IndexedDB uses one normalized scalable durable topology rather than threshold modes",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.match(source,/const FORMAT_VERSION = 2/);
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

test("D4 legacy monolithic snapshots migrate transactionally and are not the steady-state write format",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  assert.match(source,/private async migrateLegacySnapshot\(\)/);
  assert.match(source,/const LEGACY_KEY = "snapshot"/);
  assert.match(source,/store\.delete\(LEGACY_KEY\)/);
  const commit=source.match(/private async commit\([\s\S]*?\n  }\n\n  private openInvalidationChannel/)?.[0] ?? "";
  assert.doesNotMatch(commit,/items:\s*\[\.\.\.items\].*sources:\s*\[\.\.\.sources\]/s);
  assert.match(commit,/StoredItemRecord/);
  assert.match(commit,/StoredSourceRecord/);
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


test("D4 storage open is failure-clean and custom store names upgrade dynamically",async()=>{
  const source=await read("../src/storage/indexeddb-repository.ts");
  const open=source.match(/public async open\(\): Promise<void> \{[\s\S]*?\n  }\n\n  public read/)?.[0] ?? "";
  assert.match(open,/catch \(error\)/);
  assert.match(open,/opened\?\.close\(\)/);
  assert.match(open,/this\.snapshotValue = undefined/);
  assert.match(open,/this\.loaded = false/);

  const openDb=source.match(/private async openDatabase\(\): Promise<IDBDatabase> \{[\s\S]*?\n  }\n\n  private async openDatabaseRequest/)?.[0] ?? "";
  assert.match(openDb,/existing\.objectStoreNames\.contains\(this\.storeName\)/);
  assert.match(openDb,/Math\.max\(DATABASE_VERSION, existing\.version \+ 1\)/);
  assert.match(openDb,/existing\.close\(\)/);
  assert.match(source,/requireStore && !db\.objectStoreNames\.contains\(this\.storeName\)/);
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

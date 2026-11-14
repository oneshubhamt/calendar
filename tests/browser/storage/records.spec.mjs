import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { DATABASE_NAME, SOURCE, closeRepository, createItem, createSource, deleteDatabase, event, openRepository, rawRecords, removeItem, removeSource, repositoryOperationError, repositoryState, updateItem, updateSource } from "../helpers.mjs";

scenario("storage.persist-reopen", "native IndexedDB persists normalized create, update and delete state across reopen", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openRepository(page);
  await createItem(page, event("persisted", { title: "Persisted event" }));
  await closeRepository(page);

  await openRepository(page);
  let state = await repositoryState(page);
  expect(state.revision).toBe(1);
  expect(state.items.map(item => item.title)).toEqual(["Persisted event"]);

  await updateItem(page, "persisted", { title: "Updated event" });
  await closeRepository(page);
  await openRepository(page);
  state = await repositoryState(page);
  expect(state.revision).toBe(2);
  expect(state.items[0]?.title).toBe("Updated event");

  await removeItem(page, "persisted");
  await closeRepository(page);
  const records = await rawRecords(page);
  expect(records.map(record => record.key).sort()).toEqual(["meta", "source:personal"]);
  const meta = records.find(record => record.key === "meta");
  expect(meta).toMatchObject({ revision: 3, itemOrder: [], sourceOrder: ["personal"] });

  await openRepository(page);
  state = await repositoryState(page);
  expect(state).toMatchObject({ revision: 3, items: [] });
  expect(state.sources).toEqual([SOURCE]);

  await closeRepository(page);
  await deleteDatabase(page);
});

scenario("storage.crud", "native IndexedDB item and source CRUD preserve the canonical transition semantics", async ({ page }) => {
  const databaseName = DATABASE_NAME;
  await openRepository(page);

  const work = { id: "work", title: "Work", visible: true, removable: true };
  await createSource(page, work);
  await updateSource(page, "work", { title: "Work calendar", visible: false });
  expect((await repositoryState(page)).sources.find(source => source.id === "work")).toMatchObject({
    title: "Work calendar",
    visible: false,
  });

  await createItem(page, event("work-item", { calendarId: "work" }));
  expect(await repositoryOperationError(page, {
    type: "create-item",
    item: event("work-item", { calendarId: "work" }),
  })).toMatch(/Duplicate calendar item/);
  expect(await repositoryOperationError(page, {
    type: "update-item",
    id: "work-item",
    patch: { calendarId: "missing" },
  })).toMatch(/Unknown calendar source/);
  expect(await repositoryOperationError(page, {
    type: "remove-source",
    id: "work",
  })).toMatch(/Move or delete events/);

  await removeItem(page, "work-item");
  await removeSource(page, "work");
  const state = await repositoryState(page);
  expect(state.items).toEqual([]);
  expect(state.sources).toEqual([SOURCE]);
  expect(state.revision).toBe(5);

  await closeRepository(page);
  await deleteDatabase(page);
});

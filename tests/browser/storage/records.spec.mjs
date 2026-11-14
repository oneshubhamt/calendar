import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import {
  SOURCE,
  closeRepository,
  createItem,
  createSource,
  deleteDatabase,
  event,
  openRepository,
  rawRecords,
  removeItem,
  removeSource,
  repositoryState,
  updateItem,
  updateSource,
} from "../helpers.mjs";

scenario("storage.records", "native IndexedDB persists canonical item and source CRUD across reopen", async ({ page }) => {
  await openRepository(page);

  const work = { id: "work", title: "Work", visible: true, removable: true };
  await createSource(page, work);
  await updateSource(page, "work", { title: "Work calendar", visible: false });
  await createItem(page, event("persisted", { calendarId: "work", title: "Persisted event" }));
  await closeRepository(page);

  await openRepository(page);
  let state = await repositoryState(page);
  expect(state.revision).toBe(3);
  expect(state.sources.find(source => source.id === "work")).toMatchObject({
    title: "Work calendar",
    visible: false,
  });
  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({
    id: "persisted",
    calendarId: "work",
    title: "Persisted event",
  });

  await updateItem(page, "persisted", { title: "Updated event" });
  await closeRepository(page);
  await openRepository(page);
  state = await repositoryState(page);
  expect(state.revision).toBe(4);
  expect(state.items[0]?.title).toBe("Updated event");

  await removeItem(page, "persisted");
  await removeSource(page, "work");
  await closeRepository(page);

  const records = await rawRecords(page);
  expect(records.map(record => record.key).sort()).toEqual(["meta", "source:personal"]);
  expect(records.find(record => record.key === "meta")).toMatchObject({
    revision: 6,
    itemOrder: [],
    sourceOrder: ["personal"],
  });

  await openRepository(page);
  state = await repositoryState(page);
  expect(state).toMatchObject({ revision: 6, items: [] });
  expect(state.sources).toEqual([SOURCE]);

  await closeRepository(page);
  await deleteDatabase(page);
});

import { expect } from "@playwright/test";
import { scenario } from "../scenario-registry.mjs";
import { DATABASE_NAME, closeRepository, createItem, deleteDatabase, disableBroadcastChannel, event, installSilentBroadcastChannel, observedRevisions, openRepository, rawRecords, replaceAtRevision, repositoryState, subscribeRevisions } from "../helpers.mjs";

scenario("storage.reminder-claim", "two tabs atomically claim one reminder receipt and completed delivery stays deduplicated", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const second = await context.newPage();
  await Promise.all([page.goto("/tests/browser/harness.html"), second.goto("/tests/browser/harness.html")]);

  const claim = async (target, token) => await target.evaluate(async ({ databaseName, token }) => {
    const { IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    return await new IndexedDbReminderReceiptStore().claim("same-reminder", {
      token,
      claimedAt: "2026-11-10T10:00:00.000Z",
      expiresAt: "2026-11-10T10:15:00.000Z",
    });
  }, { databaseName, token });

  const [first, secondClaim] = await Promise.all([claim(page, "first"), claim(second, "second")]);
  expect([first, secondClaim].filter(Boolean)).toHaveLength(1);
  const winner = first ? { target: page, token: "first" } : { target: second, token: "second" };

  await winner.target.evaluate(async ({ databaseName, token }) => {
    const { IndexedDbReminderReceiptStore } = await import("/dist/interoperability/storage.js");
    await new IndexedDbReminderReceiptStore().complete("same-reminder", token, "2026-11-10T10:00:01.000Z");
  }, { databaseName, token: winner.token });

  expect(await claim(first ? second : page, "third")).toBe(false);
  await second.close();
  await deleteDatabase(page);
});

scenario("storage.google-lock", "two tabs serialize one Google connection before remote publish and shared state write", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const second = await context.newPage();
  await Promise.all([page.goto("/tests/browser/harness.html"), second.goto("/tests/browser/harness.html")]);
  await page.evaluate(() => {
    localStorage.setItem("calendar-google-inserts", "0");
    localStorage.setItem("calendar-google-active", "0");
    localStorage.setItem("calendar-google-max-active", "0");
  });

  const run = async target => await target.evaluate(async databaseName => {
    const Calendar = await import("/dist/index.js");
    const Google = await import("/dist/interoperability/google-calendar.js");
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    const source = { id: "personal", title: "Personal", visible: true, removable: true };
    const item = {
      id: "e1", calendarId: "personal", title: "Event",
      start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z",
      kind: "event", ownership: "calendar", editPolicy: "full",
    };
    const repo = new Calendar.MemoryCalendarRepository([source], [item]);
    const transport = {
      async listEvents() {
        const active = Number(localStorage.getItem("calendar-google-active") ?? "0") + 1;
        localStorage.setItem("calendar-google-active", String(active));
        localStorage.setItem("calendar-google-max-active", String(Math.max(
          active, Number(localStorage.getItem("calendar-google-max-active") ?? "0"),
        )));
        await new Promise(resolve => setTimeout(resolve, 80));
        localStorage.setItem("calendar-google-active", String(active - 1));
        return { items: [], nextSyncToken: "sync-token" };
      },
      async getEvent() { throw new Error("unused"); },
      async listInstances() { return { items: [] }; },
      async insertEvent(_calendarId, event) {
        const count = Number(localStorage.getItem("calendar-google-inserts") ?? "0") + 1;
        localStorage.setItem("calendar-google-inserts", String(count));
        return { id: "g1", etag: '"etag-1"', ...event };
      },
      async updateEvent() { throw new Error("unused"); },
      async patchEvent() { throw new Error("unexpected patch"); },
      async deleteEvent() { throw new Error("unused"); },
    };
    const adapter = new Google.GoogleCalendarSyncAdapter(
      transport, repo, new IndexedDbSyncStateStore(),
      { id: "shared-connection", googleCalendarId: "remote", localCalendarId: "personal", mode: "publish" },
    );
    return await adapter.sync();
  }, databaseName);

  await Promise.all([run(page), run(second)]);
  const observed = await page.evaluate(() => ({
    inserts: Number(localStorage.getItem("calendar-google-inserts") ?? "0"),
    maxActive: Number(localStorage.getItem("calendar-google-max-active") ?? "0"),
  }));
  expect(observed).toEqual({ inserts: 1, maxActive: 1 });

  const state = await page.evaluate(async databaseName => {
    const { IndexedDbSyncStateStore } = await import("/dist/interoperability/storage.js");
    return await new IndexedDbSyncStateStore().read("shared-connection");
  }, databaseName);
  expect(state.links).toHaveLength(1);
  expect(state.links[0].identity.eventId).toMatch(/^dcal[0-9a-v]{28}$/);

  await second.close();
  await deleteDatabase(page);
});

scenario("storage.cas", "two-tab guarded replacement rejects a durable revision that was not the local delta basis", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const stalePage = await context.newPage();
  await installSilentBroadcastChannel(stalePage);

  await openRepository(page);
  await openRepository(stalePage);
  expect((await repositoryState(stalePage)).revision).toBe(0);

  await createItem(page, event("authoritative", { title: "Authoritative" }));
  expect((await repositoryState(page)).revision).toBe(1);
  expect((await repositoryState(stalePage)).revision).toBe(0);

  const result = await replaceAtRevision(
    stalePage,
    [event("replacement", { title: "Must not commit" })],
    1,
  );
  expect(result).toMatchObject({
    ok: false,
    name: "CalendarStaleRevisionError",
    code: "stale",
    expectedRevision: 1,
    actualRevision: 0,
  });

  const records = await rawRecords(page);
  expect(records.map(record => record.key).sort()).toEqual(["item:authoritative", "meta", "source:personal"]);

  await closeRepository(stalePage);
  await stalePage.close();
  await closeRepository(page);
  await openRepository(page);
  expect((await repositoryState(page)).items.map(item => item.id)).toEqual(["authoritative"]);

  await closeRepository(page);
  await deleteDatabase(page);
});

scenario("storage.broadcast", "BroadcastChannel invalidation converges a passive tab through a burst of commits", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  const observer = await context.newPage();

  await openRepository(page);
  await openRepository(observer);
  await subscribeRevisions(observer);

  for (let index = 1; index <= 8; index += 1) {
    await createItem(page, event(`burst-${index}`, {
      title: `Burst ${index}`,
      start: `2026-11-${String(10 + index).padStart(2, "0")}T09:00:00.000Z`,
      end: `2026-11-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`,
    }));
  }

  await expect.poll(async () => (await repositoryState(observer)).revision).toBe(8);
  const state = await repositoryState(observer);
  expect(state.items).toHaveLength(8);
  expect(state.items.at(-1)?.id).toBe("burst-8");
  expect((await observedRevisions(observer)).at(-1)).toBe(8);

  await closeRepository(observer);
  await observer.close();
  await closeRepository(page);
  await deleteDatabase(page);
});

scenario("storage.focus-fallback", "no-BroadcastChannel fallback refreshes when a passive tab returns to the foreground", async ({ page, context }) => {
  const databaseName = DATABASE_NAME;
  await disableBroadcastChannel(context);
  const observer = await context.newPage();

  await openRepository(page);
  await openRepository(observer);
  expect(await page.evaluate(() => typeof BroadcastChannel)).toBe("undefined");
  expect(await observer.evaluate(() => typeof BroadcastChannel)).toBe("undefined");

  await page.bringToFront();
  await createItem(page, event("fallback", { title: "Fallback invalidation" }));
  await observer.bringToFront();
  await expect.poll(async () => (await repositoryState(observer)).revision, { timeout: 7_000 }).toBe(1);
  expect((await repositoryState(observer)).items.map(item => item.id)).toEqual(["fallback"]);

  await closeRepository(observer);
  await observer.close();
  await closeRepository(page);
  await deleteDatabase(page);
});

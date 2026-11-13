import test from "node:test";
import assert from "node:assert/strict";
import {
  createResourceAvailabilityPlacementGuard,
  createResourceAvailabilityProvider,
  expandResourceAvailabilityDefinitions,
} from "../dist/features/resource-availability.js";

const resources = [
  { id: "rooms", title: "Rooms" },
  { id: "a", title: "Room A", parentId: "rooms", order: 1, acceptsAssignments: true },
  { id: "b", title: "Room B", parentId: "rooms", order: 2, acceptsAssignments: true },
];

const range = { start: "2026-11-09T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" };

test("resource availability expands Calendar recurrence once and fans out deterministic resource ranges", () => {
  const definitions = [{
    id: "office-hours",
    resourceIds: ["b", "a"],
    state: "available",
    start: "2026-11-09T09:00:00Z",
    end: "2026-11-09T17:00:00Z",
    recurrence: { rule: { frequency: "daily", count: 2 } },
    metadata: { origin: "host" },
  }];
  const result = expandResourceAvailabilityDefinitions(resources, definitions, range, { timeZone: "UTC" });
  assert.deepEqual(result.map(item => [item.definitionId, item.resourceId, item.start, item.end]), [
    ["office-hours", "a", "2026-11-09T09:00:00.000Z", "2026-11-09T17:00:00.000Z"],
    ["office-hours", "b", "2026-11-09T09:00:00.000Z", "2026-11-09T17:00:00.000Z"],
    ["office-hours", "a", "2026-11-10T09:00:00.000Z", "2026-11-10T17:00:00.000Z"],
    ["office-hours", "b", "2026-11-10T09:00:00.000Z", "2026-11-10T17:00:00.000Z"],
  ]);
  assert.equal(new Set(result.map(item => item.id)).size, 4);
  assert.deepEqual(result[0].metadata.calendarResourceAvailability, {
    definitionId: "office-hours", resourceId: "a", state: "available",
  });
  assert.equal(result[0].metadata.calendarAvailability, undefined);
  assert.equal(result[0].metadata.origin, "host");
});

test("resource availability rejects unknown, duplicate and group-only resource targets", () => {
  const base = { id: "x", state: "available", start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z" };
  const expand = definition => expandResourceAvailabilityDefinitions(resources, [definition], range, { timeZone: "UTC" });
  assert.throws(() => expand({ ...base, resourceIds: [] }), /non-empty array/i);
  assert.throws(() => expand({ ...base, resourceIds: ["a", "a"] }), /duplicate resource a/i);
  assert.throws(() => expand({ ...base, resourceIds: ["missing"] }), /unknown resource/i);
  assert.throws(() => expand({ ...base, resourceIds: ["rooms"] }), /does not accept assignments/i);
  assert.throws(() => expandResourceAvailabilityDefinitions(resources, [
    { ...base, resourceIds: ["a"] },
    { ...base, resourceIds: ["b"] },
  ], range, { timeZone: "UTC" }), /duplicate resource availability definition/i);
});

test("resource availability provider reads authoritative definitions on each projection and owns no persistence", () => {
  let definitions = [{
    id: "open", resourceIds: ["a"], state: "available",
    start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z",
  }];
  let listener = () => {};
  let unsubscribed = false;
  const provider = createResourceAvailabilityProvider({
    id: "resource-availability",
    timeZone: "UTC",
    definitions: () => definitions,
    subscribe(next) { listener = next; return () => { unsubscribed = true; }; },
  });
  assert.deepEqual(provider.projectAvailability(range, resources).map(item => item.definitionId), ["open"]);
  definitions = [{
    id: "closed", resourceIds: ["b"], state: "unavailable",
    start: "2026-11-09T11:00:00Z", end: "2026-11-09T12:00:00Z",
  }];
  assert.deepEqual(provider.projectAvailability(range, resources).map(item => [item.definitionId, item.resourceId]), [["closed", "b"]]);
  let invalidations = 0;
  const unsubscribe = provider.subscribe(() => { invalidations += 1; });
  listener();
  assert.equal(invalidations, 1);
  unsubscribe();
  assert.equal(unsubscribed, true);
  assert.equal("commit" in provider, false);
});

test("resource availability guard composes with target-resource placement and checks every target resource", async () => {
  const definitions = () => [
    { id: "a-open", resourceIds: ["a"], state: "available", start: "2026-11-09T09:00:00Z", end: "2026-11-09T17:00:00Z" },
    { id: "b-open", resourceIds: ["b"], state: "available", start: "2026-11-09T10:00:00Z", end: "2026-11-09T16:00:00Z" },
    { id: "b-block", resourceIds: ["b"], state: "unavailable", start: "2026-11-09T12:00:00Z", end: "2026-11-09T13:00:00Z" },
  ];
  const guard = createResourceAvailabilityPlacementGuard({
    id: "resource-hours",
    timeZone: "UTC",
    resources: () => resources,
    definitions,
    policy: "require-available",
    mode: "prevent",
  });
  const occurrence = {
    occurrenceId: "occ", sourceItemId: "item", calendarId: "calendar", title: "Visit",
    start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z",
    originalStart: "2026-11-09T10:00:00Z", recurring: false, kind: "event",
    ownership: "host", editPolicy: "full",
  };
  const context = (start, end, toResourceIds) => ({
    occurrence,
    fromResourceIds: ["a"],
    toResourceIds,
    start, end, action: "resource-reassign",
  });
  assert.deepEqual(await guard.evaluate(context("2026-11-09T10:30:00Z", "2026-11-09T11:00:00Z", ["a", "b"])), { mode: "allow" });
  assert.deepEqual(await guard.evaluate(context("2026-11-09T09:30:00Z", "2026-11-09T10:30:00Z", ["a", "b"])), {
    mode: "prevent", message: "Room B: This placement is outside available time.",
  });
  assert.deepEqual(await guard.evaluate(context("2026-11-09T12:15:00Z", "2026-11-09T12:45:00Z", ["b"])), {
    mode: "prevent", message: "Room B: This placement is outside available time.",
  });
  assert.deepEqual(await guard.evaluate(context("2026-11-09T10:30:00Z", "2026-11-09T11:00:00Z", [])), { mode: "allow" });
});

test("exclude-unavailable resource policy can warn without becoming implicit visual enforcement", async () => {
  const guard = createResourceAvailabilityPlacementGuard({
    id: "maintenance",
    timeZone: "UTC",
    resources: () => resources,
    definitions: () => [{
      id: "blocked", resourceIds: ["a"], state: "unavailable",
      start: "2026-11-09T12:00:00Z", end: "2026-11-09T13:00:00Z",
    }],
    policy: "exclude-unavailable",
    mode: "warn",
    message: "Maintenance window.",
  });
  const occurrence = {
    occurrenceId: "occ", sourceItemId: "item", calendarId: "calendar", title: "Visit",
    start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z",
    originalStart: "2026-11-09T10:00:00Z", recurring: false, kind: "event",
    ownership: "host", editPolicy: "full",
  };
  const result = await guard.evaluate({
    occurrence, fromResourceIds: ["a"], toResourceIds: ["a"],
    start: "2026-11-09T12:15:00Z", end: "2026-11-09T12:45:00Z", action: "move",
  });
  assert.deepEqual(result, { mode: "warn", message: "Room A: Maintenance window." });
});


test("resource availability guard reads authoritative resources and definitions once per decision", async () => {
  let resourceReads=0;
  let definitionReads=0;
  const guard=createResourceAvailabilityPlacementGuard({
    id:"stable-snapshot",
    timeZone:"UTC",
    resources(){resourceReads+=1;return resources;},
    definitions(){
      definitionReads+=1;
      return [{id:"open",resourceIds:["a","b"],state:"available",start:"2026-11-09T09:00:00Z",end:"2026-11-09T17:00:00Z"}];
    },
    policy:"require-available",
    mode:"prevent",
  });
  const occurrence={
    occurrenceId:"occ",sourceItemId:"item",calendarId:"calendar",title:"Visit",
    start:"2026-11-09T10:00:00Z",end:"2026-11-09T11:00:00Z",
    originalStart:"2026-11-09T10:00:00Z",recurring:false,kind:"event",ownership:"host",editPolicy:"full",
  };
  assert.deepEqual(await guard.evaluate({
    occurrence,fromResourceIds:["a"],toResourceIds:["a","b"],
    start:"2026-11-09T10:00:00Z",end:"2026-11-09T11:00:00Z",action:"resource-reassign",
  }),{mode:"allow"});
  assert.equal(resourceReads,1);
  assert.equal(definitionReads,1);
});

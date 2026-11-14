import test from "node:test";
import assert from "node:assert/strict";
import {
  executeCalendarResourcePlacement,
  layoutResourceTimeline,
} from "../../../dist/features/resource-scheduler/index.js";
import { layoutResourceTimeGrid } from "../../../dist/features/resource-time-grid/index.js";
import { CalendarCommandStaleError } from "../../../dist/core/commands.js";
import { createSeededRandom, seededInt, seededShuffle } from "../../fixtures/seeded.mjs";

const RANGE = {
  start: "2026-11-10T08:00:00.000Z",
  end: "2026-11-10T18:00:00.000Z",
};
const DAY_RANGE = {
  start: "2026-11-10T00:00:00.000Z",
  end: "2026-11-11T00:00:00.000Z",
};
const resources = [
  { id: "rooms", title: "Rooms" },
  { id: "a", title: "Room A", parentId: "rooms", order: 1, acceptsAssignments: true },
  { id: "b", title: "Room B", parentId: "rooms", order: 2, acceptsAssignments: true },
  { id: "c", title: "Room C", parentId: "rooms", order: 3, acceptsAssignments: true },
  { id: "d", title: "Room D", parentId: "rooms", order: 4, acceptsAssignments: true },
];
const roomIds = ["a", "b", "c", "d"];
const source = { id: "calendar", title: "Calendar", visible: true };

function atMinute(minute) {
  return new Date(Date.parse("2026-11-10T00:00:00.000Z") + minute * 60_000).toISOString();
}

function occurrence(id, startMinute, endMinute) {
  return {
    occurrenceId: id,
    sourceItemId: "item-" + id,
    calendarId: source.id,
    title: id,
    start: atMinute(startMinute),
    end: atMinute(endMinute),
    originalStart: atMinute(startMinute),
    recurring: false,
    kind: "event",
    ownership: "host",
    editPolicy: "full",
  };
}

function generatedSchedule(seed) {
  const random = createSeededRandom(seed);
  const occurrences = [];
  const assignments = [];
  for (let index = 0; index < 9; index += 1) {
    const startSlot = seededInt(random, 0, 31);
    const durationSlots = seededInt(random, 1, Math.min(6, 40 - startSlot));
    const startMinute = 8 * 60 + startSlot * 15;
    const endMinute = startMinute + durationSlots * 15;
    const id = "s" + seed.toString(16) + "-" + index;
    occurrences.push(occurrence(id, startMinute, endMinute));
    const shuffledRooms = seededShuffle(roomIds, random);
    assignments.push({
      occurrenceId: id,
      resourceIds: shuffledRooms.slice(0, seededInt(random, 1, 2)),
    });
  }
  return { occurrences, assignments };
}

function timelineSignature(rows) {
  return [...rows]
    .sort((a, b) => a.renderId.localeCompare(b.renderId))
    .map(row => [
      row.renderId,
      row.resourceId,
      row.resourceRow,
      row.xMinutes,
      row.widthMinutes,
      row.lane,
      row.laneCount,
    ]);
}

function gridSignature(rows) {
  return [...rows]
    .sort((a, b) => a.renderId.localeCompare(b.renderId))
    .map(row => [
      row.renderId,
      row.dayKey,
      row.resourceId,
      row.topMinutes,
      row.heightMinutes,
      row.column,
      row.columnCount,
    ]);
}

function overlaps(left, right) {
  return Date.parse(left.start) < Date.parse(right.end)
    && Date.parse(left.end) > Date.parse(right.start);
}

test("seeded resource layouts are permutation-independent bounded and collision-safe", () => {
  for (const seed of [0x10203, 0x5eed, 0xabc123, 0x314159, 0xdecafbad, 0x7f4a7c15]) {
    const { occurrences, assignments } = generatedSchedule(seed);
    const timeline = layoutResourceTimeline(resources, occurrences, assignments, RANGE, { timeZone: "UTC" });
    const grid = layoutResourceTimeGrid(resources, occurrences, assignments, DAY_RANGE, {
      timeZone: "UTC",
      startMinute: 8 * 60,
      endMinute: 18 * 60,
    });
    const expectedTimeline = timelineSignature(timeline);
    const expectedGrid = gridSignature(grid.timed);

    const random = createSeededRandom(seed ^ 0xa5a5a5a5);
    const permutedResources = seededShuffle(resources, random);
    const permutedOccurrences = seededShuffle(occurrences, random);
    const permutedAssignments = seededShuffle(assignments, random)
      .map(assignment => ({ ...assignment, resourceIds: seededShuffle(assignment.resourceIds, random) }));

    assert.deepEqual(
      timelineSignature(layoutResourceTimeline(permutedResources, permutedOccurrences, permutedAssignments, RANGE, { timeZone: "UTC" })),
      expectedTimeline,
      "timeline permutation law for seed " + seed,
    );
    assert.deepEqual(
      gridSignature(layoutResourceTimeGrid(permutedResources, permutedOccurrences, permutedAssignments, DAY_RANGE, {
        timeZone: "UTC",
        startMinute: 8 * 60,
        endMinute: 18 * 60,
      }).timed),
      expectedGrid,
      "time-grid permutation law for seed " + seed,
    );

    const expectedRenderCount = assignments.reduce((sum, assignment) => sum + assignment.resourceIds.length, 0);
    assert.equal(timeline.length, expectedRenderCount);
    assert.equal(grid.timed.length, expectedRenderCount);
    assert.equal(new Set(timeline.map(row => row.renderId)).size, expectedRenderCount);
    assert.equal(new Set(grid.timed.map(row => row.renderId)).size, expectedRenderCount);

    for (const resourceId of roomIds) {
      const scopedAssignments = assignments
        .filter(assignment => assignment.resourceIds.includes(resourceId))
        .map(assignment => ({ occurrenceId: assignment.occurrenceId, resourceIds: [resourceId] }));
      const scopedTimeline = layoutResourceTimeline(resources, occurrences, scopedAssignments, RANGE, { timeZone: "UTC" });
      const fullTimelineRows = timeline
        .filter(row => row.resourceId === resourceId)
        .map(row => [row.occurrenceId, row.xMinutes, row.widthMinutes, row.lane, row.laneCount]);
      const scopedTimelineRows = scopedTimeline
        .filter(row => row.resourceId === resourceId)
        .map(row => [row.occurrenceId, row.xMinutes, row.widthMinutes, row.lane, row.laneCount]);
      assert.deepEqual(scopedTimelineRows, fullTimelineRows, "unrelated resources must not perturb timeline lanes for seed " + seed);

      const scopedGrid = layoutResourceTimeGrid(resources, occurrences, scopedAssignments, DAY_RANGE, {
        timeZone: "UTC",
        startMinute: 8 * 60,
        endMinute: 18 * 60,
      });
      const fullGridRows = grid.timed
        .filter(row => row.resourceId === resourceId)
        .map(row => [row.occurrenceId, row.topMinutes, row.heightMinutes, row.column, row.columnCount]);
      const scopedGridRows = scopedGrid.timed
        .filter(row => row.resourceId === resourceId)
        .map(row => [row.occurrenceId, row.topMinutes, row.heightMinutes, row.column, row.columnCount]);
      assert.deepEqual(scopedGridRows, fullGridRows, "unrelated resources must not perturb time-grid lanes for seed " + seed);
    }

    for (const row of timeline) {
      assert.ok(row.xMinutes >= 0, "timeline x lower bound seed " + seed);
      assert.ok(row.widthMinutes > 0, "timeline interval width seed " + seed);
      assert.ok(row.xMinutes + row.widthMinutes <= 600, "timeline x upper bound seed " + seed);
      assert.ok(row.lane >= 0 && row.lane < row.laneCount);
    }
    for (const row of grid.timed) {
      assert.ok(row.topMinutes >= 8 * 60, "grid y lower bound seed " + seed);
      assert.ok(row.heightMinutes > 0, "grid interval height seed " + seed);
      assert.ok(row.topMinutes + row.heightMinutes <= 18 * 60, "grid y upper bound seed " + seed);
      assert.ok(row.column >= 0 && row.column < row.columnCount);
    }

    for (let left = 0; left < timeline.length; left += 1) {
      for (let right = left + 1; right < timeline.length; right += 1) {
        const a = timeline[left];
        const b = timeline[right];
        if (a.resourceId !== b.resourceId || !overlaps(a.occurrence, b.occurrence)) continue;
        assert.notEqual(a.lane, b.lane, "overlapping timeline rows share lane for seed " + seed);
      }
    }
    for (let left = 0; left < grid.timed.length; left += 1) {
      for (let right = left + 1; right < grid.timed.length; right += 1) {
        const a = grid.timed[left];
        const b = grid.timed[right];
        if (a.resourceId !== b.resourceId || a.dayKey !== b.dayKey || !overlaps(a.occurrence, b.occurrence)) continue;
        assert.notEqual(a.column, b.column, "overlapping grid rows share column for seed " + seed);
      }
    }
  }
});

test("seeded resource placement outcomes preserve atomic host state on warning prevention and stale rejection", async () => {
  const modes = ["success", "warning", "prevented", "stale"];

  for (const seed of [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888]) {
    const random = createSeededRandom(seed);
    const mode = modes[seed % modes.length];
    const fromResource = roomIds[seededInt(random, 0, roomIds.length - 1)];
    const targetChoices = roomIds.filter(id => id !== fromResource);
    const toResource = targetChoices[seededInt(random, 0, targetChoices.length - 1)];
    const startMinute = 9 * 60 + seededInt(random, 0, 12) * 15;
    const duration = seededInt(random, 2, 5) * 15;
    const shift = seededInt(random, 1, 4) * 15;
    const row = occurrence("placement-" + seed, startMinute, startMinute + duration);

    const host = {
      state: {
        resourceIds: [fromResource],
        start: row.start,
        end: row.end,
        revision: 7,
      },
    };
    const before = structuredClone(host.state);
    let attempts = 0;
    const request = {
      occurrence: row,
      sourceResourceId: fromResource,
      targetResourceId: toResource,
      fromResourceIds: [fromResource],
      toResourceIds: [toResource],
      start: atMinute(startMinute + shift),
      end: atMinute(startMinute + duration + shift),
      scope: "this",
      timeZone: "UTC",
      action: "resource-time-move",
      assignmentVersion: { revision: mode === "stale" ? 6 : 7 },
    };
    const options = {
      source,
      occurrenceCapabilityProvider: { capabilities() { return { canMove: true }; } },
      resourceCapabilityProvider: {
        capabilities() { return { canReassign: mode !== "prevented" }; },
      },
      ...(mode === "warning"
        ? { resourceGuards: [{ id: "warn", evaluate() { return { mode: "warn", message: "Seeded warning" }; } }] }
        : {}),
      mutationPort: {
        commit(change) {
          attempts += 1;
          if (change.assignmentVersion?.revision !== host.state.revision) {
            throw new CalendarCommandStaleError("seeded stale assignment");
          }
          host.state = {
            resourceIds: [...change.toResourceIds],
            start: change.start,
            end: change.end,
            revision: host.state.revision + 1,
          };
        },
      },
    };

    const result = await executeCalendarResourcePlacement(resources, request, options);
    if (mode === "success") {
      assert.equal(result.status, "committed");
      assert.equal(attempts, 1);
      assert.deepEqual(host.state, {
        resourceIds: [toResource],
        start: request.start,
        end: request.end,
        revision: 8,
      });
    } else if (mode === "warning") {
      assert.equal(result.status, "warning");
      assert.equal(attempts, 0);
      assert.deepEqual(host.state, before);
    } else if (mode === "prevented") {
      assert.equal(result.status, "prevented");
      assert.equal(attempts, 0);
      assert.deepEqual(host.state, before);
    } else {
      assert.equal(result.status, "stale");
      assert.equal(attempts, 1);
      assert.deepEqual(host.state, before, "stale version rejection must precede any host state replacement");
    }
  }
});

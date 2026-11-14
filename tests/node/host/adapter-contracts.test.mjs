import test from "node:test";
import assert from "node:assert/strict";
import * as Calendar from "../../../dist/index.js";
import { CalendarIntegrationInvalidationNotifier } from "../../../dist/integration/common.js";
import { PracticeDeskLiveProjection } from "../../../dist/integration/practice-desk.js";
import {
  createRevisionDirectorPresentationExtension,
  RevisionDirectorLiveProjection,
} from "../../../dist/integration/revision-director.js";

const RANGE = Object.freeze({
  start: "2026-11-08T00:00:00.000Z",
  end: "2026-11-10T00:00:00.000Z",
});

test("Practice Desk working-shape scheduling evidence stays host-owned while Calendar receives only due-card projection", async () => {
  const card = {
    recordType: "learning-card",
    saveRevision: 7,
    id: "learning-card:q-12",
    question: { id: "q-12" },
    answer: { type: "single", optionId: "b" },
    stimuli: [],
    assets: [],
    examId: "pfrda",
    paperId: "mock-3",
    paperEdition: "2026",
    sectionTitle: "General Stream",
    sourceTitle: "PFRDA Mock 3",
    sourceAttemptId: "attempt-3",
    note: "",
    errorLabel: "conceptual",
    customTopic: "Marginal costing",
    customSubject: "Costing",
    bookmarked: true,
    revisionDisposition: "active",
    createdAt: "2026-11-06T09:15:00.000Z",
    updatedAt: "2026-11-07T09:16:00.000Z",
    reviews: [{
      at: "2026-11-07T09:15:00.000Z",
      rating: 2,
      durationMs: 61_000,
      state: "review",
    }],
  };
  const scheduler = {
    provider: "ts-fsrs",
    configuration: {
      model: "FSRS-7",
      packageVersion: "6.0.0",
      retentionPolicy: "cost-adr",
      desiredRetention: 0.9,
      costAdrGoalWeight: 0.4,
      weights: "FSRS-7-custom",
      leechAction: "suspend",
    },
    replay(id, createdAt, reviews) {
      assert.equal(id, card.id);
      assert.equal(createdAt, card.createdAt);
      assert.deepEqual(reviews, card.reviews);
      return { dueAt: new Date("2026-11-08T12:30:00.000Z") };
    },
  };
  const attempt = {
    recordType: "generic-attempt",
    saveRevision: 4,
    id: "attempt-3",
    packageId: "PFRDA Mock 3",
    startedAt: Date.parse("2026-11-06T08:30:00.000Z"),
    updatedAt: Date.parse("2026-11-06T09:10:00.000Z"),
    finishedAt: Date.parse("2026-11-06T09:10:00.000Z"),
    frozen: { snapshot: { examId: "pfrda" }, paper: { paperId: "mock-3" } },
    state: { elapsedMs: 2_400_000 },
    completionReason: "submitted",
  };
  const seenRanges = [];
  const host = {
    readCalendar(range) {
      seenRanges.push(structuredClone(range));
      const due = scheduler.replay(card.id, card.createdAt, card.reviews).dueAt;
      return {
        attempts: [{
          id: attempt.id,
          examId: attempt.frozen.snapshot.examId,
          paperId: attempt.frozen.paper.paperId,
          title: attempt.packageId,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          elapsedMs: attempt.state.elapsedMs,
        }],
        dueCards: [{
          id: card.id,
          examId: card.examId,
          paperId: card.paperId,
          title: card.customTopic || card.sourceTitle,
          topic: card.customTopic,
          dueAt: due.toISOString(),
        }],
      };
    },
  };

  const items = await new PracticeDeskLiveProjection(host).project(RANGE);
  assert.deepEqual(seenRanges, [RANGE]);
  const due = items.find(item => item.calendarId === "practice-desk:revision");
  assert.ok(due);
  assert.equal(due.temporalForm, "point");
  assert.equal(due.start, due.end);
  assert.equal(due.metadata?.dueAt, "2026-11-08T12:30:00.000Z");
  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /durationMs|RevisionMemoryState|FSRS-7|cost-adr|weights|leech/i);
});

test("Revision Director working-shape service records are joined host-side and Calendar sees only the range projection", async () => {
  const profile = {
    schemaVersion: 1, id: "profile-pfrda", name: "PFRDA Grade A", examDate: "2026-11-20",
    status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const nodes = [
    { schemaVersion: 1, id: "subject-finance", profileId: profile.id, parentId: null, kind: "subject", name: "Finance", normalizedName: "finance", createdAt: profile.createdAt, updatedAt: profile.updatedAt },
    { schemaVersion: 1, id: "section-costing", profileId: profile.id, parentId: "subject-finance", kind: "section", name: "Costing", normalizedName: "costing", createdAt: profile.createdAt, updatedAt: profile.updatedAt },
    { schemaVersion: 1, id: "topic-bep", profileId: profile.id, parentId: "section-costing", kind: "topic", name: "Break-even", normalizedName: "break-even", createdAt: profile.createdAt, updatedAt: profile.updatedAt },
  ];
  const unit = {
    schemaVersion: 1, id: "unit-bep", profileId: profile.id, topicNodeId: "topic-bep",
    title: "Break-even analysis", scope: "Core formulas", source: "Notes", importance: 3,
    status: "active", createdAt: profile.createdAt, updatedAt: profile.updatedAt,
    evidenceCount: 2, lapseCount: 1,
  };
  const obligation = {
    schemaVersion: 1, id: "obl-bep", unitId: unit.id, type: "memory-recall", status: "active",
    dueAt: "2026-11-08T03:30:00.000Z", expectedMinutes: 25, baselineMinutes: 25,
    durationSampleCount: 2, protocol: "Recall formulas", successCriteria: "Correct reconstruction",
    workflow: { kind: "recall", prompt: "Recall", checkpoints: [], responseMedium: "mental" },
    freshnessDays: 30, priority: 3,
    policyState: { engine: "ts-fsrs", version: "FSRS-7", stage: 1, successStreak: 2, failureCount: 1, lastIntervalDays: 4 },
    createdAt: profile.createdAt, updatedAt: profile.updatedAt,
  };
  const dailyPlan = {
    schemaVersion: 1,
    id: "plan-2026-11-08",
    studyDayKey: "2026-11-08",
    createdAt: "2026-11-08T00:30:00.000Z",
    updatedAt: "2026-11-08T00:30:00.000Z",
    plannerVersion: "current",
    versions: [{
      version: 1,
      generatedAt: "2026-11-08T00:30:00.000Z",
      capacityMinutes: 90,
      reason: "initial",
      items: [{
        key: obligation.id, obligationId: obligation.id, profileId: profile.id, unitId: unit.id,
        subject: "Finance", workflow: "recall", title: unit.title, estimatedMinutes: 25,
        score: 88, disposition: "selected", reasons: ["overdue", "exam proximity"],
      }],
    }],
    outcomes: [{ itemKey: obligation.id, status: "planned" }],
  };

  const seenRanges = [];
  const host = {
    readCalendar(range) {
      seenRanges.push(structuredClone(range));
      const nodeById = new Map(nodes.map(node => [node.id, node]));
      const topic = nodeById.get(unit.topicNodeId);
      const section = topic?.parentId ? nodeById.get(topic.parentId) : undefined;
      const subject = section?.parentId ? nodeById.get(section.parentId) : undefined;
      return {
        obligations: [{
          id: obligation.id,
          unitId: obligation.unitId,
          title: unit.title,
          subject: subject?.name,
          type: obligation.type,
          status: obligation.status,
          dueAt: obligation.dueAt,
          expectedMinutes: obligation.expectedMinutes,
          examId: unit.profileId,
        }],
        dailyPlans: [{
          id: dailyPlan.id,
          studyDayKey: dailyPlan.studyDayKey,
          versions: dailyPlan.versions.map(version => ({
            version: version.version,
            generatedAt: version.generatedAt,
            items: version.items.map(item => ({
              key: item.key,
              obligationId: item.obligationId,
              profileId: item.profileId,
              unitId: item.unitId,
              subject: item.subject,
              workflow: item.workflow,
              title: item.title,
              estimatedMinutes: item.estimatedMinutes,
              disposition: item.disposition,
            })),
          })),
          outcomes: dailyPlan.outcomes,
        }],
        exams: [{ id: profile.id, name: profile.name, examDate: profile.examDate }],
      };
    },
  };

  const items = await new RevisionDirectorLiveProjection(host).project(RANGE);
  assert.deepEqual(seenRanges, [RANGE]);
  const due = items.find(item => item.calendarId === "revision-director:due");
  assert.ok(due);
  assert.equal(due.temporalForm, "point");
  assert.equal(due.start, due.end);
  assert.equal(due.metadata?.subject, "Finance");
  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /policyState|plannerVersion|score|reasons|baselineMinutes|durationSampleCount/);
});

test("host invalidation is explicit, subscription-based and controller-notifier compatible", () => {
  const notifier = new CalendarIntegrationInvalidationNotifier();
  const host = {
    calendarInvalidation: notifier,
    readCalendar() { return { attempts: [], dueCards: [] }; },
  };
  const projection = new PracticeDeskLiveProjection(host);
  let calls = 0;
  const unsubscribe = projection.subscribe(() => { calls += 1; });
  notifier.notify();
  assert.equal(calls, 1);
  unsubscribe();
  notifier.notify();
  assert.equal(calls, 1);
});

test("Revision overdue presentation follows Calendar semantic now rather than ambient wall-clock time", async () => {
  const item = (await new RevisionDirectorLiveProjection({
    readCalendar() {
      return {
        obligations: [{
          id: "obl", unitId: "unit", title: "Recall", type: "memory-recall", status: "active",
          dueAt: "2026-11-08T03:30:00.000Z", expectedMinutes: 20,
        }],
      };
    },
  }).project(RANGE))[0];
  assert.ok(item);
  const occurrence = Calendar.occurrenceFromItem(item);
  const extension = createRevisionDirectorPresentationExtension();

  extension.prepare?.({
    occurrences: [occurrence],
    range: RANGE,
    timeZone: "UTC",
    now: new Date("2026-11-08T03:00:00.000Z"),
  });
  assert.equal(extension.presentOccurrence?.(occurrence), undefined);

  extension.prepare?.({
    occurrences: [occurrence],
    range: RANGE,
    timeZone: "UTC",
    now: new Date("2026-11-08T04:00:00.000Z"),
  });
  const presentation = extension.presentOccurrence?.(occurrence);
  assert.deepEqual(presentation?.badges, [{ label: "Overdue" }]);
  assert.deepEqual(presentation?.classNames, ["revision-director-overdue"]);
});

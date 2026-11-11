import type { CalendarItem, CalendarProjectionProvider, CalendarRepository, ISODateTime } from "../core/types.js";
import { toDate } from "../core/time.js";
import type {
  RevisionDirectorCalendarInput,
  RevisionDirectorDailyPlanRecord,
  RevisionDirectorExam,
  RevisionDirectorObligation,
} from "../adapters/revision-director.js";
import { RevisionDirectorProjection } from "../adapters/revision-director.js";
import { createCalendarIntegrationId } from "./id.js";

/** Calendar-relevant subsets of the current Revision Director domain records. */
export interface RevisionDirectorRawObligation {
  readonly id: string;
  readonly unitId: string;
  readonly type: string;
  readonly status: string;
  readonly dueAt: ISODateTime;
  readonly expectedMinutes: number;
}
export interface RevisionDirectorRawUnit {
  readonly id: string;
  readonly profileId: string;
  readonly topicNodeId: string;
  readonly title: string;
}
export interface RevisionDirectorRawNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: "subject" | "section" | "topic";
  readonly name: string;
}
export interface RevisionDirectorRawProfile {
  readonly id: string;
  readonly name: string;
  readonly examDate: string;
  readonly status: string;
}

/** Mirrors public RevisionService read methods, so host glue is minimal after the merge. */
export interface RevisionDirectorCalendarHost {
  obligations(): readonly RevisionDirectorRawObligation[] | Promise<readonly RevisionDirectorRawObligation[]>;
  units(): readonly RevisionDirectorRawUnit[] | Promise<readonly RevisionDirectorRawUnit[]>;
  nodes(): readonly RevisionDirectorRawNode[] | Promise<readonly RevisionDirectorRawNode[]>;
  profiles(): readonly RevisionDirectorRawProfile[] | Promise<readonly RevisionDirectorRawProfile[]>;
  dailyPlanHistory(): readonly RevisionDirectorDailyPlanRecord[] | Promise<readonly RevisionDirectorDailyPlanRecord[]>;
  markReviewTargetsStarted?(targets: string[], now: Date): Promise<void> | void;
}

export interface RevisionScheduleRequest {
  readonly obligationId: string;
  readonly title: string;
  readonly start: ISODateTime;
  readonly durationMinutes: number;
  readonly dueAt: ISODateTime;
  readonly subject?: string;
  readonly examId?: string;
  readonly chunkId?: string;
}

export function joinRevisionDirectorObligations(
  obligations: readonly RevisionDirectorRawObligation[],
  units: readonly RevisionDirectorRawUnit[],
  nodes: readonly RevisionDirectorRawNode[],
): RevisionDirectorObligation[] {
  const unitById = new Map(units.map(unit => [unit.id, unit] as const));
  const nodeById = new Map(nodes.map(node => [node.id, node] as const));
  return obligations.flatMap(obligation => {
    const unit = unitById.get(obligation.unitId);
    if (!unit) return [];
    const topic = nodeById.get(unit.topicNodeId);
    const section = topic?.parentId ? nodeById.get(topic.parentId) : undefined;
    const subject = section?.parentId ? nodeById.get(section.parentId) : undefined;
    return [{
      id: obligation.id,
      unitId: obligation.unitId,
      title: unit.title,
      ...(subject?.kind === "subject" ? { subject: subject.name } : {}),
      type: obligation.type,
      status: obligation.status,
      dueAt: obligation.dueAt,
      expectedMinutes: obligation.expectedMinutes,
      examId: unit.profileId,
    }];
  });
}

export function revisionDirectorExams(profiles: readonly RevisionDirectorRawProfile[]): RevisionDirectorExam[] {
  return profiles.filter(profile => profile.status === "active" && profile.examDate).map(profile => ({ id: profile.id, name: profile.name, examDate: profile.examDate }));
}

/** Calendar-owned placement for revision work. It never mutates Revision Director/FSRS dueAt. */
export class RevisionCalendarScheduler {
  public constructor(
    private readonly repository: CalendarRepository,
    private readonly host?: Pick<RevisionDirectorCalendarHost, "markReviewTargetsStarted">,
  ) {}

  public async schedule(request: RevisionScheduleRequest): Promise<CalendarItem> {
    const start = toDate(request.start);
    const end = new Date(start.getTime() + Math.max(1, request.durationMinutes) * 60_000);
    const id = `revision-scheduled:${createCalendarIntegrationId()}`;
    const item: CalendarItem = {
      id,
      calendarId: "revision-director:scheduled",
      title: request.title,
      start: start.toISOString(),
      end: end.toISOString(),
      kind: "revision",
      ownership: "revision-plan",
      editPolicy: "schedule-only",
      metadata: {
        app: "revision-director",
        sourceId: request.obligationId,
        dueAt: request.dueAt,
        plannedMinutes: request.durationMinutes,
        subject: request.subject,
        examId: request.examId,
        chunkId: request.chunkId,
        scheduleAuthority: "director-calendar",
      },
    };
    await this.repository.create(item);
    return item;
  }

  public async markStarted(item: CalendarItem, now = new Date()): Promise<void> {
    if (item.calendarId !== "revision-director:scheduled" || item.ownership !== "revision-plan" || item.editPolicy !== "schedule-only" || item.metadata?.app !== "revision-director") throw new Error("Not a scheduled revision item.");
    const obligationId = item.metadata.sourceId;
    if (typeof obligationId !== "string") throw new Error("Scheduled revision item has no obligation identity.");
    const chunkId = item.metadata.chunkId;
    const target = typeof chunkId === "string" && chunkId ? `chunk:${chunkId}` : obligationId;
    await this.host?.markReviewTargetsStarted?.([target], now);
  }
}

export class RevisionDirectorLiveProjection extends RevisionDirectorProjection implements CalendarProjectionProvider {
  public constructor(host: RevisionDirectorCalendarHost) {
    super(async _range => {
      const [obligations, units, nodes, profiles, dailyPlans] = await Promise.all([
        host.obligations(), host.units(), host.nodes(), host.profiles(), host.dailyPlanHistory(),
      ]);
      return {
        obligations: joinRevisionDirectorObligations(obligations, units, nodes),
        dailyPlans,
        exams: revisionDirectorExams(profiles),
      } satisfies RevisionDirectorCalendarInput;
    });
  }
}

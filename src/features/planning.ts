import type {
  CalendarItem, CalendarItemKind, CalendarOccurrence, ISODate, ISODateTime, CalendarOwnership, EditPolicy, CalendarDisplay,
} from "../core/types.js";
import type { CalendarUiExtension, CalendarUiExtensionContext, CalendarOccurrencePresentation } from "../view/types.js";
import { dateKey, startOfDay, toDate } from "../core/time.js";

export interface PlannedActualPair {
  readonly relationId: string;
  readonly planned?: CalendarOccurrence;
  readonly actual?: CalendarOccurrence;
  readonly plannedMinutes?: number;
  readonly actualMinutes?: number;
  readonly varianceMinutes?: number;
  readonly completionRatio?: number;
}

export interface PlanningSemantics {
  readonly relationId?: (occurrence: CalendarOccurrence) => string | undefined;
  readonly relationRole?: (occurrence: CalendarOccurrence) => "planned" | "actual" | undefined;
  readonly plannedMinutes?: (occurrence: CalendarOccurrence) => number | undefined;
  readonly actualMinutes?: (occurrence: CalendarOccurrence) => number | undefined;
  readonly isMilestone?: (occurrence: CalendarOccurrence) => boolean;
  readonly isDeadline?: (occurrence: CalendarOccurrence) => boolean;
}

function defaultRelationId(occurrence: CalendarOccurrence): string | undefined {
  return typeof occurrence.metadata?.relationId === "string" ? occurrence.metadata.relationId : undefined;
}
function defaultRelationRole(occurrence: CalendarOccurrence): "planned" | "actual" | undefined {
  return occurrence.metadata?.relationRole === "planned" || occurrence.metadata?.relationRole === "actual" ? occurrence.metadata.relationRole : undefined;
}
function durationMinutes(occurrence: CalendarOccurrence): number {
  return Math.max(0, (toDate(occurrence.end).getTime() - toDate(occurrence.start).getTime()) / 60_000);
}
function defaultPlannedMinutes(occurrence: CalendarOccurrence): number | undefined {
  return typeof occurrence.metadata?.plannedMinutes === "number" ? occurrence.metadata.plannedMinutes : defaultRelationRole(occurrence) === "planned" ? durationMinutes(occurrence) : undefined;
}
function defaultActualMinutes(occurrence: CalendarOccurrence): number | undefined {
  return typeof occurrence.metadata?.actualMinutes === "number" ? occurrence.metadata.actualMinutes : defaultRelationRole(occurrence) === "actual" ? durationMinutes(occurrence) : undefined;
}
function defaultMilestone(occurrence: CalendarOccurrence): boolean {
  return occurrence.kind === "deadline" || occurrence.kind === "milestone" || occurrence.metadata?.relationRole === "milestone";
}
function defaultDeadline(occurrence: CalendarOccurrence): boolean { return occurrence.kind === "deadline"; }

function resolvedSemantics(input: PlanningSemantics = {}): Required<PlanningSemantics> {
  return {
    relationId: input.relationId ?? defaultRelationId,
    relationRole: input.relationRole ?? defaultRelationRole,
    plannedMinutes: input.plannedMinutes ?? defaultPlannedMinutes,
    actualMinutes: input.actualMinutes ?? defaultActualMinutes,
    isMilestone: input.isMilestone ?? defaultMilestone,
    isDeadline: input.isDeadline ?? defaultDeadline,
  };
}

export function plannedActualPairs(occurrences: readonly CalendarOccurrence[], semantics: PlanningSemantics = {}): readonly PlannedActualPair[] {
  const rules = resolvedSemantics(semantics);
  const rows = new Map<string, { planned?: CalendarOccurrence; actual?: CalendarOccurrence }>();
  for (const occurrence of occurrences) {
    const relationId = rules.relationId(occurrence);
    const role = rules.relationRole(occurrence);
    if (!relationId || !role) continue;
    const row = rows.get(relationId) ?? {};
    if (role === "planned") row.planned = occurrence; else row.actual = occurrence;
    rows.set(relationId, row);
  }
  return [...rows].map(([relationId, row]) => {
    const plannedMinutes = row.planned ? rules.plannedMinutes(row.planned) : undefined;
    const actualMinutes = row.actual ? rules.actualMinutes(row.actual) : undefined;
    const p = plannedMinutes !== undefined && Number.isFinite(plannedMinutes) && plannedMinutes > 0 ? plannedMinutes : undefined;
    const a = actualMinutes !== undefined && Number.isFinite(actualMinutes) && actualMinutes >= 0 ? actualMinutes : undefined;
    return {
      relationId, ...row,
      ...(p !== undefined ? { plannedMinutes: p } : {}),
      ...(a !== undefined ? { actualMinutes: a } : {}),
      ...(p !== undefined && a !== undefined ? { varianceMinutes: a - p, completionRatio: a / p } : {}),
    };
  });
}

export function createMilestoneItem(input: {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly date: ISODate;
  readonly kind: CalendarItemKind;
  readonly description?: string;
  readonly category?: string;
  readonly metadata?: CalendarItem["metadata"];
  readonly ownership?: CalendarOwnership;
  readonly editPolicy?: EditPolicy;
  readonly display?: CalendarDisplay;
  readonly now?: ISODateTime;
}): CalendarItem {
  const start = input.date;
  const p = input.date.split("-").map(Number);
  const next = new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]! + 1)).toISOString().slice(0, 10);
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id, calendarId: input.calendarId, title: input.title,
    ...(input.description ? { description: input.description } : {}),
    start, end: next, allDay: true, precision: "date", temporal: { kind: "date" }, kind: input.kind,
    ownership: input.ownership ?? "calendar", editPolicy: input.editPolicy ?? "full",
    display: input.display ?? { emphasis: input.kind === "deadline" ? "critical" : "strong" },
    metadata: { ...(input.metadata ?? {}), ...(input.category ? { category: input.category } : {}), relationRole: "milestone" },
    createdAt: now, updatedAt: now,
  };
}

export const PLANNING_CALENDAR_CSS = `
.dc-planning-actual{opacity:.78}
.dc-planning-compared-planned{outline:1px dashed color-mix(in srgb,var(--dc-accent) 72%,transparent);outline-offset:-2px}
.dc-planning-compared-actual{border-style:dashed}
.dc-planning-overdue{box-shadow:inset 3px 0 0 var(--dc-danger)}
`;

export function createPlanningUiExtension(semantics: PlanningSemantics = {}): CalendarUiExtension {
  const rules = resolvedSemantics(semantics);
  let pairs = new Map<string, PlannedActualPair>();
  let overdue = new Set<string>();
  let daySummary = new Map<string, string>();
  let currentTimeZone = "UTC";

  return {
    styles: PLANNING_CALENDAR_CSS,
    prepare(context: CalendarUiExtensionContext): void {
      currentTimeZone = context.timeZone;
      pairs = new Map();
      for (const pair of plannedActualPairs(context.occurrences, rules)) {
        if (pair.planned) pairs.set(pair.planned.occurrenceId, pair);
        if (pair.actual) pairs.set(pair.actual.occurrenceId, pair);
      }
      overdue = new Set();
      const totals = new Map<string, { planned: number; actual: number }>();
      const today = startOfDay(context.now, context.timeZone).getTime();
      for (const occurrence of context.occurrences) {
        if (rules.isDeadline(occurrence) && toDate(occurrence.start, context.timeZone).getTime() < today) overdue.add(occurrence.occurrenceId);
        const key = dateKey(occurrence.start, context.timeZone);
        const row = totals.get(key) ?? { planned: 0, actual: 0 };
        row.planned += rules.plannedMinutes(occurrence) ?? 0;
        row.actual += rules.actualMinutes(occurrence) ?? 0;
        totals.set(key, row);
      }
      daySummary = new Map([...totals].map(([key, row]) => {
        const text = `${row.planned ? `Plan ${Math.round(row.planned)}m` : ""}${row.planned && row.actual ? " · " : ""}${row.actual ? `Actual ${Math.round(row.actual)}m` : ""}`;
        return [key, text] as const;
      }).filter(([, text]) => Boolean(text)));
    },
    presentOccurrence(occurrence: CalendarOccurrence): CalendarOccurrencePresentation | undefined {
      const role = rules.relationRole(occurrence);
      const pair = pairs.get(occurrence.occurrenceId);
      const classes: string[] = [];
      if (role === "actual") classes.push("dc-planning-actual");
      if (pair && role === "planned") classes.push("dc-planning-compared-planned");
      if (pair && role === "actual") classes.push("dc-planning-compared-actual");
      if (overdue.has(occurrence.occurrenceId)) classes.push("dc-planning-overdue");
      const detailRows = pair?.plannedMinutes !== undefined || pair?.actualMinutes !== undefined
        ? [{ label: "Plan vs actual", value: [pair.plannedMinutes !== undefined ? `Planned ${Math.round(pair.plannedMinutes * 10) / 10}m` : "", pair.actualMinutes !== undefined ? `Actual ${Math.round(pair.actualMinutes * 10) / 10}m` : "", pair.varianceMinutes !== undefined ? `${pair.varianceMinutes >= 0 ? "+" : ""}${Math.round(pair.varianceMinutes * 10) / 10}m variance` : ""].filter(Boolean).join(" · ") }]
        : undefined;
      const agendaMeta = pair?.plannedMinutes !== undefined && pair.actualMinutes !== undefined
        ? `Planned ${Math.round(pair.plannedMinutes * 10) / 10}m · Actual ${Math.round(pair.actualMinutes * 10) / 10}m · ${pair.varianceMinutes! >= 0 ? "+" : ""}${Math.round(pair.varianceMinutes! * 10) / 10}m`
        : undefined;
      if (!classes.length && !detailRows && !agendaMeta && !rules.isMilestone(occurrence)) return undefined;
      return {
        ...(classes.length ? { classNames: classes } : {}),
        ...(role ? { data: { planningRole: role } } : {}),
        ...(agendaMeta ? { agendaMeta } : {}),
        ...(rules.isMilestone(occurrence) ? { agendaOrder: -100 } : {}),
        ...(detailRows ? { detailRows } : {}),
      };
    },
    presentAgendaDay(date: ISODate): { readonly summary?: string } | undefined {
      const summary = daySummary.get(dateKey(date, currentTimeZone));
      return summary ? { summary } : undefined;
    },
  };
}

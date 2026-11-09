import type { CalendarOccurrence } from "../core/types.js";
import type {
  CalendarOccurrencePresentation,
  CalendarPresentationBadge,
  CalendarPresentationContent,
  CalendarSourceAction,
  CalendarSourceActionPort,
  CalendarUiExtension,
} from "./types.js";

const MAX_PRESENTATION_TEXT = 4_096;
const MAX_PRESENTATION_CLASSES = 32;
const MAX_PRESENTATION_DATA = 32;
const MAX_PRESENTATION_BADGES = 16;
const MAX_PRESENTATION_DETAIL_ROWS = 32;
const MAX_PRESENTATION_AGENDA_META = 16;
const MAX_SOURCE_ACTIONS = 32;



function validText(value: unknown, max = MAX_PRESENTATION_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export interface ResolvedCalendarPresentationContent {
  readonly text: string;
  readonly accessibleLabel?: string | undefined;
}

export interface ResolvedCalendarOccurrencePresentation {
  readonly classNames: readonly string[];
  readonly data: Readonly<Record<string, string>>;
  readonly agendaMeta: readonly string[];
  readonly agendaOrder: number;
  readonly detailRows: readonly { readonly label: string; readonly value: string }[];
  readonly accessibleLabel?: string | undefined;
  readonly icon?: ResolvedCalendarPresentationContent | undefined;
  readonly leading?: ResolvedCalendarPresentationContent | undefined;
  readonly title?: ResolvedCalendarPresentationContent | undefined;
  readonly subtitle?: ResolvedCalendarPresentationContent | undefined;
  readonly trailing?: ResolvedCalendarPresentationContent | undefined;
  readonly badges: readonly CalendarPresentationBadge[];
}

export interface ResolvedCalendarSourceAction extends CalendarSourceAction {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly inline: boolean;
}

function content(value: CalendarPresentationContent | undefined): ResolvedCalendarPresentationContent | undefined {
  if (typeof value === "string") return validText(value) ? { text: value } : undefined;
  if (!value || typeof value !== "object" || !validText(value.text)) return undefined;
  return {
    text: value.text,
    ...(validText(value.accessibleLabel) ? { accessibleLabel: value.accessibleLabel } : {}),
  };
}

const DATASET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_DATASET_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function safeDataset(values: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (Object.keys(resolved).length >= MAX_PRESENTATION_DATA) break;
    if (key.length > 64 || !DATASET_KEY.test(key) || FORBIDDEN_DATASET_KEYS.has(key) || !validText(value)) continue;
    resolved[key] = value;
  }
  return resolved;
}

function badges(values: readonly CalendarPresentationBadge[] | undefined): readonly CalendarPresentationBadge[] {
  if (!Array.isArray(values)) return [];
  return values.filter(value => Boolean(value && validText(value.label))).slice(0, MAX_PRESENTATION_BADGES).map(value => ({
    label: value.label,
    ...(validText(value.accessibleLabel) ? { accessibleLabel: value.accessibleLabel } : {}),
  }));
}

/** Host class tokens may not reuse Calendar's internal `dc-` or state `is-` namespaces. */
export function isSafeHostClassName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value)
    && !/^(?:dc-|is-)/u.test(value);
}

function classNamesOf(values: readonly string[] | undefined): readonly string[] {
  return Array.isArray(values) ? values.filter(isSafeHostClassName).slice(0, MAX_PRESENTATION_CLASSES) : [];
}

function detailRowsOf(values: readonly { readonly label: string; readonly value: string }[] | undefined): readonly { readonly label: string; readonly value: string }[] {
  if (!Array.isArray(values)) return [];
  return values.filter(row => Boolean(row && validText(row.label) && validText(row.value))).slice(0, MAX_PRESENTATION_DETAIL_ROWS);
}

/** Merge structured host/feature presentation without accepting arbitrary DOM or HTML. Later singular slots override earlier ones. */
export function resolveOccurrencePresentation(
  extensions: readonly CalendarUiExtension[],
  occurrence: CalendarOccurrence,
  onExtensionError?: ((extensionIndex: number, error: unknown) => void) | undefined,
): ResolvedCalendarOccurrencePresentation {
  const classNames: string[] = [];
  const data: Record<string, string> = {};
  const agendaMeta: string[] = [];
  const detailRows: Array<{ readonly label: string; readonly value: string }> = [];
  const mergedBadges: CalendarPresentationBadge[] = [];
  let agendaOrder = 0;
  let accessibleLabel: string | undefined;
  let icon: ResolvedCalendarPresentationContent | undefined;
  let leading: ResolvedCalendarPresentationContent | undefined;
  let title: ResolvedCalendarPresentationContent | undefined;
  let subtitle: ResolvedCalendarPresentationContent | undefined;
  let trailing: ResolvedCalendarPresentationContent | undefined;

  for (const [extensionIndex, extension] of extensions.entries()) {
    let presentation: CalendarOccurrencePresentation | undefined;
    try { presentation = extension.presentOccurrence?.(occurrence); } catch (error) { onExtensionError?.(extensionIndex, error); continue; }
    if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) continue;
    classNames.push(...classNamesOf(presentation.classNames));
    Object.assign(data, safeDataset(presentation.data));
    if (validText(presentation.agendaMeta)) agendaMeta.push(presentation.agendaMeta);
    detailRows.push(...detailRowsOf(presentation.detailRows));
    if (typeof presentation.agendaOrder === "number" && Number.isFinite(presentation.agendaOrder)) {
      agendaOrder = Math.max(-1_000_000, Math.min(1_000_000, agendaOrder + presentation.agendaOrder));
    }
    if (validText(presentation.accessibleLabel)) accessibleLabel = presentation.accessibleLabel;
    const nextIcon = content(presentation.icon);
    const nextLeading = content(presentation.leading);
    const nextTitle = content(presentation.title);
    const nextSubtitle = content(presentation.subtitle);
    const nextTrailing = content(presentation.trailing);
    if (nextIcon) icon = nextIcon;
    if (nextLeading) leading = nextLeading;
    if (nextTitle) title = nextTitle;
    if (nextSubtitle) subtitle = nextSubtitle;
    if (nextTrailing) trailing = nextTrailing;
    mergedBadges.push(...badges(presentation.badges));
  }

  return {
    classNames: [...new Set(classNames)].slice(0, MAX_PRESENTATION_CLASSES),
    data: Object.fromEntries(Object.entries(data).slice(0, MAX_PRESENTATION_DATA)),
    agendaMeta: agendaMeta.slice(0, MAX_PRESENTATION_AGENDA_META),
    agendaOrder,
    detailRows: detailRows.slice(0, MAX_PRESENTATION_DETAIL_ROWS),
    badges: mergedBadges.slice(0, MAX_PRESENTATION_BADGES),
    ...(accessibleLabel ? { accessibleLabel } : {}),
    ...(icon ? { icon } : {}),
    ...(leading ? { leading } : {}),
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(trailing ? { trailing } : {}),
  };
}

function validAction(action: CalendarSourceAction): boolean {
  return Boolean(
    action
    && validText(action.id, 256) && action.id.trim() === action.id
    && validText(action.label, 1_024)
    && (action.icon === undefined || validText(action.icon, 256))
    && (action.kind === undefined || validText(action.kind, 256))
    && (action.primary === undefined || typeof action.primary === "boolean")
    && (action.danger === undefined || typeof action.danger === "boolean")
    && (action.enabled === undefined || typeof action.enabled === "boolean")
    && (action.pending === undefined || typeof action.pending === "boolean")
    && (action.inline === undefined || typeof action.inline === "boolean")
    && (action.pressed === undefined || typeof action.pressed === "boolean")
    && (action.state === undefined || validText(action.state, 1_024))
    && (action.accessibleLabel === undefined || validText(action.accessibleLabel, 2_048))
  );
}

/** Resolve current action state and fail closed on malformed or duplicate action IDs. */
export function resolveSourceActions(port: CalendarSourceActionPort | undefined, occurrence: CalendarOccurrence): readonly ResolvedCalendarSourceAction[] {
  if (!port) return [];
  let supplied: readonly CalendarSourceAction[];
  try {
    supplied = port.actions(occurrence);
  } catch {
    return [];
  }
  if (!Array.isArray(supplied) || supplied.length > MAX_SOURCE_ACTIONS) return [];
  const counts = new Map<string, number>();
  for (const action of supplied) if (validAction(action)) counts.set(action.id, (counts.get(action.id) ?? 0) + 1);
  return supplied.filter(action => validAction(action) && counts.get(action.id) === 1).map(action => ({
    ...action,
    enabled: action.enabled !== false,
    pending: action.pending === true,
    inline: action.inline === true,
  }));
}

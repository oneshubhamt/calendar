import type { CalendarView } from "../core/types.js";
import type {
  CalendarCustomViewPlugin,
  CalendarUiViewId,
} from "./types.js";

const BUILT_IN_VIEW_IDS = new Set<CalendarView>(["month", "week", "day", "year", "agenda"]);
const VIEW_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;
const MAX_VIEW_LABEL = 64;

export interface CalendarViewDefinition extends CalendarCustomViewPlugin {
  readonly builtIn: boolean;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) throw new RangeError(`${label} must contain 1–${max} characters`);
  return text;
}

function ownDefinition(plugin: CalendarCustomViewPlugin, builtIn: boolean): CalendarViewDefinition {
  if (!plugin || typeof plugin !== "object") throw new TypeError("Calendar view plugin must be an object");
  const id = requiredText(plugin.id, "Calendar view id", 64);
  if (!VIEW_ID_RE.test(id)) {
    throw new Error("Calendar view id must start with a letter and contain only letters, numbers, '.', '_', ':' or '-'");
  }
  const label = requiredText(plugin.label, `Calendar view ${id} label`, MAX_VIEW_LABEL);
  for (const method of ["range", "shiftAnchor", "title", "render"] as const) {
    if (typeof plugin[method] !== "function") throw new TypeError(`Calendar view ${id} ${method} must be a function`);
  }
  return Object.freeze({
    ...plugin,
    id,
    label,
    includeBackgroundRanges: plugin.includeBackgroundRanges === true,
    builtIn,
  });
}

/**
 * Immutable view registry owned by one CalendarUi instance.
 *
 * Built-ins are supplied by CalendarUi. Host/bundled custom views are validated,
 * shallow-owned and appended in registration order. Unknown IDs never silently
 * fall back to another view.
 */
export class CalendarViewRegistry {
  private readonly byId = new Map<string, CalendarViewDefinition>();
  private readonly ordered: readonly CalendarViewDefinition[];

  public constructor(
    builtIns: readonly CalendarCustomViewPlugin[],
    customViews: readonly CalendarCustomViewPlugin[] = [],
  ) {
    const definitions: CalendarViewDefinition[] = [];

    for (const plugin of builtIns) {
      const definition = ownDefinition(plugin, true);
      if (!BUILT_IN_VIEW_IDS.has(definition.id as CalendarView)) {
        throw new Error(`Unknown built-in Calendar view id: ${definition.id}`);
      }
      if (this.byId.has(definition.id)) throw new Error(`Duplicate Calendar view id: ${definition.id}`);
      this.byId.set(definition.id, definition);
      definitions.push(definition);
    }

    for (const plugin of customViews) {
      const definition = ownDefinition(plugin, false);
      if (BUILT_IN_VIEW_IDS.has(definition.id as CalendarView)) {
        throw new Error(`Custom Calendar view id is reserved by a built-in view: ${definition.id}`);
      }
      if (this.byId.has(definition.id)) throw new Error(`Duplicate Calendar view id: ${definition.id}`);
      this.byId.set(definition.id, definition);
      definitions.push(definition);
    }

    for (const id of BUILT_IN_VIEW_IDS) {
      if (!this.byId.has(id)) throw new Error(`Missing built-in Calendar view definition: ${id}`);
    }
    this.ordered = Object.freeze(definitions);
  }

  public get(id: CalendarUiViewId): CalendarViewDefinition {
    const definition = this.byId.get(id);
    if (!definition) throw new RangeError(`Unknown Calendar view: ${id}`);
    return definition;
  }

  public entries(): readonly CalendarViewDefinition[] {
    return this.ordered;
  }
}

export function isBuiltInCalendarView(id: CalendarUiViewId): id is CalendarView {
  return BUILT_IN_VIEW_IDS.has(id as CalendarView);
}

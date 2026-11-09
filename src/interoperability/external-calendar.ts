import type { CalendarItem, CalendarProjectionProvider, CalendarRange, CalendarSource } from "../core/types.js";
import { importIcs, type IcsImportOptions } from "./ics.js";

export interface ExternalCalendarFeed {
  readonly id: string;
  read(range: CalendarRange): Promise<readonly CalendarItem[]> | readonly CalendarItem[];
}

export class ExternalCalendarOverlayProvider implements CalendarProjectionProvider {
  public readonly id: string;
  public constructor(private readonly feed: ExternalCalendarFeed) { this.id = `external-overlay:${feed.id}`; }
  public project(range: CalendarRange): Promise<readonly CalendarItem[]> | readonly CalendarItem[] { return this.feed.read(range); }
}

export class IcsCalendarOverlayProvider implements CalendarProjectionProvider {
  public readonly id: string;
  private readonly items: readonly CalendarItem[];
  public constructor(text: string, options: IcsImportOptions & { readonly providerId?: string }) {
    this.id = `ics-overlay:${options.providerId ?? options.calendarId}`;
    this.items = importIcs(text, { ...options, readOnly: true }).items;
  }
  public project(_range: CalendarRange): readonly CalendarItem[] { return this.items; }
}

export function externalCalendarSource(input: {
  readonly id: string;
  readonly title: string;
  readonly visible?: boolean;
  readonly category?: string;
  readonly sourceType?: string;
  readonly removable?: boolean;
  readonly metadata?: CalendarSource["metadata"];
  readonly display?: CalendarSource["display"];
}): CalendarSource {
  return {
    id: input.id, title: input.title, visible: input.visible ?? true, sourceType: input.sourceType ?? "external", readOnly: true, allowCreate: false,
    removable: input.removable ?? false,
    ...((input.category || input.metadata) ? { metadata: { ...(input.metadata ?? {}), ...(input.category ? { category: input.category } : {}) } } : {}), ...(input.display ? { display: input.display } : {}),
  };
}

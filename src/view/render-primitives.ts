import type { CalendarBackgroundRange } from "../core/types.js";
import { dateKey } from "../core/time.js";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return dateKey(a, timeZone) === dateKey(b, timeZone);
}

export function formatTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

export function formatDateTime(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZone,
  }).format(date);
}

export function humanizeKind(value: string): string {
  const text = value.replace(/[-_]+/gu, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Event";
}

export function backgroundAriaSuffix(ranges: readonly CalendarBackgroundRange[]): string {
  const labels = [...new Set(ranges.map(range => range.label?.trim()).filter((label): label is string => Boolean(label)))].slice(0, 8);
  return labels.length ? `. Background: ${labels.join(", ")}` : "";
}

export function dayLevelBackgroundLayer(
  ranges: readonly CalendarBackgroundRange[],
  applyPresentation: (element: HTMLElement, range: CalendarBackgroundRange) => void,
): HTMLElement {
  const layer = el("div", "dc-day-background-layer");
  layer.setAttribute("aria-hidden", "true");
  for (const [index, range] of ranges.entries()) {
    const background = el("div", "dc-day-background-range");
    background.dataset.backgroundRangeId = range.id;
    background.style.zIndex = String(index);
    applyPresentation(background, range);
    layer.append(background);
  }
  return layer;
}

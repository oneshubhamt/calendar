import type { CalendarPrintSnapshotOptions } from "./types.js";

export const CALENDAR_PRINT_CSS = String.raw`
/* Detached print snapshots use the same rendered view and stylesheet, but never the live interaction surface. */
.dc-print-snapshot{display:block;background:#fff;color:#111827;font:14px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dc-print-heading{margin:0 0 10px;padding:0 0 8px;border-bottom:1px solid #cbd5e1;color:#111827}
.dc-print-heading h1{margin:0;font:650 18px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dc-print-snapshot .dc-root{--dc-border:#cbd5e1;--dc-muted:#4b5563;--dc-bg:#fff;--dc-soft:#f8fafc;--dc-text:#111827;color:var(--dc-text);background:var(--dc-bg);border:0;border-radius:0;min-height:0;height:auto;overflow:visible}
.dc-print-snapshot .dc-body,.dc-print-snapshot .dc-timeline-scroll{height:auto;max-height:none;overflow:visible}
.dc-print-snapshot .dc-weekdays,.dc-print-snapshot .dc-day-headers,.dc-print-snapshot .dc-agenda-heading,.dc-print-snapshot .dc-timeline-axis{position:static}
.dc-print-snapshot .dc-day-cell,.dc-print-snapshot .dc-all-day-col,.dc-print-snapshot .dc-background-layer,.dc-print-snapshot .dc-day-background-layer{overflow:visible}
.dc-print-snapshot .dc-timeline-scroll{max-width:none}
.dc-print-snapshot .dc-month-grid{min-height:0;grid-auto-rows:minmax(80px,auto)}
.dc-print-snapshot .dc-event,.dc-print-snapshot .dc-time-event,.dc-print-snapshot .dc-agenda-row,.dc-print-snapshot .dc-year-month,.dc-print-snapshot .dc-timeline-event{break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.dc-print-snapshot .dc-time-event{height:var(--dc-print-event-height)!important;transform:none!important}
.dc-print-snapshot .dc-timeline-event{width:var(--dc-print-event-width)!important;transform:none!important}
.dc-print-snapshot [role="button"],.dc-print-snapshot button,.dc-print-snapshot a{cursor:default}

@media print{
  .dc-root{--dc-border:#cbd5e1;--dc-muted:#4b5563;--dc-bg:#fff;--dc-soft:#f8fafc;--dc-text:#111827;color:var(--dc-text);background:var(--dc-bg);border:0!important;border-radius:0!important;min-height:0!important;height:auto!important;overflow:visible!important;box-shadow:none!important}
  .dc-toolbar{display:block!important;min-height:0!important;padding:0 0 8px!important;border-bottom:1px solid var(--dc-border)!important;background:#fff!important}
  .dc-toolbar>*{display:none!important}
  .dc-toolbar>.dc-title{display:block!important;min-width:0!important;margin:0!important;font-size:18px!important;color:#111827!important}
  .dc-dialog,.dc-source-menu,.dc-context-menu,.dc-addon-menu,.dc-inline-actions,.dc-resize-handle,.dc-timeline-resize-handle,.dc-selection-range,.dc-now,.dc-sr-only{display:none!important}
  .dc-body,.dc-timeline-scroll{height:auto!important;max-height:none!important;overflow:visible!important}
  .dc-weekdays,.dc-day-headers,.dc-agenda-heading,.dc-timeline-axis{position:static!important}
  .dc-day-cell,.dc-all-day-col,.dc-background-layer,.dc-day-background-layer{overflow:visible!important}
  .dc-timeline-scroll{max-width:none!important}
  .dc-month-grid{min-height:0!important;grid-auto-rows:minmax(80px,auto)}
  .dc-event,.dc-time-event,.dc-agenda-row,.dc-year-month,.dc-timeline-event{break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .dc-root .is-dragging,.dc-root .is-command-preview,.dc-root .is-touch-arming,.dc-root .is-pending,.dc-root [aria-busy="true"]{opacity:1!important;cursor:default!important;outline:0!important}
  .dc-root .is-dragging,.dc-root .is-command-preview{transform:none!important}
  .dc-time-event{height:var(--dc-print-event-height)!important}
  .dc-timeline-event{width:var(--dc-print-event-width)!important;transform:none!important}
  .dc-day-cell.is-external-drop-target,.dc-all-day-col.is-external-drop-target,.dc-time-column.is-external-drop-target{box-shadow:none!important}
  .dc-root *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  .dc-print-snapshot{background:#fff;color:#111827}
}
`;

const OPTION_KEYS = new Set(["title"]);
const MAX_TITLE_LENGTH = 256;
const REMOVE_SELECTOR = [
  ".dc-toolbar",
  ".dc-source-menu",
  ".dc-context-menu",
  ".dc-addon-menu",
  ".dc-inline-actions",
  ".dc-resize-handle",
  ".dc-timeline-resize-handle",
  ".dc-selection-range",
  ".dc-now",
  ".dc-sr-only",
  ".dc-drag-ghost",
].join(",");

const TRANSIENT_CLASSES = [
  "is-dragging",
  "is-command-preview",
  "is-touch-arming",
  "is-external-drop-target",
  "is-pending",
] as const;

function printTitle(
  fallbackTitle: string,
  options: CalendarPrintSnapshotOptions,
): string | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Calendar print options must be an object");
  }
  if (Object.keys(options).some(key => !OPTION_KEYS.has(key))) {
    throw new TypeError("Calendar print options contain an unexpected field");
  }
  if (options.title === false) return undefined;
  const value = options.title ?? fallbackTitle;
  if (typeof value !== "string") throw new TypeError("Calendar print title must be a string or false");
  const title = value.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new RangeError(`Calendar print title must contain 1–${MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

function sanitizeElement(element: HTMLElement): void {
  const transient = element.hasAttribute("aria-busy")
    || TRANSIENT_CLASSES.some(token => element.classList.contains(token));
  if (transient) {
    element.style.removeProperty("transform");
    element.style.removeProperty("opacity");
    if (element.classList.contains("dc-time-event")) {
      const height = element.style.getPropertyValue("--dc-print-event-height");
      if (height) element.style.height = height;
    }
    if (element.classList.contains("dc-timeline-event")) {
      const width = element.style.getPropertyValue("--dc-print-event-width");
      if (width) element.style.width = width;
    }
  }

  element.classList.remove(...TRANSIENT_CLASSES);
  element.removeAttribute("aria-busy");
  element.removeAttribute("aria-keyshortcuts");
  element.removeAttribute("draggable");
  element.removeAttribute("contenteditable");
  element.removeAttribute("data-dragging");

  for (const attribute of [...element.attributes]) {
    if (/^on/iu.test(attribute.name)) element.removeAttribute(attribute.name);
  }

  if (element instanceof HTMLAnchorElement) element.removeAttribute("href");
  if (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLAnchorElement
    || element.tabIndex >= 0
  ) {
    element.tabIndex = -1;
  }
  element.style.removeProperty("cursor");
}

/**
 * Clone the current Calendar render into a detached, self-styled, non-interactive
 * print representation. cloneNode() intentionally preserves rendered content but
 * not registered event listeners, so custom and bundled views share one path.
 */
export function createCalendarPrintSnapshot(
  host: HTMLElement,
  fallbackTitle: string,
  options: CalendarPrintSnapshotOptions = {},
): HTMLElement {
  const root = host.querySelector<HTMLElement>(":scope > .dc-root");
  if (!root) throw new Error("Calendar print snapshot requires a mounted CalendarUi");

  const snapshot = document.createElement("section");
  snapshot.className = "dc-print-snapshot";
  snapshot.dataset.calendarPrintSnapshot = "true";
  snapshot.inert = true;

  let hasPrintStyles = false;
  for (const style of host.querySelectorAll<HTMLStyleElement>(":scope > style")) {
    const ownedStyle = style.cloneNode(true) as HTMLStyleElement;
    if (style.dataset.calendarPrintStyles === "true") hasPrintStyles = true;
    snapshot.append(ownedStyle);
  }
  if (!hasPrintStyles) {
    const printStyle = document.createElement("style");
    printStyle.dataset.calendarPrintStyles = "true";
    printStyle.textContent = CALENDAR_PRINT_CSS;
    snapshot.append(printStyle);
  }

  const title = printTitle(fallbackTitle, options);
  if (title) {
    const heading = document.createElement("header");
    heading.className = "dc-print-heading";
    const label = document.createElement("h1");
    label.textContent = title;
    heading.append(label);
    snapshot.append(heading);
  }

  const clonedRoot = root.cloneNode(true) as HTMLElement;
  clonedRoot.classList.add("dc-print-root");
  clonedRoot.removeAttribute("tabindex");
  clonedRoot.querySelectorAll(REMOVE_SELECTOR).forEach(node => node.remove());

  sanitizeElement(clonedRoot);
  for (const element of clonedRoot.querySelectorAll<HTMLElement>("*")) sanitizeElement(element);

  snapshot.append(clonedRoot);
  return snapshot;
}

import type { CalendarPrintSnapshotOptions } from "./types.js";

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

  const style = host.querySelector<HTMLStyleElement>(":scope > style");
  if (style) {
    const ownedStyle = style.cloneNode(true) as HTMLStyleElement;
    ownedStyle.dataset.calendarPrintStyles = "true";
    snapshot.append(ownedStyle);
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

import type { CalendarUiTheme } from "./types.js";

const MAX_THEME_VALUE_LENGTH = 512;

const THEME_TOKENS = [
  ["background", "--dc-theme-background", "background-color"],
  ["softBackground", "--dc-theme-soft-background", "background-color"],
  ["text", "--dc-theme-text", "color"],
  ["mutedText", "--dc-theme-muted-text", "color"],
  ["border", "--dc-theme-border", "color"],
  ["accent", "--dc-theme-accent", "color"],
  ["danger", "--dc-theme-danger", "color"],
  ["fontFamily", "--dc-theme-font-family", "font-family"],
] as const satisfies readonly [keyof CalendarUiTheme, string, string][];

function supportedThemeValue(property: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_THEME_VALUE_LENGTH) return false;
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(property, candidate);
  } catch {
    return false;
  }
}

/**
 * Apply only Calendar-prefixed presentation variables to the dedicated mount.
 * The returned disposer restores exactly the prior inline state; host CSS remains host-owned.
 */
export function applyCalendarUiTheme(host: HTMLElement, theme: CalendarUiTheme | undefined): () => void {
  if (!theme) return () => {};
  const previous = new Map<string, { readonly value: string; readonly priority: string }>();
  for (const [key, cssName, validationProperty] of THEME_TOKENS) {
    const value = theme[key];
    if (!supportedThemeValue(validationProperty, value)) continue;
    previous.set(cssName, {
      value: host.style.getPropertyValue(cssName),
      priority: host.style.getPropertyPriority(cssName),
    });
    host.style.setProperty(cssName, value.trim());
  }
  return () => {
    for (const [cssName, prior] of previous) {
      if (prior.value) host.style.setProperty(cssName, prior.value, prior.priority);
      else host.style.removeProperty(cssName);
    }
  };
}

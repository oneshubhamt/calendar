import type { CalendarUiAddon, CalendarUiExtension } from "./types.js";

const MAX_HOST_CSS_LENGTH = 65_536;

/**
 * Presentation CSS is deliberately cosmetic. Calendar owns dimensions, placement,
 * overflow, hit testing and interaction geometry; the host may only decorate text/
 * surfaces through this small property allow-list.
 */
const PRESENTATION_COSMETIC_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-style",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "box-shadow",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-shadow",
  "opacity",
]);

interface CssRule {
  readonly kind: "rule";
  readonly selectors: string;
  readonly body: string;
  readonly properties: readonly string[];
}

interface CssMediaRule {
  readonly kind: "media";
  readonly condition: string;
  readonly children: readonly CssRule[];
}

type CssNode = CssRule | CssMediaRule;

function declarations(body: string): readonly string[] | null {
  const properties: string[] = [];
  for (const raw of body.split(";")) {
    const declaration = raw.trim();
    if (!declaration) continue;
    const parsed = /^(--?[a-zA-Z][a-zA-Z0-9-]*|[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;{}]+)$/u.exec(declaration);
    if (!parsed) return null;
    properties.push(parsed[1]!.toLowerCase());
  }
  return properties.length ? properties : null;
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function parseRules(css: string, allowMedia: boolean): readonly CssNode[] | null {
  const nodes: CssNode[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    while (cursor < css.length && /\s/u.test(css[cursor]!)) cursor += 1;
    if (cursor >= css.length) break;

    const open = css.indexOf("{", cursor);
    if (open < 0) return null;
    const header = css.slice(cursor, open).trim();
    if (!header) return null;
    const close = matchingBrace(css, open);
    if (close < 0) return null;
    const body = css.slice(open + 1, close);

    if (header.startsWith("@")) {
      if (!allowMedia || !/^@media(?:\s|\()/u.test(header)) return null;
      const condition = header.slice("@media".length).trim();
      if (!condition || /[;{}]/u.test(condition)) return null;
      const children = parseRules(body, false);
      if (!children || !children.length || children.some(node => node.kind !== "rule")) return null;
      nodes.push({ kind: "media", condition, children: children as readonly CssRule[] });
    } else {
      // Selector headers may not contain rule/at-rule delimiters that could escape the Calendar/add-on scope.
      if (/[{};@]/u.test(header) || body.includes("{") || body.includes("}")) return null;
      const properties = declarations(body);
      if (!properties) return null;
      nodes.push({ kind: "rule", selectors: header, body, properties });
    }
    cursor = close + 1;
  }
  return nodes.length ? nodes : null;
}

/** Reject syntax that would make this intentionally small CSS subset ambiguous. */
function parsedHostCss(css: string | undefined, allowMedia: boolean): readonly CssNode[] | null {
  if (!css || css.length > MAX_HOST_CSS_LENGTH) return null;
  if (css.includes("\\") || css.includes("/*") || css.includes("*/") || /!\s*important\b/iu.test(css)) return null;
  return parseRules(css, allowMedia);
}

function splitSelectors(selectors: string): readonly string[] | null {
  const out: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < selectors.length; index += 1) {
    const char = selectors[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "," && round === 0 && square === 0) {
      const selector = selectors.slice(start, index).trim();
      if (!selector) return null;
      out.push(selector);
      start = index + 1;
    }
    if (round < 0 || square < 0) return null;
  }
  if (quote || round !== 0 || square !== 0) return null;
  const tail = selectors.slice(start).trim();
  if (!tail) return null;
  out.push(tail);
  return out;
}

function scopeNodes(nodes: readonly CssNode[], scope: string): string {
  const rendered: string[] = [];
  for (const node of nodes) {
    if (node.kind === "media") {
      const body = scopeNodes(node.children, scope);
      if (body) rendered.push(`@media ${node.condition}{${body}}`);
      continue;
    }
    const selectors = splitSelectors(node.selectors);
    if (!selectors) return "";
    rendered.push(`${selectors.map(selector => `${scope} ${selector}`).join(",")}{${node.body}}`);
  }
  return rendered.join("\n");
}

/**
 * Presentation extensions may decorate Calendar-owned occurrences, but never own
 * their geometry or escape Calendar's root. Unknown properties and unsupported CSS fail closed.
 */
export function safePresentationCss(css: string | undefined): string {
  const nodes = parsedHostCss(css, false);
  if (!nodes || !nodes.every(node => node.kind === "rule" && node.properties.every(property => PRESENTATION_COSMETIC_PROPERTIES.has(property)))) return "";
  return scopeNodes(nodes, ".dc-root");
}

/**
 * Add-ons own only the DOM Calendar gives them. A deliberately small subset of CSS
 * (flat rules plus one @media level) is accepted before scoping to the add-on wrapper.
 */
export function safeAddonCss(css: string | undefined): string {
  const nodes = parsedHostCss(css, true);
  return nodes ? css! : "";
}

function scopedAddonCss(css: string, index: number): string {
  const nodes = parsedHostCss(css, true);
  return nodes ? scopeNodes(nodes, `[data-calendar-addon="${index}"]`) : "";
}

/** Resolve host CSS defensively; one broken accessor cannot prevent Calendar mounting. */
export function calendarHostCss(
  extensions: readonly CalendarUiExtension[],
  addons: readonly CalendarUiAddon[],
  onError?: ((kind: "extension" | "addon", index: number, error: unknown) => void) | undefined,
): string {
  const blocks: string[] = [];
  for (const [index, extension] of extensions.entries()) {
    try {
      const css = safePresentationCss(extension.styles);
      if (css) blocks.push(css);
    } catch (error) {
      onError?.("extension", index, error);
    }
  }
  for (const [index, addon] of addons.entries()) {
    try {
      const css = safeAddonCss(addon.styles);
      if (css) blocks.push(scopedAddonCss(css, index));
    } catch (error) {
      onError?.("addon", index, error);
    }
  }
  return blocks.join("\n");
}

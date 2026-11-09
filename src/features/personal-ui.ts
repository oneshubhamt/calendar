import type { CalendarItem, CalendarOccurrence, CalendarSource, ISODate } from "../core/types.js";
import { dateKey } from "../core/time.js";
import { requestCalendarDate } from "../view/dialogs.js";
import type { CalendarCreateDraft, CalendarUiAction, CalendarUiAddon, CalendarUiAddonContext } from "../view/types.js";
import {
  PERSONAL_CALENDAR_FEATURE,
  type CalendarPersonalFeaturePort,
  type CalendarPersonalFilter,
  type CalendarQuickCreateOptions,
  type CalendarRoutineTemplate,
} from "./personal.js";

export interface PersonalCalendarUiOptions {
  readonly feature?: CalendarPersonalFeaturePort;
  readonly quickCreate?: boolean;
  readonly search?: boolean;
  readonly filters?: boolean;
  readonly calendarCreation?: boolean;
  readonly copyMove?: boolean;
  readonly quickCreatePlaceholder?: string;
  readonly quickCreateOptions?: CalendarQuickCreateOptions;
  readonly routineTemplates?: readonly CalendarRoutineTemplate[];
  readonly sourceIdFactory?: ((title: string, existingIds: ReadonlySet<string>) => string) | undefined;
  readonly calendarCategoryPlaceholder?: string;
}

const PERSONAL_UI_CSS = `
.dc-personal-toolbar{display:contents}
.dc-quick-input,.dc-search-input{min-width:150px;max-width:250px;border:1px solid var(--dc-border);background:var(--dc-bg);color:var(--dc-text);border-radius:8px;padding:7px 9px;font:inherit}.dc-quick-input{flex:1 1 220px}.dc-search-input{flex:0 1 180px}.dc-quick-input:focus,.dc-search-input:focus{outline:2px solid color-mix(in srgb,var(--dc-accent) 28%,transparent);border-color:var(--dc-accent)}
.dc-filter-menu{max-height:min(70vh,620px);overflow:auto}
@media(max-width:900px){.dc-quick-input{order:5;flex-basis:55%}.dc-search-input{order:5;flex:1 1 140px}}
@media(max-width:620px){.dc-quick-input,.dc-search-input{order:6;min-width:0;max-width:none;flex:1 1 100%}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, action: () => void, ariaLabel?: string): HTMLButtonElement {
  const node = el("button", "dc-btn", label);
  node.type = "button";
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  node.addEventListener("click", action);
  return node;
}

function writableSource(source: CalendarSource | undefined): boolean {
  return Boolean(source && !source.readOnly && source.allowCreate !== false);
}

function draftFromItem(item: CalendarItem): CalendarCreateDraft {
  return {
    calendarId: item.calendarId,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    ...(item.location ? { location: item.location } : {}),
    start: item.start,
    end: item.end,
    ...(item.allDay !== undefined ? { allDay: item.allDay } : {}),
    ...(item.precision ? { precision: item.precision } : {}),
    ...(item.temporal ? { temporal: item.temporal } : {}),
    kind: item.kind,
    ownership: item.ownership,
    editPolicy: item.editPolicy,
    ...(item.recurrence ? { recurrence: item.recurrence } : {}),
    ...(item.reminders ? { reminders: item.reminders } : {}),
    ...(item.display ? { display: item.display } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
}

async function requestCalendarDefinition(host: HTMLElement, placeholder: string): Promise<{ title: string; category?: string } | null> {
  const dialog = el("dialog", "dc-dialog dc-scope-dialog");
  dialog.setAttribute("aria-label", "New calendar");
  const form = el("form", "dc-editor"); form.method = "dialog";
  const header = el("div", "dc-dialog-header"); header.append(el("h2", undefined, "New calendar"));
  const body = el("div", "dc-dialog-body");
  const title = el("input", "dc-input"); title.required = true; title.placeholder = "Calendar name";
  const category = el("input", "dc-input"); category.placeholder = placeholder;
  const titleField = el("label", "dc-field"); titleField.append(el("span", "dc-field-label", "Name"), title);
  const categoryField = el("label", "dc-field"); categoryField.append(el("span", "dc-field-label", "Category (optional)"), category);
  body.append(titleField, categoryField);
  const footer = el("div", "dc-dialog-footer");
  const cancel = button("Cancel", () => dialog.close("cancel"));
  const create = button("Create", () => { if (title.reportValidity()) dialog.close("confirm"); }); create.classList.add("dc-primary");
  footer.append(cancel, create); form.append(header, body, footer); dialog.append(form); host.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); title.focus();
  return await new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm" ? { title: title.value.trim(), ...(category.value.trim() ? { category: category.value.trim() } : {}) } : null), { once: true }));
}

async function requestRoutine(host: HTMLElement, templates: readonly CalendarRoutineTemplate[], initialDate: ISODate): Promise<{ template: CalendarRoutineTemplate; date: ISODate } | null> {
  const dialog = el("dialog", "dc-dialog dc-scope-dialog");
  dialog.setAttribute("aria-label", "Apply routine");
  const form = el("form", "dc-editor"); form.method = "dialog";
  const header = el("div", "dc-dialog-header"); header.append(el("h2", undefined, "Apply routine"));
  const body = el("div", "dc-dialog-body");
  const select = el("select", "dc-input");
  for (const template of templates) { const option = el("option", undefined, template.title); option.value = template.id; select.append(option); }
  const date = el("input", "dc-input"); date.type = "date"; date.required = true; date.value = initialDate;
  const a = el("label", "dc-field"); a.append(el("span", "dc-field-label", "Routine"), select);
  const b = el("label", "dc-field"); b.append(el("span", "dc-field-label", "Date"), date); body.append(a, b);
  const footer = el("div", "dc-dialog-footer");
  footer.append(button("Cancel", () => dialog.close("cancel")), button("Apply", () => { if (date.reportValidity()) dialog.close("confirm"); }));
  form.append(header, body, footer); dialog.append(form); host.append(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); select.focus();
  return await new Promise(resolve => dialog.addEventListener("close", () => {
    const template = templates.find(value => value.id === select.value);
    resolve(dialog.returnValue === "confirm" && template ? { template, date: date.value } : null);
  }, { once: true }));
}

export function createPersonalCalendarUiAddon(options: PersonalCalendarUiOptions = {}): CalendarUiAddon {
  const feature = options.feature ?? PERSONAL_CALENDAR_FEATURE;
  const state = {
    searchText: "",
    kinds: new Set<string>(),
    categories: new Set<string>(),
    context: null as CalendarUiAddonContext | null,
    searchTimer: 0,
  };

  const currentFilter = (): CalendarPersonalFilter | undefined => {
    if (!state.searchText && !state.kinds.size && !state.categories.size) return undefined;
    return {
      ...(state.searchText ? { text: state.searchText } : {}),
      ...(state.kinds.size ? { kinds: state.kinds } : {}),
      ...(state.categories.size ? { categories: state.categories } : {}),
    };
  };

  const refresh = (): void => { if (state.context) void state.context.refresh(); };

  const quickCreate = async (input: HTMLInputElement): Promise<void> => {
    const context = state.context;
    const text = input.value.trim(); if (!context || !text) return;
    try {
      const parsed = feature.parseQuickCreate(text, new Date(), context.timeZone, options.quickCreateOptions);
      const draft: CalendarCreateDraft = {
        calendarId: context.defaultCalendarId, title: parsed.title, start: parsed.start, end: parsed.end,
        allDay: parsed.allDay, precision: parsed.allDay ? "date" : "minute", temporal: parsed.allDay ? { kind: "date" } : { kind: "instant" }, kind: parsed.kind,
        ...(parsed.category ? { metadata: { category: parsed.category } } : {}),
      };
      const created = await context.createDraft(draft, "quick-create");
      if (!created) return;
      input.value = ""; context.announce(`${parsed.title} created.`);
    } catch (error) {
      input.setCustomValidity(error instanceof Error ? error.message : "Could not understand quick create"); input.reportValidity(); input.setCustomValidity("");
    }
  };

  const openFilters = (anchor: HTMLElement): void => {
    const context = state.context; if (!context) return;
    const existing = context.host.querySelector<HTMLElement>(".dc-filter-menu"); if (existing) { existing.remove(); return; }
    const menu = el("div", "dc-filter-menu dc-addon-menu dc-source-menu"); menu.setAttribute("role", "group"); menu.setAttribute("aria-label", "Calendar filters");
    const kinds = context.kindOptions.map(option => option.value);
    menu.append(el("div", "dc-menu-title", "Types"));
    for (const option of context.kindOptions) {
      const row = el("label", "dc-source-row"); const check = el("input"); check.type = "checkbox"; check.checked = !state.kinds.size || state.kinds.has(option.value);
      check.addEventListener("change", () => { if (!state.kinds.size) for (const kind of kinds) state.kinds.add(kind); check.checked ? state.kinds.add(option.value) : state.kinds.delete(option.value); if (state.kinds.size === kinds.length) state.kinds.clear(); refresh(); });
      row.append(check, el("span", undefined, option.label)); menu.append(row);
    }
    const categories = [...new Set(context.sources.map(source => typeof source.metadata?.category === "string" ? source.metadata.category : "").filter(Boolean).concat(context.items.map(item => typeof item.metadata?.category === "string" ? item.metadata.category : "").filter(Boolean)))].sort();
    if (categories.length) {
      menu.append(el("div", "dc-menu-title", "Categories"));
      for (const category of categories) {
        const row = el("label", "dc-source-row"); const check = el("input"); check.type = "checkbox"; check.checked = !state.categories.size || state.categories.has(category);
        check.addEventListener("change", () => { if (!state.categories.size) for (const value of categories) state.categories.add(value); check.checked ? state.categories.add(category) : state.categories.delete(category); if (state.categories.size === categories.length) state.categories.clear(); refresh(); });
        row.append(check, el("span", undefined, category)); menu.append(row);
      }
    }
    if (state.kinds.size || state.categories.size || state.searchText) {
      const clear = el("button", "dc-menu-item", "Clear filters"); clear.type = "button";
      clear.addEventListener("click", () => { state.kinds.clear(); state.categories.clear(); state.searchText = ""; const search = context.host.querySelector<HTMLInputElement>(".dc-search-input"); if (search) search.value = ""; menu.remove(); refresh(); }); menu.append(clear);
    }
    const rect = anchor.getBoundingClientRect(), hostRect = context.host.getBoundingClientRect(); menu.style.left = `${Math.max(8, rect.left - hostRect.left)}px`; menu.style.top = `${rect.bottom - hostRect.top + 4}px`;
    context.host.querySelector<HTMLElement>(".dc-root")?.append(menu);
  };

  const copyToDate = async (occurrence: CalendarOccurrence): Promise<void> => {
    const context = state.context; if (!context) return;
    const date = await requestCalendarDate(context.host, `Copy “${occurrence.title}”`, dateKey(occurrence.start, context.timeZone), "Copy"); if (!date) return;
    const patch = feature.moveItemToDatePatch(occurrence, date, context.timeZone);
    const source = context.sources.find(candidate => candidate.id === occurrence.calendarId);
    const calendarId = writableSource(source) ? occurrence.calendarId : context.defaultCalendarId;
    const allDay = Boolean(patch.allDay ?? occurrence.allDay);
    const temporal = patch.temporal === null ? undefined : patch.temporal ?? occurrence.temporal;
    const created = await context.createDraft({
      calendarId, title: occurrence.title,
      ...(occurrence.description ? { description: occurrence.description } : {}), ...(occurrence.location ? { location: occurrence.location } : {}),
      start: patch.start ?? occurrence.start, end: patch.end ?? occurrence.end, allDay,
      precision: patch.precision ?? occurrence.precision ?? (allDay ? "date" : "minute"), ...(temporal ? { temporal } : {}), kind: occurrence.kind,
      ...(occurrence.reminders ? { reminders: occurrence.reminders } : {}), ...(occurrence.display ? { display: occurrence.display } : {}), ...(occurrence.metadata ? { metadata: occurrence.metadata } : {}),
    }, "copy", occurrence);
    if (created) context.announce(`${occurrence.title} copied to ${date}.`);
  };

  const moveToDate = async (occurrence: CalendarOccurrence): Promise<void> => {
    const context = state.context; if (!context) return;
    const date = await requestCalendarDate(context.host, `Move “${occurrence.title}”`, dateKey(occurrence.start, context.timeZone), "Move"); if (!date) return;
    const patch = feature.moveItemToDatePatch(occurrence, date, context.timeZone);
    if (await context.patchOccurrence(occurrence, patch, "Move")) context.announce(`${occurrence.title} moved to ${date}.`);
  };

  const applyRoutine = async (): Promise<void> => {
    const context = state.context, templates = options.routineTemplates ?? []; if (!context || !templates.length) return;
    const choice = await requestRoutine(context.host, templates, context.anchorDate); if (!choice) return;
    const items = feature.instantiateRoutine(choice.template, choice.date, context.timeZone);
    for (const item of items) {
      const source = context.sources.find(candidate => candidate.id === item.calendarId);
      if (!writableSource(source)) throw new Error(`Routine calendar is not writable: ${item.calendarId}`);
      if (!await context.canPlaceDraft(draftFromItem(item), undefined, "routine")) return;
    }
    for (const item of items) await context.createDraft(draftFromItem(item), "routine");
    context.announce(`${choice.template.title} added for ${choice.date}.`);
  };

  const newCalendar = async (): Promise<void> => {
    const context = state.context; if (!context || !context.canManageSources()) return;
    const definition = await requestCalendarDefinition(context.host, options.calendarCategoryPlaceholder ?? "e.g. Work, Personal"); if (!definition) return;
    const existing = new Set(context.sources.map(source => source.id));
    let id: string;
    if (options.sourceIdFactory) id = options.sourceIdFactory(definition.title, existing);
    else {
      const idBase = definition.title.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "calendar";
      id = `calendar:${idBase}`; let suffix = 2; while (existing.has(id)) id = `calendar:${idBase}-${suffix++}`;
    }
    if (!id.trim() || existing.has(id)) throw new Error("Calendar source id must be unique and non-empty.");
    await context.createSource(feature.createCalendarSource(id, definition.title, definition.category)); await context.refresh(); context.announce(`${definition.title} calendar created.`);
  };

  return {
    id: "personal-calendar-ui",
    styles: PERSONAL_UI_CSS,
    filterOccurrence(occurrence, source) { return feature.matchesFilter(occurrence, currentFilter(), source); },
    mountToolbar(container, context) {
      state.context = context;
      if (options.quickCreate !== false) {
        const quick = el("input", "dc-quick-input"); quick.type = "search"; quick.placeholder = options.quickCreatePlaceholder ?? "Quick add: tomorrow 7pm Dinner 2h"; quick.setAttribute("aria-label", "Quick create event");
        quick.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void quickCreate(quick); } }); container.append(quick);
      }
      if (options.search !== false) {
        const search = el("input", "dc-search-input"); search.type = "search"; search.placeholder = "Search"; search.value = state.searchText; search.setAttribute("aria-label", "Search calendar");
        search.addEventListener("input", () => { window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(() => { state.searchText = search.value.trim(); refresh(); }, 120); }); container.append(search);
      }
      if (options.filters !== false) { const filter = button("Filter", () => openFilters(filter), "Filter calendar"); filter.dataset.addonToggle = "personal-filters"; container.append(filter); }
      if (options.routineTemplates?.length) container.append(button("Routine", () => { void applyRoutine().catch(error => context.announce(error instanceof Error ? error.message : "Could not apply routine")); }, "Apply a routine"));
    },
    sourceMenuActions(context) { state.context = context; return options.calendarCreation === false || !context.canManageSources() ? [] : [{ label: "+ New calendar", run: newCalendar }]; },
    detailActions(occurrence, context) { state.context = context; if (options.copyMove === false) return []; const actions: CalendarUiAction[] = [{ label: "Copy to date", run: () => copyToDate(occurrence) }]; if (context.canMoveOccurrence(occurrence)) actions.push({ label: "Move to date", run: () => moveToDate(occurrence) }); return actions; },
    contextActions(occurrence, context) { state.context = context; if (options.copyMove === false) return []; const actions: CalendarUiAction[] = [{ label: "Copy to date…", run: () => copyToDate(occurrence) }]; if (context.canMoveOccurrence(occurrence)) actions.push({ label: "Move to date…", run: () => moveToDate(occurrence) }); return actions; },
    onRefresh(context) { state.context = context; },
    emptyMessage() { return currentFilter() ? "No events match the current filters." : undefined; },
    destroy() { window.clearTimeout(state.searchTimer); state.context = null; },
  };
}

import type {
  CalendarItem,
  CalendarItemKind,
  CalendarOccurrence,
  CalendarRecurrence,
  CalendarSource,
  CalendarReminder,
  CalendarTemporalSpec,
  CalendarTemporalForm,
  CalendarOverlapDisambiguation,
  RecurrenceFrequency,
  SeriesEditScope,
  Weekday,
} from "../core/types.js";
import type { CalendarKindOption, CalendarReminderChannelOption, CalendarSelection } from "./types.js";
import { addDays, startOfDay, toDate } from "../core/time.js";
import { formatPlainDateTime, instantToPlain } from "../core/temporal.js";
import { instantAtCivilDateTime } from "../core/civil-timeline.js";
import { recurrenceAdvancedFields, recurrenceRuleFromEditor, recurrenceUntilFromEditor } from "./recurrence-editor.js";

const WEEKDAYS: readonly { readonly value: Weekday; readonly label: string }[] = [
  { value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" },
  { value: 4, label: "Thu" }, { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 0, label: "Sun" },
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function localDate(date: Date, timeZone: string): string {
  const p = instantToPlain(date.getTime(), timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function localTime(date: Date, timeZone: string): string {
  const p = instantToPlain(date.getTime(), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function localDateTime(
  dateValue: string,
  timeValue: string,
  timeZone: string,
  overlap: CalendarOverlapDisambiguation,
): Date {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  if (![year, month, day, hour ?? 0, minute ?? 0].every(Number.isFinite)) throw new Error("Invalid calendar date or time");
  const resolved = instantAtCivilDateTime({ year: year!, month: month!, day: day!, hour: hour ?? 0, minute: minute ?? 0, second: 0, millisecond: 0 }, timeZone, overlap);
  if (!resolved) throw new Error("That local time does not exist because of a daylight-saving transition");
  return resolved;
}

function plainDateTimeValue(dateValue: string, timeValue: string): string {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  if (![year, month, day, hour ?? 0, minute ?? 0].every(Number.isFinite)) throw new Error("Invalid calendar date or time");
  return formatPlainDateTime({ year: year!, month: month!, day: day!, hour: hour ?? 0, minute: minute ?? 0, second: 0, millisecond: 0 });
}

function input(name: string, type: string, value = ""): HTMLInputElement {
  const field = element("input", "dc-input");
  field.name = name;
  field.type = type;
  field.value = value;
  return field;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = element("label", "dc-field");
  wrapper.append(element("span", "dc-field-label", label), control);
  return wrapper;
}

function selectableSources(sources: readonly CalendarSource[], selected: string, includeSelected = false): HTMLSelectElement {
  const select = element("select", "dc-input");
  select.name = "calendarId";
  for (const source of sources.filter(source => (!source.readOnly && source.allowCreate !== false) || (includeSelected && source.id === selected))) {
    const option = element("option", undefined, source.title);
    option.value = source.id;
    option.selected = source.id === selected;
    select.append(option);
  }
  return select;
}

export interface EventEditorInitial {
  readonly selection?: CalendarSelection;
  readonly occurrence?: CalendarOccurrence;
  readonly sourceItem?: CalendarItem;
  readonly duplicate?: boolean;
}

export interface EventEditorCapabilities {
  /** Whether non-temporal semantic fields may be edited. Omitted preserves the occurrence's base EditPolicy. */
  readonly allowSemanticEdit?: boolean | undefined;
  readonly allowAllDayConversion?: boolean | undefined;
  readonly allowRecurrenceChange?: boolean | undefined;
  readonly allowStartChange?: boolean | undefined;
  readonly allowEndChange?: boolean | undefined;
}

export interface EventEditorResult {
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly temporal: CalendarTemporalSpec;
  readonly temporalForm?: CalendarTemporalForm | undefined;
  readonly kind: CalendarItemKind;
  readonly recurrence?: CalendarRecurrence;
  readonly reminders?: readonly CalendarReminder[];
}

export async function openEventEditor(
  host: HTMLElement,
  initial: EventEditorInitial,
  sources: readonly CalendarSource[],
  defaultCalendarId: string,
  weekStartsOn: Weekday,
  timeZone: string,
  kindOptions: readonly CalendarKindOption[] = [{ value: "event", label: "Event" }],
  reminderChannelOptions: readonly CalendarReminderChannelOption[] = [
    { value: "browser", label: "Browser / OS" },
    { value: "in-app", label: "In app" },
    { value: "external", label: "External calendar" },
  ],
  capabilities: EventEditorCapabilities = {},
  overlapDisambiguation: CalendarOverlapDisambiguation = "earlier",
): Promise<EventEditorResult | null> {
  const occurrence = initial.occurrence;
  const sourceItem = initial.sourceItem;
  const pointOccurrence = Boolean(occurrence && occurrence.temporalForm === "point");
  const selection = initial.selection;
  const allDay = occurrence?.allDay ?? selection?.allDay ?? false;
  const sourceTemporal: CalendarTemporalSpec = sourceItem?.temporal ?? occurrence?.temporal ?? (allDay ? { kind: "date" } : { kind: "instant" });
  const editorTimeZone = sourceTemporal.kind === "zoned" ? sourceTemporal.timeZone ?? timeZone : timeZone;
  const start = occurrence ? toDate(occurrence.start) : selection ? toDate(selection.start) : new Date();
  const end = occurrence ? toDate(occurrence.end) : selection ? toDate(selection.end) : new Date(start.getTime() + 60 * 60_000);
  const selectedCalendar = initial.duplicate ? defaultCalendarId : occurrence?.calendarId ?? defaultCalendarId;
  const baseSemanticEdit = !occurrence || initial.duplicate || occurrence.editPolicy === "full";
  const scheduleOnly = Boolean(occurrence && !initial.duplicate && !(capabilities.allowSemanticEdit ?? baseSemanticEdit));
  const dialog = element("dialog", "dc-dialog dc-editor-dialog");
  dialog.setAttribute("aria-label", initial.duplicate ? "Duplicate event" : occurrence ? "Edit event" : "New event");
  const form = element("form", "dc-editor");
  form.method = "dialog";
  const header = element("div", "dc-dialog-header");
  header.append(element("h2", undefined, initial.duplicate ? "Duplicate event" : occurrence ? "Edit event" : "New event"));
  const close = element("button", "dc-icon-btn", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => dialog.close("cancel"));
  header.append(close);

  const title = input("title", "text", initial.duplicate ? `${occurrence?.title ?? "Event"} copy` : occurrence?.title ?? "");
  title.required = true;
  title.maxLength = 240;
  title.placeholder = "Add title";

  const allDayInput = input("allDay", "checkbox");
  allDayInput.checked = allDay;
  const allDayField = element("label", "dc-check");
  allDayField.append(allDayInput, document.createTextNode("All day"));

  const startDate = input("startDate", "date", localDate(start, editorTimeZone));
  const startTime = input("startTime", "time", localTime(start, editorTimeZone));
  startTime.step = "300";
  const endDateDisplay = allDay ? addDays(startOfDay(end, editorTimeZone), -1, editorTimeZone) : end;
  const endDate = input("endDate", "date", localDate(endDateDisplay, editorTimeZone));
  const endTime = input("endTime", "time", localTime(end, editorTimeZone));
  endTime.step = "300";

  const dateGrid = element("div", "dc-editor-grid");
  const endDateField = field(pointOccurrence ? "At" : "Ends", endDate);
  const endTimeField = field("Time", endTime);
  dateGrid.append(field(pointOccurrence ? "Date" : "Starts", startDate), field("Time", startTime), endDateField, endTimeField);
  if (pointOccurrence) {
    endDate.disabled = true;
    endTime.disabled = true;
    endDateField.hidden = true;
    endTimeField.hidden = true;
    dateGrid.dataset.temporalForm = "point";
  }

  const location = input("location", "text", occurrence?.location ?? "");
  location.maxLength = 320;
  const description = element("textarea", "dc-input dc-textarea");
  description.name = "description";
  description.rows = 4;
  description.maxLength = 8000;
  description.value = occurrence?.description ?? "";
  const existingReminder = occurrence?.reminders?.find(reminder => reminder.enabled !== false);
  const reminderMinutes = element("select", "dc-input");
  reminderMinutes.name = "reminderMinutes";
  for (const [value, label] of [["", "None"], ["0", "At start"], ["5", "5 minutes before"], ["10", "10 minutes before"], ["15", "15 minutes before"], ["30", "30 minutes before"], ["60", "1 hour before"], ["1440", "1 day before"]] as const) {
    const option = element("option", undefined, label); option.value = value; option.selected = value === (existingReminder ? String(existingReminder.minutesBefore) : ""); reminderMinutes.append(option);
  }
  const reminderChannel = element("select", "dc-input");
  reminderChannel.name = "reminderChannel";
  const channelChoices = new Map<string, string>();
  for (const option of reminderChannelOptions) if (option.value.trim()) channelChoices.set(option.value, option.label || option.value);
  const selectedReminderChannel = existingReminder?.channel ?? reminderChannelOptions[0]?.value ?? "in-app";
  if (!channelChoices.has(selectedReminderChannel)) channelChoices.set(selectedReminderChannel, selectedReminderChannel);
  for (const [value, label] of channelChoices) {
    const option = element("option", undefined, label); option.value = value; option.selected = value === selectedReminderChannel; reminderChannel.append(option);
  }
  const reminderRow = element("div", "dc-editor-inline");
  reminderRow.append(field("Reminder", reminderMinutes), field("Delivery", reminderChannel));

  const calendar = selectableSources(sources, selectedCalendar, Boolean(occurrence && !initial.duplicate));
  const kind = element("select", "dc-input");
  kind.name = "kind";
  const selectedKind = occurrence?.kind ?? kindOptions[0]?.value ?? "event";
  const choices = new Map<string, string>();
  for (const option of kindOptions) if (option.value.trim()) choices.set(option.value, option.label || option.value);
  if (!choices.has(selectedKind)) choices.set(selectedKind, selectedKind.replace(/[-_]+/gu, " "));
  if (!choices.size) choices.set("event", "Event");
  for (const [value, label] of choices) {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === selectedKind;
    kind.append(option);
  }

  const recurrenceBox = element("fieldset", "dc-recurrence-box");
  recurrenceBox.append(element("legend", undefined, "Repeat"));
  const repeat = element("select", "dc-input");
  repeat.name = "repeat";
  const currentRule = sourceItem?.recurrence?.rule;
  for (const [value, label] of [["", "Does not repeat"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]] as const) {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === (currentRule?.frequency ?? "");
    repeat.append(option);
  }
  const interval = input("interval", "number", String(currentRule?.interval ?? 1));
  interval.min = "1";
  interval.max = "999";
  const repeatRow = element("div", "dc-editor-inline");
  repeatRow.append(field("Pattern", repeat), field("Every", interval));
  recurrenceBox.append(repeatRow);

  const weekdays = element("div", "dc-weekday-picker");
  const recurrenceAnchor = sourceItem?.recurrence && !initial.duplicate
    ? toDate(sourceItem.start, sourceTemporal.kind === "instant" ? undefined : editorTimeZone)
    : start;
  const startPlain = instantToPlain(recurrenceAnchor.getTime(), editorTimeZone);
  const startWeekday = new Date(Date.UTC(startPlain.year, startPlain.month - 1, startPlain.day)).getUTCDay() as Weekday;
  const simpleByDay = currentRule?.byDay?.filter(entry => entry.ordinal === undefined).map(entry => entry.weekday);
  const selectedWeekdays = new Set(simpleByDay?.length ? simpleByDay : currentRule?.byWeekday?.length ? currentRule.byWeekday : [startWeekday]);
  for (const weekday of WEEKDAYS) {
    const label = element("label", "dc-weekday-check");
    const check = input(`weekday-${weekday.value}`, "checkbox");
    check.dataset.weekday = String(weekday.value);
    check.checked = selectedWeekdays.has(weekday.value);
    label.append(check, document.createTextNode(weekday.label));
    weekdays.append(label);
  }
  recurrenceBox.append(weekdays);

  const advancedValues = recurrenceAdvancedFields(currentRule);
  const advanced = element("details", "dc-recurrence-advanced");
  advanced.append(element("summary", undefined, "Advanced recurrence filters"));
  advanced.append(element("p", "dc-help", "Optional RFC-style filters. Use comma-separated values; negative month days count backwards from month end."));
  const advancedGrid = element("div", "dc-advanced-recurrence-grid");
  const monthDays = input("byMonthDay", "text", advancedValues.byMonthDay);
  monthDays.placeholder = "e.g. 1, 15, -1";
  const months = input("byMonth", "text", advancedValues.byMonth);
  months.placeholder = "e.g. 1, 4, 7, 10";
  const byDay = input("byDay", "text", advancedValues.byDay);
  byDay.placeholder = "e.g. MO, WE, 2TU, -1FR";
  const setPositions = input("bySetPosition", "text", advancedValues.bySetPosition);
  setPositions.placeholder = "e.g. 1, -1";
  advancedGrid.append(field("Month days", monthDays), field("Months (1–12)", months), field("Weekday rules", byDay), field("Set positions", setPositions));
  advanced.append(advancedGrid);
  recurrenceBox.append(advanced);

  const endMode = element("select", "dc-input");
  endMode.name = "endMode";
  const existingEndMode = currentRule?.count ? "count" : currentRule?.until ? "until" : "never";
  for (const [value, label] of [["never", "Never"], ["until", "On date"], ["count", "After occurrences"]] as const) {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === existingEndMode;
    endMode.append(option);
  }
  const until = input("until", "date", currentRule?.until ? localDate(toDate(currentRule.until, editorTimeZone), editorTimeZone) : localDate(addDays(start, 30, editorTimeZone), editorTimeZone));
  const count = input("count", "number", String(currentRule?.count ?? 10));
  count.min = "1";
  count.max = "20000";
  const endRow = element("div", "dc-editor-grid dc-repeat-end");
  endRow.append(field("Ends", endMode), field("Date", until), field("Count", count));
  recurrenceBox.append(endRow);

  const recurrenceFormState = (): string => JSON.stringify({
    repeat: repeat.value,
    interval: interval.value,
    weekdays: [...weekdays.querySelectorAll<HTMLInputElement>("input[data-weekday]:checked")].map(node => node.dataset.weekday),
    byMonthDay: monthDays.value.trim(),
    byMonth: months.value.trim(),
    byDay: byDay.value.trim().toUpperCase(),
    bySetPosition: setPositions.value.trim(),
    endMode: endMode.value,
    until: until.value,
    count: count.value,
  });
  const initialRecurrenceFormState = recurrenceFormState();

  const startLocked = Boolean(occurrence && capabilities.allowStartChange === false);
  const endLocked = Boolean(occurrence && capabilities.allowEndChange === false);
  const toggleTime = () => {
    startDate.disabled = startLocked;
    startTime.disabled = startLocked || allDayInput.checked;
    endDate.disabled = pointOccurrence || endLocked;
    endTime.disabled = pointOccurrence || endLocked || allDayInput.checked;
  };
  const toggleRecurrence = () => {
    const enabled = repeat.value !== "";
    interval.disabled = !enabled;
    weekdays.hidden = repeat.value !== "weekly";
    advanced.hidden = !enabled;
    endMode.disabled = !enabled;
    until.disabled = !enabled || endMode.value !== "until";
    count.disabled = !enabled || endMode.value !== "count";
    for (const control of [monthDays, months, byDay, setPositions]) control.disabled = !enabled;
  };
  allDayInput.addEventListener("change", toggleTime);
  repeat.addEventListener("change", toggleRecurrence);
  endMode.addEventListener("change", toggleRecurrence);
  toggleTime();
  toggleRecurrence();
  if (pointOccurrence || (occurrence && capabilities.allowAllDayConversion === false)) allDayInput.disabled = true;
  if (occurrence && capabilities.allowRecurrenceChange === false) recurrenceBox.disabled = true;
  if (scheduleOnly) {
    title.disabled = true;
    calendar.disabled = true;
    kind.disabled = true;
    location.disabled = true;
    description.disabled = true;
    reminderMinutes.disabled = true;
    reminderChannel.disabled = true;
    allDayInput.disabled = true;
    repeat.disabled = true;
    interval.disabled = true;
    endMode.disabled = true;
    until.disabled = true;
    count.disabled = true;
    for (const check of weekdays.querySelectorAll<HTMLInputElement>("input")) check.disabled = true;
    for (const control of [monthDays, months, byDay, setPositions]) control.disabled = true;
  }

  const body = element("div", "dc-dialog-body");
  body.append(field("Title", title), allDayField, dateGrid, field("Calendar", calendar), field("Type", kind), field("Location", location), field("Description", description), reminderRow, recurrenceBox);
  const footer = element("div", "dc-dialog-footer");
  const cancel = element("button", "dc-btn", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close("cancel"));
  const save = element("button", "dc-btn dc-primary", "Save");
  save.type = "submit";
  footer.append(cancel, save);
  form.append(header, body, footer);
  dialog.append(form);
  host.append(dialog);

  return await new Promise(resolve => {
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      try {
        const allDayValue = allDayInput.checked;
        const timedKind = sourceTemporal.kind === "date" ? "instant" : sourceTemporal.kind;
        const nextTemporal: CalendarTemporalSpec = allDayValue
          ? { kind: "date" }
          : timedKind === "zoned"
            ? { ...sourceTemporal, kind: "zoned", timeZone: sourceTemporal.timeZone ?? editorTimeZone }
            : timedKind === "floating"
              ? { ...sourceTemporal, kind: "floating" }
              : { kind: "instant" };
        let nextStart: Date;
        let nextEnd: Date;
        if (allDayValue) {
          nextStart = startOfDay(toDate(startDate.value, editorTimeZone), editorTimeZone);
          nextEnd = addDays(startOfDay(toDate(endDate.value, editorTimeZone), editorTimeZone), 1, editorTimeZone);
        } else {
          nextStart = localDateTime(startDate.value, startTime.value, editorTimeZone, overlapDisambiguation);
          nextEnd = pointOccurrence ? nextStart : localDateTime(endDate.value, endTime.value, editorTimeZone, overlapDisambiguation);
        }
        if (pointOccurrence ? nextEnd.getTime() !== nextStart.getTime() : nextEnd.getTime() <= nextStart.getTime()) {
          endDate.setCustomValidity(pointOccurrence ? "Point time must remain a single instant" : "End must be after start");
          endDate.reportValidity();
          return;
        }
        endDate.setCustomValidity("");
        let recurrence: CalendarRecurrence | undefined;
        if (repeat.value) {
          const frequency = repeat.value as RecurrenceFrequency;
          const checkedWeekdays = [...weekdays.querySelectorAll<HTMLInputElement>("input[data-weekday]:checked")].map(node => Number(node.dataset.weekday) as Weekday);
          const nextStartPlain = instantToPlain(nextStart.getTime(), editorTimeZone);
          const untilValue = endMode.value === "until"
            ? recurrenceUntilFromEditor(until.value, nextTemporal.kind, editorTimeZone)
            : undefined;
          const countValue = endMode.value === "count" ? Math.max(1, Number(count.value) || 1) : undefined;
          const generatedRule = recurrenceRuleFromEditor({
            frequency,
            interval: Math.max(1, Number(interval.value) || 1),
            weekStartsOn,
            checkedWeekdays: checkedWeekdays.length ? checkedWeekdays : [startWeekday],
            startMonth: nextStartPlain.month,
            startMonthDay: nextStartPlain.day,
            advanced: { byMonthDay: monthDays.value, byMonth: months.value, byDay: byDay.value, bySetPosition: setPositions.value },
            ...(countValue !== undefined ? { count: countValue } : {}),
            ...(untilValue !== undefined ? { until: untilValue } : {}),
          });
          const preserveRule = Boolean(currentRule && recurrenceFormState() === initialRecurrenceFormState && nextTemporal.kind === sourceTemporal.kind);
          const rule = preserveRule ? currentRule! : generatedRule;
          recurrence = { rule, ...(!initial.duplicate && sourceItem?.recurrence?.exceptions ? { exceptions: sourceItem.recurrence.exceptions } : {}) };
        }
        const reminders: CalendarReminder[] = reminderMinutes.value === "" ? [] : [{ id: existingReminder?.id ?? `reminder-${crypto.randomUUID()}`, minutesBefore: Math.max(0, Number(reminderMinutes.value) || 0), channel: reminderChannel.value as CalendarReminder["channel"] }];
        const startValue = allDayValue
          ? startDate.value
          : nextTemporal.kind === "zoned" || nextTemporal.kind === "floating"
            ? plainDateTimeValue(startDate.value, startTime.value)
            : nextStart.toISOString();
        const endValue = pointOccurrence
          ? startValue
          : allDayValue
            ? localDate(nextEnd, editorTimeZone)
            : nextTemporal.kind === "zoned" || nextTemporal.kind === "floating"
              ? plainDateTimeValue(endDate.value, endTime.value)
              : nextEnd.toISOString();
        const result: EventEditorResult = {
          calendarId: calendar.value || defaultCalendarId,
          title: title.value.trim(),
          ...(description.value.trim() ? { description: description.value.trim() } : {}),
          ...(location.value.trim() ? { location: location.value.trim() } : {}),
          start: startValue,
          end: endValue,
          allDay: allDayValue,
          temporal: nextTemporal,
          ...(pointOccurrence ? { temporalForm: "point" as const } : {}),
          kind: kind.value as CalendarItemKind,
          ...(reminders.length ? { reminders } : {}),
          ...(recurrence ? { recurrence } : {}),
        };
        dialog.close("save");
        resolve(result);
      } catch (error) {
        title.setCustomValidity(error instanceof Error ? error.message : "Invalid event");
        title.reportValidity();
        title.setCustomValidity("");
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (dialog.returnValue !== "save") resolve(null);
    }, { once: true });
    dialog.showModal();
    title.focus();
  });
}

export async function chooseSeriesScope(host: HTMLElement, action: string, allowThis = true): Promise<SeriesEditScope | null> {
  const dialog = element("dialog", "dc-dialog dc-scope-dialog");
  dialog.setAttribute("aria-label", `${action} recurring event`);
  const box = element("div", "dc-scope-box");
  box.append(element("h2", undefined, `${action} recurring event`), element("p", "dc-muted", "Choose which events in this series should be affected."));
  const actions = element("div", "dc-scope-actions");
  const choices: readonly [SeriesEditScope, string][] = [["this", "This event"], ["this-and-following", "This and following"], ["all", "All events"]];
  for (const [scope, label] of choices) {
    const button = element("button", "dc-btn", label);
    button.type = "button";
    button.disabled = scope === "this" && !allowThis;
    button.addEventListener("click", () => dialog.close(scope));
    actions.append(button);
  }
  const cancel = element("button", "dc-btn", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close("cancel"));
  actions.append(cancel);
  box.append(actions);
  dialog.append(box);
  host.append(dialog);
  return await new Promise(resolve => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      dialog.remove();
      resolve(value === "this" || value === "this-and-following" || value === "all" ? value : null);
    }, { once: true });
    dialog.showModal();
  });
}

import { openHarness } from "./harness.mjs";

export async function mountAuthorizedExternalDrop(page) {
  await openHarness(page);
  await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { RepositoryCommandHandler },
      { CalendarUi },
      { CALENDAR_EXTERNAL_DROP_MIME, setCalendarExternalDropData },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/external-drop.js"),
    ]);

    const sources = [
      { id: "personal", title: "Personal", visible: true, removable: true },
      { id: "locked", title: "Locked", visible: true, removable: true, readOnly: true },
    ];
    const initial = {
      id: "internal",
      calendarId: "personal",
      title: "Internal event",
      start: "2026-11-05",
      end: "2026-11-06",
      allDay: true,
      precision: "date",
      temporal: { kind: "date" },
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const collision = {
      id: "collision",
      calendarId: "personal",
      title: "Collision fixture",
      start: "2026-11-10T12:00:00.000Z",
      end: "2026-11-10T13:00:00.000Z",
      kind: "event",
      ownership: "calendar",
      editPolicy: "full",
    };
    const repository = new MemoryCalendarRepository(sources, [initial, collision]);
    const purposes = [];
    let decoderCalls = 0;
    const customDropView = {
      id: "external-drop-view",
      label: "Drop view",
      range(context) {
        const start = new Date(context.anchor);
        start.setUTCHours(0, 0, 0, 0);
        return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
      },
      shiftAnchor(context, direction) {
        return new Date(context.anchor.getTime() + direction * 86400000);
      },
      title() { return "External drop custom view"; },
      render(context) {
        const target = document.createElement("section");
        target.className = "custom-external-drop-target";
        target.textContent = "Custom drop target";
        context.actions.bindExternalDropTarget(target, () => ({
          start: "2026-11-15T00:00:00.000Z",
          end: "2026-11-16T00:00:00.000Z",
          allDay: true,
        }));
        return target;
      },
    };
    const calendar = new CalendarUi(
      document.getElementById("browser-test-host"),
      new CalendarEngine(repository),
      {
        locale: "en-US",
        timeZone: "UTC",
        initialDate: "2026-11-10",
        initialView: "month",
        customViews: [customDropView],
        dayStartHour: 8,
        dayEndHour: 18,
        slotMinutes: 30,
        snapPolicy: { selection: "floor", move: "round", resize: "round", keyboardStepMinutes: 30 },
        commandHandler: new RepositoryCommandHandler(repository),
        navigationBounds: { min: "2026-11-01", max: "2026-11-15" },
        collisionPolicy: { mode: "prevent", includeAllDay: false },
        itemFactory({ id, now, purpose, draft }) {
          purposes.push(purpose);
          return {
            ...draft,
            ...(draft.title === "Factory redirect" ? { calendarId: "locked" } : {}),
            id,
            ownership: "calendar",
            editPolicy: "full",
            createdAt: now,
            updatedAt: now,
          };
        },
        externalDropDecoder: {
          types: ["application/x-host-task"],
          decode(dataTransfer) {
            decoderCalls += 1;
            return JSON.parse(dataTransfer.getData("application/x-host-task"));
          },
        },
        placementGuards: [{
          id: "block-nov-14",
          evaluate(context) {
            return context.start.startsWith("2026-11-14T")
              ? { mode: "prevent", message: "Fixture blocked date." }
              : { mode: "allow" };
          },
        }],
      },
    );
    await calendar.refresh();

    const addSource = (id, writer) => {
      const source = document.createElement("button");
      source.id = id;
      source.type = "button";
      source.draggable = true;
      source.textContent = id;
      source.addEventListener("dragstart", event => {
        if (event.dataTransfer) writer(event.dataTransfer);
      });
      document.body.append(source);
    };
    addSource("external-month", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "External month",
      durationDays: 2,
      metadata: { origin: "outside-dom" },
    }));
    addSource("external-locked", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Locked external",
      calendarId: "locked",
    }));
    addSource("external-malformed", dataTransfer => {
      dataTransfer.setData(CALENDAR_EXTERNAL_DROP_MIME, "{malformed");
      dataTransfer.effectAllowed = "copy";
    });
    addSource("external-custom", dataTransfer => {
      dataTransfer.setData("application/x-host-task", JSON.stringify({
        title: "Host decoded",
        durationDays: 1,
        kind: "task",
      }));
      dataTransfer.effectAllowed = "copy";
    });
    addSource("external-blocked", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Blocked external",
    }));
    addSource("external-lane", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "All-day lane",
    }));
    addSource("external-timed", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Timed external",
      durationMinutes: 90,
    }));
    addSource("external-collision", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Collision external",
      durationMinutes: 60,
    }));
    addSource("external-out-of-bounds", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Out of bounds external",
    }));
    addSource("external-factory-redirect", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Factory redirect",
    }));
    addSource("external-custom-view", dataTransfer => setCalendarExternalDropData(dataTransfer, {
      title: "Custom view external",
    }));

    const dispatchDrag = (source, target, clientY) => {
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + Math.min(12, Math.max(1, rect.width / 2)),
        clientY: clientY ?? rect.top + Math.min(12, Math.max(1, rect.height / 2)),
      };
      const callsBeforeHover = decoderCalls;
      target.dispatchEvent(new DragEvent("dragenter", init));
      target.dispatchEvent(new DragEvent("dragover", init));
      const accepted = target.classList.contains("is-external-drop-target");
      const callsAfterHover = decoderCalls;
      target.dispatchEvent(new DragEvent("drop", init));
      source.dispatchEvent(new DragEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
      return {
        accepted,
        callsBeforeHover,
        callsAfterHover,
        callsAfterDrop: decoderCalls,
        targetStillActive: target.classList.contains("is-external-drop-target"),
      };
    };

    const monthCell = date => document.querySelector(
      `.dc-day-cell[data-calendar-date^="${date}"]`,
    );
    globalThis.__externalDropProbe = {
      calendar,
      repository,
      purposes,
      decoderCalls: () => decoderCalls,
      dropMonth(sourceId, date) {
        const source = document.getElementById(sourceId);
        const target = monthCell(date);
        if (!source || !target) throw new Error("Month drag fixture target missing");
        return dispatchDrag(source, target);
      },
      moveInternal(date) {
        const source = [...document.querySelectorAll(".dc-event")]
          .find(node => node.textContent?.includes("Internal event"));
        const target = monthCell(date);
        if (!source || !target) throw new Error("Internal drag fixture target missing");
        return dispatchDrag(source, target);
      },
      async showDay(date) {
        calendar.setView("day");
        calendar.goTo(new Date(`${date}T00:00:00.000Z`));
        await calendar.refresh();
      },
      dropAllDay(sourceId) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".dc-all-day-col");
        if (!source || !target) throw new Error("All-day drag fixture target missing");
        return dispatchDrag(source, target);
      },
      dropTimed(sourceId, minuteOffset) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".dc-time-column");
        if (!source || !target) throw new Error("Timed drag fixture target missing");
        const rect = target.getBoundingClientRect();
        return dispatchDrag(source, target, rect.top + minuteOffset);
      },
      async showCustomDropView() {
        calendar.setView("external-drop-view");
        await calendar.refresh();
      },
      dropCustomView(sourceId) {
        const source = document.getElementById(sourceId);
        const target = document.querySelector(".custom-external-drop-target");
        if (!source || !target) throw new Error("Custom-view drag fixture target missing");
        return dispatchDrag(source, target);
      },
    };
  });
}

export async function evaluateDormantExternalDropAndPrint(page) {
  await openHarness(page);
  return await page.evaluate(async () => {
    const [{ CalendarEngine }, { MemoryCalendarRepository }, { RepositoryCommandHandler }, { CalendarUi }, { setCalendarExternalDropData }] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/external-drop.js"),
    ]);
    const source={id:"personal",title:"Personal",visible:true};
    const repository=new MemoryCalendarRepository([source],[]);
    const host=document.getElementById("browser-test-host");
    const calendar=new CalendarUi(host,new CalendarEngine(repository),{
      locale:"en-US",timeZone:"UTC",initialDate:"2026-11-10",initialView:"month",
      commandHandler:new RepositoryCommandHandler(repository),
    });
    await calendar.refresh();
    const cell=host.querySelector(".dc-day-cell");
    const transfer=new DataTransfer();
    setCalendarExternalDropData(transfer,{title:"Should stay external"});
    const before=repository.read().revision;
    cell.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:transfer}));
    cell.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer}));
    await new Promise(resolve=>setTimeout(resolve,0));
    const printStyles=host.querySelectorAll("style[data-calendar-print-styles='true']").length;
    return {
      revisionBefore:before,
      revisionAfter:repository.read().revision,
      externalTarget:cell.classList.contains("is-external-drop-target"),
      printStyles,
      snapshotStyles:calendar.createPrintSnapshot().querySelectorAll("style[data-calendar-print-styles='true']").length,
    };
  });
}

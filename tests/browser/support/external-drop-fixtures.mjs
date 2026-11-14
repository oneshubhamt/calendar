import { openHarness } from "./harness.mjs";

export async function mountAuthorizedExternalDrop(page) {
  await openHarness(page);
  await page.evaluate(async () => {
    const [
      { CalendarEngine },
      { MemoryCalendarRepository },
      { RepositoryCommandHandler },
      { CalendarUi },
      { setCalendarExternalDropData },
    ] = await Promise.all([
      import("/dist/core/calendar-engine.js"),
      import("/dist/core/store.js"),
      import("/dist/core/commands.js"),
      import("/dist/view/calendar-ui.js"),
      import("/dist/view/external-drop.js"),
    ]);

    const source = { id: "personal", title: "Personal", visible: true, removable: true };
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
    const repository = new MemoryCalendarRepository([source], [initial]);
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
        externalDropDecoder: {
          types: ["application/x-host-task"],
          decode(dataTransfer) {
            decoderCalls += 1;
            return JSON.parse(dataTransfer.getData("application/x-host-task"));
          },
        },
      },
    );
    await calendar.refresh();

    const addSource = (id, writer) => {
      const node = document.createElement("button");
      node.id = id;
      node.type = "button";
      node.draggable = true;
      node.textContent = id;
      node.addEventListener("dragstart", event => {
        if (event.dataTransfer) writer(event.dataTransfer);
      });
      document.body.append(node);
    };
    addSource("external-month", transfer => setCalendarExternalDropData(transfer, {
      title: "External month", durationDays: 2, metadata: { origin: "outside-dom" },
    }));
    addSource("external-custom", transfer => {
      transfer.setData("application/x-host-task", JSON.stringify({
        title: "Host decoded", durationDays: 1, kind: "task",
      }));
      transfer.effectAllowed = "copy";
    });
    addSource("external-lane", transfer => setCalendarExternalDropData(transfer, { title: "All-day lane" }));
    addSource("external-timed", transfer => setCalendarExternalDropData(transfer, {
      title: "Timed external", durationMinutes: 90,
    }));
    addSource("external-custom-view", transfer => setCalendarExternalDropData(transfer, { title: "Custom view external" }));

    const dispatchDrag = (dragSource, target, clientY) => {
      const dataTransfer = new DataTransfer();
      dragSource.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
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
      dragSource.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
      return { accepted, callsBeforeHover, callsAfterHover, callsAfterDrop: decoderCalls };
    };

    const monthCell = date => document.querySelector(`.dc-day-cell[data-calendar-date^="${date}"]`);
    globalThis.__externalDropProbe = {
      calendar,
      repository,
      dropMonth(sourceId, date) {
        const dragSource = document.getElementById(sourceId);
        const target = monthCell(date);
        if (!dragSource || !target) throw new Error("Month drag fixture target missing");
        return dispatchDrag(dragSource, target);
      },
      moveInternal(date) {
        const dragSource = [...document.querySelectorAll(".dc-event")]
          .find(node => node.textContent?.includes("Internal event"));
        const target = monthCell(date);
        if (!dragSource || !target) throw new Error("Internal drag fixture target missing");
        return dispatchDrag(dragSource, target);
      },
      async showDay(date) {
        calendar.setView("day");
        calendar.goTo(new Date(`${date}T00:00:00.000Z`));
        await calendar.refresh();
      },
      dropAllDay(sourceId) {
        const dragSource = document.getElementById(sourceId);
        const target = document.querySelector(".dc-all-day-col");
        if (!dragSource || !target) throw new Error("All-day drag fixture target missing");
        return dispatchDrag(dragSource, target);
      },
      dropTimed(sourceId, minuteOffset) {
        const dragSource = document.getElementById(sourceId);
        const target = document.querySelector(".dc-time-column");
        if (!dragSource || !target) throw new Error("Timed drag fixture target missing");
        const rect = target.getBoundingClientRect();
        return dispatchDrag(dragSource, target, rect.top + minuteOffset);
      },
      async showCustomDropView() {
        calendar.setView("external-drop-view");
        await calendar.refresh();
      },
      dropCustomView(sourceId) {
        const dragSource = document.getElementById(sourceId);
        const target = document.querySelector(".custom-external-drop-target");
        if (!dragSource || !target) throw new Error("Custom-view drag fixture target missing");
        return dispatchDrag(dragSource, target);
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

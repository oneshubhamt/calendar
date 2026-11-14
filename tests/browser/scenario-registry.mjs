import { test } from "@playwright/test";

// Single source of truth for scenario selection. Every case also belongs to @release.
// "cross" is the selective multi-engine witness and runs in all three engines.
// "smoke" adds Chromium breadth; "visual" keeps reviewed screenshots Chromium-only.
export const scenarioTags = Object.freeze({
  "refresh.midnight": ["cross"],
  "refresh.queue": [],
  "view.week": ["smoke"],
  "interaction.timed-drag": ["cross"],
  "presentation.actions": ["smoke"],
  "view.dst-fallback": ["cross"],
  "custom.host-view": ["cross"],
  "view.week-numbers": ["smoke"],
  "custom.multi-month": ["smoke"],
  "custom.timeline": ["smoke"],
  "drop.authorized": ["cross"],
  "drop.opt-in": [],
  "custom.dispose": [],
  "print.snapshot": ["cross"],
  "print.all-views": [],
  "embed.isolation": ["smoke"],
  "host.overdue": ["smoke"],
  "resource.timeline.hierarchy": ["smoke"],
  "resource.timeline.keyboard": ["cross"],
  "resource.timeline.refresh-failures": [],
  "resource.timeline.pointer": ["cross"],
  "resource.timeline.auto-scroll": [],
  "resource.grid.render": ["smoke"],
  "resource.grid.keyboard": ["cross"],
  "resource.grid.pointer": ["cross"],
  "storage.schema": ["cross"],
  "storage.schema-reject": [],
  "storage.interop-invalid": [],
  "storage.interop-identity": [],
  "storage.reminder-claim": ["cross"],
  "storage.google-lock": [],
  "storage.lifecycle": [],
  "storage.reload-generation": [],
  "storage.records": ["smoke"],
  "storage.cas": ["cross"],
  "storage.broadcast": ["smoke"],
  "storage.focus-fallback": ["cross"],
  "visual.week": ["visual"],
  "visual.month": ["visual"],
  "visual.day-narrow": ["visual"],
  "visual.dst-fallback": ["visual"],
  "visual.multi-month": ["visual"],
  "visual.multi-month-narrow": ["visual"],
  "visual.timeline": ["visual"],
  "visual.print": ["visual"],
  "visual.resource-grid": ["visual"],
});

const registered = new Set();
export function scenario(id, title, body) {
  const tags = scenarioTags[id];
  if (!tags) throw new Error(`Unknown browser QA scenario: ${id}`);
  if (registered.has(id)) throw new Error(`Duplicate browser QA scenario: ${id}`);
  registered.add(id);
  test(title, { tag: ["@release", ...tags.map(value => `@${value}`)] }, body);
}

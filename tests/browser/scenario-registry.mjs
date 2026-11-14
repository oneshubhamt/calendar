import { test } from "@playwright/test";

// Single source of truth for scenario selection. Every case also belongs to @release.
// "cross" is the selective multi-engine witness; "smoke" is a Chromium-only fast check;
// "visual" keeps reviewed screenshot coverage outside the cross-browser run.
export const scenarioTags = Object.freeze({
  "refresh.midnight": ["cross"],
  "refresh.coalesce": [],
  "refresh.failure-recovery": [],
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
  "resource.timeline.keyboard-reassign": ["cross"],
  "resource.timeline.committed-refresh-failure": [],
  "resource.timeline.stale-refresh-failure": [],
  "resource.timeline.resize": [],
  "resource.timeline.pointer": ["cross"],
  "resource.timeline.auto-scroll": [],
  "resource.grid.render": ["smoke"],
  "resource.grid.diagonal-move": ["cross"],
  "resource.grid.vertical-keyboard": [],
  "resource.grid.resize": [],
  "resource.grid.pointer": ["cross"],
  "storage.schema": ["cross"],
  "storage.schema-reject": [],
  "storage.interop-invalid": [],
  "storage.interop-identity": [],
  "storage.reminder-claim": ["cross"],
  "storage.google-lock": [],
  "storage.single-flight": [],
  "storage.close-open": [],
  "storage.reopen-race": [],
  "storage.reopen": [],
  "storage.reload-generation": [],
  "storage.persist-reopen": ["smoke"],
  "storage.crud": [],
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

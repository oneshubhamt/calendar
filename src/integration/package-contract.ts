export const DIRECTOR_CALENDAR_PACKAGE = Object.freeze({
  name: "@director/calendar",
  version: "1.1.0",
  coreContract: 11,
  integrations: Object.freeze({
    studyDirector: Object.freeze({ contractVersion: 1, verifiedAgainst: "SDVB75F10" }),
    revisionDirector: Object.freeze({ contractVersion: 1, verifiedAgainst: "main" }),
    practiceDesk: Object.freeze({ contractVersion: 1, verifiedAgainst: "overhaul" }),
    practiceBridge: Object.freeze({ contractVersion: 1 }),
    interoperability: Object.freeze({ contractVersion: 2, standards: Object.freeze(["RFC5545", "Google Calendar API v3"]) }),
  }),
} as const);

export type CalendarUiPackageContract = typeof DIRECTOR_CALENDAR_PACKAGE;

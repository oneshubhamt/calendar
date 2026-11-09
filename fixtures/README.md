# Director fixtures

Reusable Director-specific fixtures live in `src/fixtures/director.ts` and are exported only from the opt-in subpath `@director/calendar/fixtures/director`.

They model Study Director plans/history, Revision Director obligations/daily plans/exams, Practice Desk attempts/scheduler-derived due cards, scheduled source actions and a 04:00 logical study-day boundary. They are integration fixtures, not part of the generic calendar root.

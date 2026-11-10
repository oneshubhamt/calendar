# Director fixtures

Repository-only Director fixtures live in `src/fixtures/director.ts`.

They model Study Director plans/history, Revision Director obligations/daily plans/exams, Practice Desk attempts/scheduler-derived due cards, scheduled source actions and a 04:00 logical study-day boundary. They support repository tests and demos only: they are not exported from `@director/calendar` and are excluded from the published package build.

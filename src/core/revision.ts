/** Generic optimistic-concurrency rejection for authoritative Calendar repositories. */
export class CalendarStaleRevisionError extends Error {
  public readonly code = "stale" as const;

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision?: number,
    message = actualRevision === undefined
      ? `Calendar state changed after revision ${expectedRevision}`
      : `Calendar state changed: expected revision ${expectedRevision}, found ${actualRevision}`,
  ) {
    super(message);
    this.name = "CalendarStaleRevisionError";
  }
}

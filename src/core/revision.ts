/** Generic stale-authority signal shared by repository and host command boundaries. */
export class CalendarStaleError extends Error {
  public readonly code = "stale" as const;

  public constructor(message = "Calendar authoritative state changed") {
    super(message);
    this.name = "CalendarStaleError";
  }
}

/** Optimistic-concurrency rejection carrying concrete repository revisions. */
export class CalendarStaleRevisionError extends CalendarStaleError {
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

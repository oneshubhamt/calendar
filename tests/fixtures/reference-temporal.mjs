// Independent test-only Gregorian reference. No imports from Calendar's temporal or recurrence engines.
export const DAY_MS = 86_400_000;
export const utcDateKey = epoch => new Date(epoch).toISOString().slice(0,10);

// Deliberately enumerate civil UTC dates rather than borrowing production recurrence iterators.
export function referenceUtcRecurrence({start, frequency, interval = 1, weekdays = [], count}) {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new RangeError("Invalid reference count");
  if (!Number.isInteger(interval) || interval < 1) throw new RangeError("Invalid reference interval");
  if (frequency !== "daily" && frequency !== "weekly") throw new RangeError("Unsupported reference frequency");
  const anchor = Date.parse(start);
  if (!Number.isFinite(anchor) || !start.endsWith("Z")) throw new RangeError("Reference requires absolute UTC anchor");
  const firstWeekOffset = (new Date(anchor).getUTCDay() + 6) % 7;
  const occurrences = [];
  for (let day = 0; day < 20_000 && occurrences.length < count; day += 1) {
    const instant = anchor + day * DAY_MS;
    const weekday = new Date(instant).getUTCDay() || 7;
    const weekNumber = Math.floor((day + firstWeekOffset) / 7);
    const included = frequency === "daily"
      ? day % interval === 0
      : weekNumber % interval === 0 && weekdays.includes(weekday);
    if (included) occurrences.push(new Date(instant).toISOString());
  }
  if (occurrences.length !== count) throw new Error("Reference range exhausted");
  return occurrences;
}

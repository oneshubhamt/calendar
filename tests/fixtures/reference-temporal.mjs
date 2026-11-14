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


function isoWeekday(epoch) {
  const weekday = new Date(epoch).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function utcMonthLength(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function sameUtcClock(anchor, year, month, day) {
  return Date.UTC(
    year,
    month - 1,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

function monthDayMatches(year, month, day, values) {
  if (!values?.length) return true;
  const last = utcMonthLength(year, month);
  return values.some(value => day === (value > 0 ? value : last + value + 1));
}

function byDayEntryMatches(year, month, day, entry) {
  const epoch = Date.UTC(year, month - 1, day);
  if (isoWeekday(epoch) !== entry.weekday) return false;
  if (entry.ordinal === undefined) return true;
  const last = utcMonthLength(year, month);
  const ordinal = entry.ordinal > 0
    ? Math.floor((day - 1) / 7) + 1
    : -(Math.floor((last - day) / 7) + 1);
  return ordinal === entry.ordinal;
}

function calendarDateMatches(anchor, year, month, day, rule) {
  const interval = rule.interval ?? 1;
  if (rule.byMonth?.length && !rule.byMonth.includes(month)) return false;

  if (rule.frequency === "monthly") {
    const monthDistance = (year - anchor.getUTCFullYear()) * 12 + (month - (anchor.getUTCMonth() + 1));
    if (monthDistance < 0 || monthDistance % interval !== 0) return false;
  } else if (rule.frequency === "yearly") {
    const yearDistance = year - anchor.getUTCFullYear();
    if (yearDistance < 0 || yearDistance % interval !== 0) return false;
    if (!rule.byMonth?.length && month !== anchor.getUTCMonth() + 1) return false;
  } else {
    throw new RangeError("Calendar reference supports only monthly/yearly frequency");
  }

  const byMonthDay = rule.byMonthDay ?? [];
  const byDay = rule.byDay ?? [];
  if (byMonthDay.length && !monthDayMatches(year, month, day, byMonthDay)) return false;
  if (byDay.length && !byDay.some(entry => byDayEntryMatches(year, month, day, entry))) return false;
  if (!byMonthDay.length && !byDay.length && day !== anchor.getUTCDate()) return false;
  return true;
}

/**
 * Independent UTC date-scan oracle for the bounded monthly/yearly subset exercised by QA.
 * It deliberately does not import Calendar recurrence helpers or period iterators.
 */
export function referenceUtcCalendarRecurrence({
  start,
  rule,
  exceptions = [],
  rangeStart,
  rangeEnd,
  maxYears = 20,
}) {
  if (rule.frequency !== "monthly" && rule.frequency !== "yearly") {
    throw new RangeError("Calendar reference supports only monthly/yearly frequency");
  }
  if (rule.bySetPosition?.length) throw new RangeError("Calendar reference does not model BYSETPOS");
  if (!Number.isInteger(rule.interval ?? 1) || (rule.interval ?? 1) < 1) throw new RangeError("Invalid reference interval");
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 500)) {
    throw new RangeError("Invalid reference count");
  }

  const anchorEpoch = Date.parse(start);
  const rangeStartEpoch = Date.parse(rangeStart);
  const rangeEndEpoch = Date.parse(rangeEnd);
  if (!Number.isFinite(anchorEpoch) || !start.endsWith("Z")) throw new RangeError("Reference requires absolute UTC anchor");
  if (!Number.isFinite(rangeStartEpoch) || !Number.isFinite(rangeEndEpoch) || rangeEndEpoch <= rangeStartEpoch) {
    throw new RangeError("Invalid reference range");
  }
  const untilEpoch = rule.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(rule.until);
  if (!Number.isFinite(untilEpoch) && rule.until !== undefined) throw new RangeError("Invalid reference UNTIL");

  const anchor = new Date(anchorEpoch);
  const identities = [new Date(anchorEpoch).toISOString()];
  const limitYear = anchor.getUTCFullYear() + maxYears;
  outer:
  for (let year = anchor.getUTCFullYear(); year <= limitYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const last = utcMonthLength(year, month);
      for (let day = 1; day <= last; day += 1) {
        const epoch = sameUtcClock(anchor, year, month, day);
        if (epoch <= anchorEpoch) continue;
        if (epoch > untilEpoch) break outer;
        if (!calendarDateMatches(anchor, year, month, day, rule)) continue;
        identities.push(new Date(epoch).toISOString());
        if (identities.length >= (rule.count ?? 500)) break outer;
      }
    }
  }
  if (rule.count !== undefined && identities.length < rule.count && untilEpoch === Number.POSITIVE_INFINITY) {
    throw new Error("Calendar reference range exhausted before COUNT");
  }

  const exceptionByIdentity = new Map(exceptions.map(exception => [new Date(Date.parse(exception.originalStart)).toISOString(), exception]));
  return identities.flatMap(originalStart => {
    const exception = exceptionByIdentity.get(originalStart);
    if (exception?.cancelled) return [];
    const resolvedStart = exception?.replacement?.start
      ? new Date(Date.parse(exception.replacement.start)).toISOString()
      : originalStart;
    const epoch = Date.parse(resolvedStart);
    if (epoch < rangeStartEpoch || epoch >= rangeEndEpoch) return [];
    return [{ originalStart, start: resolvedStart }];
  });
}

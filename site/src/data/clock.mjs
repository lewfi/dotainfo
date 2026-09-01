const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function buildClockEpoch(clock) {
  if (clock instanceof Date) {
    if (!Number.isFinite(clock.getTime())) {
      throw new TypeError('build clock must be a valid Date');
    }
    return Math.floor(clock.getTime() / 1000);
  }

  if (typeof clock !== 'string' || !UTC_INSTANT.test(clock)) {
    throw new TypeError('build clock must be an ISO-8601 UTC instant ending in Z');
  }

  const milliseconds = Date.parse(clock);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('build clock must be a valid ISO-8601 UTC instant');
  }
  return Math.floor(milliseconds / 1000);
}

export function trailingWindow(clock, days) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new TypeError('window days must be a positive integer');
  }
  const endEpoch = buildClockEpoch(clock);
  return Object.freeze({
    days,
    startEpoch: endEpoch - days * 86_400,
    endEpoch,
  });
}

export function utcMonthFromEpoch(epochSeconds) {
  if (!Number.isInteger(epochSeconds)) {
    throw new TypeError('epoch seconds must be an integer');
  }
  const date = new Date(epochSeconds * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

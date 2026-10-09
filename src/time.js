// IST is a fixed +05:30 offset (no DST), so day boundaries can be computed arithmetically.
const IST_OFFSET_MS = 5.5 * 3600e3;

/** 'YYYY-MM-DD' for the IST calendar day of `d`. */
export function istDateKey(d = new Date()) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC Date for 00:00 IST, `offsetDays` from today's IST date. */
export function istStartOfDay(offsetDays = 0, from = new Date()) {
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  const midnightUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offsetDays);
  return new Date(midnightUtc - IST_OFFSET_MS);
}

/** UTC Date for 00:00 IST on the Monday of the current IST week. */
export function istStartOfWeek(from = new Date()) {
  const dow = new Date(from.getTime() + IST_OFFSET_MS).getUTCDay(); // 0 = Sun
  return istStartOfDay(-((dow + 6) % 7), from);
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
}

export function fmtDateTime(iso) {
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}

// Pulled out as pure functions specifically so they're deterministically
// testable against a fixed input, unlike a locale-dependent
// `Date.toLocaleString()` call sprinkled directly into DOM code. Mirrors
// TaskListView.swift's `.dateTime.month(.abbreviated).day()` deadline format
// and ApprovalQueueView.swift's `timeLabel(start:end:)`.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// "Jul 28" style — month + day only, no year/time (matches TaskListView's
// deadline chip, which is a coarse "due around when" indicator, not a
// precise timestamp display).
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// "Mon Jul 28 14:00" or, with an end time, "Mon Jul 28 14:00 – 15:00" — the
// end omits date/weekday, matching ApprovalQueueView.swift's own
// `timeLabel` (an end time on a different day is presumed rare enough not
// to warrant a repeated date, same tradeoff Swift already made).
export function formatTimeRange(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  const startLabel = `${WEEKDAYS[start.getDay()]} ${MONTHS[start.getMonth()]} ${start.getDate()} ${formatTime(start)}`;
  if (!endIso) return startLabel;
  const end = new Date(endIso);
  return `${startLabel} – ${formatTime(end)}`;
}

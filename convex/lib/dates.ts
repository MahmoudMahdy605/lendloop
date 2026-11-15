const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Inclusive date ranges overlap. YYYY-MM-DD strings compare correctly as strings. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

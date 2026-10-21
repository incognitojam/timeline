/**
 * Row model for the sidebar activity list.
 *
 * The list only holds dates that have events, so consecutive rows can be years
 * apart. Month dividers are interleaved with the date rows so a month change is
 * visible rather than silent.
 */

export interface MonthRow {
  kind: "month";
  key: string;
  /** YYYY-MM */
  month: string;
}

export interface DateRow {
  kind: "date";
  key: string;
  /** YYYY-MM-DD */
  date: string;
}

export type ActivityRow = MonthRow | DateRow;

export function buildActivityRows(
  datesNewestFirst: readonly string[],
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let currentMonth: string | null = null;

  for (const date of datesNewestFirst) {
    const month = date.slice(0, 7);
    if (month !== currentMonth) {
      rows.push({ kind: "month", key: `month:${month}`, month });
      currentMonth = month;
    }

    rows.push({ kind: "date", key: date, date });
  }

  return rows;
}

export function formatMonthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00Z`).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface RowMatch {
  index: number;
  /** Whether the row is the selected date itself rather than the nearest one. */
  exact: boolean;
}

/**
 * The row to bring into view for a selected date: its own row, or the nearest
 * loaded date before it when that day has no events of its own.
 *
 * Returns null while the date lies outside the loaded range, so a caller can
 * wait for the months around it instead of jumping to an unrelated row.
 */
export function findRowForDate(
  rows: readonly ActivityRow[],
  date: string,
): RowMatch | null {
  const dateRows: { index: number; date: string }[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "date") dateRows.push({ index, date: row.date });
  }

  const newest = dateRows[0];
  const oldest = dateRows[dateRows.length - 1];
  if (!newest || !oldest) return null;
  if (date > newest.date || date < oldest.date) return null;

  for (const row of dateRows) {
    if (row.date === date) return { index: row.index, exact: true };
    if (row.date < date) return { index: row.index, exact: false };
  }
  return { index: oldest.index, exact: false };
}

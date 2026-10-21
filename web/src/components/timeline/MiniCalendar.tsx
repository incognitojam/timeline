import { For, createMemo } from "solid-js";
import { getToday } from "../../lib/timelineDate";
import { IconCalendarToday, IconChevronDown, IconChevronLeft, IconChevronRight } from "../../ui/icons";

interface Props {
  selectedDate: string;  // YYYY-MM-DD
  activityDates: Set<string>;  // Set of YYYY-MM-DD dates with activity
  onSelectDate: (date: string) => void;
  onMonthChange: (year: number, month: number) => void;
  dateRange?: { earliest: string | null; latest: string | null };
}

// Get days in month
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Get day of week for first day of month (0 = Monday)
function getFirstDayOfMonth(year: number, month: number): number {
  // Convert Sunday=0 to Monday=0 system: (day + 6) % 7
  return (new Date(year, month, 1).getDay() + 6) % 7;
}

// Format date as YYYY-MM-DD
function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Parse YYYY-MM-DD
function parseDate(dateStr: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month: month - 1, day };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const DAY_NAMES = ["M", "T", "W", "T", "F", "S", "S"];

export default function MiniCalendar(props: Props) {
  const currentDate = createMemo(() => parseDate(props.selectedDate));

  // Parse the date range bounds
  const rangeBounds = createMemo(() => {
    const earliest = props.dateRange?.earliest ? parseDate(props.dateRange.earliest) : null;
    const latest = props.dateRange?.latest ? parseDate(props.dateRange.latest) : null;
    return { earliest, latest };
  });

  // Generate year range based on data bounds (always include current year)
  const yearRange = createMemo(() => {
    const bounds = rangeBounds();
    const currentYear = new Date().getFullYear();

    // Default: 10 years back, current year
    let startYear = currentYear - 10;
    let endYear = currentYear;

    if (bounds.earliest) {
      startYear = bounds.earliest.year;
    }
    if (bounds.latest) {
      // Use the later of data bound or current year
      endYear = Math.max(bounds.latest.year, currentYear);
    }

    const years: number[] = [];
    for (let y = startYear; y <= endYear; y++) {
      years.push(y);
    }
    return years;
  });

  // Check if a month is within the valid range (always allow up to current month)
  const isMonthInRange = (year: number, month: number): boolean => {
    const bounds = rangeBounds();
    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth();

    // Check lower bound (earliest data)
    if (bounds.earliest) {
      if (year < bounds.earliest.year) return false;
      if (year === bounds.earliest.year && month < bounds.earliest.month) return false;
    }

    // Check upper bound: allow up to the later of data bound or today
    const latestYear = bounds.latest ? Math.max(bounds.latest.year, todayYear) : todayYear;
    const latestMonth = latestYear === todayYear
      ? (bounds.latest && bounds.latest.year === todayYear ? Math.max(bounds.latest.month, todayMonth) : todayMonth)
      : (bounds.latest && bounds.latest.year === latestYear ? bounds.latest.month : 11);

    if (year > latestYear) return false;
    if (year === latestYear && month > latestMonth) return false;

    return true;
  };

  const calendarDays = createMemo(() => {
    const { year, month } = currentDate();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);

    const days: Array<{ day: number; date: string } | null> = [];

    // Add empty cells for days before the first day
    for (let i = 0; i < firstDay; i++) {
      days.push(null);
    }

    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      days.push({ day, date: formatDate(year, month, day) });
    }

    return days;
  });

  const goToPrevMonth = () => {
    const { year, month } = currentDate();
    const newMonth = month === 0 ? 11 : month - 1;
    const newYear = month === 0 ? year - 1 : year;
    if (isMonthInRange(newYear, newMonth)) {
      props.onMonthChange(newYear, newMonth);
      props.onSelectDate(formatDate(newYear, newMonth, 1));
    }
  };

  const goToNextMonth = () => {
    const { year, month } = currentDate();
    const newMonth = month === 11 ? 0 : month + 1;
    const newYear = month === 11 ? year + 1 : year;
    if (isMonthInRange(newYear, newMonth)) {
      props.onMonthChange(newYear, newMonth);
      props.onSelectDate(formatDate(newYear, newMonth, 1));
    }
  };

  const selectMonth = (month: number) => {
    const { year } = currentDate();
    props.onMonthChange(year, month);
    props.onSelectDate(formatDate(year, month, 1));
  };

  const selectYear = (year: number) => {
    let { month } = currentDate();
    // Clamp month to valid range for the new year
    if (!isMonthInRange(year, month)) {
      const bounds = rangeBounds();
      if (bounds.earliest && year === bounds.earliest.year && month < bounds.earliest.month) {
        month = bounds.earliest.month;
      } else if (bounds.latest && year === bounds.latest.year && month > bounds.latest.month) {
        month = bounds.latest.month;
      }
    }
    props.onMonthChange(year, month);
    props.onSelectDate(formatDate(year, month, 1));
  };

  const goToToday = () => {
    props.onSelectDate(getToday());
  };

  // Check if prev/next buttons should be disabled
  const canGoPrev = createMemo(() => {
    const { year, month } = currentDate();
    const newMonth = month === 0 ? 11 : month - 1;
    const newYear = month === 0 ? year - 1 : year;
    return isMonthInRange(newYear, newMonth);
  });

  const canGoNext = createMemo(() => {
    const { year, month } = currentDate();
    const newMonth = month === 11 ? 0 : month + 1;
    const newYear = month === 11 ? year + 1 : year;
    return isMonthInRange(newYear, newMonth);
  });

  return (
    <div class="border border-border rounded-lg p-3 bg-card">
      {/* Month/Year Header */}
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-1">
          {/* Month select */}
          <div class="relative flex items-center">
            <select
              class="text-sm font-medium bg-transparent hover:bg-accent rounded px-1 py-0.5 pr-5 cursor-pointer border-none focus:outline-none focus:ring-1 focus:ring-ring appearance-none"
              value={currentDate().month}
              onChange={(e) => selectMonth(parseInt(e.currentTarget.value))}
            >
              <For each={MONTH_NAMES_SHORT}>
                {(name, index) => (
                  <option
                    value={index()}
                    disabled={!isMonthInRange(currentDate().year, index())}
                  >
                    {name}
                  </option>
                )}
              </For>
            </select>
            <IconChevronDown class="w-3 h-3 absolute right-1 pointer-events-none" />
          </div>

          {/* Year select */}
          <div class="relative flex items-center">
            <select
              class="text-sm font-medium bg-transparent hover:bg-accent rounded px-1 py-0.5 pr-5 cursor-pointer border-none focus:outline-none focus:ring-1 focus:ring-ring appearance-none"
              value={currentDate().year}
              onChange={(e) => selectYear(parseInt(e.currentTarget.value))}
            >
              <For each={yearRange()}>
                {(year) => (
                  <option value={year}>{year}</option>
                )}
              </For>
            </select>
            <IconChevronDown class="w-3 h-3 absolute right-1 pointer-events-none" />
          </div>
        </div>

        <div class="flex items-center">
          <button
            class="p-1 enabled:hover:bg-accent rounded disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={goToPrevMonth}
            disabled={!canGoPrev()}
            title="Previous month"
          >
            <IconChevronLeft class="w-4 h-4" />
          </button>
          <button
            class="p-1 enabled:hover:bg-accent rounded disabled:opacity-30 disabled:cursor-not-allowed"
            onClick={goToNextMonth}
            disabled={!canGoNext()}
            title="Next month"
          >
            <IconChevronRight class="w-4 h-4" />
          </button>
          <button
            class="p-1 hover:bg-accent rounded ml-1"
            onClick={goToToday}
            title="Go to today"
          >
            <IconCalendarToday class="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Day names */}
      <div class="grid grid-cols-7 gap-1 mb-1">
        <For each={DAY_NAMES}>
          {(name) => (
            <div class="text-center text-xs text-muted-foreground font-medium">
              {name}
            </div>
          )}
        </For>
      </div>

      {/* Days */}
      <div class="grid grid-cols-7 gap-1">
        <For each={calendarDays()}>
          {(item) => (
            <div class="aspect-square">
              {item ? (
                <button
                  class={`w-full h-full flex items-center justify-center text-xs rounded relative ${
                    item.date === props.selectedDate
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent"
                  }`}
                  onClick={() => props.onSelectDate(item.date)}
                >
                  {item.day}
                  {/* Activity indicator dot */}
                  {props.activityDates.has(item.date) && item.date !== props.selectedDate && (
                    <span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full" />
                  )}
                </button>
              ) : (
                <div />
              )}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

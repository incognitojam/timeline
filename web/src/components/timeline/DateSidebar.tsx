import { createMemo } from "solid-js";
import { useDateActivityQuery } from "../../lib/dateActivityQueries";
import DateActivityList from "./DateActivityList";
import MiniCalendar from "./MiniCalendar";

interface DateRange {
  earliest: string | null;
  latest: string | null;
}

interface Props {
  selectedDate: string; // YYYY-MM-DD
  onSelectDate: (date: string) => void;
}

export default function DateSidebar(props: Props) {
  const dateActivityQuery = useDateActivityQuery();
  const dateActivities = () => dateActivityQuery.data?.dates ?? [];

  const activityDateSet = createMemo(
    () => new Set(dateActivities().map((activity) => activity.date)),
  );
  const eventDateRange = createMemo<DateRange>(() => {
    const dates = dateActivities();
    return {
      earliest: dates.at(-1)?.date ?? null,
      latest: dates[0]?.date ?? null,
    };
  });

  // Handle calendar month changes
  const handleMonthChange = (year: number, month: number) => {
    // Just update selected date, the range will auto-adjust
    const newDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    props.onSelectDate(newDate);
  };

  return (
    <div class="h-full flex flex-col bg-card border-r border-border">
      {/* Mini calendar */}
      <div class="p-3 border-b border-border">
        <MiniCalendar
          selectedDate={props.selectedDate}
          activityDates={activityDateSet()}
          onSelectDate={props.onSelectDate}
          onMonthChange={handleMonthChange}
          dateRange={eventDateRange()}
        />
      </div>

      {/* Activity list - the complete index with virtualized DOM rows */}
      <div class="flex-1 overflow-hidden flex flex-col p-3 pb-0">
        <div class="flex-1 min-h-0 relative">
          <DateActivityList
            dates={dateActivities()}
            isLoading={dateActivityQuery.isPending}
            selectedDate={props.selectedDate}
            onSelectDate={props.onSelectDate}
          />
        </div>
      </div>
    </div>
  );
}

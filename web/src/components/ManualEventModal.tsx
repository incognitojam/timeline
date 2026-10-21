import { createSignal, Show } from "solid-js";
import Dialog from "../ui/Dialog";
import ContactSelector from "./ContactSelector";
import type { ManualEventInput } from "../lib/api";
import { useCreateManualEvent, useUpdateManualEvent } from "../lib/queries";
import type { TimelineEvent } from "../lib/types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  defaultDate?: string; // YYYY-MM-DD
  defaultTimestamp?: string; // ISO 8601
  editEvent?: TimelineEvent;
  onSuccess?: (event: TimelineEvent) => void;
}

// Outer component just handles visibility - inner component remounts each time
export default function ManualEventModal(props: Props) {
  return (
    <Show when={props.isOpen}>
      <ManualEventModalContent
        editEvent={props.editEvent}
        defaultDate={props.defaultDate}
        defaultTimestamp={props.defaultTimestamp}
        onClose={props.onClose}
        onSuccess={props.onSuccess}
      />
    </Show>
  );
}

// Inner component - mounts fresh each time modal opens, so state initializes from props
function ManualEventModalContent(props: Omit<Props, "isOpen">) {
  // Initialize state from props - this runs once on mount
  const [date, setDate] = createSignal(getDefaultDate());
  const [time, setTime] = createSignal(getDefaultTime());
  const [title, setTitle] = createSignal(props.editEvent?.title || "");
  const [content, setContent] = createSignal(props.editEvent?.content || "");
  const [selectedContacts, setSelectedContacts] = createSignal<number[]>(getInitialContacts());

  const [error, setError] = createSignal<string | null>(null);
  const createManualEventMutation = useCreateManualEvent();
  const updateManualEventMutation = useUpdateManualEvent();
  const isSubmitting = () => createManualEventMutation.isPending || updateManualEventMutation.isPending;

  /** Format a Date as YYYY-MM-DD in local time */
  function formatLocalDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Format a Date as HH:MM in local time */
  function formatLocalTime(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${min}`;
  }

  /** Parse a timestamp (string or Date) into a local Date object */
  function parseTimestamp(ts: string | Date | null): Date | null {
    if (!ts) return null;
    const d = ts instanceof Date ? ts : new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }

  function getDefaultDate(): string {
    const d = parseTimestamp(props.editEvent?.timestamp ?? null)
      ?? (props.defaultTimestamp ? new Date(props.defaultTimestamp) : null);
    if (d && !isNaN(d.getTime())) return formatLocalDate(d);
    if (props.defaultDate) return props.defaultDate;
    return formatLocalDate(new Date());
  }

  function getDefaultTime(): string {
    const d = parseTimestamp(props.editEvent?.timestamp ?? null)
      ?? (props.defaultTimestamp ? new Date(props.defaultTimestamp) : null);
    if (d && !isNaN(d.getTime())) return formatLocalTime(d);
    // Default to current time rounded to nearest 15 min
    const now = new Date();
    const minutes = Math.round(now.getMinutes() / 15) * 15;
    now.setMinutes(minutes);
    return formatLocalTime(now);
  }

  function getInitialContacts(): number[] {
    if (!props.editEvent?.people) return [];

    // Parse contact IDs from people field (format: ["contact:123", "contact:456"])
    try {
      const people = typeof props.editEvent.people === "string"
        ? JSON.parse(props.editEvent.people)
        : props.editEvent.people;
      if (Array.isArray(people)) {
        return people
          .filter((p: unknown) => typeof p === "string" && p.startsWith("contact:"))
          .map((p: string) => Number(p.slice(8)))
          .filter((id: number) => Number.isSafeInteger(id) && id > 0);
      }
    } catch {
      // Ignore parse errors
    }
    return [];
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError(null);

    if (!title().trim()) {
      setError("Title is required");
      return;
    }

    try {
      // Build Date from local date/time inputs, then convert to UTC ISO string
      const timestamp = new Date(`${date()}T${time()}:00`).toISOString();

      let event: TimelineEvent;
      if (props.editEvent) {
        // On edit, send explicit null for cleared fields so the backend clears them
        const input = {
          timestamp,
          title: title().trim(),
          content: content().trim() || null,
          people: selectedContacts().length > 0 ? selectedContacts() : null,
        };
        event = await updateManualEventMutation.mutateAsync({
          id: props.editEvent.id,
          input,
          previousEvent: props.editEvent,
          date: date(),
        });
      } else {
        const input: ManualEventInput = {
          timestamp,
          title: title().trim(),
          content: content().trim() || undefined,
          people: selectedContacts().length > 0 ? selectedContacts() : undefined,
        };
        event = await createManualEventMutation.mutateAsync({ input, date: date() });
      }

      props.onSuccess?.(event);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event");
    }
  }

  function handleClose() {
    if (!isSubmitting()) {
      props.onClose();
    }
  }

  return (
    <Dialog
      open
      onClose={handleClose}
      title={props.editEvent ? "Edit Note" : "Add Note"}
      class="max-w-[480px]"
    >
      <form onSubmit={handleSubmit} class="space-y-4">
        {/* Date and Time */}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-medium mb-1">Date</label>
            <input
              type="date"
              class="w-full px-3 py-2 rounded border border-border bg-background"
              value={date()}
              onInput={(e) => setDate(e.currentTarget.value)}
              required
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Time</label>
            <input
              type="time"
              class="w-full px-3 py-2 rounded border border-border bg-background"
              value={time()}
              onInput={(e) => setTime(e.currentTarget.value)}
              required
            />
          </div>
        </div>

        {/* Title */}
        <div>
          <label class="block text-sm font-medium mb-1">Title</label>
          <input
            type="text"
            class="w-full px-3 py-2 rounded border border-border bg-background"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Daily reflection"
            required
          />
        </div>

        {/* Content */}
        <div>
          <label class="block text-sm font-medium mb-1">Content</label>
          <textarea
            class="w-full px-3 py-2 rounded border border-border bg-background min-h-[100px] resize-y"
            value={content()}
            onInput={(e) => setContent(e.currentTarget.value)}
            placeholder="Write your thoughts..."
          />
        </div>

        {/* People */}
        <div>
          <label class="block text-sm font-medium mb-1">People</label>
          <ContactSelector
            selectedContactIds={selectedContacts()}
            onChange={setSelectedContacts}
            placeholder="Associate people..."
          />
        </div>

        {/* Error message */}
        <Show when={error()}>
          <div class="text-sm text-red-500">{error()}</div>
        </Show>

        {/* Actions */}
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-4 py-2 text-sm border border-border rounded hover:bg-accent"
            onClick={handleClose}
            disabled={isSubmitting()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="px-4 py-2 text-sm bg-primary text-primary-foreground rounded enabled:hover:bg-primary/90 disabled:opacity-50"
            disabled={isSubmitting()}
          >
            {isSubmitting() ? "Saving..." : props.editEvent ? "Update" : "Create"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

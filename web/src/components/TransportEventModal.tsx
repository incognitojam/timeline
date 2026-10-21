import { createSignal, For, Show } from "solid-js";
import Dialog from "../ui/Dialog";
import ContactSelector from "./ContactSelector";
import type { TransportEventInput } from "../lib/api";
import { useCreateTransportEvent, useUpdateTransportEvent } from "../lib/queries";
import { TRANSPORT_MODES } from "../lib/transport-modes";
import type { TimelineEvent } from "../lib/types";
import { IconArrowDownward } from "../ui/icons";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  defaultDate?: string;
  editEvent?: TimelineEvent;
  onSuccess?: (event: TimelineEvent) => void;
}

export default function TransportEventModal(props: Props) {
  return (
    <Show when={props.isOpen}>
      <TransportEventModalContent
        editEvent={props.editEvent}
        defaultDate={props.defaultDate}
        onClose={props.onClose}
        onSuccess={props.onSuccess}
      />
    </Show>
  );
}

function parseTransportFromEvent(event: TimelineEvent) {
  try {
    const raw = typeof event.raw_data === "string" ? JSON.parse(event.raw_data) : event.raw_data;
    return raw?.transport ?? null;
  } catch {
    return null;
  }
}

function TransportEventModalContent(props: Omit<Props, "isOpen">) {
  const transport = () => props.editEvent ? parseTransportFromEvent(props.editEvent) : null;

  const [mode, setMode] = createSignal(transport()?.mode ?? "train");
  const [originName, setOriginName] = createSignal(transport()?.origin?.name ?? "");
  const [originCode, setOriginCode] = createSignal(transport()?.origin?.code ?? "");
  const [destName, setDestName] = createSignal(transport()?.destination?.name ?? "");
  const [destCode, setDestCode] = createSignal(transport()?.destination?.code ?? "");
  const [depDate, setDepDate] = createSignal(getDefaultDate("departure"));
  const [depTime, setDepTime] = createSignal(getDefaultTime("departure"));
  const [arrDate, setArrDate] = createSignal(getDefaultDate("arrival"));
  const [arrTime, setArrTime] = createSignal(getDefaultTime("arrival"));
  const [hasArrival, setHasArrival] = createSignal(!!props.editEvent?.end_timestamp);
  const [service, setService] = createSignal(transport()?.service ?? "");
  const [operator, setOperator] = createSignal(transport()?.operator ?? "");
  const [notes, setNotes] = createSignal(props.editEvent?.content ?? "");
  const [selectedContacts, setSelectedContacts] = createSignal<number[]>(getInitialContacts());
  const [error, setError] = createSignal<string | null>(null);
  const createTransportEventMutation = useCreateTransportEvent();
  const updateTransportEventMutation = useUpdateTransportEvent();
  const isSubmitting = () => createTransportEventMutation.isPending || updateTransportEventMutation.isPending;

  function formatLocalDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatLocalTime(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function getDefaultDate(which: "departure" | "arrival"): string {
    const ts = which === "departure" ? props.editEvent?.timestamp : props.editEvent?.end_timestamp;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) return formatLocalDate(d);
    }
    if (props.defaultDate) return props.defaultDate;
    return formatLocalDate(new Date());
  }

  function getDefaultTime(which: "departure" | "arrival"): string {
    const ts = which === "departure" ? props.editEvent?.timestamp : props.editEvent?.end_timestamp;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) return formatLocalTime(d);
    }
    const now = new Date();
    now.setMinutes(Math.round(now.getMinutes() / 15) * 15);
    return formatLocalTime(now);
  }

  function getInitialContacts(): number[] {
    if (!props.editEvent?.people) return [];
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
    } catch { /* ignore */ }
    return [];
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError(null);

    // Validate origin and destination
    if (!originName().trim() && !originCode().trim()) {
      setError("Origin requires at least a name or code");
      return;
    }
    if (!destName().trim() && !destCode().trim()) {
      setError("Destination requires at least a name or code");
      return;
    }

    try {
      const departure = new Date(`${depDate()}T${depTime()}:00`).toISOString();
      const arrival = hasArrival()
        ? new Date(`${arrDate()}T${arrTime()}:00`).toISOString()
        : undefined;

      // When editing, use null (not undefined) for cleared fields so JSON.stringify
      // preserves them and the backend knows to clear the value.
      const cleared = props.editEvent ? null : undefined;

      const input: TransportEventInput = {
        mode: mode(),
        origin: {
          name: originName().trim() || undefined,
          code: originCode().trim().toUpperCase() || undefined,
        },
        destination: {
          name: destName().trim() || undefined,
          code: destCode().trim().toUpperCase() || undefined,
        },
        departure,
        arrival: arrival ?? cleared,
        service: service().trim() || cleared,
        operator: operator().trim() || cleared,
        people: selectedContacts().length > 0 ? selectedContacts() : cleared,
        notes: notes().trim() || cleared,
      };

      let event: TimelineEvent;
      if (props.editEvent) {
        event = await updateTransportEventMutation.mutateAsync({
          id: props.editEvent.id,
          input,
          previousEvent: props.editEvent,
          date: depDate(),
        });
      } else {
        event = await createTransportEventMutation.mutateAsync({ input, date: depDate() });
      }

      props.onSuccess?.(event);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event");
    }
  }

  function handleClose() {
    if (!isSubmitting()) props.onClose();
  }

  return (
    <Dialog
      open
      onClose={handleClose}
      title={props.editEvent ? "Edit Transport" : "Add Transport"}
      class="max-w-[520px]"
    >
      <form onSubmit={handleSubmit} class="space-y-4">
        {/* Mode selector */}
        <div>
          <label class="block text-sm font-medium mb-2">Mode</label>
          <div class="flex flex-wrap gap-1.5">
            <For each={TRANSPORT_MODES}>
              {(m) => (
                <button
                  type="button"
                  class={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition-colors ${
                    mode() === m.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-accent"
                  }`}
                  onClick={() => setMode(m.value)}
                >
                  <m.icon class="h-4 w-4" aria-hidden />
                  {m.label}
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Origin and Destination */}
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">Origin</label>
            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 px-3 py-2 rounded-sm border border-border bg-background text-sm"
                value={originName()}
                onInput={(e) => setOriginName(e.currentTarget.value)}
                placeholder="Station or airport name"
              />
              <input
                type="text"
                class="w-20 px-3 py-2 rounded-sm border border-border bg-background text-sm uppercase"
                value={originCode()}
                onInput={(e) => setOriginCode(e.currentTarget.value)}
                placeholder="Code"
              />
            </div>
          </div>

          <div class="flex justify-center text-muted-foreground">
            <IconArrowDownward class="w-4 h-4" />
          </div>

          <div>
            <label class="block text-sm font-medium mb-1">Destination</label>
            <div class="flex gap-2">
              <input
                type="text"
                class="flex-1 px-3 py-2 rounded-sm border border-border bg-background text-sm"
                value={destName()}
                onInput={(e) => setDestName(e.currentTarget.value)}
                placeholder="Station or airport name"
              />
              <input
                type="text"
                class="w-20 px-3 py-2 rounded-sm border border-border bg-background text-sm uppercase"
                value={destCode()}
                onInput={(e) => setDestCode(e.currentTarget.value)}
                placeholder="Code"
              />
            </div>
          </div>
        </div>

        {/* Departure */}
        <div>
          <label class="block text-sm font-medium mb-1">Departure</label>
          <div class="grid grid-cols-2 gap-2">
            <input
              type="date"
              class="px-3 py-2 rounded-sm border border-border bg-background text-sm"
              value={depDate()}
              onInput={(e) => {
                setDepDate(e.currentTarget.value);
                // Sync arrival date if not set or same
                if (!hasArrival() || arrDate() < e.currentTarget.value) {
                  setArrDate(e.currentTarget.value);
                }
              }}
              required
            />
            <input
              type="time"
              class="px-3 py-2 rounded-sm border border-border bg-background text-sm"
              value={depTime()}
              onInput={(e) => setDepTime(e.currentTarget.value)}
              required
            />
          </div>
        </div>

        {/* Arrival (optional) */}
        <div>
          <label class="flex items-center gap-2 text-sm font-medium mb-1">
            <input
              type="checkbox"
              checked={hasArrival()}
              onChange={(e) => setHasArrival(e.currentTarget.checked)}
            />
            Arrival
          </label>
          <Show when={hasArrival()}>
            <div class="grid grid-cols-2 gap-2">
              <input
                type="date"
                class="px-3 py-2 rounded-sm border border-border bg-background text-sm"
                value={arrDate()}
                onInput={(e) => setArrDate(e.currentTarget.value)}
              />
              <input
                type="time"
                class="px-3 py-2 rounded-sm border border-border bg-background text-sm"
                value={arrTime()}
                onInput={(e) => setArrTime(e.currentTarget.value)}
              />
            </div>
          </Show>
        </div>

        {/* Service number and Operator */}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-medium mb-1">Service / Flight No.</label>
            <input
              type="text"
              class="w-full px-3 py-2 rounded-sm border border-border bg-background text-sm"
              value={service()}
              onInput={(e) => setService(e.currentTarget.value)}
              placeholder="e.g. 1513, XY123"
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Operator</label>
            <input
              type="text"
              class="w-full px-3 py-2 rounded-sm border border-border bg-background text-sm"
              value={operator()}
              onInput={(e) => setOperator(e.currentTarget.value)}
              placeholder="e.g. Example Rail"
            />
          </div>
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

        {/* Notes */}
        <div>
          <label class="block text-sm font-medium mb-1">Notes</label>
          <textarea
            class="w-full px-3 py-2 rounded-sm border border-border bg-background text-sm min-h-[60px] resize-y"
            value={notes()}
            onInput={(e) => setNotes(e.currentTarget.value)}
            placeholder="Optional notes..."
          />
        </div>

        {/* Error */}
        <Show when={error()}>
          <div class="text-sm text-red-500">{error()}</div>
        </Show>

        {/* Actions */}
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            class="px-4 py-2 text-sm border border-border rounded-sm hover:bg-accent"
            onClick={handleClose}
            disabled={isSubmitting()}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-sm enabled:hover:bg-primary/90 disabled:opacity-50"
            disabled={isSubmitting()}
          >
            {isSubmitting() ? "Saving..." : props.editEvent ? "Update" : "Create"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

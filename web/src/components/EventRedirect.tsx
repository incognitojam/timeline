import { createResource, Show } from "solid-js";
import { useNavigate, useParams, A } from "@solidjs/router";
import { fetchEvent } from "../lib/api";
import { buildTimelineUrl } from "../lib/routes";

/**
 * Stable deep-link target for individual events. Agents (and humans) can hand
 * out `<base>/event/<id>` and land on the timeline view scrolled to that
 * event, with the conversation pane auto-opened for message events.
 *
 * Behaviour:
 *   1. Fetch the event by id.
 *   2. Redirect to /?date=<YYYY-MM-DD>#event-<id> using `replace`
 *      so this URL doesn't pollute history.
 *   3. On 404, render a friendly "not found" with a link back to the timeline.
 */
export default function EventRedirect() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();

  const id = () => parseInt(params.id, 10);

  const [event] = createResource(id, async (eventId) => {
    if (!Number.isFinite(eventId) || eventId <= 0) return null;
    const ev = await fetchEvent(eventId);
    if (ev) {
      const ts = ev.timestamp;
      const iso = ts instanceof Date ? ts.toISOString() : ts;
      const date = iso ? iso.slice(0, 10) : undefined;
      navigate(buildTimelineUrl({ date, eventId }), { replace: true });
    }
    return ev;
  });

  return (
    <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Show
        when={!event.loading}
        fallback={<span>Loading event #{params.id}…</span>}
      >
        <Show
          when={event() === null}
          fallback={<span>Redirecting…</span>}
        >
          <div class="text-center">
            <p class="mb-2">Event #{params.id} not found.</p>
            <A href={buildTimelineUrl()} class="text-primary underline">Back to timeline</A>
          </div>
        </Show>
      </Show>
    </div>
  );
}

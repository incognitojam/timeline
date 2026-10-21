import type { Job } from "./api";

/** Summarize a finished sync job for status toasts/labels. */
export function summarizeSyncJob(job: Job): { message: string; success: boolean } {
  if (job.status === "succeeded") {
    const result = job.result ?? {};
    if (result.skipped === true) {
      return { success: true, message: "Sync deferred" };
    }
    const added = typeof result.eventsAdded === "number" ? result.eventsAdded : 0;
    return { success: true, message: `Sync completed: +${added} events` };
  }
  if (job.status === "cancelled") {
    return { success: false, message: "Sync was cancelled" };
  }
  return { success: false, message: job.error ?? "Sync failed" };
}

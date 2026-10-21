/**
 * Jobs API
 *
 * Read access to the job queue: list jobs, fetch a single job, cancel a queued
 * job. The worker drains the queue; the API is a read/write interface for
 * humans and the UI.
 */

import { Hono } from "hono";
import { cancelJob, getJob, listJobs } from "../jobs/store";
import type { JobKind, JobStatus } from "../jobs/types";
import { clampLimit, clampOffset } from "./query-params";

const VALID_STATUSES: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];
const VALID_KINDS: JobKind[] = ["sync", "inbox-process"];

export const jobsRoutes = new Hono()
  .get("/api/jobs", (c) => {
    const query = c.req.query();
    const limit = clampLimit(query.limit, 50, 200);
    const offset = clampOffset(query.offset);

    let status: JobStatus[] | undefined;
    if (query.status) {
      const requested = query.status.split(",").map((s) => s.trim()).filter(Boolean);
      const valid = requested.filter((s): s is JobStatus =>
        (VALID_STATUSES as string[]).includes(s)
      );
      if (valid.length === 0) {
        return c.json({ error: `Invalid status filter: ${query.status}` }, 400);
      }
      status = valid;
    }

    let kind: JobKind | undefined;
    if (query.kind) {
      if (!(VALID_KINDS as string[]).includes(query.kind)) {
        return c.json({ error: `Invalid kind: ${query.kind}` }, 400);
      }
      kind = query.kind as JobKind;
    }

    const jobs = listJobs({
      status,
      kind,
      source: query.source,
      limit,
      offset,
    });

    return c.json({ jobs, count: jobs.length });
  })

  .get("/api/jobs/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "Invalid job id" }, 400);
    }
    const job = getJob(id);
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json({ job });
  })

  .post("/api/jobs/:id/cancel", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "Invalid job id" }, 400);
    }
    const job = getJob(id);
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    if (job.status !== "queued") {
      return c.json(
        { error: `Cannot cancel job in status '${job.status}' (only 'queued' jobs can be cancelled)` },
        409
      );
    }
    const cancelled = cancelJob(id);
    if (!cancelled) {
      // Lost a race: status changed between read and cancel.
      return c.json({ error: "Job is no longer queued" }, 409);
    }
    const updated = getJob(id);
    return c.json({ job: updated });
  });

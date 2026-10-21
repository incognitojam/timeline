import type { Database } from "bun:sqlite";
import { Effect, Stream } from "effect";
import sharp from "sharp";
import type { MediaStore } from "../media/storage";
import { errorMessage, EventEmbeddingError, FatalEmbeddingError } from "./client";
import { EVENT_CORPUS_POLICY } from "./corpus";
import {
  insertVector,
  listEmbeddedContentHashes,
  listFailedSourceKeys,
  recordEmbeddingFailure,
  upsertDocument,
} from "./db";
import type { IndexTarget } from "./indexer";

/** Photos are embedded from the image itself, in the same vector space as event text. */
export const ATTACHMENT_IMAGE_PROFILE = {
  name: "attachment-image",
  version: 1,
  formatter: "image-768-jpeg",
} as const;

/** Formats the image preparation step decodes. */
export const EMBEDDABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Longest side, in pixels, of the image sent to the model. The server's cost
 * grows with pixel count (about 0.35 s per image at 768 px against 0.75 s at
 * 1024 px on the Mac host), and 768 px is the size the photo search spike graded.
 */
export const IMAGE_MAX_SIDE = 768;

/**
 * Longest a single image read from media storage may take. A read that stalls
 * this long points at the network or remote storage rather than the image, so
 * it stops the run instead of marking the image failed.
 */
const MEDIA_READ_TIMEOUT_MS = 60_000;

export interface ImageIndexCounts {
  embedded: number;
  failed: number;
}

export interface ImageIndexOutcome {
  /** Photos still waiting to be embedded after this run. */
  remaining: number;
}

/** Downscale to IMAGE_MAX_SIDE as a JPEG: the first frame of a GIF, transparency on white. */
export function prepareImageForEmbedding(image: Uint8Array): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

interface ImageCandidate {
  content_hash: string;
  storage_path: string;
}

interface PreparedImage {
  contentHash: string;
  image: Buffer;
}

const corpusSources = EVENT_CORPUS_POLICY.sources;
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/**
 * Embed stored photos from corpus sources that have no vector yet, newest first,
 * until none remain or `deadline` passes. Each distinct image (by content hash)
 * becomes one document linked to every corpus event that carries it, so search
 * returns those events. Image bytes are read without filling the local media
 * cache. An image that is missing or cannot be decoded is recorded as a failure
 * and skipped by later runs; a FatalEmbeddingError stops the run.
 */
export function indexNewImages(
  target: IndexTarget,
  timelineDb: Database,
  mediaStore: MediaStore,
  options: { concurrency: number; deadline: number },
  counts: ImageIndexCounts
): Effect.Effect<ImageIndexOutcome, FatalEmbeddingError> {
  const { embeddingsDb, client, contentProfile, modelProfile } = target;
  const filterParams = [...EMBEDDABLE_IMAGE_TYPES, ...corpusSources];
  const filter = `status = 'stored' AND content_hash IS NOT NULL AND storage_path IS NOT NULL
    AND mime_type IN (${placeholders(EMBEDDABLE_IMAGE_TYPES.length)}) AND source IN (${placeholders(corpusSources.length)})`;
  const selectCandidates = timelineDb.prepare(
    `SELECT content_hash, MAX(storage_path) AS storage_path FROM attachments WHERE ${filter}
     GROUP BY content_hash ORDER BY MAX(id) DESC`
  );
  const selectEvents = timelineDb.prepare(
    `SELECT a.event_id, MIN(e.timestamp) AS timestamp FROM attachments a JOIN events e ON e.id = a.event_id
     WHERE a.content_hash = ? AND a.source IN (${placeholders(corpusSources.length)})
     GROUP BY a.event_id ORDER BY timestamp, a.event_id`
  );

  const fail = (contentHash: string, reason: string) =>
    Effect.sync(() => {
      counts.failed++;
      recordEmbeddingFailure(embeddingsDb, contentProfile.id, modelProfile.id, contentHash, reason);
      console.error(`Failed to embed image ${contentHash}: ${reason}`);
    });

  const prepare = (candidate: ImageCandidate): Effect.Effect<PreparedImage | null, FatalEmbeddingError> =>
    Effect.tryPromise({
      try: async () => {
        const bytes = await mediaStore.readUncached(candidate.storage_path, candidate.content_hash);
        if (!bytes) return { missing: true as const };
        return { image: await prepareImageForEmbedding(bytes) };
      },
      catch: cause => cause,
    }).pipe(
      Effect.flatMap(result =>
        "missing" in result
          ? fail(candidate.content_hash, "missing from media storage").pipe(Effect.as(null))
          : Effect.succeed({ contentHash: candidate.content_hash, image: result.image })
      ),
      Effect.catchAll(cause => fail(candidate.content_hash, `could not read or decode: ${errorMessage(cause)}`).pipe(Effect.as(null))),
      Effect.timeoutFail({
        duration: MEDIA_READ_TIMEOUT_MS,
        onTimeout: () =>
          new FatalEmbeddingError({
            message: `Reading image ${candidate.content_hash} from media storage timed out after ${MEDIA_READ_TIMEOUT_MS / 1000}s`,
          }),
      })
    );

  const store = (item: PreparedImage, vector: number[]) =>
    Effect.sync(() => {
      const events = selectEvents.all(item.contentHash, ...corpusSources) as { event_id: number; timestamp: string | null }[];
      const document = upsertDocument(embeddingsDb, {
        sourceKind: "attachment",
        sourceKey: item.contentHash,
        title: null,
        snippet: null,
        startTimestamp: events[0]?.timestamp ?? null,
        endTimestamp: events.at(-1)?.timestamp ?? null,
        contentProfileId: contentProfile.id,
        contentProfileVersion: contentProfile.version,
        renderedContent: "",
        contentHash: item.contentHash,
        eventIds: events.map(event => event.event_id),
      });
      // Another index run stored this image's vector first.
      if (insertVector(embeddingsDb, document.id, modelProfile.id, vector, "attachment")) counts.embedded++;
    });

  const embed = (item: PreparedImage) =>
    client.embedImages([item.image]).pipe(
      Effect.flatMap(([vector]) =>
        vector ? store(item, vector) : Effect.fail(new EventEmbeddingError({ message: "Embedding response did not contain a vector" }))
      ),
      Effect.catchTag("EventEmbeddingError", error => fail(item.contentHash, error.message))
    );

  return Effect.gen(function* () {
    const done = listEmbeddedContentHashes(embeddingsDb, contentProfile.id, modelProfile.id);
    const failed = listFailedSourceKeys(embeddingsDb, contentProfile.id, modelProfile.id);
    const pending = (selectCandidates.all(...filterParams) as ImageCandidate[]).filter(
      candidate => !done.has(candidate.content_hash) && !failed.has(candidate.content_hash)
    );
    let started = 0;
    yield* Stream.fromIterable(pending).pipe(
      // One image per pull, so the deadline is checked as each image starts and
      // at most `concurrency` images are in flight when it passes.
      Stream.rechunk(1),
      Stream.takeWhile(() => Date.now() < options.deadline),
      Stream.tap(() => Effect.sync(() => started++)),
      Stream.mapEffect(prepare, { concurrency: options.concurrency }),
      Stream.filter((item): item is PreparedImage => item !== null),
      Stream.mapEffect(embed, { concurrency: options.concurrency }),
      Stream.runDrain
    );
    return { remaining: pending.length - started };
  });
}

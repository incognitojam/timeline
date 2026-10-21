import { Data, Effect } from "effect";

export interface EmbeddingModelConfig {
  provider: string;
  endpoint: string;
  model: string;
  dimensions: number;
  apiKeyEnv?: string;
  /** Prepended to each document by embedDocuments. */
  documentPrefix: string;
  /** Prepended to the query by embedQuery. */
  queryPrefix: string;
  /** Each request, including reading its response, fails fatally after this long. */
  timeoutMs: number;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown; index?: unknown }>;
}

interface ServerProps {
  media_marker?: unknown;
  modalities?: { vision?: unknown };
}

/**
 * A failure that recurs identically for every event: a misconfiguration
 * (dimension mismatch, wrong model) or a provider that is unusable for the whole
 * run (auth rejected, endpoint/model not found, provider down, network
 * unreachable). Indexing aborts on the first one rather than hammer a dead
 * provider once per event.
 */
export class FatalEmbeddingError extends Data.TaggedError("FatalEmbeddingError")<{
  readonly message: string;
}> {}

/**
 * A failure specific to one input (e.g. an HTTP 400/422 the provider raised for
 * this request, or a malformed response body). Indexing skips that event and
 * continues — re-running picks it up once the input or provider is fixed.
 */
export class EventEmbeddingError extends Data.TaggedError("EventEmbeddingError")<{
  readonly message: string;
}> {}

/**
 * Statuses that mean the provider is unusable for *every* event, not just this
 * input: auth (401/403), missing endpoint/model (404), rate limiting (429), and
 * any 5xx (provider down). 429 aborts rather than skips — matching the repo's
 * convention that a throttled API source stops and resumes later, not hammers
 * the endpoint once per event. Other 4xx (400/422) are specific to the request.
 */
function isFatalStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 429 || status >= 500;
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class OpenAIEmbeddingClient {
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private mediaMarker?: string;

  constructor(private readonly config: EmbeddingModelConfig, env: Record<string, string | undefined> = process.env) {
    if (!config.provider.trim()) throw new Error("Embedding provider is required");
    if (!config.endpoint.trim()) throw new Error("Embedding endpoint URL is required");
    if (!config.model.trim()) throw new Error("Embedding model is required");
    if (!Number.isInteger(config.dimensions) || config.dimensions <= 0) {
      throw new Error("Embedding dimensions must be a positive integer");
    }
    if (!(config.timeoutMs > 0)) throw new Error("Embedding timeout must be positive");
    this.endpoint = new URL(config.endpoint);
    if (config.apiKeyEnv) {
      const value = env[config.apiKeyEnv];
      if (!value) throw new Error(`Embedding API key env ${config.apiKeyEnv} is not set`);
      this.apiKey = value;
    }
  }

  embedQuery(query: string): Effect.Effect<number[], FatalEmbeddingError | EventEmbeddingError> {
    return this.request([this.config.queryPrefix + query]).pipe(
      Effect.flatMap(vectors => {
        const vector = vectors[0];
        return vector
          ? Effect.succeed(vector)
          : Effect.fail(new EventEmbeddingError({ message: "Embedding response did not contain a vector" }));
      })
    );
  }

  embedDocuments(documents: string[]): Effect.Effect<number[][], FatalEmbeddingError | EventEmbeddingError> {
    const { documentPrefix } = this.config;
    return this.request(documents.map(document => documentPrefix + document));
  }

  /**
   * Embed images through llama-server's multimodal input, one vector per image.
   * The prompt for each image is the server's media marker alone, so images
   * carry no task prefix.
   */
  embedImages(images: readonly Uint8Array[]): Effect.Effect<number[][], FatalEmbeddingError | EventEmbeddingError> {
    if (images.length === 0) return Effect.succeed([]);
    return this.loadMediaMarker().pipe(
      Effect.flatMap(marker =>
        this.request(
          images.map(image => ({ prompt_string: marker, multimodal_data: [Buffer.from(image).toString("base64")] }))
        )
      )
    );
  }

  /**
   * llama-server randomizes the marker that stands for an image at start-up and
   * reports it in /props, with whether it can embed images at all. A server
   * without vision support fails every image, so that is fatal.
   */
  private loadMediaMarker(): Effect.Effect<string, FatalEmbeddingError> {
    const cached = this.mediaMarker;
    if (cached) return Effect.succeed(cached);
    const propsUrl = new URL("/props", this.endpoint);
    return Effect.tryPromise({
      try: async signal => {
        const response = await fetch(propsUrl, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as ServerProps;
      },
      catch: cause =>
        new FatalEmbeddingError({ message: `Could not read image support from ${propsUrl.href}: ${errorMessage(cause)}` }),
    }).pipe(
      Effect.timeoutFail({
        duration: this.config.timeoutMs,
        onTimeout: () => new FatalEmbeddingError({ message: `Reading ${propsUrl.href} timed out` }),
      }),
      Effect.flatMap(props => {
        const marker = props.media_marker;
        if (props.modalities?.vision !== true || typeof marker !== "string" || !marker) {
          return Effect.fail(
            new FatalEmbeddingError({
              message: `The embeddings server at ${propsUrl.host} cannot embed images; start llama-server with --mmproj`,
            })
          );
        }
        this.mediaMarker = marker;
        return Effect.succeed(marker);
      })
    );
  }

  private request(inputs: readonly unknown[]): Effect.Effect<number[][], FatalEmbeddingError | EventEmbeddingError> {
    if (inputs.length === 0) return Effect.succeed([]);
    const { endpoint, apiKey } = this;
    const { model, dimensions, timeoutMs } = this.config;
    const request = Effect.gen(function* () {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const response = yield* Effect.tryPromise({
        try: signal => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model, input: inputs }), signal }),
        // fetch rejects only on a network/connection failure — the endpoint is
        // unreachable for every event, so abort the run.
        catch: cause => new FatalEmbeddingError({ message: `Embedding request could not reach ${endpoint.host}: ${errorMessage(cause)}` }),
      });

      if (!response.ok) {
        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: cause => errorMessage(cause),
        }).pipe(Effect.catchAll(cause => Effect.succeed(`could not read response body: ${cause}`)));
        // Surface the throttling signal so the operator knows when to resume.
        const retryAfter = response.headers.get("retry-after");
        const message = `Embedding request failed with HTTP ${response.status}: ${body}${retryAfter ? ` (retry-after: ${retryAfter})` : ""}`;
        return yield* isFatalStatus(response.status)
          ? Effect.fail(new FatalEmbeddingError({ message }))
          : Effect.fail(new EventEmbeddingError({ message }));
      }

      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<EmbeddingResponse>,
        catch: cause => new EventEmbeddingError({ message: `Embedding response was not valid JSON: ${errorMessage(cause)}` }),
      });
      if (!Array.isArray(payload.data)) {
        return yield* Effect.fail(new EventEmbeddingError({ message: "Embedding response did not contain vector data" }));
      }
      if (payload.data.length !== inputs.length) {
        return yield* Effect.fail(
          new EventEmbeddingError({
            message: `Embedding response count mismatch: expected ${inputs.length}, got ${payload.data.length}`,
          })
        );
      }

      const hasIndexes = payload.data.some(item => item.index !== undefined);
      const rows = hasIndexes ? new Array<{ embedding?: unknown; index?: unknown }>(inputs.length) : payload.data;
      if (hasIndexes) {
        for (const item of payload.data) {
          if (!Number.isInteger(item.index)) {
            return yield* Effect.fail(new EventEmbeddingError({ message: "Embedding response contained an invalid index" }));
          }
          const index = item.index;
          if (typeof index !== "number" || index < 0 || index >= inputs.length || rows[index] !== undefined) {
            return yield* Effect.fail(new EventEmbeddingError({ message: "Embedding response contained an invalid index" }));
          }
          rows[index] = item;
        }
      }

      const vectors: number[][] = [];
      for (const [index, item] of rows.entries()) {
        if (!item) {
          return yield* Effect.fail(new EventEmbeddingError({ message: `Embedding response omitted vector ${index}` }));
        }
        const embedding = item.embedding;
        if (!Array.isArray(embedding) || !embedding.every(value => typeof value === "number")) {
          return yield* Effect.fail(
            new EventEmbeddingError({ message: `Embedding response item ${index} did not contain a numeric vector` })
          );
        }
        if (embedding.length !== dimensions) {
          // A wrong width is a config error ([embeddings] dimensions or the
          // model) — it recurs for every event, so abort rather than skip-and-retry.
          return yield* Effect.fail(
            new FatalEmbeddingError({
              message: `Embedding dimension mismatch: expected ${dimensions}, got ${embedding.length}`,
            })
          );
        }
        vectors.push(embedding);
      }
      return vectors;
    });
    // A provider that accepts the connection but never answers would otherwise
    // hold the caller forever. Interrupting the request aborts the fetch.
    return request.pipe(
      Effect.timeoutFail({
        duration: timeoutMs,
        onTimeout: () =>
          new FatalEmbeddingError({ message: `Embedding request to ${endpoint.host} timed out after ${timeoutMs / 1000}s` }),
      })
    );
  }
}

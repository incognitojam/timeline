# Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Web App (SolidJS)                                          │
│  Search · Conversations · Day View · Contacts · AI Chat     │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│  API Server (Hono)                                          │
│  REST endpoints · Streaming chat · MCP over HTTP            │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      ┌───────────────┐               ┌─────────────────┐
      │  timeline.db  │               │  app-state.db   │
      │  Events, FTS  │               │  Chats, Logs    │
      └───────────────┘               └─────────────────┘
```

**Service mode** adds a worker thread, the only writer to `timeline.db`, which runs:
- Sync scheduler (runs API sources at configured intervals)
- Inbox watcher (auto-imports new export files)

## Events table

All sources normalize into a single `events` table, so new parsers need no schema changes. Each parser keeps the original export data in `raw_data` so events can be reprocessed when parsing improves.

| Column | Purpose |
|--------|---------|
| `source`, `source_id`, `source_account` | Track origin |
| `type` | Classification (listen:track, message, location:visit, etc.) |
| `timestamp`, `end_timestamp`, `duration_ms` | Temporal data |
| `title`, `content` | Searchable text (FTS5 indexed) |
| `latitude`, `longitude`, `location_name` | Location |
| `people`, `tags` | JSON arrays |
| `raw_data` | Original export data preserved |

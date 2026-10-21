# Timeline

A self-hosted, searchable timeline of your life. Timeline indexes exports and API syncs from 30+ services into a single SQLite database, with a web app, AI chat, and an MCP server for querying it. It is also a platform for experimenting with AI on personal data.

![Day timeline: vitals, listening sessions, conversations, coding, transactions, and check-ins on one page](docs/screenshots/timeline-day.png)

| | |
|---|---|
| ![Conversation view](docs/screenshots/conversation.png) | ![Cross-source search](docs/screenshots/search.png) |
| ![Health dashboard](docs/screenshots/health.png) | ![Music dashboard](docs/screenshots/music.png) |

## Features

- **Web app** with search, conversation browsing, day views, health and music dashboards, and contact management
- **AI chat** for natural language questions ("What was I listening to during my trip to Japan?")
- **MCP server** so assistants such as Claude can query your timeline
- **Automated sync** from API sources (Monzo, Trakt, Google Health, GitHub, and more) and an inbox that imports dropped-in exports
- **Local-first**: your data stays on your machine, with the original export data kept for reprocessing

## Stack

Bun and TypeScript throughout: a Hono API serving a SolidJS web app, backed by SQLite with FTS5 full-text search. The service runs on a macOS host under a menu bar app that also handles screen recall capture and remote access.

## Documentation

- [Install on macOS](docs/user/macos-host.md)
- [Data sources](docs/user/source-setup.md)
- [All documentation](docs/README.md)

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

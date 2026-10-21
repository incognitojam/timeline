ARG BUN_VERSION
ARG PLAYWRIGHT_VERSION
FROM oven/bun:${BUN_VERSION} AS bun
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

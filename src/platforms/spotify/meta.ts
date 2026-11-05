import type { PlatformMeta } from "../types";

export const spotifyMeta = {
  id: "spotify",
  color: "#1DB954",
  sources: [
    {
      id: "spotify",
      label: "Spotify",
      traits: { session: { gapMinutes: 10 } },
      eventTypes: [
        "listen:track",
        "listen:podcast",
        "listen:audiobook",
        "listen:unknown",
      ],
    },
    {
      id: "spotify-friends",
      label: "Spotify Friends",
      // groupEvents groups these per person.
      traits: { session: { gapMinutes: 15 } },
      eventTypes: ["listen:track:friend"],
    },
    {
      id: "spotify-playlists",
      label: "Spotify Playlists",
    },
  ],
  identityPlatforms: ["spotify"],
} as const satisfies PlatformMeta;

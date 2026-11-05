import type { PlatformMeta } from "../types";

export const spotifyMeta = {
  id: "spotify",
  color: "#1DB954",
  sources: [
    {
      id: "spotify",
      label: "Spotify",
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
      eventTypes: ["listen:track:friend"],
    },
    {
      id: "spotify-playlists",
      label: "Spotify Playlists",
    },
  ],
  identityPlatforms: ["spotify"],
} as const satisfies PlatformMeta;

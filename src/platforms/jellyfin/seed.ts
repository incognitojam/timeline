import type { SeedSource } from "../../seed/context";
import { saveSession } from "./parser";
export const jellyfinSeed: SeedSource = {
  name: "jellyfin",
  produces: { jellyfin: ["jellyfin:movie", "jellyfin:episode"] },
  async seed(ctx) {
    for (const [i, kind] of ["Movie", "Episode"].entries()) {
      const user = String(i + 1).repeat(32);
      saveSession(
        ctx.db,
        "synthetic/" + user,
        {
          UserId: user,
          ItemId: String(i + 3).repeat(32),
          RowId: String(i + 1),
          DateCreated: ctx.anchorDate + " 18:00:00",
          ItemType: kind,
          ItemName: i ? "The Moonlit Parcel" : "A Clock for Rain",
          ClientName: "Example Player",
          DeviceName: "Example Screen",
          PlaybackMethod: "DirectPlay",
          PlayDuration: "600",
        },
        "UTC",
      );
    }
  },
};

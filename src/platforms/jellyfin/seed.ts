import type { SeedSource } from "../../seed/context";
import { reconcileActivity } from "./activity";
import { saveSession } from "./parser";
export const jellyfinSeed: SeedSource = {
  name: "jellyfin",
  produces: { jellyfin: ["jellyfin:movie", "jellyfin:episode", "jellyfin:activity"] },
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
    const user = "1".repeat(32);
    const account = "synthetic/" + user;
    const evidence = {
      Id: 1,
      UserId: user,
      ItemId: "7".repeat(32),
      Type: "VideoPlayback",
      DateCreated: ctx.anchorDate + " 11:00:00",
      Name: "Viewer is playing Copper Meadow on Screen",
      item: null,
    };
    ctx.db.run("INSERT INTO jellyfin_activity_evidence VALUES (?,?,?,?)", [
      "synthetic",
      user,
      1,
      JSON.stringify(evidence),
    ]);
    reconcileActivity(ctx.db, account, "UTC");
  },
};

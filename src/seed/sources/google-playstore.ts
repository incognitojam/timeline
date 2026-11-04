import type { SeedSource } from "../context";
import { GOOGLE_ACCOUNT } from "./google-data";

type DocType = "Android Apps" | "GAME";

/** Apps on Alex's phone at the start of the range, set up in one sitting. */
const CORE_APPS: readonly [string, DocType][] = [
  ["Google Maps", "Android Apps"],
  ["Gmail", "Android Apps"],
  ["Google Chrome: Fast & Secure", "Android Apps"],
  ["Spotify: Music and Podcasts", "Android Apps"],
  ["Discord - Chat, Talk & Hangout", "Android Apps"],
  ["Instagram", "Android Apps"],
  ["Messages", "Android Apps"],
  ["Google Calendar", "Android Apps"],
  ["Google Keep - Notes and Lists", "Android Apps"],
  ["YouTube", "Android Apps"],
  ["AllTrails: Hike, Bike & Run", "Android Apps"],
  ["Strava: Run, Bike, Hike", "Android Apps"],
  ["Transit • Subway & Bus Times", "Android Apps"],
  ["Swarm", "Android Apps"],
  ["Monzo - Mobile Banking", "Android Apps"],
  ["Amex", "Android Apps"],
  ["Google Fit: Activity Tracking", "Android Apps"],
  ["Slack", "Android Apps"],
  ["1Password: Password Manager", "Android Apps"],
  ["Pocket Casts - Podcast Player", "Android Apps"],
];

/** Installed later, one at a time. */
const LATER_APPS: readonly [string, DocType][] = [
  ["Fitbit", "Android Apps"],
  ["Trakt", "Android Apps"],
  ["Duolingo: Language Lessons", "Android Apps"],
  ["Letterboxd", "Android Apps"],
  ["Goodreads", "Android Apps"],
  ["Kindle", "Android Apps"],
  ["Zoom Workplace", "Android Apps"],
  ["Lime - #RideGreen", "Android Apps"],
  ["Washington State Ferries", "Android Apps"],
  ["Mountain Project", "Android Apps"],
  ["PlantNet Plant Identification", "Android Apps"],
  ["Home Assistant", "Android Apps"],
  ["Tailscale", "Android Apps"],
  ["Termux", "Android Apps"],
  ["Pokémon GO", "GAME"],
  ["Minecraft", "GAME"],
  ["Stardew Valley", "GAME"],
  ["Balatro", "GAME"],
  ["Wingspan: The Board Game", "GAME"],
  ["Catan Universe", "GAME"],
  ["Monument Valley 2", "GAME"],
  ["NYT Games: Word Games & Sudoku", "GAME"],
];

/** Restored onto the new phone when Alex upgraded. */
const RESTORED_COUNT = 18;

/** Takeout "Google Play Store/Installs.json", run through the CLI importer. */
export const googlePlaystoreSeed: SeedSource = {
  name: "google-playstore",
  produces: { "google-playstore": ["app:install"] },
  async seed(ctx) {
    const rng = ctx.rng("google-playstore");
    const oldPhone = { manufacturer: "Google", model: "Pixel 7", deviceDisplayName: "Google Pixel 7" };
    const newPhone = { manufacturer: "Google", model: "Pixel 9", deviceDisplayName: "Google Pixel 9" };
    const upgradeIndex = Math.floor(ctx.days.length * 0.62);
    const upgradeDay = ctx.days[upgradeIndex];
    const firstDay = ctx.days[2];
    if (!upgradeDay || !firstDay) throw new Error("Seed range too short for Play Store installs");
    const lastUpdate = ctx.localIso(ctx.anchorDate, 3, 12);

    const installs: object[] = [];
    const install = (title: string, documentType: DocType, at: string, device: typeof oldPhone) => {
      installs.push({
        install: {
          doc: { documentType, title },
          firstInstallationTime: at,
          deviceAttribute: device,
          lastUpdateTime: lastUpdate,
        },
      });
    };

    let t = ctx.localDate(firstDay.date, 20, 5).getTime();
    for (const [title, type] of CORE_APPS) {
      t += rng.int(20, 240) * 1000;
      install(title, type, new Date(t).toISOString(), oldPhone);
    }

    const later = rng.shuffle(LATER_APPS);
    for (const [title, type] of later) {
      const day = rng.pick(ctx.days.slice(5));
      const device = day.index >= upgradeIndex ? newPhone : oldPhone;
      install(title, type, ctx.localIso(day.date, rng.int(8, 23), rng.int(0, 59), rng.int(0, 59)), device);
    }

    t = ctx.localDate(upgradeDay.date, 19, 30).getTime();
    for (const [title, type] of rng.sample(CORE_APPS, RESTORED_COUNT)) {
      t += rng.int(5, 90) * 1000;
      install(title, type, new Date(t).toISOString(), newPhone);
    }

    const path = ctx.writeStaged("google-playstore", "Takeout/Google Play Store/Installs.json", JSON.stringify(installs, null, 1));
    await ctx.runParserCli("google-playstore.ts", [path, GOOGLE_ACCOUNT]);
  },
};

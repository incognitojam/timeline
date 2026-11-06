import type { SeedSource } from "../../../seed/context";
import type { Rng } from "../../../seed/rng";
import { GOOGLE_ACCOUNT } from "../seed-data/google-data";

interface KeepNote {
  color: string;
  isTrashed: boolean;
  isPinned: boolean;
  isArchived: boolean;
  textContent?: string;
  textContentHtml?: string;
  listContent?: { textHtml: string; text: string; isChecked: boolean }[];
  title: string;
  userEditedTimestampUsec: number;
  createdTimestampUsec: number;
  labels?: { name: string }[];
}

const GROCERIES = [
  "oat milk", "eggs", "sourdough", "bananas", "spinach", "greek yogurt", "coffee beans", "tofu", "rice",
  "gochujang", "limes", "avocados", "cheddar", "pasta", "tinned tomatoes", "onions", "garlic", "salmon",
  "chicken thighs", "tortillas", "cilantro", "frozen peas", "peanut butter", "apples", "olive oil", "miso",
];

const LISTS: readonly { title: string; label: string; items: readonly string[]; color?: string }[] = [
  { title: "Day hike packing", label: "Hiking", color: "GREEN", items: ["Water (2L)", "Headlamp", "Rain shell", "Puffy", "Microspikes", "First aid kit", "Discover Pass", "Snacks", "Sunscreen", "Map downloaded"] },
  { title: "Portland weekend", label: "Travel", items: ["Charger", "Gift for Mei", "Running shoes", "Book", "Snacks for the drive", "Umbrella"] },
  { title: "SF trip packing", label: "Travel", items: ["Boarding pass", "Laptop", "Layers", "Headphones", "Toiletries", "Passport (just in case)"] },
  { title: "Books to read", label: "Reading", color: "BLUE", items: ["Tomorrow, and Tomorrow, and Tomorrow", "Project Hail Mary", "The Overstory", "Piranesi", "Klara and the Sun", "Station Eleven", "The Ministry for the Future", "Designing Data-Intensive Applications"] },
  { title: "Movies to watch", label: "Watchlist", items: ["Past Lives", "Perfect Days", "Dune: Part Two", "Spirited Away", "Arrival", "The Grand Budapest Hotel", "Everything Everywhere All at Once"] },
  { title: "Apartment todo", label: "Home", items: ["Replace shower head", "Descale kettle", "Fix squeaky door", "Change AC filter", "Hang the prints", "Donate old jackets"] },
  { title: "Garden sensors parts", label: "Ideas", items: ["Capacitive soil moisture sensors x4", "ESP32 dev board", "18650 battery holder", "Weatherproof enclosure", "Jumper wires"] },
  { title: "Game night snacks", label: "Social", items: ["Chips + salsa", "Pocky", "Sparkling water", "Popcorn", "Clementines"] },
  { title: "Gift ideas", label: "Ideas", color: "PINK", items: ["Mei: ceramic pour-over set", "Mum: photo book from the Portland trip", "Rowan: trail sandwich cookbook (joke)", "Priya: chalk bag", "Sam: Wingspan expansion"] },
];

const TEXT_NOTES: readonly { title: string; label?: string; text: string; color?: string; pinned?: boolean }[] = [
  { title: "Trailhead feature ideas", label: "Ideas", pinned: true, text: "- Offline trail maps\n- Carpool sign-up per hike\n- Pull WTA trip reports into the plan view\n- Gear checklist per season\n- Weather window suggestions" },
  { title: "Running PRs", label: "Fitness", text: "5k: 24:10 (Green Lake)\n10k: 51:42\nHalf: 1:58:30 — goal sub-1:55 next spring" },
  { title: "Climbing log", label: "Fitness", text: "Sent the purple V4 in the cave. Projecting the yellow V5 slab — work on trusting feet." },
  { title: "Podcast recs", text: "Rowan: Darknet Diaries\nJordan: Software Unscripted\nMei: Search Engine\nPriya: Radiolab" },
  { title: "1:1 topics", label: "Work", text: "- On-call load is uneven, propose rota change\n- Schema registry migration timeline\n- Interest in leading ingest v2\n- Conference budget?" },
  { title: "Mum's tamale notes", label: "Recipes", color: "YELLOW", text: "Soak husks 1hr. Masa: lard whipped until it floats. Red chile pork, steam 75–90 min. Make on a Sunday with Mei." },
  { title: "Focaccia", label: "Recipes", color: "YELLOW", text: "500g flour, 400g water, 10g salt, 4g yeast. Overnight cold proof. 230°C for 22 min. Lots of olive oil." },
  { title: "Bike fit numbers", text: "Saddle height 72.5cm from BB. Setback 6cm. Bars 2cm below saddle." },
  { title: "Things Mei said to try in Portland", label: "Travel", text: "Powell's (obviously), Washington Park rose garden, the food carts on Hawthorne, Saturday Market." },
  { title: "Quotes", text: "\"The best time to plant a tree was 20 years ago. The second best time is now.\"\n\"Make it work, make it right, make it fast.\"" },
  { title: "Retro thoughts", label: "Work", text: "Flaky integration tests cost us two days. Propose quarantining + tracking flake rate on the dashboard." },
  { title: "Apartment wifi for guests", label: "Home", text: "Network: rivera-guest (password on the fridge)" },
  { title: "Hike ideas for summer", label: "Hiking", text: "Lake Serene, Snow Lake, Colchuck (permit?), Mailbox Peak if we're feeling brave, Enchantments day-hike lottery." },
  { title: "Sourdough schedule", label: "Recipes", text: "Feed starter 9am → mix 1pm → folds every 30 min x4 → shape 6pm → fridge overnight → bake 8am." },
  { title: "", text: "call the dentist back re: cleaning" },
  { title: "", text: "Kraken tickets on the 14th — check with Omar" },
  { title: "", text: "rent goes up in March, budget +$75" },
];

function usec(ms: number): number {
  return ms * 1000;
}

/**
 * Takeout "Keep/*.json" notes (lists and text), run through the CLI
 * importer. Grocery lists recur; everything else is a one-off note.
 */
export const googleKeepSeed: SeedSource = {
  name: "google-keep",
  produces: { "google-keep": ["note:text", "note:list"] },
  async seed(ctx) {
    const rng = ctx.rng("google-keep");
    const usedNames = new Map<string, number>();
    const fileName = (title: string, createdMs: number) => {
      const base = title || new Date(createdMs).toISOString().replace(/:/g, "_").replace(/\.\d+Z$/, "");
      const n = usedNames.get(base) ?? 0;
      usedNames.set(base, n + 1);
      return n === 0 ? `${base}.json` : `${base}(${n}).json`;
    };
    const randomDayMs = (r: Rng) => {
      const day = r.pick(ctx.days);
      return ctx.localDate(day.date, r.int(7, 22), r.int(0, 59), r.int(0, 59)).getTime();
    };

    const write = (note: KeepNote) => {
      ctx.writeStaged("google-keep", `Keep/${fileName(note.title, note.createdTimestampUsec / 1000)}`, JSON.stringify(note));
    };
    const base = (created: number) => {
      const edited = Math.min(created + rng.int(0, 30) * 86_400_000, ctx.localDate(ctx.anchorDate, 12).getTime());
      return {
        color: "DEFAULT",
        isTrashed: false,
        isPinned: false,
        isArchived: rng.chance(0.2),
        createdTimestampUsec: usec(created),
        userEditedTimestampUsec: usec(edited),
      };
    };

    // Grocery lists, roughly every few weeks.
    for (let i = 0; i < 50; i++) {
      const created = randomDayMs(rng);
      const items = rng.sample(GROCERIES, rng.int(5, 11)).map((text) => ({ text, textHtml: text, isChecked: rng.chance(0.55) }));
      write({ ...base(created), title: rng.pick(["Groceries", "Groceries", "Grocery run", "Costco"]), listContent: items, labels: [{ name: "Groceries" }] });
    }

    for (const list of LISTS) {
      const copies = list.label === "Hiking" || list.label === "Travel" ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        const created = randomDayMs(rng);
        write({
          ...base(created),
          color: list.color ?? "DEFAULT",
          title: list.title,
          listContent: list.items.map((text) => ({ text, textHtml: text, isChecked: rng.chance(0.4) })),
          labels: [{ name: list.label }],
        });
      }
    }

    for (const note of TEXT_NOTES) {
      const created = randomDayMs(rng);
      write({
        ...base(created),
        color: note.color ?? "DEFAULT",
        isPinned: note.pinned ?? false,
        isTrashed: note.title === "" && rng.chance(0.3),
        title: note.title,
        textContent: note.text,
        textContentHtml: `<p dir="ltr" style="line-height:1.38;margin-top:0.0pt;margin-bottom:0.0pt;">${note.text.replace(/\n/g, "<br>")}</p>`,
        ...(note.label ? { labels: [{ name: note.label }] } : {}),
      });
    }

    await ctx.runParserCli("platforms/google/keep/parser.ts", [`${ctx.stage("google-keep")}/Keep`, GOOGLE_ACCOUNT]);
  },
};

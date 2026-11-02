import { gzipSync } from "node:zlib";
import type { SeedSource } from "../context";
import { personByKey, TIME_ZONE } from "../persona";
import type { Rng } from "../rng";

const SERVER = "theo-smp";

/** Minecraft usernames (the importer stores these bare in events.people). */
const PLAYERS = {
  alex: personByKey("alex").handle,
  theo: personByKey("theo").handle,
  omar: personByKey("omar").handle,
  sam: personByKey("sam").handle,
} as const;
type PlayerKey = keyof typeof PLAYERS;

/** Vanilla advancements in roughly the order a survival world earns them. */
const ADVANCEMENTS = [
  "Stone Age", "Getting an Upgrade", "Acquire Hardware", "Suit Up", "Hot Stuff", "Isn't It Iron Pick",
  "Sweet Dreams", "A Seedy Place", "Monster Hunter", "Diamonds!", "Ice Bucket Challenge",
  "We Need to Go Deeper", "Cover Me with Diamonds", "Enchanter", "Return to Sender", "Into Fire",
  "Eye Spy", "The End?", "The Next Generation", "Sky's the Limit",
];
const CHALLENGES = ["Monsters Hunted", "Adventuring Time", "A Balanced Diet"];

const DEATHS: readonly ((p: string) => string)[] = [
  (p) => `${p} was slain by Zombie`,
  (p) => `${p} was shot by Skeleton`,
  (p) => `${p} was blown up by Creeper`,
  (p) => `${p} was slain by Enderman`,
  (p) => `${p} was slain by Piglin Brute`,
  (p) => `${p} drowned`,
  (p) => `${p} fell from a high place`,
  (p) => `${p} hit the ground too hard`,
  (p) => `${p} tried to swim in lava`,
  (p) => `${p} burned to death`,
  (p) => `${p} was pricked to death`,
  (p) => `${p} suffocated in a wall`,
];

const CHAT_EARLY = [
  "where are we building the base?",
  "found a village to the east, ~300 blocks",
  "anyone got spare iron?",
  "i'll get the farm going",
  "theo did you seed this world? spawn is gorgeous",
  "who took my bed",
  "torches people, TORCHES",
  "mining at y -58 for diamonds",
  "cave by the river is massive",
  "first night, stay inside lol",
  "sheep secured",
  "can someone make a crafting table at spawn",
];
const CHAT_ANY = [
  "brb snack",
  "lol",
  "nooo my stuff",
  "omw",
  "coming to you",
  "gg",
  "who's on tomorrow?",
  "check out the bridge i built",
  "is it night already",
  "creeper behind you!!",
  "sorry that was me",
  "i have a stack of bread if anyone needs",
  "the nether portal is behind the barn",
  "need help with the witch hut",
  "trading hall finally done",
  "mending villager acquired 🎉",
  "anyone want to go to the end tonight?",
  "i'm at 40% durability, going home",
  "drop your coords",
  "nice",
  "how do you have so many diamonds",
  "this is why we can't have nice things",
  "going afk for a sec",
  "who left the door open",
  "that's a lot of phantoms",
  "shulker boxes changed my life",
  "rowan would love this build",
  "ok last thing then bed",
];
const CHAT_LATE = [
  "elytra get!",
  "the end city is huge",
  "iron farm is pumping",
  "we need a storage system",
  "redstone sorter is broken again",
  "who's fighting the dragon",
  "netherite upgrade time",
  "beacon is up at spawn",
];

interface Season {
  version: string;
  start: number;
  end: number;
}

/**
 * Paper server logs from Theo's survival server (logs/YYYY-MM-DD-N.log.gz),
 * run through the CLI importer. The server is played in bursts: a new world
 * each "season", a few evenings a week, plus the odd one-off session.
 */
export const minecraftSeed: SeedSource = {
  name: "minecraft",
  produces: {
    minecraft: ["minecraft:chat", "minecraft:join", "minecraft:leave", "minecraft:advancement", "minecraft:death"],
  },
  async seed(ctx) {
    const rng = ctx.rng("minecraft");
    const total = ctx.days.length;
    const seasons: Season[] = [
      { version: "1.20.4", start: Math.floor(total * 0.04), end: Math.floor(total * 0.17) },
      { version: "1.21.1", start: Math.floor(total * 0.45), end: Math.floor(total * 0.56) },
      { version: "1.21.4", start: Math.floor(total * 0.86), end: Math.floor(total * 0.97) },
    ];

    for (const season of seasons) {
      const progress = new Map<PlayerKey, number>();
      const challenged = new Set<string>();
      for (const day of ctx.days.slice(season.start, season.end)) {
        const prime = day.weekday === 5 || day.weekday === 6;
        if (!rng.chance(prime ? 0.5 : 0.06)) continue;
        const weeksIn = (day.index - season.start) / 7;
        const lines = session(rng, season.version, weeksIn, progress, challenged);
        ctx.writeStaged("minecraft", `logs/${day.date}-1.log.gz`, gzipSync(lines.join("\n")));
      }
    }
    // A few one-off evenings between seasons.
    for (const day of ctx.days) {
      const inSeason = seasons.some((s) => day.index >= s.start && day.index < s.end);
      if (inSeason || !day.isWeekend || !rng.chance(0.03)) continue;
      const lines = session(rng, "1.21.1", 12, new Map(), new Set());
      ctx.writeStaged("minecraft", `logs/${day.date}-1.log.gz`, gzipSync(lines.join("\n")));
    }

    // Paper names files by local date and logs local wall-clock times; the
    // importer reads them in the process time zone, so run it in Alex's.
    await ctx.runParserCli("minecraft.ts", [`${ctx.stage("minecraft")}/logs`, SERVER, PLAYERS.alex], {
      TZ: TIME_ZONE,
    });
  },
};

function session(
  rng: Rng,
  version: string,
  weeksIn: number,
  progress: Map<PlayerKey, number>,
  challenged: Set<string>,
): string[] {
  const out: string[] = [];
  let t = (19 * 60 + rng.int(10, 70)) * 60 + rng.int(0, 59); // seconds since local midnight
  const end = Math.min((22 * 60 + rng.int(30, 85)) * 60, 23 * 3600 + 50 * 60);
  const stamp = () => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
  };
  const line = (thread: string, message: string) => out.push(`${stamp()} [${thread}/INFO]: ${message}`);
  const tick = (min: number, max: number) => {
    t += rng.int(min, max);
  };

  line("ServerMain", "Environment: Environment[sessionHost=https://sessionserver.mojang.com, servicesHost=https://api.minecraftservices.com, name=PROD]");
  line("Server thread", `Starting minecraft server version ${version}`);
  line("Server thread", "Preparing level \"world\"");
  tick(5, 12);
  line("Server thread", `Done (${rng.float(4, 9).toFixed(3)}s)! For help, type "help"`);
  tick(30, 300);

  const keys = Object.keys(PLAYERS) as PlayerKey[];
  const present = keys.filter((k) => (k === "alex" ? rng.chance(0.92) : k === "theo" ? rng.chance(0.85) : rng.chance(0.6)));
  if (present.length === 0) present.push("theo");
  const online = new Set<PlayerKey>();

  const join = (k: PlayerKey) => {
    const name = PLAYERS[k];
    line("User Authenticator #1", `UUID of player ${name} is ${uuidFor(name)}`);
    tick(1, 2);
    line("Server thread", `${name}[/192.0.2.${10 + keys.indexOf(k)}:${rng.int(49152, 65535)}] logged in with entity id ${rng.int(100, 9000)} at ([world]${rng.float(-300, 300).toFixed(1)}, ${rng.int(60, 90)}.0, ${rng.float(-300, 300).toFixed(1)})`);
    line("Server thread", `${name} joined the game`);
    online.add(k);
    tick(5, 90);
  };
  const leave = (k: PlayerKey) => {
    const name = PLAYERS[k];
    line("Server thread", `${name} lost connection: Disconnected`);
    line("Server thread", `${name} left the game`);
    online.delete(k);
    tick(5, 60);
  };

  for (const k of rng.shuffle(present)) join(k);

  const chatPool = [...(weeksIn < 2 ? CHAT_EARLY : []), ...CHAT_ANY, ...(weeksIn > 4 ? CHAT_LATE : [])];
  const actions = rng.int(10, 18);
  for (let i = 0; i < actions && t < end; i++) {
    tick(60, 600);
    const players = [...online];
    const k = players.length > 0 ? rng.pick(players) : null;
    if (!k) {
      join(rng.pick(present));
      continue;
    }
    const name = PLAYERS[k];
    const roll = rng.next();
    if (roll < 0.68) {
      line("Async Chat Thread - #0", `<${name}> ${rng.pick(chatPool)}`);
    } else if (roll < 0.82) {
      const next = progress.get(k) ?? 0;
      const advancement = ADVANCEMENTS[next];
      if (advancement) {
        line("Server thread", `${name} has made the advancement [${advancement}]`);
        progress.set(k, next + 1);
      } else {
        const challenge = rng.pick(CHALLENGES);
        if (!challenged.has(`${k}:${challenge}`)) {
          challenged.add(`${k}:${challenge}`);
          line("Server thread", `${name} has completed the challenge [${challenge}]`);
        }
      }
    } else if (roll < 0.93) {
      line("Server thread", rng.pick(DEATHS)(name));
      tick(3, 10);
      if (rng.chance(0.6)) line("Async Chat Thread - #0", `<${name}> ${rng.pick(["noooo", "my stuff!!", "ugh", "lol rip me", "someone save my items"])}`);
    } else if (players.length > 1) {
      leave(k);
      if (rng.chance(0.6)) {
        tick(120, 900);
        join(k);
      }
    }
  }

  for (const k of rng.shuffle([...online])) leave(k);
  line("Server thread", "Stopping server");
  return out;
}

function uuidFor(name: string): string {
  let h = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 32; round++) {
    for (const c of `${name}:${round}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    hex += h.toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

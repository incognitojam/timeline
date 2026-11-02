/**
 * Conversation material for the chat-assistant generators (Claude.ai and
 * ChatGPT): topics Alex asks about, each with slot variants so the same topic
 * reads differently across conversations, and a planner that times them.
 */
import type { SeedContext, SeedDay } from "../context";
import type { Rng } from "../rng";
import { fence } from "./coding-data";

type Slot = Readonly<Record<string, string>>;

interface ChatTopic {
  /** Conversation titles; `{field}` placeholders are filled from the slot. */
  titles: readonly string[];
  slots: readonly Slot[];
  /** The first turn always runs; later turns are sampled in order. */
  turns: readonly { asks: readonly string[]; answer: string }[];
  /** Search queries Claude might run for this topic (enables web search blocks). */
  search?: string;
  technical?: boolean;
}

export interface ChatTurn {
  ask: string;
  askAt: number;
  answer: string;
  answerAt: number;
  search?: { query: string; results: readonly { title: string; url: string }[] };
  thinking?: string;
}

export interface ChatConversation {
  title: string;
  day: SeedDay;
  technical: boolean;
  turns: ChatTurn[];
}

function fill(template: string, slot: Slot): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = slot[key];
    if (value === undefined) throw new Error(`Missing chat slot field ${key} for "${template.slice(0, 40)}"`);
    return value;
  });
}

const TOPICS: readonly ChatTopic[] = [
  {
    titles: ["{trail} hike prep", "Planning {trail}", "{trail} this weekend"],
    search: "{trail} trail conditions",
    slots: [
      { trail: "Mount Si", miles: "8", gain: "3,150 ft", region: "North Bend", note: "The last stretch to the Haystack is a scramble — most people stop at the viewpoint below it.", parking: "The main lot fills by 8am on summer weekends." },
      { trail: "Rattlesnake Ledge", miles: "4", gain: "1,160 ft", region: "North Bend", note: "The ledges have sheer drops, so keep an eye on anyone who wanders near the edge.", parking: "It's one of the busiest trails in the state; arrive before 7:30am or after 4pm." },
      { trail: "Lake Serene", miles: "8.2", gain: "2,000 ft", region: "Highway 2", note: "There's an optional side trip to Bridal Veil Falls that's worth the extra mile.", parking: "You'll need a Northwest Forest Pass for the lot." },
      { trail: "Snow Lake", miles: "7.2", gain: "1,800 ft", region: "Snoqualmie Pass", note: "Snow lingers on the descent to the lake well into July; microspikes help early season.", parking: "The Alpental lot is large but still fills on sunny Saturdays." },
      { trail: "Poo Poo Point", miles: "7.4", gain: "1,858 ft", region: "Issaquah", note: "You can usually watch paragliders launch from the top on clear days.", parking: "Parking at the Chirico trailhead is limited; the High School trail is the alternative." },
      { trail: "Mailbox Peak", miles: "9.4", gain: "4,000 ft", region: "North Bend", note: "The new trail is gentler; the old trail is brutally steep and hard on knees.", parking: "Needs a Discover Pass; there's an overflow lot down the road." },
    ],
    turns: [
      {
        asks: [
          "I'm doing {trail} on Saturday with a few friends. What should we know?",
          "Thinking about hiking {trail} this weekend. Is it a good one for a group with mixed fitness?",
        ],
        answer:
          "**{trail}** ({region}) is about **{miles} miles round trip with {gain} of gain**, so plan on 3–5 hours depending on pace and breaks.\n\nA few things worth knowing:\n\n- {note}\n- {parking}\n- Check the WTA trip reports for the last week — conditions change fast in shoulder season.\n- For a mixed group, agree on a turnaround time before you start so nobody feels pressured.\n\nWant a packing list or a suggested start time?",
      },
      {
        asks: ["Yes, packing list please. Forecast says showers in the morning.", "What should we pack? Might be drizzly."],
        answer:
          "For a wet morning on {trail}:\n\n**Essentials**\n- Rain shell and a warm mid-layer (fleece or light puffy)\n- Synthetic or wool base layer — skip cotton\n- 1.5–2L water per person, plus electrolytes\n- Snacks you'll actually eat when cold (sandwiches, trail mix, chocolate)\n- Headlamp, small first-aid kit, map/offline GPX\n\n**Nice to have**\n- Spare socks in a zip bag\n- Trekking poles for the descent\n- A sit pad for lunch on wet rock\n\nIf the showers clear by midday, starting a bit later can mean better views at the top.",
      },
      {
        asks: ["What time should we leave Capitol Hill?", "When should we head out from Seattle?"],
        answer:
          "Driving from Capitol Hill to {region} usually takes 35–60 minutes depending on I-90 traffic. {parking} I'd aim to leave around **6:45am**, which gets you hiking by ~7:45 and back before the afternoon crowds.",
      },
      {
        asks: ["Any good food stops on the way back?", "Where should we eat afterwards?"],
        answer:
          "Post-hike food is half the fun. In North Bend and along I-90 you'll find classic diners and burger spots; Snoqualmie also has a few bakeries. If you'd rather wait until you're back in the city, a big bowl of ramen on Capitol Hill is hard to beat after a wet hike.",
      },
    ],
  },
  {
    titles: ["Rust: {concept}", "Help with {concept} in Rust", "{concept} question"],
    technical: true,
    slots: [
      {
        concept: "lifetimes in a struct",
        question: "I have a struct that holds a &str from a parsed CSV line and the compiler wants lifetime annotations everywhere. Is there a cleaner way?",
        answer: "You have two options:\n\n1. **Keep the borrow** and annotate once: `struct Row<'a> { name: &'a str }`. This is zero-copy but every `Row` is tied to the buffer it came from.\n2. **Own the data**: `struct Row { name: String }`. One allocation per field, but no lifetime threading.\n\nFor a budgeting CLI that reads a few thousand rows, owning the data is simpler and the cost is negligible. Reach for borrowed rows when you're streaming millions of records.",
        code: "#[derive(Debug, serde::Deserialize)]\nstruct Row {\n    date: String,\n    name: String,\n    amount: rust_decimal::Decimal,\n}",
      },
      {
        concept: "anyhow vs thiserror",
        question: "When should I use anyhow and when thiserror? My CLI has both and it feels messy.",
        answer: "The usual split: **`thiserror` in library code** where callers need to match on error variants, and **`anyhow` at the application edge** (main, command handlers) where you just want context and a nice report.\n\nIn a single-binary CLI, define a small `thiserror` enum for errors you handle specifically (e.g. `DuplicateTransaction`) and use `anyhow::Result` + `.context()` everywhere else.",
        code: "#[derive(Debug, thiserror::Error)]\npub enum ImportError {\n    #[error(\"unknown CSV format (headers: {0})\")]\n    UnknownFormat(String),\n    #[error(\"duplicate transaction {0}\")]\n    Duplicate(String),\n}",
      },
      {
        concept: "Rc<RefCell<T>>",
        question: "Is Rc<RefCell<T>> a code smell? I'm using it for a tree of budget categories.",
        answer: "Not inherently, but in a tree it often signals that ownership could be flatter. A common pattern is an **arena**: store nodes in a `Vec<Node>` and refer to parents/children by index. You get cheap traversal, no runtime borrow panics, and easy serialization.",
        code: "struct Category {\n    name: String,\n    parent: Option<usize>,\n    children: Vec<usize>,\n}\n\nstruct Tree {\n    nodes: Vec<Category>,\n}",
      },
      {
        concept: "iterators and collect",
        question: "How do I collect an iterator of Result<T, E> into Result<Vec<T>, E>?",
        answer: "`collect()` does this directly — `Result` implements `FromIterator`, so collecting stops at the first error and returns it.",
        code: "let rows: Result<Vec<Row>, csv::Error> = reader.deserialize().collect();\nlet rows = rows?;",
      },
    ],
    turns: [
      { asks: ["{question}"], answer: "{answer}\n\n{code_block}" },
      {
        asks: ["Makes sense. Would this change if I later add a TUI?", "What would you do in a bigger codebase?"],
        answer: "The core advice holds. As the project grows, keep the domain types (parsing, budgets, reports) in a library crate with precise errors and owned data, and make the CLI/TUI thin front-ends over it. That way the TUI can hold state without fighting lifetimes.",
      },
      {
        asks: ["Can you show a quick test for that?", "How would I test it?"],
        answer: "A minimal unit test alongside the code:\n\n" + fence("rust", "#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn parses_sample() {\n        let input = \"date,name,amount\\n2024-03-01,Coffee,-3.50\\n\";\n        let rows = parse(input.as_bytes()).unwrap();\n        assert_eq!(rows.len(), 1);\n    }\n}"),
      },
    ],
  },
  {
    titles: ["Go {concept}", "{concept} in Go", "Question about {concept}"],
    technical: true,
    slots: [
      {
        concept: "context cancellation",
        question: "In our Kafka consumer, how do I make sure a retry sleep is interrupted when the service shuts down?",
        answer: "Never use a bare `time.Sleep` in code that should respect shutdown. Select on the context and a timer instead, and stop the timer if the context wins so it can be collected.",
        code: "func sleep(ctx context.Context, d time.Duration) error {\n\tt := time.NewTimer(d)\n\tdefer t.Stop()\n\tselect {\n\tcase <-ctx.Done():\n\t\treturn ctx.Err()\n\tcase <-t.C:\n\t\treturn nil\n\t}\n}",
      },
      {
        concept: "errgroup",
        question: "What's the idiomatic way to run N workers and stop all of them if one fails?",
        answer: "`golang.org/x/sync/errgroup` with `WithContext` is exactly that: the first error cancels the shared context, and `Wait` returns it. Use `SetLimit` to bound concurrency.",
        code: "g, ctx := errgroup.WithContext(ctx)\ng.SetLimit(8)\nfor _, p := range partitions {\n\tg.Go(func() error { return consume(ctx, p) })\n}\nreturn g.Wait()",
      },
      {
        concept: "table-driven tests",
        question: "Our tests are copy-pasted. How do I structure table-driven tests nicely?",
        answer: "Define a slice of cases with a name, inputs, and expected output, then loop with `t.Run` so each case reports separately and can be run alone with `-run`.",
        code: "tests := []struct {\n\tname string\n\tn    int\n\twant time.Duration\n}{\n\t{\"first retry\", 0, 200 * time.Millisecond},\n\t{\"capped\", 20, 30 * time.Second},\n}\nfor _, tt := range tests {\n\tt.Run(tt.name, func(t *testing.T) {\n\t\tif got := maxBackoff(tt.n); got != tt.want {\n\t\t\tt.Errorf(\"got %v, want %v\", got, tt.want)\n\t\t}\n\t})\n}",
      },
    ],
    turns: [
      { asks: ["{question}"], answer: "{answer}\n\n{code_block}" },
      {
        asks: ["Does this play well with -race?", "Any gotchas with the race detector?"],
        answer: "Yes — nothing here shares memory without synchronization. The usual race-detector gotcha is closing over a loop variable in older Go versions; since Go 1.22 each iteration gets its own variable, so the closure above is safe.",
      },
      {
        asks: ["How would you explain this to a junior on the team?", "Can you give me a one-paragraph summary for our wiki?"],
        answer: "Short version for the wiki: *anything that waits — sleeps, network calls, channel receives — should also wait on `ctx.Done()`. That's what lets the service shut down in seconds instead of hanging until the next timeout, and it keeps tests fast because they can cancel instead of sleeping.*",
      },
    ],
  },
  {
    titles: ["SQLite {concept}", "{concept} question", "Help with {concept}"],
    technical: true,
    slots: [
      {
        concept: "FTS5 ranking",
        question: "How do I rank SQLite FTS5 results so title matches count more than body matches?",
        answer: "Use `bm25()` with per-column weights. Lower scores are better in FTS5, so order ascending.",
        code: "SELECT trails.*, bm25(trails_fts, 10.0, 2.0, 1.0) AS score\nFROM trails_fts\nJOIN trails ON trails.id = trails_fts.rowid\nWHERE trails_fts MATCH 'lake*'\nORDER BY score\nLIMIT 20;",
      },
      {
        concept: "window functions",
        question: "I want a running monthly balance per category in SQL. Window functions?",
        answer: "Yes — aggregate per month first, then `SUM() OVER (PARTITION BY category ORDER BY month)` for the running total.",
        code: "WITH monthly AS (\n  SELECT category, strftime('%Y-%m', date) AS month, SUM(amount) AS total\n  FROM transactions GROUP BY 1, 2\n)\nSELECT category, month, total,\n       SUM(total) OVER (PARTITION BY category ORDER BY month) AS running\nFROM monthly;",
      },
      {
        concept: "WAL mode",
        question: "Should I turn on WAL mode for a small app with one writer and a web server reading?",
        answer: "Almost certainly. WAL lets readers proceed while the writer commits, which is exactly the one-writer/many-readers shape. Pair it with `synchronous = NORMAL` and a `busy_timeout` so occasional checkpoints don't surface as errors.",
        code: "PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA busy_timeout = 5000;",
      },
    ],
    turns: [
      { asks: ["{question}"], answer: "{answer}\n\n{code_block}" },
      {
        asks: ["Will that be fast with ~100k rows?", "How does this scale?"],
        answer: "At 100k rows SQLite won't break a sweat — queries like this typically run in single-digit milliseconds on a laptop. Run `EXPLAIN QUERY PLAN` to confirm it's using the index or FTS table rather than scanning.",
      },
    ],
  },
  {
    titles: ["TypeScript {concept}", "{concept} in TS"],
    technical: true,
    slots: [
      {
        concept: "discriminated unions",
        question: "How do I model API results that are either { ok: true, data } or { ok: false, error } so TypeScript narrows properly?",
        answer: "Use a literal discriminant and check it — TypeScript narrows each branch automatically, and an exhaustive `switch` with a `never` check catches new variants.",
        code: "type Result<T> = { ok: true; data: T } | { ok: false; error: string };\n\nfunction show(r: Result<Trip>) {\n  if (r.ok) return r.data.name;\n  return 'Error: ' + r.error;\n}",
      },
      {
        concept: "satisfies",
        question: "What's the point of `satisfies`? I keep seeing it in config files.",
        answer: "`satisfies` checks a value against a type **without widening it**. You get validation plus the precise inferred type — handy for config objects where you want autocomplete on the exact keys.",
        code: "const routes = {\n  trips: '/api/trips',\n  trails: '/api/trails',\n} satisfies Record<string, `/api/${string}`>;\n\nroutes.trips; // type is '/api/trips', not string",
      },
      {
        concept: "branded types",
        question: "I keep mixing up trip IDs and trail IDs (both strings). Can TS help?",
        answer: "Branded types make structurally identical strings incompatible at compile time, with zero runtime cost.",
        code: "type TripId = string & { readonly __brand: 'TripId' };\ntype TrailId = string & { readonly __brand: 'TrailId' };\n\nconst tripId = (s: string) => s as TripId;",
      },
    ],
    turns: [
      { asks: ["{question}"], answer: "{answer}\n\n{code_block}" },
      {
        asks: ["Does this work with zod?", "How does this interact with runtime validation?"],
        answer: "Yes — validate at the boundary with zod (`z.string().brand<'TripId'>()` for brands, `z.discriminatedUnion('ok', [...])` for unions), then let the static types carry the guarantees through the rest of the code.",
      },
    ],
  },
  {
    titles: ["{dish} recipe", "Making {dish} tonight", "{dish} for {servings}"],
    slots: [
      { dish: "red lentil dal", servings: "four", time: "35 minutes", ingredients: "1½ cups red lentils, 1 onion, 4 garlic cloves, thumb of ginger, 1 tsp each cumin seeds, turmeric, garam masala, a can of chopped tomatoes, coconut milk, lemon, cilantro", tip: "Bloom the cumin seeds in hot oil (tadka) right at the end and pour it over — it makes the dish." },
      { dish: "shakshuka", servings: "two", time: "25 minutes", ingredients: "6 eggs, 1 can crushed tomatoes, 1 red pepper, 1 onion, 3 garlic cloves, 1 tsp cumin, 1 tsp smoked paprika, pinch of chili flakes, feta, parsley, crusty bread", tip: "Make wells with the back of a spoon and cover the pan so the whites set before the yolks overcook." },
      { dish: "focaccia", servings: "six", time: "about 4 hours (mostly rising)", ingredients: "500g bread flour, 400g warm water, 10g salt, 4g instant yeast, plenty of olive oil, flaky salt, rosemary", tip: "Dimple aggressively with oiled fingers right before baking; that's where the crispy pockets come from." },
      { dish: "turkey chili", servings: "six", time: "1 hour", ingredients: "1 lb ground turkey, 2 cans beans, 1 can crushed tomatoes, onion, bell pepper, garlic, 2 tbsp chili powder, cumin, oregano, a square of dark chocolate", tip: "A splash of vinegar or lime at the end brightens it more than extra salt would." },
    ],
    turns: [
      {
        asks: ["Can you give me a simple {dish} recipe for {servings}?", "I want to make {dish} tonight. Simple recipe?"],
        answer: "Here's a straightforward **{dish}** for {servings} ({time}).\n\n**Ingredients:** {ingredients}.\n\n**Method**\n1. Prep everything first — it moves quickly once the pan is hot.\n2. Soften the aromatics in oil over medium heat, then add the spices for 30 seconds.\n3. Add the main ingredients and simmer until done, stirring occasionally.\n4. Taste and adjust salt and acid before serving.\n\n**Tip:** {tip}",
      },
      {
        asks: ["Can I make it ahead?", "Does it keep well?"],
        answer: "Yes — most of it keeps 3–4 days in the fridge and often tastes better the next day. Store any fresh garnish separately and add it when reheating.",
      },
      {
        asks: ["What would go well with it?", "Side dish ideas?"],
        answer: "Something fresh and crunchy to contrast: a cucumber-tomato salad with lemon, quick-pickled red onions, or simply good bread. For drinks, a crisp lager or sparkling water with lime.",
      },
    ],
  },
  {
    titles: ["Portland weekend {plan}", "Visiting Mei in Portland", "Portland trip planning"],
    search: "Portland Oregon {plan}",
    slots: [
      { plan: "itinerary", detail: "Saturday morning at Powell's City of Books, lunch from a food cart pod, afternoon in Washington Park (the Japanese Garden and the Rose Test Garden), and dinner on Division Street. Sunday: a walk in Forest Park on the Wildwood Trail, then brunch before heading home." },
      { plan: "train vs driving", detail: "Amtrak Cascades takes about 3.5 hours Seattle → Portland and drops you downtown, so you can skip parking entirely. Driving is 3–4 hours depending on I-5 traffic through Tacoma and Olympia, but gives you flexibility for the Gorge." },
      { plan: "Columbia Gorge day", detail: "Multnomah Falls is the classic stop (timed-entry permits are needed in summer), then continue to the Vista House at Crown Point and finish with a short hike like Latourell Falls. Hood River makes a great lunch stop." },
    ],
    turns: [
      {
        asks: ["I'm visiting my sister in Portland next month. Help me with a {plan}?", "Portland trip: can you suggest a {plan}?"],
        answer: "Fun! Here's a suggestion:\n\n{detail}\n\nWant me to adjust it for weather or for anything Mei is into?",
      },
      {
        asks: ["She's training for a half marathon so maybe something not too exhausting.", "Let's keep it relaxed, she has a race the weekend after."],
        answer: "Good call — swap the longer walks for flatter options: a stroll along the Eastbank Esplanade, the Lan Su Chinese Garden, and a lazy brunch. Save the bigger hike for after her race.",
      },
      {
        asks: ["Any rainy day backup?", "What if it rains all weekend?"],
        answer: "Portland in the rain is still great: spend a few hours at Powell's, visit OMSI (the science museum), catch a film at a historic cinema, or do a coffee crawl. Pack a proper rain jacket rather than an umbrella — it's usually drizzle, not downpour.",
      },
    ],
  },
  {
    titles: ["Gift ideas for {who}", "{occasion} gift for {who}"],
    slots: [
      { who: "my mum", occasion: "Birthday", likes: "gardening, mystery novels, and calling everyone on Sunday", ideas: "- A good pair of gardening gloves and a hori-hori knife\n- A subscription to a seed-of-the-month club\n- A signed copy of a new mystery novel from a local bookstore\n- A digital photo frame preloaded with family photos (you can add photos remotely)" },
      { who: "my sister", occasion: "Race day", likes: "running, coffee, and podcasts", ideas: "- A race-day flat-lay frame for her bib and medal\n- Good running socks (seriously, runners love them)\n- A massage gun or a foam roller\n- Beans from her favourite roaster with a note for post-race brunch" },
      { who: "a friend's housewarming", occasion: "Housewarming", likes: "cooking and hosting", ideas: "- A nice olive oil and flaky salt set\n- A sturdy cast-iron pan\n- A plant that's hard to kill (pothos, snake plant)\n- A board game for hosting nights" },
    ],
    turns: [
      {
        asks: ["Gift ideas for {who}? They're into {likes}. Budget around $60.", "Need a gift for {who} — {likes}. Ideas under $60?"],
        answer: "Some ideas that fit ~$60:\n\n{ideas}\n\nA short handwritten note with any of these goes a long way.",
      },
      {
        asks: ["I like the second one. Can you help me write the card?", "Help me write a short note to go with it?"],
        answer: "Here's a short, warm option:\n\n> Thinking of you and wishing you a wonderful day. I hope this makes the next few weeks a little brighter. Love, Alex\n\nWant it funnier or more sentimental?",
      },
    ],
  },
  {
    titles: ["Explain {concept}", "{concept} explained", "How does {concept} work?"],
    technical: true,
    slots: [
      { concept: "Raft consensus", explanation: "Raft elects a **leader** that accepts writes and replicates them as log entries to followers. An entry is **committed** once a majority has it, so the cluster tolerates (n-1)/2 failures. If followers stop hearing heartbeats they start an election with a higher **term**; a candidate wins with a majority of votes, and only candidates with up-to-date logs can win, which keeps committed entries safe." },
      { concept: "Kafka consumer groups", explanation: "A topic is split into **partitions**; each partition is read by exactly one consumer in a **group** at a time. Adding consumers (up to the partition count) spreads the load. When membership changes, the group **rebalances** and partitions are reassigned. Each group tracks its own **committed offsets**, so commit only after you've durably processed a message if you want at-least-once delivery." },
      { concept: "CRDTs", explanation: "Conflict-free replicated data types are structures whose replicas can be edited independently and **merged deterministically** without coordination. The merge is commutative, associative, and idempotent, so replicas converge regardless of message order. Examples: G-Counters (per-replica counts, merged by max), OR-Sets, and sequence CRDTs used by collaborative editors." },
      { concept: "how DNS resolution works", explanation: "Your machine asks a **recursive resolver** (often your ISP or 1.1.1.1). If it hasn't cached the answer, it asks a **root server** which points to the **TLD servers** (.com), which point to the domain's **authoritative nameservers**, which return the record. Every answer has a **TTL** that controls how long resolvers cache it — which is why DNS changes can take a while to propagate." },
    ],
    turns: [
      { asks: ["Can you explain {concept} simply?", "ELI5 {concept}?", "I need to understand {concept} for a design review tomorrow."], answer: "{explanation}\n\nWant a diagram-style walkthrough or the common failure modes?" },
      {
        asks: ["Failure modes please.", "What goes wrong in practice?"],
        answer: "The ones that bite in practice:\n\n- **Timeouts tuned too aggressively** cause needless churn (elections, rebalances, retries).\n- **Assuming exactly-once** when the system only guarantees at-least-once — make handlers idempotent.\n- **Clock assumptions**: never rely on wall clocks across machines for ordering.\n- **Observability gaps**: you need metrics for lag/leadership changes to notice problems before users do.",
      },
      {
        asks: ["How would I explain this in two sentences to my manager?", "TL;DR for a non-engineer?"],
        answer: "It's a way for several machines to agree on the same data even when some of them fail or messages arrive late. The trade-off is a bit of extra latency and operational care in exchange for not losing or corrupting data.",
      },
    ],
  },
  {
    titles: ["{plant} help", "Why is my {plant} {symptom}?"],
    slots: [
      { plant: "basil", symptom: "wilting", cause: "Basil on a sunny balcony usually wilts from **underwatering in heat** or **root rot from overwatering** — check the soil an inch down. Dry and light? Water deeply. Soggy and smelly? Repot into fresh, free-draining mix.", tip: "Pinch off flower buds as soon as they appear; flowering makes the leaves bitter and the plant leggy." },
      { plant: "monstera", symptom: "getting yellow leaves", cause: "One yellow lower leaf now and then is normal aging. Several at once usually means **overwatering** — let the top 2–3 inches dry before watering again, and make sure the pot drains.", tip: "Bright indirect light is ideal; a north window in Seattle winter is often too dim." },
      { plant: "chili plant", symptom: "dropping flowers", cause: "Flower drop on chilies is usually **temperature swings** (below ~60°F at night) or **lack of pollination** indoors. Gently shake the plant or use a small brush to move pollen between flowers.", tip: "Bring it inside once nights drop below 50°F; chilies overwinter surprisingly well." },
    ],
    turns: [
      { asks: ["My {plant} is {symptom}. What am I doing wrong?", "Help, {plant} {symptom}."], answer: "{cause}\n\n**Tip:** {tip}" },
      {
        asks: ["I have a soil moisture sensor on it — what reading should I aim for?", "What moisture % should I target?"],
        answer: "For most herbs and houseplants, aim to water when the sensor reads around **25–35%** and let it climb to **60–70%** after watering. Calibrate the sensor in dry air and in a glass of water first so the percentages mean something.",
      },
    ],
  },
  {
    titles: ["{goal} plan", "Help me {goal}"],
    slots: [
      { goal: "train for a 10K", plan: "**Weeks 1–2:** three easy 25–30 minute runs + one rest day between each.\n**Weeks 3–5:** add a weekly long run (build from 4 to 6 miles) and one session of 6×2 min at a comfortably hard pace.\n**Weeks 6–7:** long run to 7 miles; tempo run of 20 minutes.\n**Week 8:** taper — shorter runs, a few strides, and rest two days before the race." },
      { goal: "stop my knees hurting on descents", plan: "- **Trekking poles** take a big chunk of load off your knees going downhill.\n- **Shorter steps** and a slight bend in the knee absorb impact.\n- **Strength work** twice a week: step-downs, split squats, and glute bridges.\n- If pain is sharp or persists after rest, see a physio — it could be patellofemoral pain or IT band irritation." },
      { goal: "build a stretching routine after hikes", plan: "10 minutes is enough: **calf stretch** against a tree (45s each), **standing quad stretch**, **hamstring fold**, **figure-four** for glutes/hips, and a **hip flexor lunge**. Breathe slowly and don't bounce." },
    ],
    turns: [
      { asks: ["I want to {goal}. Can you give me a plan?", "Help me {goal}?"], answer: "{plan}\n\nWant me to turn this into a calendar or checklist?" },
      {
        asks: ["Can you make it a checklist I can paste into my notes app?", "Checklist version please."],
        answer: "Here you go:\n\n- [ ] Week 1 — start easy, focus on consistency\n- [ ] Week 2 — same plan, note how you feel\n- [ ] Week 3 — add the extra session\n- [ ] Week 4 — check in: any pain? adjust\n- [ ] Week 5+ — progress gradually (no more than ~10%/week)",
      },
    ],
  },
  {
    titles: ["{doc} draft", "Help writing {doc}"],
    slots: [
      { doc: "a self-review", context: "performance review at Northwind", draft: "This half I led the migration of the ingest pipeline to batched writes, which cut warehouse costs by roughly a third and removed our most frequent on-call page. I also mentored two newer engineers through their first on-call rotations and wrote the runbooks we now use for consumer lag incidents.\n\nNext half I'd like to own the schema-validation project end to end and grow my design-review skills." },
      { doc: "a message to my landlord", context: "a leaking kitchen faucet", draft: "Hi — the kitchen faucet has been dripping steadily for about a week and it's getting worse (it now runs even when fully closed). Could you arrange for someone to take a look? I'm home most evenings after 6pm, or I'm happy to leave access instructions. Thanks!" },
      { doc: "a hiking group update", context: "rescheduling Saturday's hike", draft: "Hey all — the forecast for Saturday has turned into an atmospheric river, so let's push the hike to Sunday. Same plan: meet at 7am, Rowan's driving one car and I'll drive the other. Reply with 👍 if Sunday works!" },
    ],
    turns: [
      { asks: ["Can you help me write {doc} about {context}?", "I need to write {doc} ({context}). Draft something?"], answer: "Here's a draft:\n\n> {draft}\n\nI kept it short and concrete. Want it more formal or more casual?" },
      { asks: ["A bit more casual?", "Make it shorter."], answer: "Sure — a tighter take: keep the first sentence as the headline, cut everything after it down to one line, and finish with a single clear ask. Shorter messages about {context} tend to get faster replies." },
    ],
  },
  {
    titles: ["Books like {book}", "Recommendations: {book}"],
    slots: [
      { book: "Project Hail Mary", recs: "- **The Martian** (same author, same problem-solving joy)\n- **Children of Time** by Adrian Tchaikovsky — big ideas, great aliens\n- **The Long Way to a Small, Angry Planet** by Becky Chambers — cozy and character-driven\n- **Recursion** by Blake Crouch — a fast, twisty thriller" },
      { book: "Into Thin Air", recs: "- **Touching the Void** by Joe Simpson\n- **Annapurna** by Maurice Herzog\n- **The Push** by Tommy Caldwell\n- **Minus 148°** by Art Davidson — the first winter ascent of Denali" },
      { book: "The House in the Cerulean Sea", recs: "- **Legends & Lattes** by Travis Baldree\n- **A Psalm for the Wild-Built** by Becky Chambers\n- **Howl's Moving Castle** by Diana Wynne Jones" },
    ],
    turns: [
      { asks: ["I loved {book}. What should I read next?", "Recommend me something like {book}?"], answer: "If you enjoyed **{book}**, try:\n\n{recs}\n\nWant something shorter for the bus, or audiobook-friendly?" },
      { asks: ["Audiobook-friendly ones?", "Which of those works best as an audiobook?"], answer: "Of those, the first one is a standout on audio — the narration adds a lot. The cozy picks also make great bedtime listening." },
    ],
  },
  {
    titles: ["git {concept}", "How do I {concept}?"],
    technical: true,
    slots: [
      { concept: "rebase onto main after a squash merge", answer: "After the parent branch was squash-merged, use `git rebase --onto` to replay only your commits.", code: "git fetch origin\ngit rebase --onto origin/main old-parent-branch my-branch" },
      { concept: "find which commit broke the tests", answer: "`git bisect run` automates it: mark a good and bad commit and give it a command whose exit code says pass/fail.", code: "git bisect start HEAD v0.4.0\ngit bisect run cargo test --quiet\ngit bisect reset" },
      { concept: "undo the last commit but keep the changes", answer: "`git reset --soft HEAD~1` moves the branch back one commit and leaves the changes staged.", code: "git reset --soft HEAD~1\ngit status" },
    ],
    turns: [
      { asks: ["How do I {concept}?", "git question: {concept}?"], answer: "{answer}\n\n{code_block}" },
      { asks: ["What if I already pushed?", "And if it's already on the remote?"], answer: "Then you'll need to force-push the rewritten branch. Use `git push --force-with-lease` rather than `--force` — it refuses to overwrite commits on the remote that you haven't seen, which protects collaborators' work." },
    ],
  },
  {
    titles: ["Board games for {n} players", "Game night picks"],
    slots: [
      { n: "five", recs: "- **Codenames** — easy to teach, works with any number\n- **Wavelength** — great conversation starter\n- **Just One** — cooperative and quick\n- **Cascadia** — calm, pretty, and very Pacific Northwest" },
      { n: "four", recs: "- **Wingspan** — engine building with birds\n- **Ticket to Ride** — classic gateway game\n- **The Crew** — cooperative trick-taking, surprisingly addictive\n- **Azul** — quick and beautiful" },
    ],
    turns: [
      { asks: ["Game night with {n} people this week. What should we play?", "Recommend board games for {n} players?"], answer: "Good picks for {n}:\n\n{recs}\n\nDo you want something competitive or co-op?" },
      { asks: ["Co-op please, someone always gets salty.", "Something where nobody gets eliminated?"], answer: "Then go co-op: **The Crew**, **Just One**, or **Pandemic**. Everyone wins or loses together, and there's no player elimination." },
    ],
  },
];

const SEARCH_RESULTS = [
  { title: "Washington Trails Association — Trip Reports", url: "https://www.wta.org/go-outside/trip-reports" },
  { title: "National Weather Service — Seattle", url: "https://www.weather.gov/sew/" },
  { title: "Travel Portland", url: "https://www.travelportland.com/" },
  { title: "Recreation.gov — Permits", url: "https://www.recreation.gov/" },
  { title: "WSDOT — Snoqualmie Pass conditions", url: "https://wsdot.com/travel/real-time/mountainpasses/snoqualmie" },
];

export interface ChatPlanOptions {
  fromDaysAgo: number;
  toDaysAgo: number;
  conversations: number;
  /** Extra turns sampled after the first, inclusive. */
  extraTurns: readonly [number, number];
}

/**
 * Plan timed chat conversations: lunch breaks and evenings on weekdays,
 * any time on weekends, denser in recent months.
 */
export function planChatConversations(ctx: SeedContext, rng: Rng, options: ChatPlanOptions): ChatConversation[] {
  const days = ctx.days.filter((d) => d.daysAgo <= options.fromDaysAgo && d.daysAgo >= options.toDaysAgo);
  if (days.length === 0) throw new Error("planChatConversations: empty day window");
  const weighted = days.map((d) => [d, 1 + (1 - d.daysAgo / Math.max(1, options.fromDaysAgo))] as const);
  const conversations: ChatConversation[] = [];

  for (let i = 0; i < options.conversations; i++) {
    const day = rng.weighted(weighted);
    const topic = TOPICS[i % TOPICS.length] ?? rng.pick(TOPICS);
    const base = rng.pick(topic.slots);
    const slot: Slot = { ...base, code_block: base.code ? fence(codeLang(topic), base.code) : "" };
    const hour = day.isWeekend ? rng.int(9, 22) : rng.weighted([[12, 3], [rng.int(19, 23), 5], [rng.int(7, 8), 1], [rng.int(14, 16), 1]]);
    let t = ctx.localDate(day.date, hour, rng.int(0, 59), rng.int(0, 59)).getTime();

    const [first, ...rest] = topic.turns;
    if (!first) throw new Error("chat topic without turns");
    const extra = rng.int(options.extraTurns[0], Math.min(options.extraTurns[1], rest.length));
    const keep = new Set(rng.sample(rest.map((_, idx) => idx), extra));
    const chosen = [first, ...rest.filter((_, idx) => keep.has(idx))];

    const turns: ChatTurn[] = chosen.map((turn, idx) => {
      const askAt = idx === 0 ? t : (t += rng.int(40_000, 600_000));
      const answer = fill(turn.answer, slot);
      const answerAt = (t += rng.int(6_000, 40_000) + Math.min(answer.length * 15, 30_000));
      const search =
        idx === 0 && topic.search && rng.chance(0.6)
          ? { query: fill(topic.search, slot), results: rng.sample(SEARCH_RESULTS, 3) }
          : undefined;
      return {
        ask: fill(rng.pick(turn.asks), slot),
        askAt,
        answer,
        answerAt,
        search,
        thinking: topic.technical && rng.chance(0.3) ? "Let me work out what the user actually needs here and give a concrete example." : undefined,
      };
    });
    conversations.push({ title: fill(rng.pick(topic.titles), slot), day, technical: topic.technical ?? false, turns });
  }
  return conversations.sort((a, b) => (a.turns[0]?.askAt ?? 0) - (b.turns[0]?.askAt ?? 0));
}

function codeLang(topic: ChatTopic): string {
  const title = topic.titles[0] ?? "";
  if (title.startsWith("Rust")) return "rust";
  if (title.startsWith("Go")) return "go";
  if (title.startsWith("SQLite")) return "sql";
  if (title.startsWith("TypeScript")) return "ts";
  if (title.startsWith("git")) return "bash";
  return "";
}

/** Zip files into an archive without directory prefixes, as the export downloads are. */
export async function zipFlat(zipPath: string, files: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["zip", "-q", "-j", zipPath, ...files], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`zip failed: ${await new Response(proc.stderr).text()}`);
}

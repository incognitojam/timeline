import type { SeedSource } from "../context";
import { SELF, TIME_ZONE } from "../persona";
import { CODING_ACCOUNT, CODING_PROJECTS, type CodingProject, TASKS } from "./coding-data";

/** Extra files per project beyond the ones the coding tasks touch. */
const EXTRA_FILES: Readonly<Record<CodingProject["name"], readonly string[]>> = {
  trailhead: ["src/index.ts", "src/db/client.ts", "web/src/App.tsx", "web/src/pages/Planner.tsx", "package.json", "README.md"],
  "pocket-ledger": ["src/main.rs", "src/categories.rs", "Cargo.toml", "README.md"],
  dotfiles: ["Brewfile", "git/.gitconfig", "nvim/init.lua", "tmux/.tmux.conf"],
  "northwind-ingest": ["cmd/ingest/main.go", "internal/kafka/consumer.go", "internal/config/config.go", "go.mod", "Makefile", "deploy/values.yaml"],
  "garden-sensors": ["sensors/reader.py", "app/dashboard.py", "pyproject.toml", "README.md"],
};

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  rs: "Rust",
  go: "Go",
  py: "Python",
  sh: "Bash",
  sql: "SQL",
  toml: "TOML",
  json: "JSON",
  md: "Markdown",
  yaml: "YAML",
  lua: "Lua",
  html: "HTML",
  mod: "Go",
};

function languageOf(project: CodingProject, file: string): string {
  const base = file.split("/").at(-1) ?? file;
  const ext = base.includes(".") ? (base.split(".").at(-1) ?? "") : "";
  if (ext === "" || base.startsWith(".")) return project.name === "dotfiles" ? "Bash" : project.language;
  return LANGUAGE_BY_EXT[ext] ?? project.language;
}

export const wakatimeSeed: SeedSource = {
  name: "wakatime",
  produces: { wakatime: ["code:session"] },
  async seed(ctx) {
    const rng = ctx.rng("wakatime");
    const machine = rng.uuid();
    const editor = rng.uuid();
    const userId = rng.uuid();
    const filesByProject = new Map(
      CODING_PROJECTS.map((p) => [p.name, [...new Set([...TASKS[p.name].flatMap((t) => t.files), ...EXTRA_FILES[p.name]])]] as const),
    );
    const work = CODING_PROJECTS.find((p) => p.name === "northwind-ingest");
    if (!work) throw new Error("work project missing");
    const personal = CODING_PROJECTS.filter((p) => p !== work);

    const days: { date: string; heartbeats: Record<string, unknown>[] }[] = [];
    let count = 0;
    for (const day of ctx.days) {
      const plans: { project: CodingProject; hour: number; minutes: number }[] = [];
      if (!day.isWeekend && rng.chance(0.62)) plans.push({ project: work, hour: rng.int(9, 14), minutes: rng.int(35, 150) });
      if (!day.isWeekend && rng.chance(0.25)) plans.push({ project: rng.weighted(personal.map((p) => [p, p.weight] as const)), hour: rng.int(19, 21), minutes: rng.int(20, 90) });
      if (day.isWeekend && rng.chance(0.3)) plans.push({ project: rng.weighted(personal.map((p) => [p, p.weight] as const)), hour: rng.int(10, 16), minutes: rng.int(30, 160) });

      const heartbeats: Record<string, unknown>[] = [];
      for (const plan of plans) {
        const files = filesByProject.get(plan.project.name) ?? [];
        const branch = rng.chance(0.4) ? "main" : `${CODING_ACCOUNT}/${rng.pick(TASKS[plan.project.name]).branch}`;
        const category = rng.weighted([["coding", 8], ["debugging", 1], ["building", 1]] as const);
        let t = ctx.localDate(day.date, plan.hour, rng.int(0, 59), rng.int(0, 59)).getTime() / 1000;
        const end = t + plan.minutes * 60;
        let file = rng.pick(files);
        let line = rng.int(1, 200);
        while (t < end) {
          if (rng.chance(0.15)) file = rng.pick(files);
          line = Math.max(1, line + rng.int(-20, 25));
          heartbeats.push({
            branch,
            category,
            created_at: new Date((t + rng.int(1, 30)) * 1000).toISOString(),
            cursorpos: rng.int(0, 4000),
            dependencies: [],
            entity: `${plan.project.dir}/${file}`,
            id: rng.uuid(),
            is_write: rng.chance(0.3),
            language: languageOf(plan.project, file),
            line_additions: null,
            line_deletions: null,
            lineno: line,
            lines: line + rng.int(10, 300),
            machine_name_id: machine,
            project: plan.project.name,
            project_root_count: plan.project.dir.split("/").length - 1,
            time: t,
            type: "file",
            user_agent_id: editor,
            user_id: userId,
          });
          t += rng.int(40, 130);
        }
      }
      count += heartbeats.length;
      days.push({ date: day.date, heartbeats });
    }
    if (count === 0) throw new Error("wakatime generated no heartbeats");

    const first = ctx.localDate(ctx.startDate, 0).getTime() / 1000;
    const last = ctx.localDate(ctx.anchorDate, 23, 59, 59).getTime() / 1000;
    const exportPath = ctx.writeStaged(
      "wakatime",
      "wakatime-export.json",
      JSON.stringify({
        user: { id: userId, username: CODING_ACCOUNT, display_name: SELF.name, email: SELF.email, timezone: TIME_ZONE },
        range: { start: first, end: last },
        days,
      }),
    );
    await ctx.runParserCli("wakatime.ts", [exportPath, CODING_ACCOUNT]);
  },
};

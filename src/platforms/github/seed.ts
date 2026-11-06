import type { SeedSource } from "../../seed/context";
import { personByKey } from "../../seed/persona";
import { CODING_ACCOUNT, CODING_PROJECTS, type CodingProject, iso, TASKS } from "../../seed/sources/coding-data";

const GITHUB = "https://github.com";
const ME = `${GITHUB}/${CODING_ACCOUNT}`;
/** Teammates whose PRs on the work repo Alex reviews. */
const TEAMMATES = [personByKey("jordan").handle, personByKey("nadia").handle];

const CHORES: Readonly<Record<CodingProject["name"], readonly string[]>> = {
  trailhead: ["Bump hono to 4.6", "Add dark mode to the planner", "Cache trail photos with a service worker", "Fix map tiles on Safari", "Show sunrise and sunset times", "Add elevation profile chart", "Paginate trip history", "Seed data for local development"],
  "pocket-ledger": ["Update to Rust 2024 edition", "Add --json output to report", "Speed up CSV parsing with ByteRecord", "Document category config", "Support Amex CSV exports"],
  dotfiles: ["Add ripgrep config", "Switch prompt to starship", "nvim: add LSP for Go and Rust", "git: enable rerere and zdiff3"],
  "northwind-ingest": ["Bump franz-go to v1.18", "Add readiness probe", "Tune consumer fetch sizes", "Add partition lag alert", "Make DLQ topic configurable", "Drop deprecated v1 schema", "Add load test harness"],
  "garden-sensors": ["Add Grafana dashboard JSON", "Log sensor voltage", "Pin dependencies with uv lock", "Add humidity sensor support"],
};

const ISSUES: Readonly<Record<CodingProject["name"], readonly { title: string; body: string }[]>> = {
  trailhead: [
    { title: "Trip dates shift by a day after 5pm", body: "Creating a trip in the evening saves it for the next day. Probably converting to UTC somewhere." },
    { title: "GPX import fails on files from Gaia GPS", body: "Gaia exports include `<extensions>` with a namespace we don't handle; the parser throws." },
    { title: "Forecast card shows stale data", body: "The forecast didn't update for two days. Cache key may not include the date." },
    { title: "Idea: share trip link with friends without an account", body: "Read-only share links with an unguessable token would make planning in the group chat easier." },
  ],
  "pocket-ledger": [
    { title: "Pot transfers counted as spending", body: "Monzo pot transfers show up in the Dining category total." },
    { title: "Report panics on an empty month", body: "`ledger report --month 2024-02` panics with `attempt to divide by zero` when there are no transactions." },
    { title: "Support multiple currencies", body: "Travel transactions in CAD and EUR should convert at the transaction date's rate." },
  ],
  dotfiles: [{ title: "install.sh fails on a fresh Mac", body: "Homebrew isn't on PATH yet when the script runs `brew bundle` on Apple Silicon." }],
  "northwind-ingest": [
    { title: "Consumer hot-loops when warehouse is down", body: "Retries have no backoff; CPU pegs at 100% and logs explode." },
    { title: "TestConsumerRebalance is flaky", body: "Fails roughly 1 in 10 CI runs under -race." },
    { title: "Dead-letter messages lack the original topic", body: "Hard to replay DLQ messages without knowing the source topic." },
  ],
  "garden-sensors": [
    { title: "Readings drift after a few days", body: "Raw values creep up ~5% over a week. Could be the sensor or the ADC reference." },
    { title: "Alerts fire every 5 minutes", body: "Once dry, the alert repeats on every check. Needs a cooldown." },
  ],
};

const COMMENTS = [
  "Thanks for the report — I can reproduce this locally.",
  "Fixed in the latest commit, can you give it another try?",
  "I think this is the same root cause as the timezone bug; investigating.",
  "Good idea. I'll sketch something this weekend.",
  "Closing as fixed. Reopen if you still see it.",
  "Added a regression test for this so it doesn't come back.",
  "Nice catch! Merging once CI is green.",
  "Could we split this into two PRs? The refactor and the behaviour change are easier to review separately.",
  "Benchmarked this: about 3x faster on the full dataset.",
  "LGTM after the rename.",
];

const REVIEWS = [
  { state: 40, body: "LGTM — nice cleanup." },
  { state: 40, body: "Looks good. Left one nit about naming, feel free to ignore." },
  { state: 40, body: "" },
  { state: 30, body: "Can we add a test for the retry path before merging?" },
  { state: 30, body: "This commits the offset before the write succeeds; I think we can lose messages on crash." },
  { state: 1, body: "Mostly questions inline — happy to pair on this tomorrow." },
];

export const githubSeed: SeedSource = {
  name: "github",
  produces: {
    github: ["github:issue", "github:pull_request", "github:issue_comment", "github:pr_review", "github:commit_comment"],
  },
  async seed(ctx) {
    const rng = ctx.rng("github");
    const issues: Record<string, unknown>[] = [];
    const pullRequests: Record<string, unknown>[] = [];
    const issueComments: Record<string, unknown>[] = [];
    const reviews: Record<string, unknown>[] = [];
    const commitComments: Record<string, unknown>[] = [];
    const numbers = new Map<string, number>();
    const nextNumber = (repo: string) => {
      const n = (numbers.get(repo) ?? 0) + 1;
      numbers.set(repo, n);
      return n;
    };
    // Weekday-weighted moments across the range.
    const dayWeights = ctx.days.map((d) => [d, d.isWeekend ? 0.5 : 1] as const);
    const moment = (hourMin: number, hourMax: number) => {
      const day = rng.weighted(dayWeights);
      return ctx.localDate(day.date, rng.int(hourMin, hourMax), rng.int(0, 59), rng.int(0, 59)).getTime();
    };
    const projectWeights = CODING_PROJECTS.map((p) => [p, p.weight] as const);
    const repoUrl = (p: CodingProject) => `${GITHUB}/${p.repo}`;
    // Merges/closures that would land after the anchor are still open.
    const horizon = ctx.localDate(ctx.anchorDate, 23, 59, 59).getTime();
    const ifPast = (at: number) => (at <= horizon ? iso(at) : undefined);

    const timeline: { at: number; make: () => void }[] = [];

    // Alex's own pull requests.
    for (let i = 0; i < 140; i++) {
      const project = rng.weighted(projectWeights);
      const isWork = project.name === "northwind-ingest";
      const at = isWork ? moment(9, 17) : moment(18, 22);
      timeline.push({
        at,
        make: () => {
          const task = rng.chance(0.55) ? rng.pick(TASKS[project.name]) : null;
          const title = task?.title ?? rng.pick(CHORES[project.name]);
          const number = nextNumber(project.repo);
          const url = `${repoUrl(project)}/pull/${number}`;
          const merged = rng.chance(0.85) ? ifPast(at + rng.int(1, 72) * 3_600_000) : undefined;
          pullRequests.push({
            type: "pull_request",
            url,
            user: ME,
            repository: repoUrl(project),
            title,
            body: task ? `${task.summary}\n\nCloses #${rng.int(1, Math.max(1, number))}` : `${title}.\n\nNo behaviour change outside this area.`,
            base: { ref: "main", sha: rng.hex(40), user: `${GITHUB}/${project.repo.split("/")[0]}`, repo: repoUrl(project) },
            head: { ref: task ? `${CODING_ACCOUNT}/${task.branch}` : `${CODING_ACCOUNT}/chore-${number}`, sha: rng.hex(40), user: ME, repo: repoUrl(project) },
            assignee: null,
            assignees: [],
            milestone: null,
            labels: [],
            review_requests: isWork ? [{ reviewer: `${GITHUB}/${rng.pick(TEAMMATES)}` }] : [],
            work_in_progress: false,
            merged_at: merged,
            closed_at: merged ?? (rng.chance(0.5) ? ifPast(at + 86_400_000 * rng.int(2, 20)) : undefined),
            created_at: iso(at),
          });
          // Discussion on the PR.
          if (rng.chance(0.45)) {
            issueComments.push({ type: "issue_comment", url: `${url}#issuecomment-${rng.digits(10)}`, pull_request: url, user: ME, body: rng.pick(COMMENTS), formatter: "markdown", reactions: [], created_at: iso(at + rng.int(1, 30) * 3_600_000) });
          }
          if (rng.chance(0.1)) {
            const commit = rng.hex(40);
            commitComments.push({
              type: "commit_comment",
              url: `${repoUrl(project)}/commit/${commit}#commitcomment-${rng.digits(9)}`,
              repository: repoUrl(project),
              user: ME,
              body: rng.pick(["Note to self: revert this once the upstream fix lands.", "This is the commit that fixed the flaky test.", "Benchmarks for this change are in the PR description."]),
              commit_id: commit,
              path: null,
              position: null,
              formatter: "markdown",
              created_at: iso(at + 3_600_000),
            });
          }
        },
      });
    }

    // Teammates' PRs on the work repo, reviewed by Alex. Their own rows are
    // in the export too; the importer keeps only Alex's activity.
    const work = CODING_PROJECTS.find((p) => p.name === "northwind-ingest");
    if (!work) throw new Error("work project missing");
    for (let i = 0; i < 75; i++) {
      const at = moment(9, 17);
      timeline.push({
        at,
        make: () => {
          const author = rng.pick(TEAMMATES);
          const number = nextNumber(work.repo);
          const url = `${repoUrl(work)}/pull/${number}`;
          const title = rng.chance(0.5) ? rng.pick(CHORES[work.name]) : rng.pick(TASKS[work.name]).title;
          pullRequests.push({ type: "pull_request", url, user: `${GITHUB}/${author}`, repository: repoUrl(work), title, body: `${title}.`, created_at: iso(at), merged_at: ifPast(at + 86_400_000) });
          const review = rng.pick(REVIEWS);
          const reviewAt = at + rng.int(1, 20) * 3_600_000;
          reviews.push({ type: "pull_request_review", url: `${url}#pullrequestreview-${rng.digits(10)}`, pull_request: url, user: ME, body: review.body, head_sha: rng.hex(40), formatter: "markdown", state: review.state, reactions: [], created_at: iso(reviewAt), submitted_at: iso(reviewAt) });
          if (rng.chance(0.35)) {
            issueComments.push({ type: "issue_comment", url: `${url}#issuecomment-${rng.digits(10)}`, pull_request: url, user: ME, body: rng.pick(COMMENTS), formatter: "markdown", reactions: [], created_at: iso(reviewAt + 600_000) });
          }
        },
      });
    }

    // Issues Alex files on their repos, with follow-up comments.
    for (let i = 0; i < 60; i++) {
      const project = rng.weighted(projectWeights);
      const at = moment(8, 22);
      timeline.push({
        at,
        make: () => {
          const issue = rng.pick(ISSUES[project.name]);
          const number = nextNumber(project.repo);
          const url = `${repoUrl(project)}/issues/${number}`;
          const closed = rng.chance(0.7) ? ifPast(at + rng.int(1, 30) * 86_400_000) : undefined;
          issues.push({ type: "issue", url, repository: repoUrl(project), user: ME, title: issue.title, body: issue.body, assignee: ME, assignees: [ME], milestone: null, labels: [], closed_at: closed, created_at: iso(at) });
          for (let c = rng.int(0, 2); c > 0; c--) {
            issueComments.push({ type: "issue_comment", url: `${url}#issuecomment-${rng.digits(10)}`, issue: url, user: ME, body: rng.pick(COMMENTS), formatter: "markdown", reactions: [], created_at: iso(at + rng.int(1, 200) * 3_600_000) });
          }
        },
      });
    }

    // Build items in time order so PR/issue numbers increase with time.
    for (const item of timeline.sort((a, b) => a.at - b.at)) item.make();

    const write = (prefix: string, all: Record<string, unknown>[]) => {
      // Follow-ups scheduled after the anchor haven't happened yet.
      const items = all.filter((item) => typeof item.created_at === "string" && Date.parse(item.created_at) <= horizon);
      for (let i = 0; i * 100 < items.length; i++) {
        ctx.writeStaged("github", `export/${prefix}_${String(i + 1).padStart(6, "0")}.json`, JSON.stringify(items.slice(i * 100, (i + 1) * 100)));
      }
    };
    write("issues", issues);
    write("pull_requests", pullRequests);
    write("issue_comments", issueComments);
    write("pull_request_reviews", reviews);
    write("commit_comments", commitComments);

    await ctx.runParserCli("platforms/github/parser.ts", [`${ctx.stage("github")}/export`, CODING_ACCOUNT]);
    ctx.identify("alex", `github:${CODING_ACCOUNT}`);
  },
};

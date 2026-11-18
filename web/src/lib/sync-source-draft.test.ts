import { describe, expect, it } from "vitest";
import type { SyncSourceInfo } from "./api";
import {
  buildConfigurationPatch,
  type ConfigurationDraft,
  draftFromSource,
  numberSettingError,
} from "./sync-source-draft";

function source(overrides?: Partial<SyncSourceInfo>): SyncSourceInfo {
  return {
    name: "backup",
    description: "Backup timeline database",
    configured: true,
    enabled: true,
    interval: null,
    effectiveInterval: "30m",
    effectiveIntervalMs: 1_800_000,
    defaultInterval: "30m",
    settings: { destination: "/tmp/backups", keep_count: 24, compress: true, mode: "full", exclude: ["cache"] },
    settingsSchema: [
      { key: "destination", type: "string", label: "Backup directory", required: true },
      { key: "keep_count", type: "number", label: "Backups to retain", integer: true, min: 1, default: 24 },
      { key: "compress", type: "boolean", label: "Compress backups", default: true },
      { key: "mode", type: "select", label: "Backup mode", options: ["full", "incremental"], default: "full" },
      { key: "exclude", type: "string-list", label: "Excluded folders" },
    ],
    ...overrides,
  };
}

/** The source's own draft with some fields edited, as the form would hold it. */
function edited(
  from: SyncSourceInfo,
  changes: Partial<Omit<ConfigurationDraft, "settings">> & { settings?: ConfigurationDraft["settings"] },
): [SyncSourceInfo, ConfigurationDraft] {
  const draft = draftFromSource(from);
  return [from, { ...draft, ...changes, settings: { ...draft.settings, ...changes.settings } }];
}

describe("buildConfigurationPatch", () => {
  it.each([
    { name: "an untouched draft", input: edited(source(), {}), patch: {} },
    {
      name: "a draft edited and then restored exactly",
      input: edited(source(), { settings: { destination: "/tmp/backups", compress: true } }),
      patch: {},
    },
    {
      name: "edits, toggles and selections, trimmed",
      input: edited(source(), {
        enabled: false,
        interval: " 45m ",
        settings: { destination: "  /mnt/new-backups  ", compress: false, mode: "incremental" },
      }),
      patch: {
        enabled: false,
        interval: "45m",
        settings: { destination: "/mnt/new-backups", compress: false, mode: "incremental" },
      },
    },
    {
      name: "an interval that only differs by whitespace",
      input: edited(source({ interval: "2h" }), { interval: " 2h " }),
      patch: {},
    },
    {
      name: "an untouched interval stored untrimmed",
      input: edited(source({ interval: " 2h " }), {}),
      patch: {},
    },
    {
      name: "a blank interval falls back to the default",
      input: edited(source({ interval: "2h" }), { interval: "  " }),
      patch: { interval: null },
    },
    {
      name: "using a setting's default removes its override",
      input: edited(source(), { settings: { compress: null, mode: null } }),
      patch: { settings: { compress: null, mode: null } },
    },
    {
      name: "blank text and an empty list remove their overrides",
      input: edited(source(), { settings: { destination: " ", keep_count: "", exclude: "\n \n" } }),
      patch: { settings: { destination: null, keep_count: null, exclude: null } },
    },
    {
      name: "numbers parse only when decimal; anything else goes to the server as typed",
      input: edited(source(), { settings: { keep_count: " 0x10 " } }),
      patch: { settings: { keep_count: "0x10" } },
    },
    {
      name: "a decimal number",
      input: edited(source(), { settings: { keep_count: " 12.5 " } }),
      patch: { settings: { keep_count: 12.5 } },
    },
    {
      name: "a list keeps its non-blank lines, trimmed",
      input: edited(source(), { settings: { exclude: " cache \n\n tmp " } }),
      patch: { settings: { exclude: ["cache", "tmp"] } },
    },
    {
      name: "a list reformatted to the stored entries",
      input: edited(source(), { settings: { exclude: "cache\n" } }),
      patch: {},
    },
    {
      name: "an untouched invalid stored override",
      input: edited(source({ settings: { destination: "/tmp/backups", keep_count: "twenty-four" } }), {}),
      patch: {},
    },
    {
      name: "an invalid stored override reset to its default",
      input: edited(source({ settings: { destination: "/tmp/backups", keep_count: "twenty-four" } }), {
        settings: { keep_count: null },
      }),
      patch: { settings: { keep_count: null } },
    },
    {
      name: "a source with no settings schema",
      input: edited(source({ settings: {}, settingsSchema: [] }), { enabled: false, interval: "1h" }),
      patch: { enabled: false, interval: "1h" },
    },
  ])("$name", ({ input: [from, draft], patch }) => {
    expect(buildConfigurationPatch(from, draft)).toEqual(patch);
  });

  it("refuses a draft missing a schema field", () => {
    const [from, draft] = edited(source(), {});
    delete draft.settings.mode;
    expect(() => buildConfigurationPatch(from, draft)).toThrow("Missing configuration draft for settings.mode");
  });
});

describe("numberSettingError", () => {
  const keepCount = { key: "keep_count", type: "number", label: "Backups", integer: true, min: 1, max: 100 } as const;

  it.each([
    { draft: "12", error: undefined },
    { draft: null, error: undefined },
    { draft: "0x10", error: undefined },
    { draft: "0", error: "Must be at least 1" },
    { draft: "101", error: "Must be at most 100" },
    { draft: "9007199254740993", error: "Must be a whole number in the safe integer range" },
    { draft: `1${"0".repeat(309)}`, error: "Number is too large" },
  ])("$draft → $error", ({ draft, error }) => {
    expect(numberSettingError(keepCount, draft)).toBe(error);
  });
});

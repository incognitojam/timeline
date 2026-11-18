import type { SyncSourceConfigField, SyncSourceInfo, SyncSourceSettingsPatch } from "./api";

interface InvalidStoredOverride {
  readonly kind: "invalid-stored-override";
}

export type ConfigurationDraftValue = string | boolean | InvalidStoredOverride | null;

const INVALID_STORED_OVERRIDE: InvalidStoredOverride = {
  kind: "invalid-stored-override",
};

export interface ConfigurationDraft {
  enabled: boolean;
  interval: string;
  settings: Record<string, ConfigurationDraftValue>;
}

export type ConfigurationFieldPath = "enabled" | "interval" | `settings.${string}`;

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function settingsFieldPath(key: string): `settings.${string}` {
  return `settings.${key}`;
}

function draftValueFromSettings(
  field: SyncSourceConfigField,
  settings: Record<string, unknown>
): ConfigurationDraftValue {
  const value = settings[field.key];
  if (value === undefined || value === null) return null;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? value : INVALID_STORED_OVERRIDE;
    case "number":
      return typeof value === "number" ? String(value) : INVALID_STORED_OVERRIDE;
    case "string-list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value.join("\n")
        : INVALID_STORED_OVERRIDE;
    default:
      return typeof value === "string" ? value : INVALID_STORED_OVERRIDE;
  }
}

export function isInvalidStoredOverride(
  value: ConfigurationDraftValue
): value is InvalidStoredOverride {
  return typeof value === "object" && value !== null && value.kind === "invalid-stored-override";
}

export function hasSettingDefault(field: SyncSourceConfigField): boolean {
  return field.default !== undefined;
}

function defaultDraftValue(field: SyncSourceConfigField): Exclude<ConfigurationDraftValue, null> {
  if (field.default === undefined) return field.type === "boolean" ? false : "";
  if (field.type === "boolean") return field.default;
  if (field.type === "number") return String(field.default);
  if (field.type === "string-list") return field.default.join("\n");
  return field.default;
}

export function effectiveDraftValue(
  field: SyncSourceConfigField,
  draft: ConfigurationDraftValue
): Exclude<ConfigurationDraftValue, null> {
  return draft === null || isInvalidStoredOverride(draft) ? defaultDraftValue(field) : draft;
}

export function formattedSettingDefault(field: SyncSourceConfigField): string {
  if (field.default === undefined) return "";
  if (field.type === "boolean") return field.default ? "On" : "Off";
  if (field.type === "string-list") {
    return field.default.length === 0 ? "None" : field.default.join(", ");
  }
  return String(field.default);
}

export function canRemoveSettingOverride(field: SyncSourceConfigField): boolean {
  return hasSettingDefault(field) || field.required !== true;
}

export function settingDefaultActionLabel(field: SyncSourceConfigField): string {
  return hasSettingDefault(field) ? "Use default" : "Remove override";
}

export function draftFromSource(source: SyncSourceInfo): ConfigurationDraft {
  const settings: Record<string, ConfigurationDraftValue> = {};
  for (const field of source.settingsSchema) {
    settings[field.key] = draftValueFromSettings(field, source.settings);
  }
  return {
    enabled: source.enabled,
    interval: source.interval ?? "",
    settings,
  };
}

export function sourceFingerprint(source: SyncSourceInfo): string {
  return JSON.stringify({
    name: source.name,
    enabled: source.enabled,
    interval: source.interval,
    settings: source.settings,
    settingsSchema: source.settingsSchema,
  });
}

export function settingValueForPatch(
  field: SyncSourceConfigField,
  draft: ConfigurationDraftValue
): string | number | boolean | string[] | null {
  if (draft === null) return null;
  if (field.type === "boolean") return draft === true;
  const raw = typeof draft === "string" ? draft : "";
  if (field.type === "number") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    return DECIMAL_PATTERN.test(trimmed) ? Number(trimmed) : trimmed;
  }
  if (field.type === "string-list") {
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return entries.length === 0 ? null : entries;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function numberSettingError(
  field: SyncSourceConfigField & { type: "number" },
  draft: ConfigurationDraftValue
): string | undefined {
  const value = settingValueForPatch(field, draft);
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return "Number is too large";
  if (field.integer && !Number.isSafeInteger(value)) {
    return "Must be a whole number in the safe integer range";
  }
  if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}`;
  if (field.max !== undefined && value > field.max) return `Must be at most ${field.max}`;
  return undefined;
}

export function settingValuesEqual(
  left: SyncSourceSettingsPatch[string],
  right: unknown
): boolean {
  if (left === null) return right === null || right === undefined;
  if (Array.isArray(left)) {
    return Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

export function selectSegments(options: string[], stored: string): { value: string; label: string }[] {
  const values = stored !== "" && !options.includes(stored) ? [...options, stored] : options;
  return values.map((value) => ({ value, label: value }));
}

export function hasDraftValue(field: SyncSourceConfigField, value: ConfigurationDraftValue): boolean {
  if (field.type === "boolean") return true;
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

export function stringDraft(field: SyncSourceConfigField, value: ConfigurationDraftValue): string {
  const effective = effectiveDraftValue(field, value);
  return typeof effective === "string" ? effective : "";
}

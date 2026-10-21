import { useBeforeLeave } from "@solidjs/router";
import { createForm } from "@tanstack/solid-form";
import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import {
  type SyncSourceConfigField,
  SyncSourceConfigurationError,
  type SyncSourceConfigurationPatch,
  type SyncSourceInfo,
  type SyncSourceSettingsPatch,
} from "../lib/api";
import { useUpdateSyncSourceConfiguration } from "../lib/queries";
import { getSourceColorStyle } from "../lib/source-styles";
import SegmentedControl from "../ui/SegmentedControl";

interface InvalidStoredOverride {
  readonly kind: "invalid-stored-override";
}

type ConfigurationDraftValue = string | boolean | InvalidStoredOverride | null;

const INVALID_STORED_OVERRIDE: InvalidStoredOverride = {
  kind: "invalid-stored-override",
};

interface ConfigurationDraft {
  enabled: boolean;
  interval: string;
  settings: Record<string, ConfigurationDraftValue>;
}

type ConfigurationFieldPath = "enabled" | "interval" | `settings.${string}`;

interface SyncSourceConfigurationFormProps {
  source: SyncSourceInfo;
}

interface ActiveSubmission {
  id: number;
  sourceEpoch: number;
}

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function settingsFieldPath(key: string): `settings.${string}` {
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

function isInvalidStoredOverride(
  value: ConfigurationDraftValue
): value is InvalidStoredOverride {
  return typeof value === "object" && value !== null && value.kind === "invalid-stored-override";
}

function hasSettingDefault(field: SyncSourceConfigField): boolean {
  return field.default !== undefined;
}

function defaultDraftValue(field: SyncSourceConfigField): Exclude<ConfigurationDraftValue, null> {
  if (field.default === undefined) return field.type === "boolean" ? false : "";
  if (field.type === "boolean") return field.default;
  if (field.type === "number") return String(field.default);
  if (field.type === "string-list") return field.default.join("\n");
  return field.default;
}

function effectiveDraftValue(
  field: SyncSourceConfigField,
  draft: ConfigurationDraftValue
): Exclude<ConfigurationDraftValue, null> {
  return draft === null || isInvalidStoredOverride(draft) ? defaultDraftValue(field) : draft;
}

function formattedSettingDefault(field: SyncSourceConfigField): string {
  if (field.default === undefined) return "";
  if (field.type === "boolean") return field.default ? "On" : "Off";
  if (field.type === "string-list") {
    return field.default.length === 0 ? "None" : field.default.join(", ");
  }
  return String(field.default);
}

function settingDescription(
  field: SyncSourceConfigField,
  draft: ConfigurationDraftValue
): JSX.Element | undefined {
  if (!hasSettingDefault(field)) return field.description;
  const defaultLabel = draft === null
    ? "Using default, "
    : isInvalidStoredOverride(draft)
      ? "Invalid stored override · Default is "
      : "Default is ";
  return (
    <>
      {field.description}
      <span class="text-muted-foreground/80">
        {field.description ? " · " : ""}{defaultLabel}
        <span class="font-mono text-foreground/80">{formattedSettingDefault(field)}</span>
      </span>
    </>
  );
}

function canRemoveSettingOverride(field: SyncSourceConfigField): boolean {
  return hasSettingDefault(field) || field.required !== true;
}

function settingDefaultActionLabel(field: SyncSourceConfigField): string {
  return hasSettingDefault(field) ? "Use default" : "Remove override";
}

function draftFromSource(source: SyncSourceInfo): ConfigurationDraft {
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

function sourceFingerprint(source: SyncSourceInfo): string {
  return JSON.stringify({
    name: source.name,
    enabled: source.enabled,
    interval: source.interval,
    settings: source.settings,
    settingsSchema: source.settingsSchema,
  });
}

function settingValueForPatch(
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

function numberSettingError(
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

function settingValuesEqual(
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

function selectSegments(options: string[], stored: string): { value: string; label: string }[] {
  const values = stored !== "" && !options.includes(stored) ? [...options, stored] : options;
  return values.map((value) => ({ value, label: value }));
}

function changeError(error: unknown): string | null {
  return typeof error === "string" ? error : null;
}

function hasDraftValue(field: SyncSourceConfigField, value: ConfigurationDraftValue): boolean {
  if (field.type === "boolean") return true;
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

function stringDraft(field: SyncSourceConfigField, value: ConfigurationDraftValue): string {
  const effective = effectiveDraftValue(field, value);
  return typeof effective === "string" ? effective : "";
}

function ConfigurationRow(props: {
  changed: boolean;
  source: string;
  align?: "center" | "start";
  children: JSX.Element;
}) {
  // Keep the field subtree mounted while its reactive bindings update.
  const content = untrack(() => props.children);
  return (
    <div
      class={`relative grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-[minmax(12rem,1fr)_minmax(12rem,auto)] sm:gap-6 ${props.align === "start" ? "sm:items-start" : "sm:items-center"}`}
      style={getSourceColorStyle(props.source)}
    >
      <Show when={props.changed}>
        <span
          aria-hidden="true"
          class="absolute inset-y-2 left-0 w-0.5 rounded-r bg-[var(--source-color)]"
        />
      </Show>
      {content}
    </div>
  );
}

function SettingRowLabel(props: {
  label: string;
  description?: JSX.Element;
  showRequired: boolean;
  error: string | null;
  errorId?: string;
  for?: string;
}) {
  return (
    <div class="min-w-0">
      <Show
        when={props.for}
        fallback={<div class="text-sm font-medium">{props.label}</div>}
      >
        {(id) => <label class="text-sm font-medium" for={id()}>{props.label}</label>}
      </Show>
      <Show when={props.description || props.showRequired}>
        <div class="mt-0.5 text-xs text-muted-foreground">
          <Show when={props.description}>{(description) => <>{description()}</>}</Show>
          <Show when={props.showRequired}>
            <span class="text-muted-foreground/70">{props.description ? " · " : ""}Required</span>
          </Show>
        </div>
      </Show>
      <Show when={props.error}>
        {(message) => (
          <div id={props.errorId} role="alert" class="mt-1 text-xs text-destructive">
            {message()}
          </div>
        )}
      </Show>
    </div>
  );
}

function StagedToggle(props: {
  label: string;
  checked: boolean;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      aria-invalid={props.invalid || undefined}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      class="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      onClick={() => props.onChange(!props.checked)}
    >
      <span
        aria-hidden="true"
        class={`relative h-4 w-7 rounded-full transition-colors ${props.checked ? "bg-primary" : "bg-muted"}`}
      >
        <span
          class={`absolute left-0 top-0.5 h-3 w-3 rounded-full transition-transform motion-reduce:transition-none ${props.checked ? "translate-x-3.5 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground"}`}
        />
      </span>
      <span class="min-w-5 text-left">{props.checked ? "On" : "Off"}</span>
    </button>
  );
}

function RemoveOverrideButton(props: {
  label: string;
  fieldLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${props.label} for ${props.fieldLabel}`}
      class="text-xs text-muted-foreground underline-offset-2 transition-colors enabled:hover:text-foreground enabled:hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export default function SyncSourceConfigurationForm(props: SyncSourceConfigurationFormProps) {
  const updateMutation = useUpdateSyncSourceConfiguration();
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = createSignal<Partial<Record<ConfigurationFieldPath, string>>>({});
  const [activeSubmission, setActiveSubmission] = createSignal<ActiveSubmission | null>(null);
  const [baseline, setBaseline] = createSignal({
    source: props.source,
    fingerprint: sourceFingerprint(props.source),
    values: draftFromSource(props.source),
  });
  const source = () => baseline().source;
  const [sourceEpoch, setSourceEpoch] = createSignal(0);
  let nextSubmissionId = 0;
  const validFieldPaths = () => new Set<ConfigurationFieldPath>([
    "enabled",
    "interval",
    ...source().settingsSchema.map((field) => settingsFieldPath(field.key)),
  ]);

  const form = createForm(() => ({
    defaultValues: baseline().values,
    onSubmit: async ({ value }) => {
      const submittedSource = source();
      const epoch = sourceEpoch();
      setSubmitError(null);
      const patch = buildPatch(value, submittedSource);
      if (Object.keys(patch).length === 0) {
        reseed(submittedSource);
        return;
      }

      try {
        const updated = await updateMutation.mutateAsync({ source: submittedSource.name, patch });
        if (epoch !== sourceEpoch()) return;
        reseed(updated);
      } catch (error) {
        if (epoch !== sourceEpoch()) return;
        if (
          error instanceof SyncSourceConfigurationError &&
          error.field !== null &&
          validFieldPaths().has(error.field as ConfigurationFieldPath)
        ) {
          setFieldError(error.field as ConfigurationFieldPath, error.message);
        } else {
          setSubmitError(error instanceof Error ? error.message : "Failed to save configuration");
        }
      }
    },
  }));
  const isDefaultValue = form.useSelector((state) => state.isDefaultValue);
  const isSubmitting = form.useSelector((state) => state.isSubmitting);
  const dirtyCount = form.useSelector((state) =>
    Object.values(state.fieldMeta).filter((meta) => meta && !meta.isDefaultValue).length
  );
  const canUseSourceDefaults = form.useSelector((state) =>
    state.values.interval !== "" ||
    source().settingsSchema.some(
      (field) => hasSettingDefault(field) && state.values.settings[field.key] !== null
    )
  );
  const isCurrentSubmissionPending = () => activeSubmission()?.sourceEpoch === sourceEpoch();
  const isCurrentBusy = () => isSubmitting() || isCurrentSubmissionPending();

  function reseed(source: SyncSourceInfo) {
    const values = draftFromSource(source);
    setBaseline({
      source,
      fingerprint: sourceFingerprint(source),
      values,
    });
    setSubmitError(null);
    setServerFieldErrors({});
    form.reset(values);
  }

  function fieldChanged(path: ConfigurationFieldPath): boolean {
    return form.getFieldMeta(path)?.isDefaultValue === false;
  }

  function setFieldError(path: ConfigurationFieldPath, message: string | undefined) {
    setServerFieldErrors((previous) => {
      const next = { ...previous };
      if (message === undefined) delete next[path];
      else next[path] = message;
      return next;
    });
  }

  function clearServerError(path: ConfigurationFieldPath) {
    setSubmitError(null);
    setFieldError(path, undefined);
  }

  function stageSourceDefaults() {
    form.setFieldValue("interval", "");
    clearServerError("interval");
    for (const field of source().settingsSchema) {
      if (!hasSettingDefault(field)) continue;
      const path = settingsFieldPath(field.key);
      form.setFieldValue(path, null);
      clearServerError(path);
    }
  }

  function buildPatch(values: ConfigurationDraft, source: SyncSourceInfo): SyncSourceConfigurationPatch {
    const patch: SyncSourceConfigurationPatch = {};
    if (fieldChanged("enabled") && values.enabled !== source.enabled) {
      patch.enabled = values.enabled;
    }

    if (fieldChanged("interval")) {
      const interval = values.interval.trim() === "" ? null : values.interval.trim();
      if (interval !== source.interval) patch.interval = interval;
    }

    const settings: SyncSourceSettingsPatch = {};
    for (const field of source.settingsSchema) {
      const path = settingsFieldPath(field.key);
      if (!fieldChanged(path)) continue;
      const draft = values.settings[field.key];
      if (draft === undefined) {
        throw new Error(`Missing configuration draft for ${path}`);
      }
      const value = settingValueForPatch(field, draft);
      if (!settingValuesEqual(value, source.settings[field.key])) {
        settings[field.key] = value;
      }
    }
    if (Object.keys(settings).length > 0) patch.settings = settings;
    return patch;
  }

  createEffect(on(
    () => [props.source.name, sourceFingerprint(props.source), isDefaultValue(), isSubmitting()] as const,
    ([sourceName, fingerprint, defaultValue, submitting]) => {
      if (sourceName !== baseline().source.name) {
        setSourceEpoch((epoch) => epoch + 1);
        reseed(props.source);
        return;
      }
      if (fingerprint !== baseline().fingerprint && defaultValue && !submitting) {
        reseed(props.source);
      }
    }
  ));

  useBeforeLeave((event) => {
    if (isDefaultValue() || event.defaultPrevented) return;
    event.preventDefault();
    if (window.confirm("Discard unsaved configuration changes?")) {
      event.retry(true);
    }
  });

  createEffect(() => {
    if (isDefaultValue()) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", handleBeforeUnload));
  });

  return (
    <form
      aria-label="Source configuration"
      class="overflow-clip rounded-lg border border-border bg-card"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (activeSubmission() !== null) return;
        const submission: ActiveSubmission = {
          id: ++nextSubmissionId,
          sourceEpoch: sourceEpoch(),
        };
        setActiveSubmission(submission);
        void form.handleSubmit()
          .finally(() => {
            setActiveSubmission((current) => current?.id === submission.id ? null : current);
          })
          .catch(() => {});
      }}
    >
      <div class="flex min-h-11 items-center gap-3 border-b border-border px-4 py-2.5">
        <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Configuration
        </div>
        <span class="h-px flex-1 bg-border" />
        <Show when={dirtyCount() > 0}>
          <span role="status" class="text-xs text-muted-foreground">
            <span class="font-mono text-foreground">{dirtyCount()}</span> unsaved {dirtyCount() === 1 ? "change" : "changes"}
          </span>
        </Show>
      </div>

      <div class="divide-y divide-border">
        <form.Field name="enabled">
          {(field) => (
            <ConfigurationRow changed={!field().state.meta.isDefaultValue} source={source().name}>
              <SettingRowLabel
                label="Automatic sync"
                description={field().state.value
                  ? "Runs on the schedule below."
                  : "Paused — no syncs will run until re-enabled."}
                showRequired={false}
                error={serverFieldErrors().enabled ?? null}
                errorId="sync-error-enabled"
              />
              <div class="sm:justify-self-end">
                <StagedToggle
                  label="Automatic sync"
                  checked={field().state.value}
                  disabled={isCurrentBusy()}
                  invalid={serverFieldErrors().enabled !== undefined}
                  describedBy={serverFieldErrors().enabled === undefined ? undefined : "sync-error-enabled"}
                  onChange={(value) => {
                    field().handleChange(value);
                    clearServerError("enabled");
                  }}
                />
              </div>
            </ConfigurationRow>
          )}
        </form.Field>

        <form.Field name="interval">
          {(field) => (
            <ConfigurationRow changed={!field().state.meta.isDefaultValue} source={source().name}>
              <SettingRowLabel
                for="sync-interval-input"
                label="Sync interval"
                description={field().state.value.trim() === ""
                  ? <>Using the default, <span class="font-mono">{source().defaultInterval}</span></>
                  : <>Custom · default is <span class="font-mono">{source().defaultInterval}</span></>}
                showRequired={false}
                error={serverFieldErrors().interval ?? null}
                errorId="sync-error-interval"
              />
              <div class="flex flex-wrap items-center gap-2 sm:justify-self-end">
                <input
                  id="sync-interval-input"
                  name={field().name}
                  class="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 sm:w-32"
                  value={field().state.value}
                  placeholder={source().defaultInterval}
                  disabled={isCurrentBusy()}
                  aria-invalid={serverFieldErrors().interval !== undefined || undefined}
                  aria-describedby={serverFieldErrors().interval === undefined ? undefined : "sync-error-interval"}
                  onBlur={field().handleBlur}
                  onInput={(event) => {
                    field().handleChange(event.currentTarget.value);
                    clearServerError("interval");
                  }}
                />
                <Show when={source().interval !== null && field().state.value !== ""}>
                  <RemoveOverrideButton
                    label="Use default"
                    fieldLabel="Sync interval"
                    disabled={isCurrentBusy()}
                    onClick={() => {
                      field().handleChange("");
                      clearServerError("interval");
                    }}
                  />
                </Show>
              </div>
            </ConfigurationRow>
          )}
        </form.Field>

        <For each={source().settingsSchema}>
          {(configField) => {
            const path = settingsFieldPath(configField.key);
            return (
              <form.Field
                name={path}
                validators={configField.type === "number"
                  ? { onChange: ({ value }) => numberSettingError(configField, value) }
                  : undefined}
              >
                {(field) => (
                  <Switch>
                    <Match when={configField.type === "boolean" ? configField : undefined}>
                      {(booleanField) => {
                        const checked = () => effectiveDraftValue(
                          booleanField(),
                          field().state.value
                        ) === true;
                        return (
                          <ConfigurationRow changed={!field().state.meta.isDefaultValue} source={source().name}>
                            <SettingRowLabel
                              label={booleanField().label}
                              description={settingDescription(
                                booleanField(),
                                field().state.value
                              )}
                              showRequired={false}
                              error={serverFieldErrors()[path] ?? null}
                              errorId={`sync-error-${booleanField().key}`}
                            />
                            <div class="flex flex-wrap items-center gap-2 sm:justify-self-end">
                              <StagedToggle
                                label={booleanField().label}
                                checked={checked()}
                                disabled={isCurrentBusy()}
                                invalid={serverFieldErrors()[path] !== undefined}
                                describedBy={serverFieldErrors()[path] === undefined
                                  ? undefined
                                  : `sync-error-${booleanField().key}`}
                                onChange={(value) => {
                                  field().handleChange(value);
                                  clearServerError(path);
                                }}
                              />
                              <Show when={field().state.value !== null && canRemoveSettingOverride(booleanField())}>
                                <RemoveOverrideButton
                                  label={settingDefaultActionLabel(booleanField())}
                                  fieldLabel={booleanField().label}
                                  disabled={isCurrentBusy()}
                                  onClick={() => {
                                    field().handleChange(null);
                                    clearServerError(path);
                                  }}
                                />
                              </Show>
                            </div>
                          </ConfigurationRow>
                        );
                      }}
                    </Match>
                    <Match when={configField.type === "select" ? configField : undefined}>
                      {(selectField) => {
                        const value = () => stringDraft(selectField(), field().state.value);
                        return (
                          <ConfigurationRow changed={!field().state.meta.isDefaultValue} source={source().name}>
                            <SettingRowLabel
                              label={selectField().label}
                              description={settingDescription(
                                selectField(),
                                field().state.value
                              )}
                              showRequired={selectField().required === true && !hasDraftValue(selectField(), value())}
                              error={serverFieldErrors()[path] ?? null}
                              errorId={`sync-error-${selectField().key}`}
                            />
                            <div class="flex max-w-full flex-wrap items-center gap-2 overflow-x-auto sm:justify-self-end">
                              <SegmentedControl
                                options={selectSegments(selectField().options, value())}
                                value={value()}
                                disabled={isCurrentBusy()}
                                label={selectField().label}
                                invalid={serverFieldErrors()[path] !== undefined}
                                describedBy={serverFieldErrors()[path] === undefined
                                  ? undefined
                                  : `sync-error-${selectField().key}`}
                                onChange={(nextValue) => {
                                  field().handleChange(nextValue);
                                  clearServerError(path);
                                }}
                              />
                              <Show when={field().state.value !== null && canRemoveSettingOverride(selectField())}>
                                <RemoveOverrideButton
                                  label={settingDefaultActionLabel(selectField())}
                                  fieldLabel={selectField().label}
                                  disabled={isCurrentBusy()}
                                  onClick={() => {
                                    field().handleChange(null);
                                    clearServerError(path);
                                  }}
                                />
                              </Show>
                            </div>
                          </ConfigurationRow>
                        );
                      }}
                    </Match>
                    <Match when={configField.type === "string-list" ? configField : undefined}>
                      {(listField) => {
                        const value = () => stringDraft(listField(), field().state.value);
                        return (
                          <ConfigurationRow
                            changed={!field().state.meta.isDefaultValue}
                            source={source().name}
                            align="start"
                          >
                            <SettingRowLabel
                              for={`sync-setting-${listField().key}`}
                              label={listField().label}
                              description={settingDescription(
                                listField(),
                                field().state.value
                              )}
                              showRequired={listField().required === true && !hasDraftValue(listField(), value())}
                              error={serverFieldErrors()[path] ?? null}
                              errorId={`sync-error-${listField().key}`}
                            />
                            <div class="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:justify-self-end">
                              <textarea
                                id={`sync-setting-${listField().key}`}
                                name={field().name}
                                class={`h-24 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 sm:w-64 ${field().state.value === null || isInvalidStoredOverride(field().state.value) ? "text-muted-foreground" : "text-foreground"}`}
                                value={value()}
                                placeholder={listField().placeholder ?? "One per line"}
                                disabled={isCurrentBusy()}
                                aria-invalid={serverFieldErrors()[path] !== undefined || undefined}
                                aria-describedby={serverFieldErrors()[path] === undefined
                                  ? undefined
                                  : `sync-error-${listField().key}`}
                                onBlur={field().handleBlur}
                                onInput={(event) => {
                                  field().handleChange(event.currentTarget.value);
                                  clearServerError(path);
                                }}
                              />
                              <Show when={field().state.value !== null && canRemoveSettingOverride(listField())}>
                                <RemoveOverrideButton
                                  label={settingDefaultActionLabel(listField())}
                                  fieldLabel={listField().label}
                                  disabled={isCurrentBusy()}
                                  onClick={() => {
                                    field().handleChange(null);
                                    clearServerError(path);
                                  }}
                                />
                              </Show>
                            </div>
                          </ConfigurationRow>
                        );
                      }}
                    </Match>
                    <Match when={configField.type === "string" || configField.type === "number"}>
                      {(() => {
                        const value = () => stringDraft(configField, field().state.value);
                        const error = () => serverFieldErrors()[path] ?? changeError(field().state.meta.errorMap.onChange);
                        return (
                          <ConfigurationRow changed={!field().state.meta.isDefaultValue} source={source().name}>
                            <SettingRowLabel
                              for={`sync-setting-${configField.key}`}
                              label={configField.label}
                              description={settingDescription(
                                configField,
                                field().state.value
                              )}
                              showRequired={configField.required === true && !hasDraftValue(configField, value())}
                              error={error()}
                              errorId={`sync-error-${configField.key}`}
                            />
                            <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-self-end">
                              <input
                                id={`sync-setting-${configField.key}`}
                                name={field().name}
                                inputmode={configField.type === "number"
                                  ? (configField.integer ? "numeric" : "decimal")
                                  : undefined}
                                class={`${configField.type === "number" ? "font-mono sm:w-32" : "sm:w-64"} w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${field().state.value === null || isInvalidStoredOverride(field().state.value) ? "text-muted-foreground" : "text-foreground"}`}
                                value={value()}
                                placeholder={configField.placeholder ?? ""}
                                disabled={isCurrentBusy()}
                                aria-invalid={error() !== null || undefined}
                                aria-describedby={error() === null ? undefined : `sync-error-${configField.key}`}
                                onBlur={field().handleBlur}
                                onInput={(event) => {
                                  field().handleChange(event.currentTarget.value);
                                  clearServerError(path);
                                }}
                              />
                              <Show when={field().state.value !== null && canRemoveSettingOverride(configField)}>
                                <RemoveOverrideButton
                                  label={settingDefaultActionLabel(configField)}
                                  fieldLabel={configField.label}
                                  disabled={isCurrentBusy()}
                                  onClick={() => {
                                    field().handleChange(null);
                                    clearServerError(path);
                                  }}
                                />
                              </Show>
                            </div>
                          </ConfigurationRow>
                        );
                      })()}
                    </Match>
                  </Switch>
                )}
              </form.Field>
            );
          }}
        </For>
      </div>

      <div class="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card/95 px-4 py-3 backdrop-blur-sm">
        <div class="mr-auto flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            class="rounded-sm px-2 py-1.5 text-sm text-primary/90 transition-colors enabled:hover:bg-primary/10 enabled:hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground disabled:opacity-50"
            disabled={!canUseSourceDefaults() || isCurrentBusy()}
            onClick={stageSourceDefaults}
          >
            Use source defaults
          </button>
          <Show when={submitError()}>
            {(message) => <div role="alert" class="text-xs text-destructive">{message()}</div>}
          </Show>
        </div>
        <button
          type="reset"
          class="rounded-sm px-3 py-1.5 text-sm text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={isDefaultValue() || isCurrentBusy()}
          onClick={(event) => {
            event.preventDefault();
            reseed(props.source);
          }}
        >
          Discard changes
        </button>
        <button
          type="submit"
          class="rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={isDefaultValue() || activeSubmission() !== null}
        >
          <Show when={!isCurrentSubmissionPending()} fallback={<span class="animate-pulse">Saving changes...</span>}>
            Save changes
          </Show>
        </button>
      </div>
    </form>
  );
}

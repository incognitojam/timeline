type MergeableObject = Record<string, unknown>;

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object
    ? T[P] extends Array<unknown>
      ? T[P] // Arrays are not deep-partialed (replaced wholesale)
      : DeepPartial<T[P]> | null // Allow null to replace objects
    : T[P];
};

function isMergeableObject(value: unknown): value is MergeableObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as Array<Extract<keyof T, string>>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue !== undefined && isMergeableObject(sourceValue) && isMergeableObject(targetValue)) {
      (result as unknown as MergeableObject)[key] = deepMerge(
        targetValue as unknown as MergeableObject,
        sourceValue as unknown as MergeableObject
      ) as unknown;
      continue;
    }

    if (sourceValue !== undefined) {
      (result as unknown as MergeableObject)[key] = sourceValue as unknown;
    }
  }

  return result;
}


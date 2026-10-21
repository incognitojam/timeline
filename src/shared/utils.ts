export function filterMap<T, U>(arr: T[], fn: (item: T) => U | null | undefined): U[] {
  const result: U[] = [];
  for (const item of arr) {
    const v = fn(item);
    if (v != null) result.push(v);
  }
  return result;
}

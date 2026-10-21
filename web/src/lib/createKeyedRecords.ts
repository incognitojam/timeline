import { batch, createComputed, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";

export interface KeyedRecord<K, T> {
  key: K;
  value: Accessor<T>;
}

interface MutableKeyedRecord<K, T> extends KeyedRecord<K, T> {
  setValue: Setter<T>;
}

/**
 * Reconciles derived values by a semantic key while exposing each latest value
 * through an accessor. Solid's reference-keyed For can retain the record (and
 * therefore its mounted subtree) even when the derived value is rebuilt.
 */
export function createKeyedRecords<T, K>(
  source: Accessor<readonly T[]>,
  keyFor: (value: T) => K,
): Accessor<readonly KeyedRecord<K, T>[]> {
  const records = new Map<K, MutableKeyedRecord<K, T>>();
  const [list, setList] = createSignal<readonly KeyedRecord<K, T>[]>([]);

  createComputed(() => {
    const seen = new Set<K>();
    const updates: Array<readonly [MutableKeyedRecord<K, T>, T]> = [];
    const next = source().map((value) => {
      const key = keyFor(value);
      if (seen.has(key)) throw new Error(`Duplicate keyed record: ${String(key)}`);
      seen.add(key);
      const existing = records.get(key);
      if (existing) {
        updates.push([existing, value]);
        return existing;
      }

      const [recordValue, setRecordValue] = createSignal(value);
      const record: MutableKeyedRecord<K, T> = {
        key,
        value: recordValue,
        setValue: setRecordValue,
      };
      records.set(key, record);
      return record;
    });

    batch(() => {
      for (const [record, value] of updates) record.setValue(() => value);
      for (const key of records.keys()) {
        if (!seen.has(key)) records.delete(key);
      }
      setList(next);
    });
  });

  onCleanup(() => records.clear());
  return list;
}

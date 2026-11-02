/**
 * Deterministic pseudo-random numbers for the synthetic seed.
 *
 * Each source draws from its own stream, derived from a label, so changing
 * how much one source generates never reshuffles another source's data.
 */

/** FNV-1a: a stable 32-bit hash used to derive per-label seeds. */
function hash32(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === "string" ? hash32(seed) : seed >>> 0;
  }

  /** Uniform float in [0, 1) (mulberry32). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick called with an empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick using relative weights. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    const last = items.at(-1);
    if (!last) throw new Error("Rng.weighted called with an empty list");
    return last[0];
  }

  /** Normally distributed value (Box-Muller). */
  normal(mean: number, sd: number): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Poisson-distributed count, for "about N per day" volumes. */
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** `count` distinct items. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, count);
  }

  /** Hex string of `length` characters, for synthetic ids and hashes. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += Math.floor(this.next() * 16).toString(16);
    return out;
  }

  /** RFC 4122-shaped v4 UUID. */
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[this.int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /** Decimal digit string, for snowflake-like numeric ids. */
  digits(length: number): string {
    let out = String(this.int(1, 9));
    while (out.length < length) out += String(this.int(0, 9));
    return out;
  }
}

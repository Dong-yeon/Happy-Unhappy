// 난수 주입용. core의 모든 랜덤은 Rng를 인자로 받는다 (스펙 §4.1.1 "난수").

/** [0, 1) 균등 난수 */
export type Rng = () => number;

/** 상태를 저장·복원할 수 있는 Rng (저장/복원 후에도 같은 난수열, 스펙 §5.8-2) */
export interface SeededRng extends Rng {
  getState(): number;
  setState(n: number): void;
}

/** 시드 고정 PRNG (mulberry32). 상태 = 32비트 정수 하나 */
export function mulberry32(seed: number): SeededRng {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as SeededRng;
  next.getState = () => a;
  next.setState = (n: number) => {
    a = n >>> 0;
  };
  return next;
}

/** 새 일생의 시드 (?seed= 없을 때). 32비트 부호 없는 정수 */
export function randomSeed(source: () => number): number {
  return Math.floor(source() * 4294967296) >>> 0;
}

/** `?seed=` 값 → 정수 시드. 없거나 잘못되면 null */
export function parseSeed(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** 0 ≤ i < n 정수 */
export function randInt(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** 가중치 비례 선택. 가중치 합이 0 이하면 예외 */
export function weightedPick<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((s, it) => s + Math.max(0, weight(it)), 0);
  if (!(total > 0)) throw new Error('가중치 합이 0');
  let r = rng() * total;
  for (const it of items) {
    const w = Math.max(0, weight(it));
    if (r < w) return it;
    r -= w;
  }
  // 부동소수 오차 대비: 마지막 양수 가중치 항목
  for (let i = items.length - 1; i >= 0; i--) if (weight(items[i]) > 0) return items[i];
  throw new Error('unreachable');
}

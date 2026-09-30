import { describe, expect, it } from 'vitest';
import {
  WILDCARD,
  applyDrop,
  createGrid,
  emptyIndices,
  enqueueReturn,
  flushReturnQueue,
  isPreset,
  pickChain,
  pickEmpty,
  releaseAt,
  releaseValue,
  resolveDrop,
  resolveGridSize,
  spawnBlock,
  spawnCost,
  toCell,
  toIndex,
  type Grid,
  type Piece,
} from '../src/core/grid';
import { mulberry32 } from '../src/core/rng';
import { PORTAL, REGION, cellAt, dropTarget } from '../src/scenes/layout';

const MAX = 3;
const presets: [number, number][] = [[4, 4], [5, 4], [6, 4]];

let nextId = 1;
function pc(chain: string, tier: number, bornAt = 0): Piece {
  return { id: nextId++, chain, tier, bornAt };
}
function wild(bornAt = 0): Piece {
  return { id: nextId++, chain: WILDCARD, tier: 0, bornAt };
}
/** 1행 그리드에 조각을 순서대로 채운다 */
function row(...cells: (Piece | null)[]): Grid {
  const g = createGrid({ cols: cells.length, rows: 1 }, MAX);
  g.cells = [...cells];
  return g;
}

const DOG = 'companion_animal';
const BLANKET = 'comfort_object';

describe('createGrid', () => {
  it.each(presets)('%i×%i 빈 그리드', (cols, rows) => {
    const g = createGrid({ cols, rows }, MAX);
    expect(g.cells).toHaveLength(cols * rows);
    expect(g.cells.every((c) => c === null)).toBe(true);
    expect(g.maxTier).toBe(MAX);
  });

  it('잘못된 크기는 거부', () => {
    expect(() => createGrid({ cols: 0, rows: 4 }, MAX)).toThrow();
    expect(() => createGrid({ cols: 4.5, rows: 4 }, MAX)).toThrow();
  });
});

describe('좌표 변환', () => {
  const size = { cols: 5, rows: 4 };

  it('index ↔ (col,row) 왕복, 행 우선', () => {
    for (let i = 0; i < 20; i++) {
      const { col, row: r } = toCell(size, i);
      expect(toIndex(size, col, r)).toBe(i);
    }
    expect(toCell(size, 5)).toEqual({ col: 0, row: 1 });
  });

  it('범위 밖은 예외', () => {
    expect(() => toIndex(size, 5, 0)).toThrow(RangeError);
    expect(() => toCell(size, 20)).toThrow(RangeError);
  });
});

describe('resolveGridSize', () => {
  const fallback = { cols: 5, rows: 4 };
  it('프리셋에 있는 요청만 채택', () => {
    expect(resolveGridSize(presets, fallback, { cols: 6, rows: 4 })).toEqual({ cols: 6, rows: 4 });
    expect(resolveGridSize(presets, fallback, { cols: 3, rows: 3 })).toEqual(fallback);
    expect(resolveGridSize(presets, fallback, null)).toEqual(fallback);
    expect(isPreset(presets, { cols: 4, rows: 5 })).toBe(false);
  });
});

// ── §4.1.1 드래그 결과표: 한 행씩 ──
describe('resolveDrop / applyDrop — §4.1.1 결과표', () => {
  it('조각 → 빈 칸: 이동', () => {
    const a = pc(DOG, 1, 5);
    const g = row(a, null);
    expect(resolveDrop(g, 0, 1)).toBe('move');
    expect(applyDrop(g, 0, 1)).toBe('move');
    expect(g.cells).toEqual([null, a]);
  });

  it('조각 → 같은 체인·같은 단계(<3): 머지, B 칸 단계 +1, A 칸 비움', () => {
    const a = pc(DOG, 1);
    const b = pc(DOG, 1);
    const g = row(a, b);
    expect(resolveDrop(g, 0, 1)).toBe('merge');
    applyDrop(g, 0, 1);
    expect(g.cells[0]).toBeNull();
    expect(g.cells[1]).toMatchObject({ chain: DOG, tier: 2, id: b.id });
  });

  it('2단계끼리 머지 → 3단계(영웅)', () => {
    const g = row(pc(BLANKET, 2), pc(BLANKET, 2));
    applyDrop(g, 0, 1);
    expect(g.cells[1]).toMatchObject({ chain: BLANKET, tier: 3 });
  });

  it('조각 → 같은 체인·같은 단계(=3): 자리 교환', () => {
    const a = pc(DOG, 3);
    const b = pc(DOG, 3);
    const g = row(a, b);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([b, a]);
  });

  it('조각 → 다른 체인: 자리 교환', () => {
    const a = pc(DOG, 1);
    const b = pc(BLANKET, 1);
    const g = row(a, b);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([b, a]);
  });

  it('조각 → 다른 단계: 자리 교환', () => {
    const a = pc(DOG, 1);
    const b = pc(DOG, 2);
    const g = row(a, b);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([b, a]);
  });

  it('와일드카드 → 조각(<3): 머지, B 칸 조각 단계 +1, 와일드카드 소모', () => {
    const w = wild();
    const b = pc(DOG, 2);
    const g = row(w, b);
    expect(resolveDrop(g, 0, 1)).toBe('merge');
    applyDrop(g, 0, 1);
    expect(g.cells[0]).toBeNull();
    expect(g.cells[1]).toMatchObject({ chain: DOG, tier: 3, id: b.id });
  });

  it('조각(<3) → 와일드카드: 머지, B 칸에 A 조각 단계 +1 (방향 무관 같은 결과)', () => {
    const a = pc(BLANKET, 1);
    const w = wild();
    const g = row(a, w);
    expect(resolveDrop(g, 0, 1)).toBe('merge');
    applyDrop(g, 0, 1);
    expect(g.cells[0]).toBeNull();
    expect(g.cells[1]).toMatchObject({ chain: BLANKET, tier: 2, id: a.id });

    // 반대 방향과 결과 비교 (id 제외)
    const g2 = row(wild(), pc(BLANKET, 1));
    applyDrop(g2, 0, 1);
    expect({ ...g2.cells[1], id: 0 }).toEqual({ ...g.cells[1], id: 0 });
  });

  it('와일드카드 → 3단계 조각: 자리 교환', () => {
    const w = wild();
    const b = pc(DOG, 3);
    const g = row(w, b);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([b, w]);
  });

  it('와일드카드 → 와일드카드: 자리 교환', () => {
    const w1 = wild();
    const w2 = wild();
    const g = row(w1, w2);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([w2, w1]);
  });

  it('3단계 조각 → 와일드카드: 자리 교환', () => {
    const a = pc(BLANKET, 3);
    const w = wild();
    const g = row(a, w);
    expect(resolveDrop(g, 0, 1)).toBe('swap');
    applyDrop(g, 0, 1);
    expect(g.cells).toEqual([w, a]);
  });

  it('자기 자신 칸: 원위치(none)', () => {
    const a = pc(DOG, 1);
    const g = row(a, null);
    expect(resolveDrop(g, 0, 0)).toBe('none');
    expect(applyDrop(g, 0, 0)).toBe('none');
    expect(g.cells).toEqual([a, null]);
  });

  it('그리드 밖 무효 영역: 원위치(none)', () => {
    const a = pc(DOG, 1);
    const g = row(a, null);
    expect(resolveDrop(g, 0, null)).toBe('none');
    expect(resolveDrop(g, 0, 99)).toBe('none');
    applyDrop(g, 0, null);
    expect(g.cells).toEqual([a, null]);
  });

  it('포탈·레인 (M3 이전): 그리드 칸이 아니므로 원위치(none)', () => {
    const g = createGrid({ cols: 5, rows: 4 }, MAX);
    const a = pc(DOG, 1);
    g.cells[0] = a;
    for (const [x, y] of [
      [PORTAL.happy.x, PORTAL.happy.y],
      [PORTAL.unhappy.x, PORTAL.unhappy.y],
      [20, REGION.defenseLane.y + 50],
      [340, REGION.abyssLane.y + 50],
    ]) {
      expect(dropTarget(g, x, y).kind).toBe('summon');
      expect(cellAt(g.cols, g.rows, x, y)).toBeNull();
      expect(applyDrop(g, 0, null)).toBe('none');
    }
    expect(g.cells[0]).toBe(a);
  });

  it('빈 칸에서 시작한 드래그는 none', () => {
    const g = row(null, pc(DOG, 1));
    expect(resolveDrop(g, 0, 1)).toBe('none');
  });

  it('resolveDrop은 grid를 바꾸지 않는다', () => {
    const g = row(pc(DOG, 1), pc(DOG, 1));
    const before = structuredClone(g);
    resolveDrop(g, 0, 1);
    expect(g).toEqual(before);
  });
});

describe('bornAt 규칙', () => {
  it('머지 결과 = 재료 중 더 이른 값 (어느 쪽이 이르든)', () => {
    const g1 = row(pc(DOG, 1, 10), pc(DOG, 1, 3));
    applyDrop(g1, 0, 1);
    expect(g1.cells[1]!.bornAt).toBe(3);

    const g2 = row(pc(DOG, 1, 2), pc(DOG, 1, 8));
    applyDrop(g2, 0, 1);
    expect(g2.cells[1]!.bornAt).toBe(2);
  });

  it('와일드카드 머지도 더 이른 값 (양방향)', () => {
    const g1 = row(wild(1), pc(DOG, 1, 9));
    applyDrop(g1, 0, 1);
    expect(g1.cells[1]!.bornAt).toBe(1);

    const g2 = row(pc(DOG, 1, 9), wild(4));
    applyDrop(g2, 0, 1);
    expect(g2.cells[1]!.bornAt).toBe(4);
  });

  it('이동·교환은 bornAt 유지', () => {
    const g = row(pc(DOG, 1, 7), null, pc(BLANKET, 2, 11));
    applyDrop(g, 0, 1); // move
    expect(g.cells[1]!.bornAt).toBe(7);
    applyDrop(g, 1, 2); // swap
    expect(g.cells[1]!.bornAt).toBe(11);
    expect(g.cells[2]!.bornAt).toBe(7);
  });
});

describe('조각 생성 규칙', () => {
  it('spawnCost = base + step × 오늘 생성 횟수', () => {
    const cfg = { spawnCostBase: 10, spawnCostStep: 2 };
    expect(spawnCost(cfg, 0)).toBe(10);
    expect(spawnCost(cfg, 3)).toBe(16);
  });

  it('비활성 조건 1: 기쁨 < 비용 → noJoy', () => {
    const g = row(null, null);
    expect(spawnBlock(g, 9, 10)).toBe('noJoy');
    expect(spawnBlock(g, 10, 10)).toBeNull();
  });

  it('비활성 조건 2: 빈 칸 0 → full (기쁨이 부족해도 full 우선)', () => {
    const g = row(pc(DOG, 1), pc(DOG, 2));
    expect(spawnBlock(g, 100, 10)).toBe('full');
    expect(spawnBlock(g, 0, 10)).toBe('full');
  });

  it('pickEmpty: 빈 칸 중에서만, 시드 고정이면 재현', () => {
    const g = row(pc(DOG, 1), null, pc(DOG, 1), null, null);
    const picks = Array.from({ length: 50 }, () => pickEmpty(mulberry32(7), g));
    expect(new Set(picks).size).toBe(1); // 같은 시드 → 같은 결과
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) expect([1, 3, 4]).toContain(pickEmpty(rng, g));
    expect(pickEmpty(rng, row(pc(DOG, 1)))).toBeNull();
  });

  it('pickChain: spawnWeight 비례, 0이면 안 나옴', () => {
    const rng = mulberry32(1);
    const chains = [
      { id: DOG, weight: 3 },
      { id: BLANKET, weight: 1 },
      { id: 'never', weight: 0 },
    ];
    const count: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const c = pickChain(rng, chains);
      count[c] = (count[c] ?? 0) + 1;
    }
    expect(count.never).toBeUndefined();
    expect(count[DOG] / 4000).toBeGreaterThan(0.7);
    expect(count[DOG] / 4000).toBeLessThan(0.8);
  });
});

describe('놓아주기', () => {
  it('환급 = releaseRefund × 단계, 칸 비움', () => {
    const g = row(pc(DOG, 1), pc(DOG, 2), pc(BLANKET, 3));
    expect(releaseAt(g, 0, 4)?.refund).toBe(4);
    expect(releaseAt(g, 1, 4)?.refund).toBe(8);
    expect(releaseAt(g, 2, 4)?.refund).toBe(12);
    expect(emptyIndices(g)).toEqual([0, 1, 2]);
  });

  it('releaseValue: 미리보기 환급액, 와일드카드는 null', () => {
    expect(releaseValue(pc(DOG, 2), 4)).toBe(8);
    expect(releaseValue(wild(), 4)).toBeNull();
  });

  it('와일드카드·빈 칸은 무시', () => {
    const w = wild();
    const g = row(w, null);
    expect(releaseAt(g, 0, 4)).toBeNull();
    expect(releaseAt(g, 1, 4)).toBeNull();
    expect(g.cells[0]).toBe(w);
  });
});

describe('귀환 대기열 (빈 칸은 rng로 선택, D-019)', () => {
  const CAP = 2;

  it('빈 칸이 있으면 즉시 배치 (빈 칸 중 하나)', () => {
    const g = row(pc(DOG, 1), null, null);
    const q: Piece[] = [];
    const p = pc(DOG, 2);
    const r = enqueueReturn(g, q, p, CAP, mulberry32(1));
    expect(r.queued).toBe(false);
    expect(r.lost).toBe(0);
    expect([1, 2]).toContain(r.placedAt);
    expect(g.cells[r.placedAt!]).toBe(p);
    expect(q).toEqual([]);
  });

  it('빈 칸이 없으면 대기', () => {
    const g = row(pc(DOG, 1));
    const q: Piece[] = [];
    expect(enqueueReturn(g, q, pc(DOG, 2), CAP, mulberry32(1))).toEqual({ placedAt: null, queued: true, lost: 0 });
    expect(q).toHaveLength(1);
  });

  it('대기열이 상한이면 소실 + 소실 수 1', () => {
    const g = row(pc(DOG, 1));
    const q: Piece[] = [];
    const rng = mulberry32(1);
    enqueueReturn(g, q, pc(DOG, 2), CAP, rng);
    enqueueReturn(g, q, pc(DOG, 2), CAP, rng);
    const r = enqueueReturn(g, q, pc(DOG, 3), CAP, rng);
    expect(r).toEqual({ placedAt: null, queued: false, lost: 1 });
    expect(q).toHaveLength(CAP);
  });

  it('flush: 대기열 앞에서부터 배치, 배치 칸은 빈 칸 중에서', () => {
    const g = row(pc(DOG, 1), pc(DOG, 1), pc(DOG, 1));
    const q: Piece[] = [];
    const rng = mulberry32(5);
    const first = pc(BLANKET, 2);
    const second = pc(BLANKET, 3);
    const third = wild();
    for (const p of [first, second, third]) enqueueReturn(g, q, p, 5, rng);

    g.cells[2] = null;
    g.cells[0] = null;
    const placed = flushReturnQueue(g, q, rng);
    expect([...placed].sort()).toEqual([0, 2]);
    expect(g.cells[placed[0]]).toBe(first);
    expect(g.cells[placed[1]]).toBe(second);
    expect(q).toEqual([third]);
  });

  it('대기 중인 조각이 있으면 새로 온 조각보다 먼저 배치', () => {
    const g = row(pc(DOG, 1));
    const q: Piece[] = [];
    const rng = mulberry32(1);
    const waiting = pc(BLANKET, 2);
    enqueueReturn(g, q, waiting, CAP, rng);
    g.cells[0] = null; // flush 없이 칸이 빈 상태
    const late = pc(DOG, 2);
    const r = enqueueReturn(g, q, late, CAP, rng);
    expect(g.cells[0]).toBe(waiting);
    expect(r.queued).toBe(true);
    expect(q).toEqual([late]);
  });

  /** 4×4 빈 그리드에 귀환 3개 → 배치 칸 목록 */
  function placeThree(seed: number): number[] {
    const g = createGrid({ cols: 4, rows: 4 }, MAX);
    const q: Piece[] = [];
    const rng = mulberry32(seed);
    return [0, 1, 2].map(() => enqueueReturn(g, q, pc(DOG, 2), CAP, rng).placedAt!);
  }

  it('시드 고정이면 배치 칸이 결정적 (enqueue·flush 모두)', () => {
    expect(placeThree(42)).toEqual(placeThree(42));

    const flushRun = (seed: number) => {
      const g = createGrid({ cols: 4, rows: 4 }, MAX);
      g.cells.fill(pc(DOG, 1));
      const q: Piece[] = [];
      const rng = mulberry32(seed);
      for (let i = 0; i < 3; i++) enqueueReturn(g, q, pc(DOG, 2), 5, rng);
      for (const i of [1, 6, 11, 14]) g.cells[i] = null;
      return flushReturnQueue(g, q, rng);
    };
    expect(flushRun(7)).toEqual(flushRun(7));
  });

  it('여러 시드에서 첫 빈 칸(0번)에만 몰리지 않는다', () => {
    const SEEDS = 400;
    const firstPlacement = Array.from({ length: SEEDS }, (_, s) => placeThree(s + 1)[0]);
    const atFirst = firstPlacement.filter((i) => i === 0).length;
    // 균등이면 1/16 ≈ 6%. 행 우선이었다면 100%
    expect(atFirst / SEEDS).toBeLessThan(0.15);
    expect(new Set(firstPlacement).size).toBe(16);
    // 좌우 반(열 0~1 / 2~3)도 한쪽으로 쏠리지 않음 (H1 편향)
    const left = firstPlacement.filter((i) => i % 4 < 2).length;
    expect(left / SEEDS).toBeGreaterThan(0.4);
    expect(left / SEEDS).toBeLessThan(0.6);
  });

  it('flush도 첫 빈 칸에만 몰리지 않는다', () => {
    const SEEDS = 400;
    const hits = Array.from({ length: SEEDS }, (_, s) => {
      const g = createGrid({ cols: 4, rows: 4 }, MAX);
      g.cells.fill(pc(DOG, 1));
      const q: Piece[] = [];
      const rng = mulberry32(s + 1);
      enqueueReturn(g, q, pc(DOG, 2), 5, rng);
      for (const i of [0, 5, 10, 15]) g.cells[i] = null;
      return flushReturnQueue(g, q, rng)[0];
    });
    expect(hits.filter((i) => i === 0).length / SEEDS).toBeLessThan(0.4);
    expect(new Set(hits)).toEqual(new Set([0, 5, 10, 15]));
  });
});

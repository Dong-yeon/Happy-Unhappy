// 연쇄 (D-073, §5.24-5): 손 머지 결과와 맞닿은 같은 체인·단계 조각을 이어 합침 → 단계마다 다시.
// 이어짐 · 최고 단계에서 끝 · 검증 실패 무시 · 자동 뭉침은 연쇄를 시작하지 않음 · 와일드카드 제외 · 보너스 계산 · 스키마
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { validateGameData } from '../src/data/validate';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BONE = 'bone';

/** 1-1 낮 (전투 중), 자동 뭉침·저절로 조각 끔 */
function game(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(data);
  d.balance.grid.autoMergeMaxTier = 0;
  d.balance.spawn.autoInterval = 9999;
  d.balance.spawn.killDropChance = 0;
  edit(d);
  const g = new GameState(d, { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize), 1);
  g.confirmDay();
  g.tick(0);
  g.grid.cells.fill(null);
  return g;
}

function put(g: GameState, index: number, chain: string, tier: number): number {
  const p = g.newPiece(chain, tier);
  g.grid.cells[index] = p;
  return p.id;
}

const chainEvents = (es: CoreEvent[]) => es.filter((e): e is Extract<CoreEvent, { type: 'chain' }> => e.type === 'chain');

describe('연쇄 (D-073)', () => {
  it('기본값: chainBonusPerStep 0.25, chainGap 6', () => {
    expect(data.balance.grid.chainBonusPerStep).toBe(0.25);
    expect(data.balance.grid.chainGap).toBe(6);
  });

  it('이어짐: 1+1 → 2, 맞닿은 2 → 3, 맞닿은 3 → 4 (3연쇄), 이어 합친 조각은 사라진다', () => {
    const g = game();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    const t2 = put(g, 2, DOG, 2);
    const t3 = put(g, 3, DOG, 3);
    put(g, 4, BONE, 2); // 다른 체인 (목록에 없음)
    expect(g.drop(0, 1, [t3, t2])).toBe('merge'); // 순서가 달라도 단계에 맞는 것을 고른다
    expect(g.grid.cells[1]).toMatchObject({ chain: DOG, tier: 4 });
    expect(g.grid.cells[2]).toBeNull();
    expect(g.grid.cells[3]).toBeNull();
    expect(g.grid.cells[4]).toMatchObject({ chain: BONE, tier: 2 });
    expect(g.attemptStats.merges).toBe(3);
    const [c] = chainEvents(g.tick(0));
    expect(c).toEqual({ type: 'chain', to: 1, cells: [2, 3], n: 3 });
    expect([g.chains, g.chainSteps]).toEqual([1, 2]);
  });

  it('한 단계에 짝이 여럿이면 넘긴 순서(가까운 것)대로 하나만, 나머지는 남는다', () => {
    const g = game();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    const near = put(g, 2, DOG, 2);
    const far = put(g, 3, DOG, 2);
    g.drop(0, 1, [near, far]);
    expect(g.grid.cells[1]).toMatchObject({ tier: 3 });
    expect(g.grid.cells[2]).toBeNull();
    expect(g.grid.cells[3]?.id).toBe(far);
  });

  it('최고 단계(5)에서 끝난다', () => {
    const g = game();
    put(g, 0, DOG, 4);
    put(g, 1, DOG, 4);
    const t5 = put(g, 2, DOG, 5);
    g.drop(0, 1, [t5]);
    expect(g.grid.cells[1]).toMatchObject({ tier: 5 });
    expect(g.grid.cells[2]?.id).toBe(t5); // 5단계끼리는 합쳐지지 않음
    expect(chainEvents(g.tick(0))).toHaveLength(0);
  });

  it('검증 실패(체인·단계 다름, 없는 id, 결과 자신)는 무시 → 보통 머지', () => {
    const g = game();
    put(g, 0, DOG, 1);
    const self = put(g, 1, DOG, 1);
    const wrongTier = put(g, 2, DOG, 3);
    const wrongChain = put(g, 3, BONE, 2);
    g.drop(0, 1, [999999, self, wrongTier, wrongChain]);
    expect(g.grid.cells[1]).toMatchObject({ tier: 2 });
    expect(g.grid.cells.filter(Boolean)).toHaveLength(3);
    expect(g.chains).toBe(0);
  });

  it('와일드카드: 와일드카드 머지는 연쇄를 시작하지 않고, 목록의 와일드카드도 이어 합치지 않는다', () => {
    const g = game();
    put(g, 0, WILDCARD, 0);
    put(g, 1, DOG, 1);
    const t2 = put(g, 2, DOG, 2);
    g.drop(0, 1, [t2]);
    expect(g.grid.cells[1]).toMatchObject({ tier: 2 });
    expect(g.grid.cells[2]?.id).toBe(t2);
    const h = game();
    put(h, 0, DOG, 1);
    put(h, 1, DOG, 1);
    const w = put(h, 2, WILDCARD, 0);
    h.drop(0, 1, [w]);
    expect(h.grid.cells[2]?.id).toBe(w);
    expect(h.chains).toBe(0);
  });

  it('자동 뭉침은 연쇄를 시작하지 않고, 연쇄 뒤에는 잠깐 쉰다', () => {
    const g = game((d) => (d.balance.grid.autoMergeMaxTier = 1));
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    put(g, 2, DOG, 2); // 자동 뭉침 결과(2)와 같은 단계지만 이어 합치지 않는다
    const es: CoreEvent[] = [];
    for (let k = 0; k < 3; k++) es.push(...g.tick(FIXED_DT));
    expect(es.some((e) => e.type === 'autoMerge')).toBe(true);
    expect(chainEvents(es)).toHaveLength(0);
    expect(g.grid.cells.filter((p) => p?.tier === 2)).toHaveLength(2);
    // 손 연쇄 뒤 자동 뭉침 타이머 = interval × n
    const h = game((d) => (d.balance.grid.autoMergeMaxTier = 1));
    put(h, 3, DOG, 2);
    put(h, 4, DOG, 2);
    const t3 = put(h, 5, DOG, 3);
    h.drop(3, 4, [t3]);
    expect(h.autoMergeTimer).toBeCloseTo(data.balance.grid.autoMergeInterval * 2, 9);
  });

  it('보너스: n연쇄면 각 단계 병사 능력치 × (1 + 0.25 × (n−1)), 연쇄 없으면 × 1', () => {
    const soldierHp = (g: GameState) => g.abyss.units.filter((u) => u.role === 'soldier').map((u) => u.maxHp);
    const plain = game();
    put(plain, 0, DOG, 1);
    put(plain, 1, DOG, 1);
    plain.drop(0, 1);
    const base = soldierHp(plain);
    expect(base).toHaveLength(1);
    const ch = game();
    put(ch, 0, DOG, 1);
    put(ch, 1, DOG, 1);
    const t2 = put(ch, 2, DOG, 2);
    ch.drop(0, 1, [t2]);
    const hp = soldierHp(ch);
    expect(hp).toHaveLength(2);
    expect(hp[0]).toBeCloseTo(base[0] * 1.25, 6); // 2연쇄 → × 1.25 (첫 단계도)
    const off = game((d) => (d.balance.grid.chainBonusPerStep = 0));
    put(off, 0, DOG, 1);
    put(off, 1, DOG, 1);
    const o2 = put(off, 2, DOG, 2);
    off.drop(0, 1, [o2]);
    expect(soldierHp(off)[0]).toBeCloseTo(base[0], 6);
  });
});

describe('스키마: grid.chainBonusPerStep · chainGap', () => {
  const errs = (edit: (g: Record<string, unknown>) => void): string[] => {
    const raw = structuredClone(rawGameData) as unknown as Parameters<typeof validateGameData>[0];
    edit((raw.balance as { grid: Record<string, unknown> }).grid);
    const r = validateGameData(raw);
    return r.ok ? [] : r.issues.map((e) => `${e.path}: ${e.reason}`);
  };
  it('지금 데이터는 통과', () => expect(errs(() => {})).toEqual([]));
  it('빠진 키·음수는 에러', () => {
    expect(errs((g) => delete g.chainBonusPerStep).join()).toContain('chainBonusPerStep');
    expect(errs((g) => delete g.chainGap).join()).toContain('chainGap');
    expect(errs((g) => (g.chainBonusPerStep = -1)).length).toBeGreaterThan(0);
  });
});

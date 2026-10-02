// 팀 교대 이어받기 (D-072, §5.24-2): 레인 팀이 바뀔 때 새 팀 체인이 아닌 조각을 회수 → 새 팀 스킬 게이지
// 회수 대상 · 와일드카드 제외 · 게이지 상한 · 비율 · 스키마
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { validateGameData } from '../src/data/validate';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const G = data.balance.grid;

/** 1-1, 영웅 전부 보유, 편성 지정 (장면 카드 앞). 자동 뭉침·저절로 조각 끔 */
function game(offense: string[][], defense: string[][], edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(data);
  d.balance.grid.autoMergeMaxTier = 0;
  d.balance.spawn.autoInterval = 9999;
  d.balance.spawn.killDropChance = 0;
  edit(d);
  const g = new GameState(d, { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize), 1);
  g.debugGrantAllHeroes();
  const r = g.setFormation({ offense, defense });
  if (!r.ok) throw new Error(r.reason);
  g.tick(0);
  return g;
}

function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}

const handovers = (es: CoreEvent[]) => es.filter((e): e is Extract<CoreEvent, { type: 'handover' }> => e.type === 'handover');

describe('팀 교대 이어받기 (D-072)', () => {
  it('기본값: handoverRatio 0.5, 단계 값 1/3/7/15/50', () => {
    expect(G.handoverRatio).toBe(0.5);
    expect(G.handoverTierValue).toEqual([1, 3, 7, 15, 50]);
  });

  it('낮 → 밤: 밤 팀 체인이 아닌 조각만 회수, 와일드카드·밤 팀 체인 조각은 남는다', () => {
    // 낮 = 삽살(bone), 밤 = 해태(bell)
    const g = game([['sapsal']], [['haetae']]);
    g.confirmDay();
    g.tick(0);
    g.grid.cells.fill(null);
    put(g, 0, 'bone', 1); // 회수 1
    put(g, 1, 'bone', 3); // 회수 7
    put(g, 2, 'bell', 2); // 남음
    put(g, 3, WILDCARD, 0); // 남음
    g.progressOf('haetae').gauge = 0;
    g.debugToNight();
    const hs = handovers(g.tick(0));
    expect(hs).toHaveLength(1);
    expect(hs[0].role).toBe('defense');
    expect(hs[0].cells).toEqual([0, 1]);
    expect(hs[0].amount).toBeCloseTo((1 + 7) * 0.5, 9);
    expect(g.grid.cells[0]).toBeNull();
    expect(g.grid.cells[1]).toBeNull();
    expect(g.grid.cells[2]).toMatchObject({ chain: 'bell', tier: 2 });
    expect(g.grid.cells[3]?.chain).toBe(WILDCARD);
    expect(g.progressOf('haetae').gauge).toBeCloseTo(4, 9);
  });

  it('여러 영웅이면 똑같이 나눠 더하고, 게이지 상한을 넘친 몫은 버린다', () => {
    const g = game([['sapsal']], [['haetae', 'nui']]);
    g.confirmDay();
    g.tick(0);
    g.grid.cells.fill(null);
    put(g, 0, 'bone', 5); // 50 × 0.5 = 25 → 둘이 12.5씩
    const max = g.skillOf('haetae').gauge;
    g.progressOf('haetae').gauge = max - 2;
    g.progressOf('nui').gauge = 0;
    g.debugToNight();
    const [h] = handovers(g.tick(0));
    expect(h.amount).toBeCloseTo(25, 9);
    expect(g.progressOf('haetae').gauge).toBe(max); // 넘친 10.5는 버림
    expect(g.progressOf('nui').gauge).toBeCloseTo(Math.min(g.skillOf('nui').gauge, 12.5), 9);
  });

  it('회수할 조각이 없으면 이벤트 없음 (같은 체인 팀 교대)', () => {
    const g = game([['sapsal']], [['sapsal'.replace('sapsal', 'orabi')]]);
    g.confirmDay();
    g.tick(0);
    g.grid.cells.fill(null);
    const orabiChain = g.heroDef('orabi').chain;
    put(g, 0, orabiChain, 2);
    put(g, 1, WILDCARD, 0);
    g.debugToNight();
    expect(handovers(g.tick(0))).toHaveLength(0);
    expect(g.grid.cells.filter(Boolean)).toHaveLength(2);
  });

  it('handoverRatio 0이면 조각은 회수되지만 게이지는 그대로', () => {
    const g = game([['sapsal']], [['haetae']], (d) => (d.balance.grid.handoverRatio = 0));
    g.confirmDay();
    g.tick(0);
    g.grid.cells.fill(null);
    put(g, 0, 'bone', 4);
    g.progressOf('haetae').gauge = 0;
    g.debugToNight();
    const [h] = handovers(g.tick(0));
    expect(h.cells).toEqual([0]);
    expect(h.amount).toBe(0);
    expect(g.progressOf('haetae').gauge).toBe(0);
  });
});

describe('스키마: grid.handoverRatio · handoverTierValue', () => {
  const errs = (edit: (g: Record<string, unknown>) => void): string[] => {
    const raw = structuredClone(rawGameData) as unknown as Parameters<typeof validateGameData>[0];
    edit((raw.balance as { grid: Record<string, unknown> }).grid);
    const r = validateGameData(raw);
    return r.ok ? [] : r.issues.map((e) => `${e.path}: ${e.reason}`);
  };
  it('지금 데이터는 통과', () => expect(errs(() => {})).toEqual([]));
  it('빠진 키·음수·길이 틀림은 에러', () => {
    expect(errs((g) => delete g.handoverRatio).join()).toContain('handoverRatio');
    expect(errs((g) => (g.handoverRatio = -0.1)).length).toBeGreaterThan(0);
    expect(errs((g) => (g.handoverTierValue = [1, 3, 7])).join()).toContain('handoverTierValue');
  });
});

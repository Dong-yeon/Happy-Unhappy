// 자동 뭉침 (D-070): autoMergeMaxTier 이하 같은 조각 한 쌍을 autoMergeInterval마다 core가 합친다.
// 쌍 고르는 규칙 · 간격 · 잡고 있는 칸 제외 · 와일드카드 제외 · 보상은 손 머지와 같음 · 스키마
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
const INTERVAL = data.balance.grid.autoMergeInterval;

/** 1-1 낮, 저절로 조각은 멀리 미룸 (그리드를 테스트가 정한다) */
function game(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(data);
  d.balance.spawn.autoInterval = 9999;
  d.balance.spawn.killDropChance = 0;
  edit(d);
  const g = new GameState(d, { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize), 1);
  g.confirmDay();
  g.grid.cells.fill(null);
  return g;
}

function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}

function autoEvents(es: CoreEvent[]): Extract<CoreEvent, { type: 'autoMerge' }>[] {
  return es.filter((e): e is Extract<CoreEvent, { type: 'autoMerge' }> => e.type === 'autoMerge');
}

function run(g: GameState, seconds: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < Math.round(seconds / FIXED_DT); k++) out.push(...g.tick(FIXED_DT));
  return out;
}

describe('자동 뭉침 (D-070)', () => {
  it('기본값: autoMergeMaxTier 1, 간격 0.5초', () => {
    expect(data.balance.grid.autoMergeMaxTier).toBe(1);
    expect(INTERVAL).toBe(0.5);
  });

  it('쌍 고르기: 낮은 단계 먼저 → 작은 칸 번호로 합쳐짐 (to < from), 체인·단계가 같아야 함', () => {
    const g = game((d) => (d.balance.grid.autoMergeMaxTier = 2));
    put(g, 0, DOG, 2);
    put(g, 1, BONE, 1);
    put(g, 2, DOG, 2);
    put(g, 3, DOG, 1); // 체인이 달라 BONE 1과는 짝이 아님
    put(g, 5, BONE, 1);
    expect(g.autoMergePair()).toEqual({ from: 5, to: 1 }); // 1단계가 2단계보다 먼저
    put(g, 5, DOG, 3);
    expect(g.autoMergePair()).toEqual({ from: 2, to: 0 }); // 1단계 짝이 없으면 2단계
  });

  it('autoMergeMaxTier 초과 단계는 대상이 아니다 (0이면 끔)', () => {
    const g = game();
    put(g, 0, DOG, 2);
    put(g, 1, DOG, 2);
    expect(g.autoMergePair()).toBeNull();
    const off = game((d) => (d.balance.grid.autoMergeMaxTier = 0));
    put(off, 0, DOG, 1);
    put(off, 1, DOG, 1);
    expect(off.autoMergePair()).toBeNull();
    expect(autoEvents(run(off, 2))).toHaveLength(0);
  });

  it('와일드카드는 자동 대상에서 제외', () => {
    const g = game();
    put(g, 0, WILDCARD, 0);
    put(g, 1, DOG, 1);
    expect(g.autoMergePair()).toBeNull();
    put(g, 2, DOG, 1);
    expect(g.autoMergePair()).toEqual({ from: 2, to: 1 });
  });

  it('잡고 있는 칸(heldCells)은 제외 — 놓으면 다시 대상', () => {
    const g = game();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    put(g, 2, DOG, 1);
    g.heldCells.add(0);
    expect(g.autoMergePair()).toEqual({ from: 2, to: 1 });
    g.heldCells.add(2);
    expect(g.autoMergePair()).toBeNull();
    g.heldCells.clear();
    expect(g.autoMergePair()).toEqual({ from: 1, to: 0 });
  });

  it('간격: 틱마다 한 쌍만, 머지 뒤 autoMergeInterval 동안 다음 쌍을 기다린다', () => {
    const g = game();
    for (let i = 0; i < 8; i++) put(g, i, DOG, 1); // 1단계 넷 쌍
    const first = autoEvents(run(g, FIXED_DT));
    expect(first).toEqual([{ type: 'autoMerge', from: 1, to: 0 }]);
    expect(autoEvents(run(g, INTERVAL - 2 * FIXED_DT))).toHaveLength(0);
    expect(autoEvents(run(g, 2 * FIXED_DT))).toHaveLength(1);
    // 남은 두 쌍도 0.5초씩 (2단계는 대상 아님)
    expect(autoEvents(run(g, INTERVAL * 2 + FIXED_DT))).toHaveLength(2);
    expect(g.grid.cells.filter((p) => p?.tier === 2)).toHaveLength(4);
    expect(g.autoMerges).toBe(4);
  });

  it('보상은 손 머지와 같다: 머지 집계 + 전투 중 버프·병사', () => {
    const hand = game();
    put(hand, 0, DOG, 1);
    put(hand, 1, DOG, 1);
    hand.heldCells.add(0); // 손 머지 쪽은 자동이 끼어들지 않게
    expect(hand.drop(1, 0)).toBe('merge');
    const handEvents = hand.tick(0).filter((e) => e.type === 'buff' || e.type === 'soldier').map((e) => e.type);

    const auto = game();
    put(auto, 0, DOG, 1);
    put(auto, 1, DOG, 1);
    const autoEs = run(auto, FIXED_DT * 2); // 전투 머지 이벤트는 다음 틱에 나온다 (손 머지도 다음 tick에서 받음)
    expect(autoEvents(autoEs)).toHaveLength(1);
    expect(autoEs.filter((e) => e.type === 'buff' || e.type === 'soldier').map((e) => e.type)).toEqual(handEvents);
    expect(auto.attemptStats.merges).toBe(hand.attemptStats.merges);
    expect(auto.stats.battleMerges).toBe(hand.stats.battleMerges);
    expect(auto.grid.cells[0]).toMatchObject({ chain: DOG, tier: 2 });
    expect(auto.grid.cells[1]).toBeNull();
  });

  it('전투 밖(장면 카드)에서는 시간이 흐르지 않아 뭉치지 않는다', () => {
    const d = structuredClone(data);
    const g = new GameState(d, { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize), 1);
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    expect(autoEvents(run(g, 2))).toHaveLength(0);
  });
});

describe('스키마: grid.autoMergeMaxTier · autoMergeInterval', () => {
  const errs = (edit: (b: Record<string, unknown>) => void): string[] => {
    const raw = structuredClone(rawGameData) as unknown as Parameters<typeof validateGameData>[0];
    edit((raw.balance as { grid: Record<string, unknown> }).grid);
    const r = validateGameData(raw);
    return r.ok ? [] : r.issues.map((e) => `${e.path}: ${e.reason}`);
  };
  it('지금 데이터는 통과', () => expect(errs(() => {})).toEqual([]));
  it('빠진 키는 에러', () => {
    expect(errs((g) => delete g.autoMergeMaxTier).join()).toContain('autoMergeMaxTier');
    expect(errs((g) => delete g.autoMergeInterval).join()).toContain('autoMergeInterval');
  });
  it('maxTier 이상·음수·간격 0은 에러', () => {
    expect(errs((g) => (g.autoMergeMaxTier = 5)).length).toBeGreaterThan(0);
    expect(errs((g) => (g.autoMergeMaxTier = -1)).length).toBeGreaterThan(0);
    expect(errs((g) => (g.autoMergeInterval = 0)).length).toBeGreaterThan(0);
  });
});

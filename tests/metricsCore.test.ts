// core 결정적 metrics 필드 (스펙 §5.10-1, §5.19): 시도(attempt) 단위 기록
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { WILDCARD, toIndex } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const MAX = data.balance.grid.maxTier;

function game(edit: (d: GameData) => void = () => {}, cols = 4, rows = 4): GameState {
  const d = structuredClone(data);
  edit(d);
  const g = new GameState(d, { cols, rows }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + 1), 1);
  g.confirmDay(); // 1-1 낮 시작
  return g;
}

function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}

describe('AttemptStats 입력 집계', () => {
  it('spawns · merges · releases · releaseTiers (길이 maxTier+1)', () => {
    const g = game();
    g.joy = 1000;
    expect(g.spawn()).not.toBeNull();
    expect(g.spawn()).not.toBeNull();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    g.grid.cells.fill(null, 2);
    expect(g.drop(0, 1)).toBe('merge');
    put(g, 2, DOG, 1);
    put(g, 3, WILDCARD, 0);
    expect(g.release(2)).not.toBeNull();
    expect(g.release(3)).toBeNull(); // 와일드카드는 놓아줄 수 없다
    const a = g.attemptStats;
    expect([a.spawns, a.merges, a.releases]).toEqual([2, 1, 1]);
    expect(a.releaseTiers).toHaveLength(MAX + 1);
    expect(a.releaseTiers[1]).toBe(1);
    expect([a.stage, a.attempt, a.result]).toEqual([1, 1, null]);
  });

  it('gridFullSeconds: 낮·밤에 빈칸이 없던 틱 × FIXED_DT', () => {
    const g = game();
    for (let i = 0; i < g.grid.cells.length; i++) put(g, i, BLANKET, 1);
    for (let k = 0; k < 30; k++) g.tick(FIXED_DT);
    expect(g.attemptStats.gridFullSeconds).toBeCloseTo(30 * FIXED_DT, 9);
  });

  it('시도가 끝나면 attemptLog에 남고 lastAttempt, 다음 시도는 새 기록 (배열도 새 것)', () => {
    const g = game();
    put(g, 0, DOG, 1);
    g.release(0);
    g.debugFail();
    expect(g.attemptLog).toHaveLength(1);
    expect(g.lastAttempt).toMatchObject({ stage: 1, attempt: 1, result: 'dayTime', releases: 1 });
    g.confirmDay();
    expect(g.attemptStats).toMatchObject({ attempt: 2, releases: 0 });
    expect(g.attemptStats.releaseTiers).not.toBe(g.lastAttempt!.releaseTiers);
  });

  it('밤을 지킨 시도: coreHpEnd = 새벽의 핵 HP, guardianDown·carrySeconds 기록', () => {
    const g = game((d) => {
      d.stages.stages[0].day.enemies = [];
      d.stages.stages[0].day.chase = [];
    });
    g.tick(2);
    g.debugKillGuardian();
    for (let k = 0; k < 60 * 60 && g.phase === 'day'; k++) g.tick(FIXED_DT);
    expect(g.phase).toBe('night');
    g.coreHp = 70;
    g.debugEndNight();
    expect(g.lastAttempt).toMatchObject({ result: 'success', coreHpEnd: 70, guardianDown: 1 });
    expect(g.lastAttempt!.carrySeconds).toBeGreaterThan(0);
    expect(g.stats.carrySeconds).toBeCloseTo(g.lastAttempt!.carrySeconds, 9);
  });
});

describe('GameStats: tier3ByChain, FeedRecord', () => {
  it('머지로 3단계가 되면 체인별 +1 (와일드카드 + 2단계 포함), 2단계 머지는 세지 않음', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    g.drop(0, 1);
    expect(g.stats.tier3ByChain).toEqual({});
    put(g, 2, DOG, 2);
    g.drop(2, 1);
    put(g, 4, WILDCARD, 0);
    put(g, 5, BLANKET, 2);
    g.drop(4, 5);
    expect(g.stats.tier3ByChain).toEqual({ [DOG]: 1, [BLANKET]: 1 });
  });

  it('먹이기 기록: 시도·스테이지·덱·체인·단계·점수 (§5.17-2)', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, toIndex(g.grid, 2, 1), BLANKET, 2);
    g.tick(1);
    expect(g.feed(toIndex(g.grid, 2, 1), 'defense').ok).toBe(true);
    expect(g.feedLog[0]).toMatchObject({ attempt: 1, stage: 1, role: 'defense', chain: BLANKET, tier: 2, points: 3, cell: { col: 2, row: 1 } });
    expect(g.feedLog[0].heldFor).toBeCloseTo(1, 6);
  });

  it('새 필드도 저장 round-trip에 포함 (serialize → JSON → fromSave → serialize 동일)', () => {
    const g = game();
    put(g, 0, DOG, 2);
    g.feed(0, 'offense');
    g.debugFail();
    const s = serializeGame(g);
    const back = GameState.fromSave(data, JSON.parse(JSON.stringify(s)), mulberry32(1), gameGeometry(data.balance.merge.soldierCap + 1), { cols: 4, rows: 4 });
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(s));
  });
});

// M7: core 결정적 metrics 필드 (스펙 §5.10-1, §5.10-8)
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
  g.debugForceEvent('plain');
  g.confirmDay(); // 낮(오펜스) 시작 (§5.17-10)
  return g;
}

/** 칸 index에 조각을 직접 놓는다 */
function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}

describe('DayStats 입력 집계', () => {
  it('spawns · merges · releases · releaseTiers (0 = 와일드카드 칸, 길이 maxTier+1)', () => {
    const g = game();
    g.joy = 1000;
    expect(g.spawn()).not.toBeNull();
    expect(g.spawn()).not.toBeNull();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    g.grid.cells.fill(null, 2);
    expect(g.drop(0, 1)).toBe('merge');
    put(g, 5, BLANKET, 2);
    put(g, 6, BLANKET, 1);
    expect(g.release(5)).not.toBeNull();
    expect(g.release(6)).not.toBeNull();
    put(g, 7, WILDCARD, 0);
    expect(g.release(7)).toBeNull(); // 와일드카드는 놓아줄 수 없음 → 집계 안 됨
    expect(g.dayStats).toMatchObject({ spawns: 2, merges: 1, releases: 2 });
    expect(g.dayStats.releaseTiers).toHaveLength(MAX + 1);
    expect(g.dayStats.releaseTiers).toEqual([0, 1, 1, 0]);
  });

  it('이동·교환은 merges에 안 들어간다', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    expect(g.drop(0, 1)).toBe('move');
    put(g, 2, BLANKET, 1);
    expect(g.drop(1, 2)).toBe('swap');
    expect(g.dayStats.merges).toBe(0);
  });

  it('gridFullSeconds: 낮·밤에 빈칸이 없던 틱 × FIXED_DT', () => {
    const g = game();
    g.grid.cells.fill(null);
    for (let i = 0; i < g.grid.cells.length; i++) put(g, i, DOG, 1);
    for (let k = 0; k < 30; k++) g.tick(FIXED_DT);
    g.grid.cells[3] = null;
    for (let k = 0; k < 20; k++) g.tick(FIXED_DT);
    expect(g.dayStats.gridFullSeconds).toBeCloseTo(30 * FIXED_DT, 9);
    expect(g.dayStats.realSeconds).toBeCloseTo(50 * FIXED_DT, 9);
  });

  it('layerClearTimes: 층 돌파 시각(playTime), layersCleared와 개수 같음', () => {
    const g = game();
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    const t1 = g.playTime;
    for (let k = 0; k < 10; k++) g.tick(FIXED_DT);
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    expect(g.dayStats.layerClearTimes).toEqual([t1, g.playTime]);
    expect(g.dayStats.layersCleared).toBe(2);
  });

  it('lostReturns · offenseFell · stallSeconds도 그날 기록 (판 stats와 같은 증가량), 병사 쓰러짐은 stats.abyssDeaths', () => {
    const g = new GameState(structuredClone(data), { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(data.balance.merge.soldierCap + 1), 1);
    g.debugForceEvent('first_tooth');
    g.confirmDay('unhappy'); // face: 첫 층 돌파 때 조각 +1
    // 지급 소실: 그리드 가득 → 보너스 조각 사라짐
    for (let i = 0; i < g.grid.cells.length; i++) if (!g.grid.cells[i]) put(g, i, BLANKET, 1);
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    expect(g.dayStats.lostReturns).toBe(g.lostReturns);
    expect(g.dayStats.lostReturns).toBe(1);
    // 전투 중 머지 → 병사, 그다음 낮 우리 편 전멸 (병사 쓰러짐 + 영웅 쓰러짐 → 낮 끝)
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    expect(g.drop(0, 1)).toBe('merge');
    expect(g.abyss.soldierCount).toBe(1);
    g.debugKillAbyssUnits();
    g.tick(FIXED_DT);
    expect(g.stats.abyssDeaths).toBe(1);
    expect(g.lastDayStats ?? g.dayStats).toBeDefined();
    expect(g.phase).toBe('night');
    expect(g.dayStats.offenseFell).toBe(1);
    expect(g.dayStats.stallSeconds).toBe(g.stats.stallSeconds);
    expect(g.dayStats.stallSeconds).toBeGreaterThan(0);
  });

  it('하루 끝에 lastDayStats로 넘어가고 dayStats는 새로 (배열도 새 것)', () => {
    const g = game();
    g.joy = 100;
    g.spawn();
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    g.debugEndDay();
    expect(g.lastDayStats).toMatchObject({ spawns: 1, layersCleared: 1 });
    expect(g.dayStats).toMatchObject({ spawns: 0, merges: 0, layerClearTimes: [], releaseTiers: [0, 0, 0, 0] });
    expect(g.dayStats.layerClearTimes).not.toBe(g.lastDayStats!.layerClearTimes);
  });
});

describe('GameStats: tier3ByChain, FeedRecord.day', () => {
  it('머지로 3단계가 되면 체인별 +1 (와일드카드 + 2단계 포함), 2단계 머지는 세지 않음', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, 0, DOG, 2);
    put(g, 1, DOG, 2);
    g.drop(0, 1);
    put(g, 2, WILDCARD, 0);
    put(g, 3, BLANKET, 2);
    g.drop(2, 3);
    put(g, 4, DOG, 1);
    put(g, 5, DOG, 1);
    g.drop(4, 5);
    expect(g.stats.tier3ByChain).toEqual({ [DOG]: 1, [BLANKET]: 1 });
  });

  it('먹이기 기록: 일차·덱·체인·단계·점수 (§5.17-2)', () => {
    const g = game();
    g.feed(g.debugGrant(DOG, 3)!, 'offense');
    g.debugEndDay();
    g.nextDay();
    g.debugForceEvent('plain');
    g.confirmDay();
    g.feed(g.debugGrant(BLANKET, 2)!, 'defense');
    expect(g.feedLog.map((r) => [r.day, r.role, r.chain, r.tier, r.points])).toEqual([
      [1, 'offense', DOG, 3, 7],
      [2, 'defense', BLANKET, 2, 3],
    ]);
  });

  it('새 필드도 저장 round-trip에 포함 (serialize → JSON → fromSave → serialize 동일)', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, toIndex(g.grid, 0, 0), DOG, 2);
    put(g, toIndex(g.grid, 1, 0), DOG, 2);
    g.drop(0, 1);
    g.feed(1, 'defense');
    g.joy = 100;
    g.spawn();
    g.debugEndDay();
    const save = serializeGame(g);
    expect(save.stats.tier3ByChain).toEqual({ [DOG]: 1 });
    expect(save.lastDayStats).toMatchObject({ merges: 1, spawns: 1 });
    expect(save.feedLog[0].day).toBe(1);
    const back = GameState.fromSave(data, JSON.parse(JSON.stringify(save)), mulberry32(1), gameGeometry(data.balance.merge.soldierCap + 1), {
      cols: 4,
      rows: 4,
    });
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(save));
  });
});

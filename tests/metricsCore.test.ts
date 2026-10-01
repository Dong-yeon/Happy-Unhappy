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
  const g = new GameState(d, { cols, rows }, mulberry32(1), gameGeometry(d.balance.lane.laneCap), 1);
  g.debugForceEvent('plain');
  g.confirmDay();
  g.wave.paused = true; // 걱정 없이 입력만
  return g;
}

/** 밤으로 (심연 레인은 밤에만 돈다, §5.11). 테스트 동안 밤이 끝나지 않게 */
function toNight(g: GameState): GameState {
  g.debugToNight();
  g.nightTimer = 1e6;
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

  it('gridFullSeconds: waves 단계에서 빈칸이 없던 틱 × FIXED_DT', () => {
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
    const g = toNight(game());
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    const t1 = g.playTime;
    for (let k = 0; k < 10; k++) g.tick(FIXED_DT);
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    expect(g.dayStats.layerClearTimes).toEqual([t1, g.playTime]);
    expect(g.dayStats.layersCleared).toBe(2);
  });

  it('lostReturns · abyssDeaths · stallSeconds도 그날 기록 (일생 stats와 같은 증가량)', () => {
    const g = game((d) => {
      d.balance.lane.abyssAdvanceSpeed = 0;
      d.balance.grid.returnQueueCap = 0;
    });
    toNight(g);
    // 귀환 소실: 그리드 가득 + 대기열 상한 0 → 층 돌파 귀환 조각 소실
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    for (let i = 0; i < g.grid.cells.length; i++) if (!g.grid.cells[i]) put(g, i, BLANKET, 1);
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    expect(g.dayStats.lostReturns).toBe(g.lostReturns);
    expect(g.dayStats.lostReturns).toBeGreaterThan(0);
    // 심연 사망
    g.grid.cells[0] = null;
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugKillAbyssUnits();
    g.tick(FIXED_DT);
    expect(g.dayStats.abyssDeaths).toBe(g.stats.abyssDeaths);
    expect(g.dayStats.abyssDeaths).toBe(1);
    expect(g.dayStats.stallSeconds).toBe(g.stats.stallSeconds);
  });

  it('하루 끝에 lastDayStats로 넘어가고 dayStats는 새로 (배열도 새 것)', () => {
    const g = game();
    g.joy = 100;
    g.spawn();
    toNight(g);
    g.debugBreakLayer();
    g.tick(FIXED_DT);
    g.debugEndDay();
    expect(g.lastDayStats).toMatchObject({ spawns: 1, layersCleared: 1 });
    expect(g.dayStats).toMatchObject({ spawns: 0, merges: 0, layerClearTimes: [], releaseTiers: [0, 0, 0, 0] });
    expect(g.dayStats.layerClearTimes).not.toBe(g.lastDayStats!.layerClearTimes);
  });
});

describe('GameStats: tier3ByChain · heroFirstSummonDay, SummonRecord.day', () => {
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

  it('영웅 첫 소환 일차는 체인별로 처음 한 번만 (위·아래 모두)', () => {
    const g = game();
    g.summon(g.debugGrant(DOG, 3)!, 'happy');
    g.debugEndDay();
    g.nextDay();
    g.debugForceEvent('plain');
    g.confirmDay();
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.summon(g.debugGrant(BLANKET, 3)!, 'unhappy');
    g.summon(g.debugGrant(BLANKET, 2)!, 'happy');
    expect(g.stats.heroFirstSummonDay).toEqual({ [DOG]: 1, [BLANKET]: 2 });
    expect(g.summonLog.map((r) => r.day)).toEqual([1, 2, 2, 2]);
  });

  it('새 필드도 저장 round-trip에 포함 (serialize → JSON → fromSave → serialize 동일)', () => {
    const g = game();
    g.grid.cells.fill(null);
    put(g, toIndex(g.grid, 0, 0), DOG, 2);
    put(g, toIndex(g.grid, 1, 0), DOG, 2);
    g.drop(0, 1);
    g.summon(1, 'happy');
    g.joy = 100;
    g.spawn();
    g.debugEndDay();
    const save = serializeGame(g);
    expect(save.stats.tier3ByChain).toEqual({ [DOG]: 1 });
    expect(save.lastDayStats).toMatchObject({ merges: 1, spawns: 1 });
    expect(save.summonLog[0].day).toBe(1);
    const back = GameState.fromSave(data, JSON.parse(JSON.stringify(save)), mulberry32(1), gameGeometry(data.balance.lane.laneCap), {
      cols: 4,
      rows: 4,
    });
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(save));
  });
});

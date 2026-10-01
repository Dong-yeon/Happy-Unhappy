// 결말 판정 (스펙 §5.6, §5.8-3, §5.8-5)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { EndingId, Endings, GameData } from '../src/data/types';
import { endingFixtures, judgeEnding } from '../src/core/ending';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { emptyGameStats, type GameStats } from '../src/core/stats';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const CFG = base.endings;
const IDS: EndingId[] = ['hidden', 'solid', 'mask', 'quiet', 'rainy'];

function cfg(edit: (c: Endings) => void = () => {}): Endings {
  const c = structuredClone(CFG);
  edit(c);
  return c;
}

/** 모든 가중치 1: happy = worriesDefeated, unhappy = layersCleared 로만 점수를 만든다 */
const unit = cfg((c) => {
  for (const k of Object.keys(c.weights) as (keyof Endings['weights'])[]) c.weights[k] = 1;
  c.thresholds = { happy: 100, unhappy: 50 };
  c.balanceRatio = 0.2;
});
function stats(happy: number, unhappy: number, extra: Partial<GameStats> = {}): GameStats {
  return { ...emptyGameStats(), worriesDefeated: happy, layersCleared: unhappy, ...extra };
}

describe('judgeEnding', () => {
  it('fixture 5종이 각각 해당 결말 (현재 endings.json)', () => {
    const fx = endingFixtures(CFG);
    for (const id of IDS) expect(judgeEnding(fx[id].stats, fx[id].flags, CFG).id, id).toBe(id);
  });

  it('fixture는 가중치·임계값이 바뀌어도 성립', () => {
    const c = cfg((x) => {
      x.weights = { wUpTier: 0.7, wDefeat: 2, wJoy: 0, wSunk: 3, wDownTier: 0, wLayer: 0.3, wPurified: 5 };
      x.thresholds = { happy: 333, unhappy: 47 };
      x.balanceRatio = 0.05;
    });
    const fx = endingFixtures(c);
    for (const id of IDS) expect(judgeEnding(fx[id].stats, fx[id].flags, c).id, id).toBe(id);
  });

  it('공식: 항목별 기여 = stats × 가중치 (가라앉음은 감점), happy·unhappy는 그 합', () => {
    const s = {
      ...emptyGameStats(),
      sentUpTierSum: 10,
      worriesDefeated: 20,
      totalJoyEarned: 100,
      sunkCount: 3,
      sentDownTierSum: 5,
      layersCleared: 2,
      shadowPurified: 30,
    };
    const r = judgeEnding(s, [], CFG);
    const w = CFG.weights;
    expect(r.breakdown).toEqual({
      upTier: 10 * w.wUpTier,
      defeat: 20 * w.wDefeat,
      joy: 100 * w.wJoy,
      sunk: -3 * w.wSunk,
      downTier: 5 * w.wDownTier,
      layer: 2 * w.wLayer,
      purified: 30 * w.wPurified,
    });
    expect(r.happy).toBeCloseTo(10 * w.wUpTier + 20 * w.wDefeat + 100 * w.wJoy - 3 * w.wSunk);
    expect(r.unhappy).toBeCloseTo(5 * w.wDownTier + 2 * w.wLayer + 30 * w.wPurified);
  });

  it('경계값: 임계값과 같으면 통과 (≥), 모자라면 미달 / 임계값은 쪽마다 따로', () => {
    expect(judgeEnding(stats(100, 50), [], unit).id).toBe('solid');
    expect(judgeEnding(stats(99, 50), [], unit).id).toBe('quiet');
    expect(judgeEnding(stats(100, 49), [], unit).id).toBe('mask');
    expect(judgeEnding(stats(99, 49), [], unit).id).toBe('rainy');
  });

  it('경계값: |happy − unhappy| = balanceRatio × max면 히든, 넘으면 solid', () => {
    // max 100, ratio 0.2 → 차이 20까지
    expect(judgeEnding(stats(100, 80), ['face'], unit).id).toBe('hidden');
    expect(judgeEnding(stats(100, 79), ['face'], unit).id).toBe('solid');
    expect(judgeEnding(stats(100, 125), ['face'], unit).id).toBe('hidden'); // 대칭: max 125 × 0.2 = 25
    expect(judgeEnding(stats(100, 126), ['face'], unit).id).toBe('solid');
  });

  it('히든 조건에서 flag face가 없으면 solid', () => {
    expect(judgeEnding(stats(100, 100), [], unit).id).toBe('solid');
    expect(judgeEnding(stats(100, 100), ['avoid'], unit).id).toBe('solid');
    expect(judgeEnding(stats(100, 100), ['avoid', 'face'], unit).id).toBe('hidden');
  });

  it('wSunk: 가라앉은 걱정 1마리당 Happy 점수 감점 → 임계값 아래로 떨어지면 결말이 바뀐다 (D-024)', () => {
    const c = cfg((x) => {
      x.weights = { wUpTier: 0, wDefeat: 1, wJoy: 0, wSunk: 2, wDownTier: 0, wLayer: 1, wPurified: 0 };
      x.thresholds = { happy: 100, unhappy: 10 };
    });
    expect(judgeEnding(stats(120, 20), [], c)).toMatchObject({ id: 'solid', happy: 120 });
    const r = judgeEnding(stats(120, 20, { sunkCount: 11 }), [], c);
    expect(r).toMatchObject({ id: 'quiet', happy: 98 });
    expect(r.breakdown.sunk).toBe(-22);
  });

  it('두 점수는 0 하한 (감점이 커도 음수가 아니다, breakdown은 0 하한 전 값)', () => {
    const r = judgeEnding(stats(0, 0, { sunkCount: 300, sentUpTierSum: 5 }), [], CFG);
    expect(r.happy).toBe(0);
    expect(r.unhappy).toBe(0);
    expect(r.breakdown.sunk).toBe(-300 * CFG.weights.wSunk);
    expect(r.id).toBe('rainy');
  });

  it('보스 승리 그림자 감소(shadowCalmed)는 점수에 들어가지 않는다 (D-023)', () => {
    const a = judgeEnding(stats(0, 0), [], CFG);
    const b = judgeEnding(stats(0, 0, { shadowCalmed: 500, bossWins: 10 }), [], CFG);
    expect(b).toEqual(a);
    expect(judgeEnding(stats(0, 0, { shadowPurified: 100 }), [], CFG).unhappy).toBeCloseTo(100 * CFG.weights.wPurified);
  });
});

describe('GameState: 판정 시점', () => {
  function fresh(): GameState {
    return new GameState(structuredClone(base), { cols: 5, rows: 4 }, mulberry32(3), gameGeometry(base.balance.lane.laneCap), 3);
  }

  it('14일째 nextDay → lifeEnd 진입 시 1회 판정해 ending에 둔다 (그 전에는 null)', () => {
    const g = fresh();
    g.debugGotoDay(g.lifeLengthDays);
    g.debugForceEvent('plain');
    g.confirmDay();
    expect(g.ending).toBeNull();
    g.debugEndDay();
    expect(g.phase).toBe('diary');
    expect(g.ending).toBeNull();
    g.nextDay();
    expect(g.phase).toBe('lifeEnd');
    expect(g.ending).toEqual(judgeEnding(g.stats, g.flags, base.endings));
    expect(g.tick(0).some((e) => e.type === 'lifeEnd')).toBe(true);
  });

  it('디버그 즉시 결말 판정: 현재 stats·flags로 lifeEnd, 레인은 비움', () => {
    const g = fresh();
    g.debugForceEvent('plain');
    g.confirmDay();
    g.summon(g.debugGrant('companion_animal', 1)!, 'happy');
    g.debugJudgeEnding();
    expect(g.phase).toBe('lifeEnd');
    expect(g.defense.units).toHaveLength(0);
    expect(g.ending?.id).toBe(judgeEnding(g.stats, g.flags, base.endings).id);
  });
});

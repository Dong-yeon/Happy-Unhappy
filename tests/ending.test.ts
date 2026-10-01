// 결말 판정 (스펙 §5.14-3 — §5.6 대체, §5.8-3)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { EndingId, Endings, GameData } from '../src/data/types';
import { endingFixtures, judgeEnding } from '../src/core/ending';
import { GameState } from '../src/core/game';
import { emptyGrowth, type Branch, type GrowthState } from '../src/core/growth';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const CFG = base.endings;
const IDS: EndingId[] = ['hidden', 'solid', 'mask', 'quiet', 'rainy'];

function cfg(edit: (c: Endings) => void = () => {}): Endings {
  const c = structuredClone(CFG);
  edit(c);
  return c;
}

/** 단순 설정: totalThreshold 600, shareBand [0.3, 0.7], hiddenMinMemories 3 */
const C = cfg((c) => {
  c.totalThreshold = 600;
  c.shareBand = [0.3, 0.7];
  c.hiddenMinMemories = 3;
});

function g(happy: number, unhappy: number, branches: Branch[] = ['happy', 'unhappy', 'slow'], memories = 0): GrowthState {
  return { ...emptyGrowth(), happy, unhappy, branches, memories };
}

describe('judgeEnding (§5.14-3)', () => {
  it('fixture 5종이 각각 해당 결말 (현재 endings.json)', () => {
    const fx = endingFixtures(CFG);
    for (const id of IDS) expect(judgeEnding(fx[id], CFG).id, id).toBe(id);
  });

  it('fixture는 임계값이 바뀌어도 성립', () => {
    const c = cfg((x) => {
      x.totalThreshold = 1234;
      x.shareBand = [0.4, 0.55];
      x.hiddenMinMemories = 5;
    });
    const fx = endingFixtures(c);
    for (const id of IDS) expect(judgeEnding(fx[id], c).id, id).toBe(id);
  });

  it('total·share 공식, breakdown = 준 전설 수·기억', () => {
    const s = { ...g(450, 150), given: { happy: 4, purified: 1 }, memories: 1 };
    const r = judgeEnding(s, C);
    expect(r.total).toBe(600);
    expect(r.share).toBeCloseTo(0.75);
    expect(r.breakdown).toEqual({ happyLegends: 4, purifiedLegends: 1, memories: 1 });
    expect(r.id).toBe('mask');
  });

  it('total 0이면 share 0.5 (→ total < threshold라 rainy)', () => {
    const r = judgeEnding(g(0, 0, ['slow', 'slow', 'slow']), C);
    expect(r.share).toBe(0.5);
    expect(r.id).toBe('rainy');
    // 임계값 0이면 share 0.5로 solid
    expect(judgeEnding(g(0, 0, ['slow']), cfg((c) => (c.totalThreshold = 0))).id).toBe('solid');
  });

  it('경계값: total = threshold면 통과, 1 모자라면 rainy', () => {
    expect(judgeEnding(g(300, 300), C).id).toBe('solid');
    expect(judgeEnding(g(300, 299), C).id).toBe('rainy');
  });

  it('경계값: share = shareBand[0]·[1]이면 solid (포함), 넘으면 mask / quiet', () => {
    expect(judgeEnding(g(700, 300), C).id).toBe('solid'); // 0.7
    expect(judgeEnding(g(300, 700), C).id).toBe('solid'); // 0.3
    expect(judgeEnding(g(701, 299), C).id).toBe('mask');
    expect(judgeEnding(g(299, 701), C).id).toBe('quiet');
    expect(judgeEnding(g(1000, 0), C).id).toBe('mask');
    expect(judgeEnding(g(0, 1000), C).id).toBe('quiet');
  });

  it('히든: 갈래가 모두 together + 기억 ≥ hiddenMinMemories (total·share보다 먼저)', () => {
    const all3: Branch[] = ['together', 'together', 'together'];
    expect(judgeEnding(g(500, 500, all3, 3), C).id).toBe('hidden');
    // total이 모자라도 히든이 먼저
    expect(judgeEnding(g(100, 100, all3, 3), C).id).toBe('hidden');
    // 기억 하나 모자라면 아님
    expect(judgeEnding(g(500, 500, all3, 2), C).id).toBe('solid');
    // 한 번이라도 together가 아니면 아님
    expect(judgeEnding(g(500, 500, ['together', 'happy', 'together'], 5), C).id).toBe('solid');
    expect(judgeEnding(g(500, 500, ['together', 'together', 'slow'], 5), C).id).toBe('solid');
    // 자라기가 한 번도 없으면 아님
    expect(judgeEnding(g(500, 500, [], 5), C).id).toBe('solid');
  });
});

describe('GameState: 판정 시점', () => {
  function fresh(): GameState {
    return new GameState(structuredClone(base), { cols: 5, rows: 4 }, mulberry32(3), gameGeometry(base.balance.lane.laneCap), 3);
  }

  it('14일째 nextDay → 마지막 자라기 → lifeEnd 진입 시 1회 판정 (그 전에는 null)', () => {
    const s = fresh();
    s.debugGotoDay(s.lifeLengthDays);
    s.debugForceEvent('plain');
    s.confirmDay();
    expect(s.ending).toBeNull();
    s.debugEndDay();
    expect(s.phase).toBe('diary');
    expect(s.ending).toBeNull();
    const before = s.growthLog.length;
    s.nextDay();
    expect(s.phase).toBe('lifeEnd');
    expect(s.growthLog.length).toBe(before + 1);
    expect(s.ending).toEqual(judgeEnding(s.growth, base.endings));
    const ev = s.tick(0);
    expect(ev.findIndex((e) => e.type === 'growth')).toBeLessThan(ev.findIndex((e) => e.type === 'lifeEnd'));
  });

  it('디버그 즉시 결말 판정: 지금 성장치로 lifeEnd (자라기 없음), 레인은 비움', () => {
    const s = fresh();
    s.debugForceEvent('plain');
    s.confirmDay();
    s.summon(s.debugGrant('companion_animal', 1)!, 'happy');
    s.debugJudgeEnding();
    expect(s.phase).toBe('lifeEnd');
    expect(s.growthLog).toHaveLength(0);
    expect(s.defense.units).toHaveLength(0);
    expect(s.ending?.id).toBe(judgeEnding(s.growth, base.endings).id);
  });
});

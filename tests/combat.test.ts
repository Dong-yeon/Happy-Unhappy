// M3: GameState의 소환·고정 틱·결정성 (스펙 §4.3.1 "테스트 (필수)")
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const GEOS = gameGeometry(data.balance.lane.laneCap);
const GEO = GEOS.defense;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const CAP = data.balance.lane.laneCap;

function game(seed = 1, cols = 4, rows = 4): GameState {
  const g = new GameState(data, { cols, rows }, mulberry32(seed), GEOS);
  // 1일차를 평범한 하루로 시작 (이벤트 효과가 수치를 흔들지 않게) → waves 단계
  g.debugForceEvent('plain');
  g.confirmDay();
  return g;
}

describe('소환 (☀ 창문)', () => {
  it('즉시: 조각 제거 → 유닛 생성 → 전투 참여(쿨다운 0), sentUpTierSum += tier', () => {
    const g = game();
    const i = g.debugGrant(DOG, 2)!;
    const r = g.summon(i, 'happy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(g.grid.cells[i]).toBeNull();
    expect(g.defense.units).toEqual([r.unit]);
    const spirit2 = data.units.commonSpirit.find((u) => u.tier === 2)!;
    expect(r.unit).toMatchObject({ chain: DOG, tier: 2, hp: spirit2.hp, atk: spirit2.atk, range: spirit2.range, cd: 0 });
    expect(g.stats.sentUpTierSum).toBe(2);
  });

  it('1단계 = 공용 추억 정령, 3단계 = 체인 영웅 능력치', () => {
    const g = game();
    const r1 = g.summon(g.debugGrant(BLANKET, 1)!, 'happy');
    const spirit1 = data.units.commonSpirit.find((u) => u.tier === 1)!;
    expect(r1.ok && r1.unit.hp).toBe(spirit1.hp);
    for (const c of data.chains) {
      const r = g.summon(g.debugGrant(c.archetypeId, 3)!, 'happy');
      expect(r.ok && { hp: r.unit.hp, atk: r.unit.atk, atkInterval: r.unit.atkInterval, range: r.unit.range }).toEqual(c.hero);
    }
  });

  it('슬롯: 빈 슬롯 중 레인 가운데에 가장 가까운 곳부터 (같으면 x가 작은 쪽)', () => {
    const g = game(1, 5, 4);
    const xs = Array.from({ length: CAP }, () => {
      const r = g.summon(g.debugGrant(DOG, 1)!, 'happy');
      return r.ok ? r.unit.x : NaN;
    });
    // 거리가 같으면(부동소수 오차 무시) x가 작은 쪽
    const dist = (x: number) => Math.abs(x - GEO.centerX);
    const byDist = [...GEO.slotXs].sort((a, b) => (Math.abs(dist(a) - dist(b)) < 1e-6 ? a - b : dist(a) - dist(b)));
    expect(byDist[0]).toBeLessThan(GEO.centerX); // 가운데 양옆 동률 → 왼쪽 먼저
    expect(xs).toEqual(byDist);
    expect(new Set(xs).size).toBe(CAP);
  });

  it('슬롯은 Happy 자리와 겹치지 않고 레인 폭 안', () => {
    expect(GEO.slotXs).toHaveLength(CAP);
    for (const x of GEO.slotXs) {
      expect(Math.abs(x - GEO.happyX)).toBeGreaterThan(16);
      expect(x).toBeGreaterThan(GEO.spawnXMin - 12);
      expect(x).toBeLessThan(GEO.spawnXMax + 12);
    }
  });

  it('laneFull 거부: 조각은 그대로', () => {
    const g = game(1, 5, 4);
    for (let k = 0; k < CAP; k++) g.summon(g.debugGrant(DOG, 1)!, 'happy');
    expect(g.defense.isFull).toBe(true);
    const i = g.debugGrant(DOG, 1)!;
    expect(g.canSummon(i, 'happy')).toBe('laneFull');
    expect(g.summon(i, 'happy')).toEqual({ ok: false, reason: 'laneFull' });
    expect(g.grid.cells[i]).not.toBeNull();
    expect(g.stats.sentUpTierSum).toBe(CAP);
  });

  it('와일드카드 거부 (레인이 가득이어도 wildcard 사유가 먼저)', () => {
    const g = game(1, 5, 4);
    const w = g.debugGrant(WILDCARD, 0)!;
    expect(g.summon(w, 'happy')).toEqual({ ok: false, reason: 'wildcard' });
    for (let k = 0; k < CAP; k++) g.summon(g.debugGrant(DOG, 1)!, 'happy');
    expect(g.canSummon(w, 'happy')).toBe('wildcard');
    expect(g.grid.cells[w]?.chain).toBe(WILDCARD);
  });

  it('◐ 손거울(M4): 심연 출발선의 빈 슬롯, sentDownTierSum, 기록 side unhappy / 빈 칸은 empty', () => {
    const g = game();
    const i = g.debugGrant(DOG, 2)!;
    const r = g.summon(i, 'unhappy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(g.abyss.units).toEqual([r.unit]);
    expect(g.defense.units).toEqual([]);
    expect(r.unit).toMatchObject({ side: 'unhappy', y: GEOS.abyss.startY, arrived: false });
    expect(GEOS.abyss.slotXs).toContain(r.unit.x);
    expect(g.stats).toMatchObject({ sentDownTierSum: 2, sentUpTierSum: 0 });
    expect(g.summonLog.at(-1)?.side).toBe('unhappy');
    const empty = g.grid.cells.findIndex((c) => c === null);
    expect(g.canSummon(empty, 'happy')).toBe('empty');
  });

  it('소환 기록 필드: {t, side, chain, tier, cell:{col,row}, heldFor}', () => {
    const g = game(1, 4, 4);
    g.wave.paused = true;
    g.tick(1); // bornAt = 1
    const i = g.debugGrant(BLANKET, 1)!;
    g.tick(2.5); // playTime = 3.5
    g.summon(i, 'happy');
    expect(g.summonLog).toEqual([
      { t: 3.5, side: 'happy', chain: BLANKET, tier: 1, cell: { col: i % 4, row: Math.floor(i / 4) }, heldFor: 2.5 },
    ]);
  });

  it('소환이 칸을 비우면 귀환 대기열을 바로 배치', () => {
    const g = game(1, 4, 4);
    for (let k = 0; k < 16; k++) g.debugGrant(DOG, 1);
    const back = g.newPiece(BLANKET, 2);
    g.enqueueReturn(back);
    g.summon(7, 'happy');
    expect(g.grid.cells[7]).toBe(back);
  });

  it('summon 이벤트는 다음 tick()의 반환값에 들어간다', () => {
    const g = game();
    g.wave.paused = true;
    g.tick(0); // 하루 시작 이벤트 비우기
    const r = g.summon(g.debugGrant(DOG, 1)!, 'happy');
    expect(g.tick(0)).toEqual([expect.objectContaining({ type: 'summon', unitId: r.ok ? r.unit.id : -1, side: 'happy' })]);
    expect(g.tick(0)).toEqual([]);
  });
});

describe('처치 → 기쁨, 가라앉음 기록', () => {
  it('처치 즉시 기쁨 joyReward, stats 누적', () => {
    const g = game();
    const joy = g.joy;
    for (let k = 0; k < 3; k++) g.summon(g.debugGrant(DOG, 3)!, 'happy'); // 영웅 3기면 첫 웨이브를 막는다
    const types: string[] = [];
    for (let k = 0; k < 60 * 20; k++) types.push(...g.tick(FIXED_DT).map((e) => e.type));
    const kills = types.filter((t) => t === 'worryDie').length;
    expect(kills).toBeGreaterThan(0);
    expect(g.stats.worriesDefeated).toBe(kills);
    expect(g.joy).toBe(joy + kills * data.monsters.worry.joyReward);
    expect(g.stats.totalJoyEarned).toBe(kills * data.monsters.worry.joyReward);
    expect(types).not.toContain('sink');
  });

  it('유닛이 없으면 가라앉고 sunkCount 증가', () => {
    const g = game();
    const types: string[] = [];
    for (let k = 0; k < 60 * 20; k++) types.push(...g.tick(FIXED_DT).map((e) => e.type));
    const sinks = types.filter((t) => t === 'sink').length;
    expect(sinks).toBeGreaterThan(0);
    expect(g.stats.sunkCount).toBe(sinks);
  });
});

/** 비교용 상태 요약 */
function snapshot(g: GameState) {
  return {
    tick: g.tickCount,
    joy: g.joy,
    grid: g.grid.cells.map((c) => (c ? `${c.id}:${c.chain}:${c.tier}` : null)),
    wave: { day: g.day, slot: g.wave.slot, phase: g.wave.phase, spawned: g.wave.spawned },
    worries: g.defense.worries.map((w) => ({ id: w.id, x: w.x, y: w.y, hp: w.hp, state: w.state })),
    units: g.defense.units.map((u) => ({ id: u.id, hp: u.hp, cd: u.cd, slot: u.slot })),
    stats: { ...g.stats },
  };
}

type Advance = (g: GameState, seconds: number) => string[];

/** 소환 몇 번 + 웨이브 진행. 시간을 넘기는 방식만 advance로 바꾼다 */
function scenario(seed: number, advance: Advance) {
  const g = game(seed, 5, 4);
  const events: string[] = [];
  events.push(...advance(g, 3));
  g.summon(g.debugGrant(DOG, 2)!, 'happy');
  g.summon(g.debugGrant(BLANKET, 1)!, 'happy');
  events.push(...advance(g, 4));
  g.summon(g.debugGrant(BLANKET, 3)!, 'happy');
  events.push(...advance(g, 8));
  return { snap: snapshot(g), events };
}

const bigSteps: Advance = (g, s) => {
  const out: string[] = [];
  for (let k = 0; k < s; k++) out.push(...g.tick(1).map((e) => JSON.stringify(e)));
  return out;
};
const smallSteps: Advance = (g, s) => {
  const out: string[] = [];
  for (let k = 0; k < s * 60; k++) out.push(...g.tick(1 / 60).map((e) => JSON.stringify(e)));
  return out;
};

describe('고정 틱', () => {
  it('tick(1) 한 번 = tick(1/60) 60번', () => {
    const a = game(3);
    const b = game(3);
    a.tick(1);
    for (let k = 0; k < 60; k++) b.tick(1 / 60);
    expect(a.tickCount).toBe(60);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('긴 시나리오(소환·웨이브·처치)에서도 큰 dt와 작은 dt의 상태·이벤트가 같다', () => {
    const big = scenario(11, bigSteps);
    const small = scenario(11, smallSteps);
    expect(small.snap).toEqual(big.snap);
    expect(small.events).toEqual(big.events);
    expect(big.snap.stats.worriesDefeated + big.snap.stats.sunkCount).toBeGreaterThan(0);
  });

  it('틱보다 짧은 dt는 누적되어 다음 호출로 넘어간다', () => {
    const g = game();
    g.tick(FIXED_DT * 0.4);
    expect(g.tickCount).toBe(0);
    g.tick(FIXED_DT * 0.7);
    expect(g.tickCount).toBe(1);
  });
});

describe('결정성', () => {
  it('시드 고정 + 같은 입력 → 같은 결과', () => {
    expect(scenario(42, smallSteps)).toEqual(scenario(42, smallSteps));
  });

  it('시드가 다르면 걱정 등장 x가 다르다', () => {
    const xs = (seed: number) => {
      const g = game(seed);
      g.tick(3.1); // 첫 웨이브 = dayStartDelay(3초) 뒤
      return g.defense.worries.map((w) => w.x);
    };
    expect(xs(1)).not.toEqual(xs(2));
  });
});

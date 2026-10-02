// 전투 중 머지 병사 ([11]-1·2, D-049·D-050): 병사 출전·단 매핑·상한·수명·방패병 정지·반격 먼저·올가미 감속·때 맞춤 배수
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT, Lane, type LaneEvent, type UnitHost } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const B = base.balance;
const DOG = 'companion_animal'; // 떡 → 방패병, sun
const ROPE = 'comfort_object'; // 동아줄 → 올가미병, moon
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(B.merge.soldierCap + 1);
const chain = (id: string) => base.chains.find((c) => c.archetypeId === id)!;

function day(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(base);
  edit(d);
  const g = new GameState(d, SIZE, mulberry32(1), GEO, 1);
  g.confirmDay();
  g.grid.cells.fill(null);
  return g;
}
function put(g: GameState, index: number, c: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(c, tier);
}
/** a·b 칸에 같은 조각을 놓고 머지 */
function merge(g: GameState, c: string, tier: number, a = 0, b = 1): void {
  put(g, a, c, tier);
  put(g, b, c, tier);
  expect(g.drop(a, b)).toBe('merge');
  g.grid.cells[b] = null;
}
const soldiers = (l: UnitHost) => l.units.filter((u) => u.role === 'soldier');
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

describe('출전 ([11]-1)', () => {
  it('전투 중 머지 → 지금 싸우는 레인에 병사 (낮 = 핵 찾아 돌아오기, 밤 = 핵 지키기), 결과 조각은 그리드에 남음', () => {
    const g = day();
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    g.drop(0, 1);
    expect(g.grid.cells[1]).toMatchObject({ chain: DOG, tier: 2 });
    expect(soldiers(g.abyss)).toHaveLength(1);
    g.debugToNight();
    expect(soldiers(g.abyss)).toHaveLength(0); // 해질녘(핵을 가져옴)에 물러남 (귀환 없음)
    merge(g, ROPE, 1, 2, 3);
    expect(soldiers(g.defense)).toHaveLength(1);
    expect(soldiers(g.defense)[0]).toMatchObject({ chain: ROPE, soldier: 'snare' });
  });

  it('전투 밖(dayStart·이야기 한 장) 머지는 병사 없음', () => {
    const d = structuredClone(base);
    const g = new GameState(d, SIZE, mulberry32(1), GEO, 1);
    g.grid.cells.fill(null);
    merge(g, DOG, 1);
    g.confirmDay();
    expect(soldiers(g.abyss)).toHaveLength(0);
    expect(g.stats.soldiersSpawned).toBe(0);
  });

  it('단 매핑: 결과 2단계 = 1단, 3단계 = 2단 (떡 방패병 1단 hp60·atk4 / 2단 hp140·atk8)', () => {
    const g = day((d) => (d.balance.merge.affinityMult = 1)); // 배수는 따로
    merge(g, DOG, 1);
    merge(g, DOG, 2, 2, 3);
    const [s1, s2] = soldiers(g.abyss);
    expect([s1.tier, s1.maxHp, s1.atk, s1.atkInterval]).toEqual([1, 60, 4, 1.2]);
    expect([s2.tier, s2.maxHp, s2.atk]).toEqual([2, 140, 8]);
    expect(g.stats.soldiersByKind).toEqual({ [`${DOG}:1`]: 1, [`${DOG}:2`]: 1 });
  });

  it('와일드카드가 낀 머지 = 결과 체인 기준', () => {
    const g = day();
    put(g, 0, WILDCARD, 0);
    put(g, 1, ROPE, 2);
    g.drop(0, 1);
    expect(soldiers(g.abyss)[0]).toMatchObject({ chain: ROPE, tier: 2, soldier: 'snare' });
  });

  it(`상한 soldierCap(${B.merge.soldierCap}): 넘으면 병사 없이 버프만 (soldiersCapped)`, () => {
    const g = day();
    for (let k = 0; k < B.merge.soldierCap + 2; k++) merge(g, ROPE, 1);
    expect(soldiers(g.abyss)).toHaveLength(B.merge.soldierCap);
    expect(g.stats.soldiersCapped).toBe(2);
    const es = g.tick(0);
    expect(ofType(es, 'soldier').filter((e) => e.capped)).toHaveLength(2);
    expect(g.heroes.offense.momentum.stacks).toBe(Math.min(B.buff.momentumMaxStacks, B.merge.soldierCap + 2)); // 버프는 계속
  });

  it(`수명 soldierLifetime(${B.merge.soldierLifetime}초): 지나면 사라짐 (귀환 없음, 그리드 변화 없음)`, () => {
    const g = day((d) => {
      d.balance.lane.abyssAdvanceSpeed = 0; // 반격 범위 밖 오두막에서 제자리
      d.stages.stages[0].day.enemies = []; // 적 없음 (병사가 맞지 않게)
    });
    merge(g, DOG, 1);
    const cells = JSON.stringify(g.grid.cells);
    const n = Math.round(B.merge.soldierLifetime * 60);
    for (let k = 0; k < n - 2; k++) g.tick(FIXED_DT);
    expect(soldiers(g.abyss)).toHaveLength(1);
    expect(soldiers(g.abyss)[0].life).toBeLessThan(0.1);
    for (let k = 0; k < 4; k++) g.tick(FIXED_DT);
    expect(soldiers(g.abyss)).toHaveLength(0);
    expect(JSON.stringify(g.grid.cells)).toBe(cells);
  });

  it('merge.soldiers = false면 병사 없음 (버프는 그대로)', () => {
    const g = day((d) => (d.balance.merge.soldiers = false));
    merge(g, ROPE, 1);
    expect(soldiers(g.abyss)).toHaveLength(0);
    expect(g.heroes.offense.momentum.stacks).toBe(1);
  });
});

describe('때 맞춤 ([11]-2)', () => {
  it('낮에 sun(떡) / 밤에 moon(동아줄) 머지 → 병사 능력치 × affinityMult, 반대 때는 기본값', () => {
    const g = day();
    const lv = chain(DOG).soldier.levels[0];
    merge(g, DOG, 1); // 낮 + sun = 때 맞춤
    merge(g, ROPE, 1, 2, 3); // 낮 + moon = 아님
    const [shield, snare] = soldiers(g.abyss);
    expect(shield.maxHp).toBeCloseTo(lv.hp * B.merge.affinityMult, 9);
    expect(shield.atk).toBeCloseTo(lv.atk * B.merge.affinityMult, 9);
    expect(snare.maxHp).toBe(chain(ROPE).soldier.levels[0].hp);
    expect(g.stats.affinityMerges).toBe(1);
    g.debugToNight();
    merge(g, ROPE, 1, 4, 5); // 밤 + moon = 때 맞춤
    expect(soldiers(g.defense)[0].maxHp).toBeCloseTo(chain(ROPE).soldier.levels[0].hp * B.merge.affinityMult, 9);
    expect(g.stats.affinityMerges).toBe(2);
  });

  it('chains.json side: 떡 sun, 동아줄 moon', () => {
    expect(chain(DOG).side).toBe('sun');
    expect(chain(ROPE).side).toBe('moon');
  });
});

describe('방패병·올가미병 (레인 규칙)', () => {
  const HAPPY = { atk: 0, atkInterval: 1, range: 0 };
  const WORRY = { type: 'shadow', hp: 1000, speed: 60, atk: 5, atkInterval: 1, joyReward: 0 };
  function defense(): Lane {
    return new Lane('defense', GEO.defense, HAPPY, null);
  }
  function step(l: Lane, n: number): LaneEvent[] {
    const out: LaneEvent[] = [];
    for (let i = 0; i < n; i++) l.step(FIXED_DT, out);
    return out;
  }

  it('방패병은 걱정을 막고(정지) 맞는다, 올가미병은 막지 않고 맞지 않는다', () => {
    const shield = defense();
    shield.addUnit(1, 'happy', DOG, 1, { hp: 1000, atk: 0, atkInterval: 1, range: 1 }, { role: 'soldier', soldier: 'shield', life: 99 });
    const w1 = shield.spawnWorry(WORRY, GEO.defense.centerX, []);
    step(shield, 600);
    expect(w1.state).toBe('stopped');
    expect(shield.units[0].hp).toBeLessThan(1000);

    const snare = defense();
    snare.addUnit(1, 'happy', ROPE, 1, { hp: 1000, atk: 0, atkInterval: 1, range: 1 }, { role: 'soldier', soldier: 'snare', life: 99 });
    snare.spawnWorry(WORRY, GEO.defense.centerX, []);
    const es = step(snare, 600);
    expect(es.some((e) => e.type === 'sink')).toBe(true); // 막지 않으니 지나가 가라앉음
    expect(snare.units[0].hp).toBe(1000);
  });

  it('올가미병이 맞힌 걱정은 slow만큼 slowSeconds 동안 느려진다 (2단 2초)', () => {
    const lv = chain(ROPE).soldier.levels;
    const l = defense();
    l.addUnit(1, 'happy', ROPE, 2, { hp: 1000, atk: 1, atkInterval: 10, range: 1000 }, { role: 'soldier', soldier: 'snare', life: 99, slow: lv[1].slow, slowSeconds: lv[1].slowSeconds });
    const w = l.spawnWorry(WORRY, GEO.defense.centerX, []);
    step(l, 1); // 첫 공격
    expect(w.slowTimer).toBeCloseTo(lv[1].slowSeconds!, 6);
    expect(w.slowMult).toBe(lv[1].slow);
    const y0 = w.y;
    step(l, 60);
    expect(w.y - y0).toBeCloseTo(WORRY.speed * (1 - lv[1].slow!) * 1, 1);
  });

  it('오펜스: guardian 반격은 사거리 안 방패병을 먼저 친다', () => {
    const g = day((d) => {
      d.balance.guardian.counterRange = 10000;
      d.stages.stages[0].day.enemies = [];
    });
    merge(g, ROPE, 1); // 올가미병 (먼저 오름)
    merge(g, DOG, 1, 2, 3); // 방패병
    const shield = soldiers(g.abyss).find((u) => u.soldier === 'shield')!;
    const es: CoreEvent[] = [];
    for (let k = 0; k < 600 && !es.some((e) => e.type === 'counter'); k++) es.push(...g.tick(FIXED_DT));
    const [c] = ofType(es, 'counter');
    expect(c.unitId).toBe(shield.id);
  });

  it('피해 집계: 병사 피해는 damageSoldier, 영웅은 damageHero', () => {
    const g = day();
    merge(g, ROPE, 2);
    for (let k = 0; k < 60 * 20; k++) g.tick(FIXED_DT);
    expect(g.stats.damageSoldier).toBeGreaterThan(0);
    expect(g.stats.damageHero).toBeGreaterThan(0);
  });
});

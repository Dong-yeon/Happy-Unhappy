// 시작 영웅 두 명 · 먹이기 · 전투 중 머지 버프 · 쓰러짐 · 영웅 배정 (스펙 §5.17-1~4·8·10, [11]-3, D-045·D-046·D-050)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { makeSaveData, parseSave, serializeGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const B = base.balance;
const DOG = 'companion_animal'; // 떡 (sun, heal, 방패병)
const ROPE = 'comfort_object'; // 동아줄 (moon, momentum, 올가미병)
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(B.merge.soldierCap + 1);
const hero = (id: string) => base.heroes.heroes.find((h) => h.id === id)!;

function fresh(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, SIZE, mulberry32(1), GEO, 1);
}
/** 낮(오펜스) 시작 */
function day(edit: (d: GameData) => void = () => {}): GameState {
  const g = fresh(edit);
  g.confirmDay();
  return g;
}
function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

describe('시작 영웅 (§5.17-1, [11]-3)', () => {
  it('heroes.json 기본 배정: 삽살 = 낮(오펜스), 해태 = 밤(디펜스), 기본 능력치 (구 누이·오라비 수치, D-057)', () => {
    const g = fresh();
    expect(g.heroes.offense.id).toBe('sapsal');
    expect(g.heroes.defense.id).toBe('haetae');
    expect(g.heroStats('offense')).toMatchObject({ hp: 120, atk: 18, atkInterval: 0.9, range: 50, dmgMult: 1 });
    expect(g.heroStats('defense')).toMatchObject({ hp: 160, atk: 14, atkInterval: 1.0, range: 50, dmgMult: 1 });
  });

  it('start.swapHeroes = true면 반대로 배정', () => {
    const g = fresh((d) => (d.balance.start.swapHeroes = true));
    expect([g.heroes.offense.id, g.heroes.defense.id]).toEqual(['haetae', 'sapsal']);
  });

  it('배정: 1-1 dayStart에서만, 양쪽에 한 명씩 (다른 사람이 자동으로 반대 덱), 카드를 닫으면 잠김', () => {
    const g = fresh();
    expect(g.assignHeroes('nobody')).toBe(false);
    expect(g.assignHeroes('haetae')).toBe(true);
    expect([g.heroes.offense.id, g.heroes.defense.id]).toEqual(['haetae', 'sapsal']);
    expect(g.assignHeroes('sapsal')).toBe(true);
    expect([g.heroes.offense.id, g.heroes.defense.id]).toEqual(['sapsal', 'haetae']);
    g.confirmDay();
    expect(g.assignmentDone).toBe(true);
    expect(g.assignHeroes('haetae')).toBe(false); // 판 중 변경은 M8.11
  });

  it('각 단계 시작 시 그 덱 영웅이 레인에 hp 가득 (낮 = 핵 찾아 돌아오기, 밤 = 핵 지키기)', () => {
    const g = day();
    expect(g.abyss.units.map((u) => [u.role, u.chain, u.hp])).toEqual([['hero', 'sapsal', 120]]);
    expect(g.defense.units).toEqual([]);
    g.abyss.units[0].hp = 10;
    g.debugToNight();
    expect(g.abyss.units).toEqual([]);
    expect(g.defense.units.map((u) => [u.role, u.chain, u.hp])).toEqual([['hero', 'haetae', 160]]);
    g.debugEndNight();
    g.nextStage();
    g.confirmDay();
    expect(g.heroUnitOf('offense')!.hp).toBe(120); // 다음 스테이지 낮에도 가득
  });
});

describe('먹이기 (§5.17-2)', () => {
  it('점수 1단계 1 · 2단계 3 · 3단계 7, 조각은 소모, 그 체인 점수에 누적', () => {
    const g = day();
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 2);
    put(g, 2, ROPE, 3);
    expect(g.feed(0, 'offense')).toEqual({ ok: true, points: 1 });
    expect(g.feed(1, 'offense')).toEqual({ ok: true, points: 3 });
    expect(g.feed(2, 'defense')).toEqual({ ok: true, points: 7 });
    expect(g.grid.cells.slice(0, 3)).toEqual([null, null, null]);
    expect(g.heroes.offense.points).toEqual({ [DOG]: 4 });
    expect(g.heroes.defense.points).toEqual({ [ROPE]: 7 });
    expect(g.stats.feeds).toBe(3);
  });

  it('떡: maxHp +6/점, 받는 피해 −0.5%/점 (하한 −40%) / 동아줄: atk +0.8/점, atkInterval −0.6%/점 (하한 0.45초)', () => {
    const g = fresh();
    g.heroes.offense.points = { [DOG]: 10, [ROPE]: 10 };
    const s = g.heroStats('offense');
    const n = hero('sapsal');
    expect(s.hp).toBeCloseTo(n.hp + 60, 9);
    expect(s.dmgMult).toBeCloseTo(1 - 0.05, 9);
    expect(s.atk).toBeCloseTo(n.atk + 8, 9);
    expect(s.atkInterval).toBeCloseTo(n.atkInterval * (1 - 0.06), 9);
    // 하한
    g.heroes.offense.points = { [DOG]: 1000, [ROPE]: 1000 };
    const t = g.heroStats('offense');
    expect(t.dmgMult).toBeCloseTo(1 - B.hero.dmgReduceMax, 9);
    expect(t.atkInterval).toBe(B.hero.atkIntervalMin);
  });

  it('어느 체인이든 어느 영웅에게든, 낮·밤 언제든 양쪽 가능. dayStart·이야기 한 장에서는 못 먹임', () => {
    const g = fresh();
    put(g, 0, DOG, 1);
    expect(g.canFeed(0, 'offense')).toBe('closed');
    g.confirmDay();
    expect(g.canFeed(0, 'defense')).toBeNull();
    expect(g.feed(0, 'defense').ok).toBe(true);
    g.debugToNight();
    put(g, 1, ROPE, 1);
    expect(g.feed(1, 'offense').ok).toBe(true);
    g.debugEndNight();
    put(g, 2, DOG, 1);
    expect(g.canFeed(2, 'offense')).toBe('closed');
  });

  it('와일드카드·빈 칸은 먹일 수 없다', () => {
    const g = day();
    g.grid.cells.fill(null);
    put(g, 0, WILDCARD, 0);
    expect(g.feed(0, 'offense')).toEqual({ ok: false, reason: 'wildcard' });
    expect(g.feed(1, 'offense')).toEqual({ ok: false, reason: 'empty' });
    expect(g.grid.cells[0]).not.toBeNull();
  });

  it('레인 위 영웅에게 먹이면 바로 반영 (늘어난 maxHp만큼 hp도)', () => {
    const g = day();
    const u = g.heroUnitOf('offense')!;
    u.hp = 100;
    put(g, 0, DOG, 3);
    g.feed(0, 'offense');
    expect(u.maxHp).toBe(hero('sapsal').hp + 42);
    expect(u.hp).toBe(142);
    expect(u.dmgMult).toBeCloseTo(1 - 7 * 0.005, 9);
  });
});

describe('전투 중 머지 버프 (§5.17-3, [11]-2)', () => {
  /** 병사 없이 버프만 보려고 */
  const noSoldier = (d: GameData) => (d.balance.merge.soldiers = false);

  it('떡 머지(낮): 지금 싸우는 영웅 즉시 회복 maxHp × 3% × 때 맞춤(낮·sun = ×1.5)', () => {
    const g = day(noSoldier);
    const u = g.heroUnitOf('offense')!;
    u.hp = 50;
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    expect(g.drop(0, 1)).toBe('merge');
    expect(u.hp).toBeCloseTo(50 + u.maxHp * B.buff.healPct * B.merge.affinityMult, 9);
    const [b] = ofType(g.tick(0), 'buff');
    expect(b).toMatchObject({ role: 'offense', kind: 'heal', affinity: true });
  });

  it('떡 머지(밤 = 때 아님): 기본 3%, 결과 3단계면 ×2', () => {
    const g = day(noSoldier);
    g.debugToNight();
    const u = g.heroUnitOf('defense')!;
    u.hp = 10;
    g.grid.cells.fill(null);
    put(g, 0, DOG, 2);
    put(g, 1, DOG, 2);
    g.drop(0, 1);
    expect(u.hp).toBeCloseTo(10 + u.maxHp * B.buff.healPct * B.buff.tier3Mult, 9);
  });

  it('동아줄 머지: 기세 +1중첩 atk +5% (밤 = moon 때 맞춤 ×1.5), 6초, 새 중첩마다 갱신, 최대 8중첩, 3단계 결과면 2중첩', () => {
    const g = day(noSoldier);
    g.debugToNight();
    const u = g.heroUnitOf('defense')!;
    const atk = g.heroStats('defense').atk;
    g.grid.cells.fill(null);
    put(g, 0, ROPE, 1);
    put(g, 1, ROPE, 1);
    g.drop(0, 1);
    const m = g.heroes.defense.momentum;
    expect(m.stacks).toBe(1);
    expect(u.atk).toBeCloseTo(atk * (1 + B.buff.momentumAtkPct * B.merge.affinityMult), 9);
    expect(m.timer).toBe(B.buff.momentumSeconds);
    put(g, 0, ROPE, 2);
    put(g, 2, ROPE, 2);
    g.drop(0, 2);
    expect(m.stacks).toBe(3); // 3단계 결과 = 2중첩
    for (let k = 0; k < 10; k++) {
      put(g, 5, ROPE, 1);
      put(g, 6, ROPE, 1);
      g.drop(5, 6);
      g.grid.cells[6] = null;
    }
    expect(m.stacks).toBe(B.buff.momentumMaxStacks);
  });

  it('기세 만료: 마지막 중첩 뒤 6초가 지나면 모두 사라지고 atk 원래대로', () => {
    const g = day(noSoldier);
    g.debugToNight();
    const u = g.heroUnitOf('defense')!;
    const atk = g.heroStats('defense').atk;
    put(g, 0, ROPE, 1);
    put(g, 1, ROPE, 1);
    g.grid.cells.fill(null, 2);
    g.drop(0, 1);
    for (let k = 0; k < Math.round(B.buff.momentumSeconds * 60) - 2; k++) g.tick(FIXED_DT);
    expect(g.heroes.defense.momentum.stacks).toBe(1);
    for (let k = 0; k < 4; k++) g.tick(FIXED_DT);
    expect(g.heroes.defense.momentum.stacks).toBe(0);
    if (g.heroUnitOf('defense')) expect(u.atk).toBeCloseTo(atk, 9);
  });

  it('전투 밖(dayStart·이야기 한 장) 머지는 버프·병사 없음', () => {
    const g = fresh();
    g.grid.cells.fill(null);
    put(g, 0, DOG, 1);
    put(g, 1, DOG, 1);
    expect(g.drop(0, 1)).toBe('merge');
    expect(g.stats.battleMerges).toBe(0);
    expect(ofType(g.tick(0), 'buff')).toEqual([]);
  });

  it('와일드카드가 낀 머지 = 결과 체인 기준', () => {
    const g = day(noSoldier);
    g.grid.cells.fill(null);
    put(g, 0, WILDCARD, 0);
    put(g, 1, ROPE, 1);
    g.drop(0, 1);
    expect(g.heroes.offense.momentum.stacks).toBe(1); // 동아줄 = 기세
  });
});

describe('쓰러짐 (§5.17-10)', () => {
  it('낮 가는 길(guardian 전) 영웅 hp 0 → 그 낮 실패 → 밤 없이 같은 스테이지 장면 카드 (§5.19-2)', () => {
    const g = day();
    for (let k = 0; k < 60; k++) g.tick(FIXED_DT);
    g.heroUnitOf('offense')!.hp = 0;
    const es = g.tick(FIXED_DT);
    const [f] = ofType(es, 'attemptFail');
    expect(f).toMatchObject({ stage: 1, reason: 'dayFall' });
    expect(g.phase).toBe('dayStart');
    expect(g.retry).toBe('dayFall');
    expect(g.stage).toBe(1);
    expect(g.stats.offenseFalls).toBe(1);
    expect(g.stats.dayFailFall).toBe(1);
  });

  it('밤(디펜스) 영웅 hp 0 → reviveSeconds(8초) 뒤 hp × 50%로 일어남, 쓰러진 동안 레인에 없음', () => {
    const g = day();
    g.debugToNight();
    g.debugKnockDefenseHero();
    const [d] = ofType(g.tick(FIXED_DT), 'heroDown');
    expect(d.seconds).toBe(B.hero.reviveSeconds);
    expect(g.heroUnitOf('defense')).toBeNull();
    expect(g.defenseDown).toBeGreaterThan(0);
    const es: CoreEvent[] = [];
    for (let k = 0; k < Math.round(B.hero.reviveSeconds * 60) + 2; k++) es.push(...g.tick(FIXED_DT));
    const [up] = ofType(es, 'heroEnter');
    expect(up).toMatchObject({ role: 'defense', revive: true });
    const u = g.heroUnitOf('defense')!;
    expect(u.hp).toBeLessThanOrEqual(u.maxHp * B.hero.reviveHpRatio + 1e-9);
    expect(g.stats.defenseFalls).toBe(1);
    expect(g.phase).toBe('night');
  });
});

describe('저장·결정성 (§5.17-8)', () => {
  it('영웅 점수·배정·기세가 저장 round-trip, 옛 저장(v3)은 초기화', () => {
    const g = fresh();
    g.assignHeroes('haetae');
    g.confirmDay();
    put(g, 0, DOG, 3);
    g.feed(0, 'defense');
    g.debugToNight();
    g.debugEndNight();
    const save = serializeGame(g);
    expect(save.heroes).toEqual(g.heroes);
    expect(save.assignmentDone).toBe(true);
    const raw = JSON.stringify(makeSaveData(SIZE, save, 'x'));
    const r = parseSave(raw, base, SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = GameState.fromSave(base, r.save.game!, mulberry32(1), GEO, SIZE);
    expect(back.heroes).toEqual(g.heroes);
    expect(back.heroStats('defense')).toEqual(g.heroStats('defense'));
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(save));
    const v2 = JSON.parse(raw);
    v2.version = 3;
    expect(parseSave(JSON.stringify(v2), base, SIZE).ok).toBe(false);
    const same = JSON.parse(raw);
    same.game.heroes.defense.id = same.game.heroes.offense.id;
    expect(parseSave(JSON.stringify(same), base, SIZE).ok).toBe(false); // 양쪽 최소 1명
  });

  it('큰 dt와 작은 dt가 같은 결과 (먹이기·머지·병사 포함)', () => {
    const play = (dt: number) => {
      const g = day();
      g.grid.cells.fill(null);
      put(g, 0, DOG, 1);
      put(g, 1, DOG, 1);
      put(g, 2, ROPE, 2);
      g.drop(0, 1);
      g.feed(2, 'offense');
      const n = Math.round(30 / dt);
      for (let k = 0; k < n; k++) g.tick(dt);
      return { tick: g.tickCount, guardian: g.abyss.guardian.hp, units: g.abyss.units.map((u) => [u.id, u.hp, u.y]), stats: { ...g.stats } };
    };
    expect(play(1)).toEqual(play(FIXED_DT));
  });
});

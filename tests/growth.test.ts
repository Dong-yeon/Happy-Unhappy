// M8.12 영웅 성장 (§5.22-9): 잉크 시간 누적·상한·시계 되돌림 / 잉크 → 경험치 / 진급 비용·★별 스킬 값·게이지 / 적성 배율 /
// Lv10·3★ 칸 / 비법서 장착 배타·전투 중 변경 재시작 / 시작형 발동 시점 / 상시형 1회 버팀 / 챕터 완성 → 비법서 2권 /
// 10장 흠집 없음 → 숨은 비법서 / 다시 읽기 흐름·난이도·보상 / 세션 모델 시뮬 결정성
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { FIXED_DT, damageUnit } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { levelNeed, skillAtStar } from '../src/core/roster';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { runOne } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const base = structuredClone(rawGameData) as unknown as GameData;
const B = base.balance;
const H = 3_600_000;
const hero = (id: string) => base.heroes.heroes.find((h) => h.id === id)!;

function quiet(d: GameData): void {
  d.balance.spawn.autoInterval = 1e6;
  d.balance.spawn.killDropChance = 0;
}
function calm(d: GameData): void {
  quiet(d);
  for (const st of d.stages.stages) {
    st.day.enemies = [];
    st.day.chase = [];
    st.day.guardianHp = 1e9;
  }
  d.balance.guardian.counterAtk = 0;
}
function fresh(edit: (d: GameData) => void = quiet): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize), 1);
}
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) => es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);
/** 디버그로 한 스테이지 성공 (밤 HP는 hp로) */
function clear(g: GameState, hp = B.core.hp): CoreEvent[] {
  g.confirmDay();
  g.debugToNight();
  if (g.phase === 'night') {
    g.coreHp = hp;
    g.debugEndNight();
  }
  const es = g.tick(0);
  if (g.phase === 'diary') g.nextStage();
  return es;
}
/** 챕터를 끝까지 (stage별 밤 HP) */
function finish(g: GameState, hp: (stage: number) => number = () => B.core.hp): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < B.chapter.length; k++) out.push(...clear(g, hp(g.stage)));
  return out;
}

describe('잉크 (§5.22-2)', () => {
  it(`실제 시간 시간당 ${B.ink.perHour}, 시간 누적 상한 ${B.ink.perHour * B.ink.capHours}, 시계 되돌림 = 0`, () => {
    const g = fresh();
    expect(g.accrueInk(1000)).toBe(0); // 처음은 기준 시각만
    expect(g.accrueInk(1000 + 2 * H)).toBeCloseTo(2 * B.ink.perHour, 9);
    expect(g.accrueInk(1000 + 100 * H)).toBeCloseTo(g.inkCap - 2 * B.ink.perHour, 9);
    expect(g.ink).toBeCloseTo(g.inkCap, 9);
    expect(g.accrueInk(1000 + 200 * H)).toBe(0); // 상한
    g.ink = 0;
    expect(g.accrueInk(1000)).toBe(0); // 시계 되돌림
    expect(g.inkAt).toBe(1000);
    expect(g.accrueInk(1000 + H / 2)).toBeCloseTo(B.ink.perHour / 2, 9); // 되돌린 시각부터 다시
    expect(g.stats.inkTime).toBeCloseTo(g.inkCap + B.ink.perHour / 2, 9);
  });

  it('첫 클리어 보상: 보통 장 / 보스 장(1-5) / 마지막 장(1-10), 다시 깨면 없음', () => {
    const g = fresh(calm);
    const es = finish(g);
    const rewards = ofType(es, 'stageReward');
    expect(rewards).toHaveLength(B.chapter.length);
    expect(rewards[0]).toMatchObject({ stage: 1, ink: B.ink.firstClear, dust: B.star.dustFirstClear });
    expect(rewards[4]).toMatchObject({ stage: 5, ink: B.ink.bossClear, dust: B.star.dustBoss });
    expect(rewards[9]).toMatchObject({ stage: 10, ink: B.ink.finalClear, dust: B.star.dustFinal });
    expect(g.stardust).toBe(8 * B.star.dustFirstClear + B.star.dustBoss + B.star.dustFinal);
  });

  it(`잉크 붓기: 잉크 1 = 경험치 ${B.ink.expPerInk}, 다음 레벨까지 필요량, 전투 중에는 안 됨`, () => {
    const g = fresh();
    g.ink = 100;
    expect(g.inkToNext('sapsal')).toBe(Math.ceil(levelNeed(B.exp, 1) / B.ink.expPerInk));
    expect(g.pourInk('sapsal', B.ink.pourStep)).toEqual({ spent: B.ink.pourStep, levels: 1 }); // 10 × 2 = 20 = 1레벨
    expect(g.progressOf('sapsal')).toMatchObject({ level: 2, exp: 0 });
    expect(g.ink).toBe(100 - B.ink.pourStep);
    expect(g.pourInk('sapsal', 1000).spent).toBe(90); // 가진 만큼만
    g.ink = 50;
    g.confirmDay();
    expect(g.pourInk('sapsal', 10)).toEqual({ spent: 0, levels: 0 });
    expect(g.stats.inkSpent).toBe(100);
  });
});

describe('성급 (§5.22-3)', () => {
  it(`진급 비용 ${B.star.cost.join('/')}, ★은 고유 스킬만 (perStar, §5.23-0 보정), 게이지 20/17/14/12/10`, () => {
    const g = fresh();
    g.stardust = 1000;
    const hp1 = g.heroStats('sapsal').hp;
    const costs: number[] = [];
    for (let k = 0; k < 4; k++) {
      costs.push(g.promoteCost('sapsal')!);
      expect(g.promote('sapsal')).toBe(true);
    }
    expect(costs).toEqual(B.star.cost);
    expect(g.promoteCost('sapsal')).toBeNull();
    expect(g.promote('sapsal')).toBe(false);
    expect(g.stardust).toBe(1000 - costs.reduce((a, b) => a + b, 0));
    expect(g.heroStats('sapsal').hp).toBe(hp1); // 능력치는 그대로
    expect(g.skillOf('sapsal')).toMatchObject({ kind: 'strike', mult: 8, pierce: 4, gauge: 10 });
    expect([1, 2, 3, 4, 5].map((s) => skillAtStar(hero('sapsal'), s).gauge)).toEqual([20, 17, 14, 12, 10]);
    expect(skillAtStar(hero('haetae'), 3)).toMatchObject({ stunSeconds: 2.5, shieldPct: 0.3 });
    expect(skillAtStar(hero('nui'), 2)).toMatchObject({ mult: 2.7 });
    expect(skillAtStar(hero('orabi'), 4)).toMatchObject({ healPct: 0.45, revive: 2 });
    expect(skillAtStar(hero('orabi'), 5)).toMatchObject({ healPct: 0.55, revive: 3 });
  });

  it('별가루가 모자라면·전투 중이면 진급 안 됨, ★ 게이지가 실제 발동에 쓰인다', () => {
    const g = fresh(calm);
    g.stardust = 4;
    expect(g.promote('sapsal')).toBe(false);
    g.stardust = 1000;
    for (let k = 0; k < 4; k++) g.promote('sapsal');
    g.confirmDay();
    expect(g.promote('haetae')).toBe(false);
    g.tick(0);
    g.progressOf('sapsal').gauge = 7;
    g.grid.cells[0] = g.newPiece('bone', 1);
    g.grid.cells[1] = g.newPiece('bone', 1);
    g.drop(0, 1); // +3 → 10 ≥ 10 (5★) → 발동
    expect(ofType(g.tick(0), 'skill')).toHaveLength(1);
  });
});

describe('적성 (§5.22-4)', () => {
  it('공격대 = 낮 적성, 수비대 = 밤 적성 배율 (maxHp·atk)', () => {
    const g = fresh();
    const lv = (id: string) => hero(id);
    expect(lv('sapsal').aptitude).toEqual({ day: 'S', night: 'B' });
    expect(lv('haetae').aptitude).toEqual({ day: 'B', night: 'S' });
    expect(lv('nui').aptitude).toEqual({ day: 'S', night: 'A' });
    expect(lv('orabi').aptitude).toEqual({ day: 'A', night: 'S' });
    expect(g.heroStats('sapsal', 'offense').hp).toBeCloseTo(lv('sapsal').hp * B.aptitude.S, 9);
    expect(g.heroStats('sapsal', 'defense').atk).toBeCloseTo(lv('sapsal').atk * B.aptitude.B, 9);
    g.confirmDay();
    g.tick(0);
    expect(g.heroUnit('sapsal')!.maxHp).toBeCloseTo(lv('sapsal').hp * B.aptitude.S, 9);
    g.debugToNight();
    expect(g.heroUnit('haetae')!.maxHp).toBeCloseTo(lv('haetae').hp * B.aptitude.S, 9);
  });
});

describe('배우는 칸 · 비법서 (§5.22-5)', () => {
  function withBooks(edit: (d: GameData) => void = calm): GameState {
    const g = fresh(edit);
    g.debugGrantBooks();
    g.tick(0);
    return g;
  }

  it(`칸: Lv ${B.learn.levelSlot}에 1칸, ${B.learn.starSlot}★에 1칸 더`, () => {
    const g = withBooks();
    expect(g.slotsOf('sapsal')).toBe(0);
    expect(g.equip('sapsal', 0, 'sturdy_rope')).toMatchObject({ ok: false });
    g.progressOf('sapsal').level = B.learn.levelSlot;
    expect(g.slotsOf('sapsal')).toBe(1);
    g.progressOf('sapsal').star = B.learn.starSlot;
    expect(g.slotsOf('sapsal')).toBe(2);
  });

  it('한 권 = 한 영웅 (다른 영웅이 끼고 있으면 옮겨 옴), 없는 비법서는 안 됨', () => {
    const g = withBooks();
    for (const id of ['sapsal', 'haetae']) g.progressOf(id).level = 10;
    expect(g.equip('sapsal', 0, 'sturdy_rope')).toEqual({ ok: true, restarted: false });
    expect(g.equip('haetae', 0, 'sturdy_rope')).toEqual({ ok: true, restarted: false });
    expect(g.booksOf('sapsal')).toEqual([]);
    expect(g.booksOf('haetae')).toEqual(['sturdy_rope']);
    expect(g.bookHolder('sturdy_rope')).toBe('haetae');
    const h = fresh();
    h.progressOf('sapsal').level = 10;
    expect(h.equip('sapsal', 0, 'sturdy_rope')).toMatchObject({ ok: false });
  });

  it('전투 중 바꾸면 단계 재시작 (편성 변경처럼)', () => {
    const g = withBooks();
    g.progressOf('sapsal').level = 10;
    g.confirmDay();
    for (let k = 0; k < 120; k++) g.tick(FIXED_DT);
    expect(g.equip('sapsal', 0, 'share_rice_cake')).toEqual({ ok: true, restarted: true });
    expect(ofType(g.tick(0), 'formationRestart')).toHaveLength(1);
    expect(g.offenseTimer).toBe(B.offense.seconds);
  });

  it('시작형은 팀이 레인에 나갈 때 발동: 낮 출발 · 밤 시작 · 밤 구간 교대 · 전멸 교대', () => {
    const g = withBooks();
    g.debugGrantAllHeroes();
    g.tick(0);
    for (const id of g.owned) g.progressOf(id).level = 10;
    g.setFormation({ offense: [['sapsal'], ['nui']], defense: [['haetae'], ['orabi']] });
    g.equip('sapsal', 0, 'promise_sun_moon');
    g.equip('orabi', 0, 'share_rice_cake');
    g.confirmDay();
    const day = g.tick(0);
    expect(ofType(day, 'bookSkill')).toEqual([{ type: 'bookSkill', role: 'offense', heroId: 'sapsal', bookId: 'promise_sun_moon' }]);
    expect(g.progressOf('sapsal').gauge).toBeCloseTo(g.skillOf('sapsal').gauge * 0.5, 9);
    g.debugToNight();
    expect(ofType(g.tick(0), 'bookSkill')).toHaveLength(0); // 수비대 1팀(해태)은 비법서 없음
    g.debugKnockDefenseHero();
    const swap = g.tick(FIXED_DT);
    expect(ofType(swap, 'teamSwap')).toHaveLength(1);
    const sb = ofType(swap, 'bookSkill');
    expect(sb).toEqual([{ type: 'bookSkill', role: 'defense', heroId: 'orabi', bookId: 'share_rice_cake' }]);
    const u = g.heroUnit('orabi')!;
    expect(u.shield).toBeCloseTo(u.maxHp * 0.1, 9);
    for (let k = 0; k < Math.round(2.1 / FIXED_DT); k++) g.tick(FIXED_DT);
    expect(g.heroUnit('orabi')?.shield ?? 0).toBeLessThan(u.maxHp * 0.1); // 2초 보호막이 걷힘 (또는 맞아서 줄어듦)
  });

  it('상시형(튼튼한 동아줄): 단계마다 한 번 쓰러질 피해를 hp 1로 버팀', () => {
    const g = withBooks();
    g.progressOf('sapsal').level = 10;
    g.equip('sapsal', 0, 'sturdy_rope');
    g.confirmDay();
    g.tick(0);
    const u = g.heroUnit('sapsal')!;
    expect(u.endure).toBe(true);
    // 큰 피해 → hp 1 (적의 공격과 같은 core 함수)
    u.hp = 5;
    g.abyss.enemies.length = 0;
    const raw = 1000;
    damageUnit(u, raw);
    expect(u.hp).toBe(1);
    expect(u.endure).toBe(false);
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'bookSkill')[0]).toMatchObject({ heroId: 'sapsal', bookId: 'sturdy_rope' });
    damageUnit(u, raw);
    expect(u.hp).toBeLessThanOrEqual(0); // 두 번째는 못 버팀
  });
});

describe('비법서 얻기 · 흠집 없음 (§5.22-5·6)', () => {
  it('챕터 완성 → 이야기 비법서 2권, 흠집 있는 장이 있으면 숨은 비법서 없음', () => {
    const g = fresh(calm);
    const es = finish(g, (st) => (st === 3 ? 50 : B.core.hp));
    expect(g.phase).toBe('chapterComplete');
    expect(ofType(es, 'booksGained').map((e) => e.source)).toEqual(['chapter']);
    expect(g.ownedBooks).toEqual(['share_rice_cake', 'sturdy_rope']);
    expect(g.perfect).not.toContain(3);
    expect(g.perfect).toHaveLength(9);
  });

  it('흠집 있던 장을 다시 읽어 핵 HP 가득으로 지키면 흠집 없음 → 10장 모두 → 숨은 비법서', () => {
    const g = fresh(calm);
    finish(g, (st) => (st === 3 ? 50 : B.core.hp));
    expect(g.startReplay(3)).toBe(true);
    g.confirmDay();
    g.debugToNight();
    g.coreHp = B.core.hp;
    g.debugEndNight();
    const es = g.tick(0);
    expect(ofType(es, 'perfectPage')[0]).toMatchObject({ stage: 3 });
    expect(ofType(es, 'booksGained')[0]).toMatchObject({ source: 'perfect', ids: ['promise_sun_moon'] });
    expect(g.perfect).toHaveLength(10);
  });
});

describe('다시 읽기 (§5.22-6)', () => {
  it('챕터 완성 뒤에만, 그 장 하나(낮 + 밤) → 성공하면 잉크 + 챕터 완성 화면으로, 별가루·첫 클리어 보상 없음', () => {
    const g = fresh(calm);
    expect(g.startReplay(2)).toBe(false);
    finish(g);
    const ink = g.ink;
    const dust = g.stardust;
    const att = [...g.attempts];
    expect(g.startReplay(2)).toBe(true);
    expect(g.tick(0).some((e) => e.type === 'stageStart')).toBe(true);
    expect(g.phase).toBe('dayStart');
    expect(g.stage).toBe(2);
    g.confirmDay();
    g.debugToNight();
    g.debugEndNight();
    const es = g.tick(0);
    expect(ofType(es, 'replayEnd')[0]).toMatchObject({ stage: 2, success: true, ink: B.ink.replayWin });
    expect(ofType(es, 'stageReward')).toHaveLength(0);
    expect(g.ink).toBeCloseTo(ink + B.ink.replayWin, 9);
    expect(g.stardust).toBe(dust);
    expect(g.phase).toBe('chapterComplete');
    expect(g.replay).toBeNull();
    expect(g.attempts).toEqual(att); // 판 진행 시도 수는 그대로
    expect(g.stats.replayAttempts).toBe(1);
    expect(g.attemptLog[g.attemptLog.length - 1].replay).toBe(1);
  });

  it(`난이도: 적 hp·atk · guardian hp·반격 × ${B.replay.difficultyMult}, 실패하면 같은 장 다시 · 그만 읽기`, () => {
    const g = fresh(quiet);
    finish(g);
    g.startReplay(4);
    g.confirmDay();
    const st = base.stages.stages[3];
    expect(g.abyss.guardian.hp).toBeCloseTo(st.day.guardianHp * B.replay.difficultyMult, 6);
    const n = fresh(quiet);
    n.debugSetStage(4);
    n.confirmDay();
    const e0 = n.abyss.enemies[0];
    const e1 = g.abyss.enemies[0];
    expect(e1.maxHp).toBeCloseTo(e0.maxHp * B.replay.difficultyMult, 6);
    expect(e1.atk).toBeCloseTo(e0.atk * B.replay.difficultyMult, 6);
    g.debugFail();
    expect(g.phase).toBe('dayStart');
    expect(g.replay).toBe(4);
    expect(g.exitReplay()).toBe(true);
    expect(g.phase).toBe('chapterComplete');
    expect(ofType(g.tick(0), 'replayEnd')[0]).toMatchObject({ success: false });
  });

  it('다시 읽기 중 경계 저장 round-trip (잉크·별가루·비법서·장착·흠집 없음·다시 읽기)', async () => {
    const { serializeGame, parseSave, makeSaveData } = await import('../src/core/save');
    const g = fresh(calm);
    finish(g);
    g.progressOf('haetae').level = 10;
    g.equip('haetae', 0, 'sturdy_rope');
    g.accrueInk(5000);
    g.startReplay(5);
    g.tick(0);
    const s = serializeGame(g);
    const r = parseSave(JSON.stringify(makeSaveData({ cols: 5, rows: 4 }, s, 'x')), g['data'] as GameData, { cols: 5, rows: 4 });
    expect(r.ok).toBe(true);
    const back = GameState.fromSave(g['data'] as GameData, JSON.parse(JSON.stringify(s)), mulberry32(1), gameGeometry(B.merge.soldierCap + B.team.teamSize), { cols: 5, rows: 4 });
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(s));
    expect(back).toMatchObject({ replay: 5, inkAt: 5000, stardust: g.stardust });
    expect(back.booksOf('haetae')).toEqual(['sturdy_rope']);
  });
});

describe('세션 모델 시뮬 (§5.22-8)', () => {
  const cfg = simJson as SimConfig;
  const opt = { seed: 3, grid: { cols: 5, rows: 4 }, maxAttempts: 14, session: { attempts: 6, offlineHours: 8 } };

  it('같은 시드 → 같은 결과, 쉴 때마다 세션 + 1·잉크 시간 누적, noInk는 잉크를 안 쓴다', () => {
    const a = runOne(base, cfg, POLICIES.balanced, opt);
    expect(runOne(base, cfg, POLICIES.balanced, opt)).toEqual(a);
    expect(a.sessions).toBe(1 + Math.floor((Math.min(a.attempts, 14) - 1) / 6));
    if (a.sessions > 1) expect(a.inkTime).toBeGreaterThan(0);
    expect(a.inkSpent).toBeGreaterThan(0);
    const n = runOne(base, cfg, POLICIES.noInk, opt);
    expect(n.inkSpent).toBe(0);
    const s = runOne(base, cfg, POLICIES.noStar, opt);
    expect(s.promotions).toBe(0);
  });

  it('dayHeavy는 공격대에만, nightHeavy는 수비대에만 잉크·별가루', () => {
    const d = runOne(base, cfg, POLICIES.dayHeavy, opt);
    expect(d.levels.haetae).toBeLessThan(d.levels.sapsal);
    const n = runOne(base, cfg, POLICIES.nightHeavy, opt);
    expect(n.levels.sapsal).toBeLessThan(n.levels.haetae);
  });
});

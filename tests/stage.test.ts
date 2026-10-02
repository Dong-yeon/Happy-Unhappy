// 스테이지 = 낮(핵 찾아 돌아오기) + 밤(핵 지키기) (스펙 §5.19, D-053·D-054·D-055) — §5.19-7 테스트 목록
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { Expedition, type ExpeditionEvent } from '../src/core/expedition';
import { GameState, enemyStats, type CoreEvent } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const B = base.balance;
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(B.merge.soldierCap + B.team.teamSize);
const DOG = 'companion_animal';

function fresh(edit: (d: GameData) => void = () => {}, seed = 1): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, SIZE, mulberry32(seed), GEO, seed);
}
/** 장면 카드를 닫고 영웅이 이야기책을 떠날 때까지 (이야기책에서 핵을 얻으면 바로 도착이라) */
function setOut(g: GameState): void {
  g.confirmDay();
  g.tick(2);
}
/** 적 없는 스테이지 (낮 규칙만 보려고) */
const noEnemies = (d: GameData) => {
  for (const s of d.stages.stages) {
    s.day.enemies = [];
    s.day.chase = [];
  }
};
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);
/** 조건이 맞을 때까지 틱 (최대 seconds초), 그동안의 이벤트 */
function until(g: GameState, cond: () => boolean, seconds = 200): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < seconds * 60 && !cond(); k++) out.push(...g.tick(FIXED_DT));
  return out;
}
function clearStage(g: GameState): void {
  g.confirmDay();
  g.debugToNight();
  g.debugEndNight();
}

describe('낮 — 핵 찾아 돌아오기 (§5.19-2)', () => {
  it('guardian HP 0 → 핵 획득: 맨 앞 영웅이 운반자 (핵 카드 이벤트)', () => {
    const g = fresh(noEnemies);
    setOut(g);
    g.debugKillGuardian();
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'guardianDown')).toHaveLength(1);
    expect(ofType(es, 'corePick')[0]).toMatchObject({ unitId: g.heroUnitOf('offense')!.id, first: true });
    expect(ofType(es, 'coreFound')[0]).toMatchObject({ stage: 1 });
    expect(g.abyss.carrier?.role).toBe('hero');
    expect(g.coreState.state).toBe('carrying');
  });

  it('운반자는 speedMult로 이야기책까지 → 도착 = 낮 성공 → 해질녘(밤, 핵 HP 가득)', () => {
    const g = fresh(noEnemies);
    setOut(g);
    g.debugKillGuardian();
    g.tick(FIXED_DT);
    const u = g.abyss.carrier!;
    const y0 = u.y;
    g.tick(1);
    expect(u.y - y0).toBeCloseTo(B.lane.abyssAdvanceSpeed * B.carry.speedMult, 4);
    const es = until(g, () => g.phase !== 'day');
    expect(ofType(es, 'coreHome')).toHaveLength(1);
    expect(ofType(es, 'dusk')).toHaveLength(1);
    expect(g.phase).toBe('night');
    expect(g.coreHp).toBe(B.core.hp);
    expect(g.coreState).toEqual({ state: 'hut' });
  });

  it('운반 중 쓰러짐 → 핵 떨어짐 → (낮 쓰러짐은 안 일어남) 다음 팀이 이야기책에서 나와 그 핵을 다시 든다 (§5.20-3)', () => {
    const g = fresh(noEnemies);
    g.debugGrantAllHeroes();
    g.tick(0);
    expect(g.setFormation({ offense: [['sapsal'], ['nui']], defense: [['haetae']] }).ok).toBe(true);
    setOut(g);
    g.debugKillGuardian();
    g.tick(FIXED_DT);
    g.tick(2);
    const fallY = g.abyss.carrier!.y;
    g.abyss.carrier!.hp = 0;
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'coreDrop')[0].y).toBeCloseTo(fallY, 6);
    expect(ofType(es, 'heroDown')[0]).toMatchObject({ role: 'offense', heroId: 'sapsal', seconds: 0 });
    expect(ofType(es, 'teamSwap')[0]).toMatchObject({ role: 'offense', team: 1, reason: 'wipe' });
    expect(g.phase).toBe('day');
    expect(g.abyss.core).toEqual({ at: 'dropped', y: fallY });
    const up = until(g, () => g.abyss.core.at === 'carried', 30);
    expect(ofType(up, 'corePick')[0]).toMatchObject({ first: false });
    expect(g.abyss.carrier!.chain).toBe('nui');
    expect(g.heroUnit('sapsal')).toBeNull();
    expect(g.stats.coreDrops).toBe(1);
  });

  it('팀이 하나뿐이면 운반자 쓰러짐 = 낮 실패 (dayFall)', () => {
    const g = fresh(noEnemies);
    setOut(g);
    g.debugKillGuardian();
    g.tick(FIXED_DT);
    g.abyss.carrier!.hp = 0;
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'attemptFail')[0]).toMatchObject({ reason: 'dayFall' });
  });

  it('가는 길 시간 초과 → 핵 못 가져옴 → 밤 없이 같은 스테이지 낮 다시 (dayTime)', () => {
    const g = fresh((d) => {
      noEnemies(d);
      d.stages.stages[0].day.guardianHp = 1e9;
      d.balance.guardian.counterAtk = 0;
    });
    g.confirmDay();
    const es = until(g, () => g.phase !== 'day', B.offense.seconds + 1);
    expect(ofType(es, 'dusk')).toHaveLength(0);
    expect(ofType(es, 'attemptFail')[0]).toMatchObject({ stage: 1, reason: 'dayTime' });
    expect(g.phase).toBe('dayStart');
    expect(g.stage).toBe(1);
    expect(g.retry).toBe('dayTime');
    expect(g.attempts[0]).toBe(1);
  });

  it('돌아오는 길 시간 초과 → returnTime (밤 없음)', () => {
    const g = fresh((d) => {
      noEnemies(d);
      d.balance.carry.speedMult = 0.01;
    });
    setOut(g);
    g.debugKillGuardian();
    const es = until(g, () => g.phase !== 'day', B.offense.seconds + 1);
    expect(ofType(es, 'attemptFail')[0].reason).toBe('returnTime');
    expect(g.stats.returnFails).toBe(1);
  });

  it('보스 스테이지(1-5) 핵을 가져오면 와일드카드, 반격 × bossCounterMult', () => {
    const g = fresh(noEnemies);
    g.debugSetStage(5);
    g.confirmDay();
    expect(g.abyss.guardian).toMatchObject({ type: 'mitten', boss: true, atk: B.guardian.counterAtk * B.guardian.bossCounterMult });
    g.debugToNight();
    const es = g.tick(0);
    expect(ofType(es, 'bossReward')[0].rewards).toHaveLength(B.guardian.bossWildcards);
  });

  it('적 능력치 = base × 종류 배수, HP × hpGrowthPerStage^(스테이지−1) × 떼 hpMult (보스는 × 1, §5.20-13)', () => {
    const s = enemyStats(base, 'wildcat', 3);
    expect(s.hp).toBeCloseTo(base.monsters.base.hp * 0.6 * Math.pow(B.enemy.hpGrowthPerStage, 2) * B.swarm.hpMult, 9);
    expect(s.speed).toBeCloseTo(base.monsters.base.speed * 1.6, 9);
    expect(enemyStats(base, 'wildcat', 3, false).hp).toBeCloseTo(base.monsters.base.hp * 0.6 * Math.pow(B.enemy.hpGrowthPerStage, 2), 9);
  });
});

describe('Expedition 레인 규칙 (§5.19-2)', () => {
  const geo = GEO.abyss;
  const cfg = {
    advanceSpeed: 30,
    carry: { speedMult: 0.7, atkIntervalMult: 1.3, chaseInterval: 1.5, pickupRange: 8, chaseSpeedMult: 1.3, staggerSeconds: 0.2 },
    escort: { range: 80, speed: 60, contact: 8 },
    maxEnemies: 30,
  };
  const shadow = { type: 'shadow', hp: 1000, speed: 40, atk: 0, atkInterval: 1 };
  const guardian = { type: 'shadow', hp: 0, atk: 0, atkInterval: 1, range: 0, boss: false };
  const heroStats = { hp: 100, atk: 0, atkInterval: 1, range: 10 };

  function step(ex: Expedition, n: number): ExpeditionEvent[] {
    const out: ExpeditionEvent[] = [];
    for (let k = 0; k < n; k++) ex.step(FIXED_DT, out, mulberry32(1));
    return out;
  }

  it('떨어진 핵은 다른 영웅이 닿으면 든다 (병사는 들 수 없다)', () => {
    const ex = new Expedition(geo, cfg);
    ex.reset({ ...guardian, hp: 1 }, [], [], mulberry32(1));
    const mid = geo.wallY + 150;
    ex.addUnit(1, 'unhappy', 'sapsal', 0, heroStats, { role: 'hero', y: mid + 40 });
    const soldier = ex.addUnit(2, 'unhappy', DOG, 1, heroStats, { role: 'soldier', soldier: 'shield', y: mid });
    ex.guardianDown = true;
    ex.guardian.hp = 0;
    ex.core = { at: 'dropped', y: mid };
    step(ex, 1);
    expect(ex.core.at).toBe('dropped'); // 병사 위에 있어도 안 든다
    expect(soldier!.y).toBeLessThan(mid + 40);
    const es = step(ex, 120);
    expect(es.some((e) => e.type === 'corePick' && e.unitId === 1)).toBe(true);
    expect(ex.carrier?.id).toBe(1);
  });

  it('적이 떨어진 핵에 닿으면 레인 끝(guardian 자리)으로 되가져간다 (guardian 부활 없음)', () => {
    const ex = new Expedition(geo, cfg);
    ex.reset({ ...guardian, hp: 1 }, [shadow], [], mulberry32(1));
    ex.guardianDown = true;
    ex.guardian.hp = 0;
    const e = ex.enemies[0];
    ex.core = { at: 'dropped', y: e.y + 20 };
    const es = step(ex, 120);
    expect(es.some((x) => x.type === 'coreReturned')).toBe(true);
    expect(ex.core).toEqual({ at: 'dropped', y: geo.wallY });
    expect(ex.guardian.hp).toBe(0);
  });

  it('추격 무리: guardian을 쓰러뜨린 뒤 레인 끝에서 chaseInterval마다 나온다', () => {
    const ex = new Expedition(geo, cfg);
    ex.reset({ ...guardian, hp: 1 }, [], [shadow, shadow], mulberry32(1));
    ex.addUnit(1, 'unhappy', 'sapsal', 0, heroStats, { role: 'hero', y: geo.wallY + 5 });
    step(ex, 30);
    expect(ex.enemies).toHaveLength(0);
    ex.guardian.hp = 0;
    const es = step(ex, Math.round(cfg.carry.chaseInterval * 60) * 2 + 2);
    const spawned = es.filter((e) => e.type === 'enemySpawn');
    expect(spawned.map((e) => (e as { chaser: boolean }).chaser)).toEqual([true, true]);
  });

  it('추격 무리는 호위·병사에 막히지 않고 운반자만 친다, 운반자가 맞으면 staggerSeconds 멈칫 (§5.22-10 4a)', () => {
    const ex = new Expedition(geo, cfg);
    const chaser = { ...shadow, atk: 5, speed: 40 };
    ex.reset({ ...guardian, hp: 1 }, [], [chaser], mulberry32(1));
    const hero = ex.addUnit(1, 'unhappy', 'sapsal', 0, { ...heroStats, hp: 1000 }, { role: 'hero', y: geo.wallY + 120 })!;
    const s = ex.addUnit(2, 'unhappy', DOG, 1, { ...heroStats, hp: 1000 }, { role: 'soldier', soldier: 'shield', y: geo.wallY + 60 })!;
    ex.guardianDown = true;
    ex.guardian.hp = 0;
    ex.core = { at: 'carried', unitId: hero.id };
    const es = step(ex, 60 * 6);
    const hits = es.filter((e) => e.type === 'enemyAttack') as { unitId: number }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.unitId === hero.id)).toBe(true); // 방패병은 맞지 않음
    expect(s.hp).toBe(1000);
    // 멈칫: 맞은 직후 0.2초 동안 운반자가 제자리
    ex.stagger = cfg.carry.staggerSeconds;
    const y0 = hero.y;
    step(ex, 6);
    expect(hero.y).toBe(y0);
  });

  it('운반 중 다른 유닛은 운반자 뒤에서 막는다 (호위: 기준선 = 운반자 y)', () => {
    const ex = new Expedition(geo, cfg);
    ex.reset({ ...guardian, hp: 1 }, [], [], mulberry32(1));
    const hero = ex.addUnit(1, 'unhappy', 'sapsal', 0, heroStats, { role: 'hero', y: geo.wallY + 60 })!;
    const s = ex.addUnit(2, 'unhappy', DOG, 1, heroStats, { role: 'soldier', soldier: 'shield', y: geo.wallY + 20 })!;
    ex.guardianDown = true;
    ex.guardian.hp = 0;
    ex.core = { at: 'carried', unitId: hero.id };
    step(ex, 180);
    expect(Math.abs(s.y - hero.y)).toBeLessThan(2); // 할 일이 없으면 운반자 곁(기준선)
  });
});

describe('밤 — 핵 지키기 (§5.19-3)', () => {
  it('적이 거점에 닿으면 핵 HP − sinkDamage, 보스 웨이브 적은 bossSinkDamage', () => {
    const g = fresh((d) => (d.balance.lane.defenseInterceptRange = 0));
    g.confirmDay();
    g.debugToNight();
    g.defense.units.length = 0; // 막는 유닛 없음
    g.defense.happy.atk = 0;
    const es = until(g, () => g.coreHp < B.core.hp, 60);
    const [hit] = ofType(es, 'coreHit');
    expect(hit).toMatchObject({ damage: B.core.sinkDamage, boss: false });
    expect(g.coreHp).toBe(B.core.hp - B.core.sinkDamage);
  });

  it('핵 HP 0 → 그 밤 즉시 끝, 같은 스테이지를 낮부터 다시 (night)', () => {
    const g = fresh();
    g.confirmDay();
    g.debugToNight();
    g.coreHp = 1;
    g.defense.units.length = 0;
    g.defense.happy.atk = 0;
    const es = until(g, () => g.phase !== 'night', 120);
    expect(ofType(es, 'attemptFail')[0]).toMatchObject({ stage: 1, reason: 'night' });
    expect(g.phase).toBe('dayStart');
    expect(g.stage).toBe(1);
    expect(g.lastAttempt?.coreHpEnd).toBe(0);
    expect(g.stats.nightFails).toBe(1);
  });

  it('밤 웨이브는 낮 결과와 무관하게 같다 (D-055)', () => {
    const nightSpawns = (fastDay: boolean) => {
      // 낮이 길어도 실패하지 않게 (적 없음·guardian 안 쓰러짐·반격 없음)
      const g = fresh((d) => {
        noEnemies(d);
        d.stages.stages[0].day.guardianHp = 1e9;
        d.balance.guardian.counterAtk = 0;
      });
      g.confirmDay();
      if (!fastDay) for (let k = 0; k < 60 * 30; k++) g.tick(FIXED_DT);
      g.debugToNight();
      const waves = structuredClone(g.wave.waves);
      const types: string[] = [];
      for (let k = 0; k < 60 * 60 && g.phase === 'night' && types.length < 6; k++) {
        for (const e of g.tick(FIXED_DT)) if (e.type === 'spawnWorry') types.push(e.enemy);
      }
      return { types: types.slice(0, 6), waves };
    };
    expect(nightSpawns(true)).toEqual(nightSpawns(false));
  });

  it('새벽(핵 HP > 0) → 스테이지 성공 → 이야기 한 장 → [다음 이야기] → stage + 1', () => {
    const g = fresh();
    g.confirmDay();
    g.debugToNight();
    g.debugEndNight();
    expect(g.phase).toBe('diary');
    expect(g.pages).toEqual([1]);
    const [c] = ofType(g.tick(0), 'stageClear');
    expect(c).toMatchObject({ stage: 1 });
    expect(c.record.result).toBe('success');
    expect(g.nextStage()).toBe(true);
    expect(g.stage).toBe(2);
    expect(g.phase).toBe('dayStart');
    expect(g.retry).toBeNull();
  });
});

describe('스테이지 진행·재도전 (§5.19-1)', () => {
  it('실패해도 영웅 레벨·그리드 조각은 그대로 (D-054, 기쁨은 §5.20-13에서 삭제)', () => {
    const g = fresh();
    g.confirmDay();
    g.grid.cells[0] = g.newPiece(DOG, 2);
    g.grid.cells[1] = g.newPiece(DOG, 3);
    const p = g.progressOf('sapsal');
    p.level = 3;
    p.exp = 5;
    const grid = structuredClone(g.grid.cells);
    g.debugFail();
    expect(g.phase).toBe('dayStart');
    expect(g.progressOf('sapsal')).toMatchObject({ level: 3, exp: 5 });
    expect(g.grid.cells).toEqual(grid);
    g.confirmDay();
    expect(g.heroUnit('sapsal')!.maxHp).toBe(g.heroStats('sapsal').hp);
    expect(g.heroStats('sapsal').hp).toBeGreaterThan(base.heroes.heroes.find((h) => h.id === 'sapsal')!.hp);
  });

  it('시도 수: 판 통산·스테이지별, 횟수 제한 없음', () => {
    const g = fresh();
    for (let k = 0; k < 25; k++) {
      g.confirmDay();
      g.debugFail();
    }
    expect(g.attempt).toBe(25);
    expect(g.attempts[0]).toBe(25);
    expect(g.stage).toBe(1);
    expect(g.phase).toBe('dayStart');
  });

  it('1-5 성공 → 다음 장면 카드에 갈림길 없음, 바로 1-6 낮 (D-063)', () => {
    const g = fresh(noEnemies);
    for (let k = 0; k < 5; k++) {
      clearStage(g);
      g.nextStage();
    }
    expect(g.stage).toBe(6);
    expect(g.confirmDay()).toEqual({ ok: true });
    expect(g.abyss.guardian.hp).toBe(base.stages.stages[5].day.guardianHp);
    expect('crossroad' in base.chapter).toBe(false);
    expect(base.events.milestones).toEqual([]);
  });

  it('1-10 낮 성공 → 밤 없이 챕터 완성 (이야기 한 장 = 누이는 해가, 오라비는 달이…)', () => {
    const g = fresh(noEnemies);
    g.debugSetStage(10);
    g.confirmDay();
    g.debugKillGuardian();
    const es = until(g, () => g.phase !== 'day');
    expect(ofType(es, 'dusk')).toHaveLength(0);
    expect(ofType(es, 'stageClear')[0]).toMatchObject({ stage: 10 });
    expect(ofType(es, 'chapterComplete')).toHaveLength(1);
    expect(g.phase).toBe('chapterComplete');
    expect(g.completed).toBe(true);
    expect(g.pages).toEqual([10]);
    expect(base.stages.stages[9].page).toContain('누이는 해가, 오라비는 달이 되었다');
    expect(base.stages.stages[9].page).toContain('누이와 오라비가 이야기 모험대에 합류했다');
    // 보상 영웅(reward = 챕터 id)이 합류 (D-057)
    expect(ofType(es, 'heroesJoined')[0].ids).toEqual(['nui', 'orabi']);
    expect(g.owned).toEqual(['sapsal', 'haetae', 'nui', 'orabi']);
  });

  it('시작 명단 = 모험대 삽살·해태, 누이·오라비는 1챕터 보상 (reward ch01), 디버그 지급은 한 번만', () => {
    const g = fresh();
    expect(g.owned).toEqual(['sapsal', 'haetae']);
    expect(g.formation).toEqual({ offense: [['sapsal']], defense: [['haetae']] });
    expect(g.rewardHeroes.map((h) => h.id)).toEqual(['nui', 'orabi']);
    expect(g.setFormation({ offense: [['nui']], defense: [['haetae']] }).ok).toBe(false); // 보상 영웅은 아직 편성 불가
    g.debugGrantAllHeroes();
    g.debugGrantAllHeroes();
    expect(g.owned).toEqual(['sapsal', 'haetae', 'nui', 'orabi']);
    expect(ofType(g.tick(0), 'heroesJoined')).toHaveLength(1);
  });

  it('장면 카드 문구: 첫 시도 = intro, 실패 뒤 = retryIntro + 사유 (HUD에는 재도전일 때만 "다시 도전")', () => {
    const g = fresh();
    expect(g.retry).toBeNull();
    g.confirmDay();
    g.debugToNight();
    g.debugFail();
    expect(g.retry).toBe('night');
    expect(g.stageDef.retryIntro.length).toBeGreaterThan(0);
  });
});

// M8.11 (§5.20-11): 편성·팀 릴레이·덱 그리드·머지 5단계 = 스킬 게이지·특별 버프·인연·경험치·이야기책 문장·추격·근접/원거리
// + 전투 중 머지 버프(§5.17-3)·밤 쓰러짐(§5.17-10). 먹이기·영웅 슬롯은 삭제 (D-059·D-064).
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD, applyDrop } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { activeBonds, addExp, emptyProgress, fillTemplate, hasBatchim, levelNeed, statsAtLevel, type Formation } from '../src/core/roster';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const B = base.balance;
const DOG = 'companion_animal'; // 떡 (sun, heal)
const ROPE = 'comfort_object'; // 동아줄 (moon, momentum)
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(B.merge.soldierCap + B.team.teamSize);
const hero = (id: string) => base.heroes.heroes.find((h) => h.id === id)!;

/** 저절로 조각·적 없이 (규칙만 보려고) */
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
function fresh(edit: (d: GameData) => void = quiet, all = false): GameState {
  const d = structuredClone(base);
  edit(d);
  const g = new GameState(d, SIZE, mulberry32(1), GEO, 1);
  if (all) {
    g.debugGrantAllHeroes();
    g.debugGrantTestHeroes();
    g.tick(0);
  }
  return g;
}
function day(edit: (d: GameData) => void = quiet, f?: Formation): GameState {
  const g = fresh(edit, f !== undefined);
  if (f) expect(g.setFormation(f)).toMatchObject({ ok: true });
  g.confirmDay();
  g.tick(0);
  return g;
}
function put(g: GameState, index: number, chain: string, tier: number): void {
  g.grid.cells[index] = g.newPiece(chain, tier);
}
function merge(g: GameState, chain: string, tier: number, a = 0, b = 1): void {
  put(g, a, chain, tier);
  put(g, b, chain, tier);
  expect(g.drop(a, b)).toBe('merge');
  g.grid.cells[b] = null;
}
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);
function ticks(g: GameState, seconds: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < Math.round(seconds / FIXED_DT) && g.timeFlows; k++) out.push(...g.tick(FIXED_DT));
  return out;
}

describe('영웅·체인 (§5.20-1)', () => {
  it('시작 모험대 삽살(뼈다귀·해)·해태(방울·달), 누이·오라비는 1챕터 보상, 테스트 영웅은 디버그', () => {
    expect([hero('sapsal').chain, hero('haetae').chain, hero('nui').chain, hero('orabi').chain]).toEqual(['bone', 'bell', DOG, ROPE]);
    expect(base.chains.find((c) => c.archetypeId === 'bone')!.side).toBe('sun');
    expect(base.chains.find((c) => c.archetypeId === 'bell')!.side).toBe('moon');
    for (const c of base.chains) expect(c.tierNames).toHaveLength(B.grid.maxTier);
    expect(hero('test_a').reward).toBe('debug');
    const g = fresh(quiet, true);
    expect(g.owned).toEqual(['sapsal', 'haetae', 'nui', 'orabi', 'test_a', 'test_b']);
  });
});

describe('편성 (§5.20-2)', () => {
  it('기본 = 공격대 1팀 삽살 / 수비대 1팀 해태', () => {
    expect(fresh().formation).toEqual({ offense: [['sapsal']], defense: [['haetae']] });
  });

  it('겹침 금지·각 쪽 최소 1명·팀 수·팀 인원 상한·보유 영웅만', () => {
    const g = fresh(quiet, true);
    expect(g.formationError({ offense: [['sapsal']], defense: [['sapsal']] })).not.toBeNull();
    expect(g.formationError({ offense: [['sapsal', 'haetae']], defense: [[]] })).not.toBeNull();
    expect(g.formationError({ offense: [['sapsal', 'nui', 'orabi', 'test_a']], defense: [['haetae']] })).not.toBeNull();
    expect(g.formationError({ offense: [['sapsal'], ['nui'], ['orabi'], ['test_a'], ['test_b'], []], defense: [['haetae']] })).not.toBeNull();
    expect(fresh().formationError({ offense: [['nui']], defense: [['haetae']] })).not.toBeNull();
    expect(g.formationError({ offense: [['sapsal', 'nui'], ['test_a']], defense: [['haetae', 'orabi']] })).toBeNull();
  });

  it('전투 밖(장면 카드)에서 바꾸면 재시작 없음', () => {
    const g = fresh(quiet, true);
    expect(g.setFormation({ offense: [['nui']], defense: [['haetae']] })).toEqual({ ok: true, restarted: false });
    expect(ofType(g.tick(0), 'formationRestart')).toHaveLength(0);
  });

  it('전투 중 바꾸면 단계 시작 스냅샷(그리드·영웅 경험치·게이지·적·핵)으로 되돌려 다시', () => {
    const g = day(quiet, { offense: [['sapsal']], defense: [['haetae']] });
    const grid0 = JSON.stringify(g.grid.cells);
    const exp0 = g.progressOf('sapsal').exp;
    const enemies0 = g.abyss.enemies.map((e) => [e.x, e.y, e.hp]);
    ticks(g, 6);
    put(g, 3, 'bone', 2);
    g.progressOf('sapsal').gauge = 9;
    expect(JSON.stringify(g.grid.cells)).not.toBe(grid0);
    const r = g.setFormation({ offense: [['nui']], defense: [['haetae']] });
    expect(r).toEqual({ ok: true, restarted: true });
    const es = g.tick(0);
    expect(ofType(es, 'formationRestart')[0]).toMatchObject({ phase: 'day' });
    expect(JSON.stringify(g.grid.cells)).toBe(grid0);
    expect(g.progressOf('sapsal').exp).toBe(exp0);
    expect(g.progressOf('sapsal').gauge).toBe(0);
    expect(g.abyss.enemies.map((e) => [e.x, e.y, e.hp])).toEqual(enemies0);
    expect(g.offenseTimer).toBe(B.offense.seconds);
    expect(g.activeTeamIds('offense')).toEqual(['nui']);
  });
});

describe('팀 릴레이 (§5.20-3)', () => {
  it('낮: 팀 전멸 → 다음 팀이 이야기책에서 출발 (시간 공유), 팀이 없으면 낮 실패 (dayFall), 낮 쓰러짐은 안 일어남', () => {
    const g = day(calm, { offense: [['sapsal'], ['nui']], defense: [['haetae']] });
    ticks(g, 3);
    const t = g.offenseTimer;
    g.debugKillAbyssUnits();
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'teamSwap')[0]).toMatchObject({ role: 'offense', team: 1, reason: 'wipe' });
    expect(g.activeTeamIds('offense')).toEqual(['nui']);
    expect(g.heroUnit('nui')!.y).toBeCloseTo(g.abyss.geo.startY, 6);
    expect(g.offenseTimer).toBeLessThan(t);
    ticks(g, 20);
    expect(g.heroUnit('sapsal')).toBeNull();
    g.debugKillAbyssUnits();
    const f = g.tick(FIXED_DT);
    expect(ofType(f, 'attemptFail')[0]).toMatchObject({ reason: 'dayFall' });
    expect(g.stats.teamSwapsDay).toBe(1);
  });

  it('밤: 웨이브를 팀 수로 나눠 구간 교대, 전멸하면 다음 팀 즉시, 쓰러짐은 8초 뒤 일어남', () => {
    const g = day(quiet, { offense: [['sapsal']], defense: [['haetae'], ['orabi']] });
    g.debugToNight();
    expect(g.activeTeamIds('defense')).toEqual(['haetae']);
    g.debugKnockDefenseHero();
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'teamSwap')[0]).toMatchObject({ role: 'defense', team: 1, reason: 'wipe' });
    expect(g.heroUnit('orabi')).not.toBeNull();
    // 마지막 팀은 쓰러져도 reviveSeconds 뒤 일어남
    g.debugKnockDefenseHero();
    const d = ofType(g.tick(FIXED_DT), 'heroDown')[0];
    expect(d).toMatchObject({ heroId: 'orabi', seconds: B.hero.reviveSeconds });
    const up = ticks(g, B.hero.reviveSeconds + 0.1);
    expect(ofType(up, 'heroEnter')[0]).toMatchObject({ heroId: 'orabi', revive: true });
    expect(g.heroUnit('orabi')!.hp).toBeLessThanOrEqual(g.heroUnit('orabi')!.maxHp * B.hero.reviveHpRatio + 1e-9);
  });

  it('밤 구간 교대: 웨이브 진행에 따라 다음 팀이 맡는다 (segment)', () => {
    const g = day(quiet, { offense: [['sapsal']], defense: [['haetae'], ['orabi']] });
    g.debugToNight();
    const n = g.wave.waveCount;
    expect(n).toBeGreaterThanOrEqual(2);
    g.wave.slot = Math.ceil(n / 2);
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'teamSwap')[0]).toMatchObject({ role: 'defense', team: 1, reason: 'segment' });
  });
});

describe('덱이 그리드를 정한다 (§5.20-4)', () => {
  it('생기는 조각 체인 = 지금 레인 팀 영웅들의 체인 (균등)', () => {
    const g = day((d) => calm(d), { offense: [['sapsal', 'nui']], defense: [['haetae']] });
    expect(g.spawnChains.sort()).toEqual(['bone', DOG].sort());
    g.debugToNight();
    expect(g.spawnChains).toEqual(['bell']);
  });

  it('다른 체인도 머지는 되지만 게이지는 레인에 있는 주인만 (밤 팀의 방울을 낮에 머지 → 게이지 없음)', () => {
    const g = day(calm);
    merge(g, 'bell', 2);
    expect(g.progressOf('haetae').gauge).toBe(0);
    merge(g, 'bone', 2, 2, 3);
    expect(g.progressOf('sapsal').gauge).toBe(B.skill.tierPoints[2]);
  });
});

describe('머지 5단계 · 스킬 게이지 · 특별 버프 (§5.20-5)', () => {
  it('maxTier 5: 결과 2~5단계 → 병사 1~4단, 5단계끼리는 머지 안 됨(교환)', () => {
    const g = day(calm);
    expect(g.grid.maxTier).toBe(5);
    for (const t of [1, 2, 3, 4]) {
      merge(g, DOG, t, 0, 1);
      g.grid.cells.fill(null);
    }
    const lv = g.abyss.units.filter((u) => u.role === 'soldier').map((u) => u.tier);
    expect(lv).toEqual([1, 2, 3, 4]);
    put(g, 0, DOG, 5);
    put(g, 1, DOG, 5);
    expect(applyDrop(g.grid, 0, 1)).toBe('swap');
  });

  it(`게이지 ${hero('sapsal').skill.gauge}: 2단계 +${B.skill.tierPoints[1]}·3단계 +${B.skill.tierPoints[2]}·4단계 +${B.skill.tierPoints[3]}, 가득 → 자동 발동 → 0`, () => {
    const g = day(calm);
    const p = g.progressOf('sapsal');
    merge(g, 'bone', 1);
    expect(p.gauge).toBe(B.skill.tierPoints[1]);
    merge(g, 'bone', 2);
    expect(p.gauge).toBe(B.skill.tierPoints[1] + B.skill.tierPoints[2]);
    merge(g, 'bone', 3);
    expect(p.gauge).toBe(0); // 3 + 7 + 15 ≥ 20 → 발동
    const [sk] = ofType(g.tick(0), 'skill');
    expect(sk).toMatchObject({ heroId: 'sapsal', kind: 'strike' });
    expect(g.stats.skillCasts.sapsal).toBe(1);
  });

  it('5단계 = 즉시 발동 + 해 체인이면 한낮(우리 편 atk +, 때 맞춤 × affinityMult)', () => {
    const g = day(calm);
    const atk = g.heroUnit('sapsal')!.atk;
    merge(g, 'bone', 4);
    const es = g.tick(0);
    expect(ofType(es, 'skill')).toHaveLength(1);
    expect(ofType(es, 'special')[0]).toMatchObject({ kind: 'noon', affinity: true });
    expect(g.abyss.atkMult).toBeCloseTo(1 + B.special.noonAtkPct * B.merge.affinityMult, 9);
    expect(g.heroUnit('sapsal')!.atk).toBeGreaterThanOrEqual(atk);
    expect(g.stats.tier5Made).toBe(1);
    ticks(g, B.special.noonSeconds + 0.1);
    expect(g.abyss.atkMult).toBe(1);
  });

  it('5단계 달 체인 = 보름달: 적 정지 + 우리 편 보호막 (밤 = 때 맞춤)', () => {
    const g = day(quiet);
    g.debugToNight();
    ticks(g, 6);
    const w = g.defense.worries[0];
    expect(w).toBeDefined();
    merge(g, 'bell', 4);
    const es = g.tick(0);
    expect(ofType(es, 'special')[0]).toMatchObject({ kind: 'fullMoon', affinity: true });
    expect(w.slowTimer).toBeGreaterThan(0);
    expect(g.heroUnit('haetae')!.shield).toBeGreaterThan(0);
  });

  it('스킬 4종 (1★): strike·ward·beam·mend', () => {
    expect(['sapsal', 'haetae', 'nui', 'orabi'].map((id) => hero(id).skill.kind)).toEqual(['strike', 'ward', 'beam', 'mend']);
  });
});

describe('인연 (§5.20-6, bonds.json)', () => {
  it('4종: 모험대(같은 팀 삽살·해태)·오누이(같은 팀 누이·오라비)·해와 달(누이 공격대 + 오라비 수비대)·고른 팀(탱커·공격·지원)', () => {
    const ids = (f: Formation) => activeBonds(base, f).map((b) => b.bond.id).sort();
    expect(ids({ offense: [['sapsal', 'haetae']], defense: [['nui']] })).toEqual(['adventurers']);
    expect(ids({ offense: [['sapsal']], defense: [['nui', 'orabi']] })).toEqual(['siblings']);
    expect(ids({ offense: [['nui']], defense: [['orabi']] })).toEqual(['sun_moon']);
    expect(ids({ offense: [['haetae', 'sapsal', 'orabi']], defense: [['nui']] }).sort()).toEqual(['adventurers', 'role_mix']);
    expect(ids({ offense: [['sapsal']], defense: [['haetae']] })).toEqual([]);
    expect(base.bonds.bonds).toHaveLength(4);
  });

  it('효과: 모험대 = 받는 피해 감소, 고른 팀 = atk +, 해와 달 = 게이지 ×', () => {
    const g = fresh(quiet, true);
    g.setFormation({ offense: [['haetae', 'sapsal', 'orabi']], defense: [['nui']] });
    expect(g.heroStats('sapsal').dmgMult).toBeCloseTo(1 - 0.1, 9);
    expect(g.heroStats('sapsal').atk).toBeCloseTo(hero('sapsal').atk * 1.1 * g.aptitudeMult('sapsal', 'offense'), 9); // 적성(§5.22-4) 포함
    const h = fresh(quiet, true);
    h.setFormation({ offense: [['nui']], defense: [['orabi']] });
    h.confirmDay();
    merge(h, DOG, 2);
    expect(h.progressOf('nui').gauge).toBeCloseTo(B.skill.tierPoints[2] * 1.25, 9);
  });

  it('오누이: 그 팀 첫 쓰러짐 1회는 그 자리에서 hp × 50%로 다시 일어남', () => {
    const g = day(calm, { offense: [['nui', 'orabi']], defense: [['haetae']] });
    ticks(g, 2);
    g.heroUnit('nui')!.hp = 0;
    const es = g.tick(FIXED_DT);
    expect(ofType(es, 'heroEnter')[0]).toMatchObject({ heroId: 'nui', revive: true });
    g.heroUnit('nui')!.hp = 0;
    const es2 = g.tick(FIXED_DT);
    expect(ofType(es2, 'heroDown')[0]).toMatchObject({ heroId: 'nui' });
  });
});

describe('경험치 → 레벨 (§5.20-7, 임시)', () => {
  it(`필요 경험치 = ${B.exp.levelBase} + ${B.exp.levelStep}(n−1), 레벨당 +${B.exp.perLevelPct * 100}%, 상한 ${B.exp.maxLevel}`, () => {
    expect([1, 2, 3].map((n) => levelNeed(B.exp, n))).toEqual([20, 30, 40]);
    const p = emptyProgress('sapsal');
    expect(addExp(p, 55, B.exp)).toBe(2);
    expect(p).toMatchObject({ level: 3, exp: 5 });
    expect(statsAtLevel(hero('sapsal'), 3, B.exp).hp).toBeCloseTo(hero('sapsal').hp * (1 + 2 * B.exp.perLevelPct), 9);
    const q = emptyProgress('sapsal');
    addExp(q, 1e9, B.exp);
    expect(q.level).toBe(B.exp.maxLevel);
  });

  it('처치 1·guardian 20·밤 성공 30, 단계가 끝날 때 넣는다 (실패면 × 0.5)', () => {
    const g = day(calm);
    ticks(g, 2); // 이야기책을 떠난 뒤 (이야기책에서 핵을 얻으면 바로 도착이라)
    g.debugKillGuardian();
    g.tick(FIXED_DT);
    expect(g.pendingExp('sapsal')).toBe(B.exp.guardian);
    g.debugFail();
    expect(g.progressOf('sapsal').exp).toBeCloseTo(B.exp.guardian * B.exp.failMult, 9);
    const h = day(calm);
    h.debugToNight();
    h.debugEndNight();
    // 30 = 1레벨 필요 20 + 10 → 2레벨, 남은 10
    expect(h.progressOf('haetae')).toMatchObject({ level: 2 });
    expect(h.progressOf('haetae').exp).toBeCloseTo(B.exp.nightWin - levelNeed(B.exp, 1), 9);
  });
});

describe('이야기책 문장 (§5.20-8)', () => {
  it('조사: 받침에 따라 이/가·을/를', () => {
    expect(hasBatchim('삽살')).toBe(true);
    expect(hasBatchim('해태')).toBe(false);
    expect(fillTemplate('{hero}{이/가} {core}{을/를} 품고 돌아왔다.', { hero: '해태', core: '떡 조각' })).toBe('해태가 떡 조각을 품고 돌아왔다.');
    expect(fillTemplate('{hero}{이/가} {core}{을/를} 품고 돌아왔다.', { hero: '삽살', core: '방울' })).toBe('삽살이 방울을 품고 돌아왔다.');
  });

  it('장마다 플레이 한 줄: 운반자·핵 HP·시도 수', () => {
    const g = fresh(calm);
    g.confirmDay();
    g.debugFail();
    g.confirmDay();
    g.debugToNight();
    g.coreHp = 30;
    g.debugEndNight();
    const notes = g.pageNotes[1];
    const core = base.stages.stages[0].coreName;
    expect(notes[0]).toBe(fillTemplate(base.chapter.pageLines.carrier, { hero: base.heroes.heroes.find((h) => h.id === 'sapsal')!.name, core }));
    expect(notes[1]).toBe(base.chapter.pageLines.hpLow);
    expect(notes[2]).toBe(fillTemplate(base.stages.stages[0].retryPageLine ?? base.chapter.pageLines.retry, { n: 2 }));
  });
});

describe('추격·근접/원거리 (§5.20-3-1·9)', () => {
  it('추격 무리는 운반자를 향해 chaseSpeedMult로 쫓아온다 (운반이 시작되는 순간 첫 추격)', () => {
    const g = day((d) => {
      quiet(d);
      for (const st of d.stages.stages) st.day.enemies = [];
      d.stages.stages[0].day.guardianHp = 1;
    });
    const es = ticks(g, 10);
    expect(ofType(es, 'guardianDown')).toHaveLength(1);
    const chasers = g.abyss.enemies.filter((e) => e.chaser);
    expect(chasers.length).toBeGreaterThan(0);
    const c = chasers[0];
    const carrier = g.abyss.carrier;
    if (carrier) {
      const y0 = c.y;
      g.tick(FIXED_DT);
      if (g.abyss.enemies.includes(c) && c.slowTimer <= 0) expect(c.y).toBeGreaterThan(y0); // 이야기책(운반자) 쪽으로
    }
  });

  it('근접은 붙을 때까지 다가가고, 원거리는 사거리 끝에서 멈춘다', () => {
    const run = (id: string) => {
      const g = day(
        (d) => {
          quiet(d);
          d.stages.stages[0].day.enemies = [{ type: 'shadow', count: 1 }];
          d.balance.swarm.countMult = 1;
          d.monsters.base.hp = 1e6;
          d.monsters.base.speed = 0;
        },
        { offense: [[id]], defense: [['haetae']] },
      );
      ticks(g, 20);
      const u = g.heroUnit(id)!;
      const e = g.abyss.enemies[0];
      return Math.abs(u.y - e.y);
    };
    expect(run('sapsal')).toBeLessThan(hero('sapsal').range + 1);
    const r = run('nui');
    expect(r).toBeGreaterThan(hero('sapsal').range);
    expect(r).toBeLessThanOrEqual(hero('nui').range + 1);
  });

  it('적은 가장 가까운 우리 편을 친다', () => {
    const g = day(
      (d) => {
        quiet(d);
        d.stages.stages[0].day.enemies = [{ type: 'shadow', count: 1 }];
        d.balance.swarm.countMult = 1;
        d.monsters.base.hp = 1e6;
      },
      { offense: [['sapsal', 'nui']], defense: [['haetae']] },
    );
    const es = ticks(g, 20);
    const hits = ofType(es, 'enemyAttack');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].unitId).toBe(g.heroUnit('sapsal')?.id ?? hits[0].unitId); // 앞(근접) 영웅이 먼저 맞는다
  });
});

describe('전투 중 머지 버프 (§5.17-3, [11]-2)', () => {
  const noSoldier = (d: GameData) => {
    calm(d);
    d.balance.merge.soldiers = false;
  };

  it('떡 머지(낮): 지금 싸우는 팀 즉시 회복 maxHp × healPct × 때 맞춤(낮·sun)', () => {
    const g = day(noSoldier);
    const u = g.heroUnit('sapsal')!;
    u.hp = 50;
    merge(g, DOG, 1);
    expect(u.hp).toBeCloseTo(50 + u.maxHp * B.buff.healPct * B.merge.affinityMult, 9);
    const [b] = ofType(g.tick(0), 'buff');
    expect(b).toMatchObject({ role: 'offense', kind: 'heal', affinity: true });
  });

  it('동아줄 머지: 기세 중첩 (밤 = moon 때 맞춤), 3단계 결과면 2중첩, 최대 중첩, 만료', () => {
    const g = day(noSoldier);
    g.debugToNight();
    const u = g.heroUnit('haetae')!;
    const atk = g.heroStats('haetae').atk;
    merge(g, ROPE, 1);
    const m = g.momentum.defense;
    expect(m.stacks).toBe(1);
    expect(u.atk).toBeCloseTo(atk * (1 + B.buff.momentumAtkPct * B.merge.affinityMult), 9);
    merge(g, ROPE, 2);
    expect(m.stacks).toBe(3);
    for (let k = 0; k < 10; k++) merge(g, ROPE, 1);
    expect(m.stacks).toBe(B.buff.momentumMaxStacks);
    ticks(g, B.buff.momentumSeconds + 0.1);
    expect(g.momentum.defense.stacks).toBe(0);
  });

  it('전투 밖 머지는 버프·병사·게이지 없음, 와일드카드 낀 머지 = 결과 체인 기준', () => {
    const g = fresh(quiet);
    merge(g, 'bone', 3);
    expect(g.stats.battleMerges).toBe(0);
    expect(g.progressOf('sapsal').gauge).toBe(0);
    const h = day(noSoldier);
    put(h, 0, WILDCARD, 0);
    put(h, 1, ROPE, 1);
    h.drop(0, 1);
    expect(h.momentum.offense.stacks).toBe(1);
  });
});

describe('결정성', () => {
  it('큰 dt와 작은 dt가 같은 결과 (조각·머지·병사 포함)', () => {
    const a = day();
    const b = day();
    for (const g of [a, b]) merge(g, 'bone', 1);
    a.tick(10);
    for (let k = 0; k < 600; k++) b.tick(FIXED_DT);
    expect(JSON.stringify(a.grid.cells)).toBe(JSON.stringify(b.grid.cells));
    expect(a.abyss.units.map((u) => [u.y, u.hp])).toEqual(b.abyss.units.map((u) => [u.y, u.hp]));
  });
});

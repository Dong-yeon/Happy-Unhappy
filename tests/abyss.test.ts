// M4: 심연 레인·그림자·역류 (스펙 §4.3.2 "테스트 (필수)")
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, bossHp, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT, Lane, layerBaseHp, type AbyssGeometry, type LaneEvent, type WallStats } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { weatherOf } from '../src/core/shadow';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';

/** data를 복제해 일부 수치만 바꾼 GameState */
function game(edit: (d: GameData) => void = () => {}, seed = 1, cols = 4, rows = 4): GameState {
  const d = structuredClone(base);
  edit(d);
  const g = new GameState(d, { cols, rows }, mulberry32(seed), gameGeometry(d.balance.lane.laneCap));
  // 1일차를 평범한 하루로 시작 (이벤트 효과가 수치를 흔들지 않게) → waves 단계
  g.debugForceEvent('plain');
  g.confirmDay();
  return g;
}
function ticks(g: GameState, n: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...g.tick(FIXED_DT));
  return out;
}
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

// ── 레인 단위 ──

const AGEO: AbyssGeometry = { startY: 300, wallY: 50, centerX: 50, slotXs: [10, 30, 50, 70, 90] };
const WALL: WallStats = { layerHpBase: 1000, layerHpGrowth: 1.2, counterAtk: 4, counterAtkInterval: 1.5, counterRange: 60 };
const SPIRIT = { hp: 20, atk: 4, atkInterval: 1.0, range: 40 };

/** 1틱에 정확히 1px 전진 (부동소수 오차 없이 틱 번호로 확인) */
function abyssLane(wall: Partial<WallStats> = {}): Lane<'abyss'> {
  return new Lane('abyss', AGEO, { wall: { ...WALL, ...wall }, advanceSpeed: 60 });
}

describe('심연 유닛: 출발 → 사거리 도달 시 정지 → 즉시 첫 공격 → atkInterval', () => {
  it('출발선에서 위로 전진, 벽 아래 변까지 range가 되는 틱에 멈추고 그 틱에 첫 공격', () => {
    const l = abyssLane({ counterRange: -1 }); // 반격 없음
    const u = l.addUnit(1, 'unhappy', DOG, 1, SPIRIT)!;
    expect(u).toMatchObject({ y: 300, arrived: false, x: 50 });
    const out: LaneEvent[] = [];
    // 300 → 90 (= wallY 50 + range 40): 210틱
    for (let t = 1; t < 210; t++) l.stepAbyss(FIXED_DT, out);
    expect(u.arrived).toBe(false);
    expect(u.y).toBe(91);
    expect(out.some((e) => e.type === 'wallHit')).toBe(false);
    l.stepAbyss(FIXED_DT, out);
    expect(u).toMatchObject({ y: 90, arrived: true });
    expect(out.filter((e) => e.type === 'abyssArrive')).toHaveLength(1);
    expect(l.wall.hp).toBe(1000 - SPIRIT.atk); // 도달 틱에 즉시 첫 공격

    const interval = Math.round(SPIRIT.atkInterval / FIXED_DT);
    for (let t = 0; t < interval - 1; t++) l.stepAbyss(FIXED_DT, out);
    expect(l.wall.hp).toBe(1000 - SPIRIT.atk);
    l.stepAbyss(FIXED_DT, out);
    expect(l.wall.hp).toBe(1000 - SPIRIT.atk * 2);
    expect(u.y).toBe(90); // 멈춘 뒤로는 움직이지 않음
  });

  it('유닛끼리는 막지 않는다: 먼저 멈춘 유닛을 지나 자기 사거리까지 전진', () => {
    const l = abyssLane({ counterRange: -1 });
    l.addUnit(1, 'unhappy', DOG, 1, { ...SPIRIT, range: 100 }); // 150에서 멈춤
    const b = l.addUnit(2, 'unhappy', DOG, 1, { ...SPIRIT, range: 20 }); // 70까지 감
    for (let t = 0; t < 300; t++) l.stepAbyss(FIXED_DT, []);
    expect(l.units.map((u) => u.y)).toEqual([150, 70]);
    expect(b!.arrived).toBe(true);
  });
});

describe('벽의 반격', () => {
  it('counterRange 안 유닛 중 가장 앞(y 최소, 같으면 먼저 소환)에게 counterAtk', () => {
    const l = abyssLane();
    const a = l.addUnit(1, 'unhappy', DOG, 1, SPIRIT)!;
    const b = l.addUnit(2, 'unhappy', DOG, 1, SPIRIT)!;
    const c = l.addUnit(3, 'unhappy', DOG, 1, SPIRIT)!;
    Object.assign(a, { y: 100, arrived: true }); // 벽에서 50
    Object.assign(b, { y: 90, arrived: true }); // 벽에서 40 → 가장 앞
    Object.assign(c, { y: 200, arrived: false }); // 범위 밖
    const out: LaneEvent[] = [];
    l.stepAbyss(FIXED_DT, out);
    expect(out.filter((e) => e.type === 'counter')).toEqual([{ type: 'counter', unitId: b.id, damage: WALL.counterAtk }]);
    expect(b.hp).toBe(SPIRIT.hp - WALL.counterAtk);
    expect(a.hp).toBe(SPIRIT.hp);

    // 같은 y → 먼저 소환된 유닛
    const l2 = abyssLane();
    const p = l2.addUnit(1, 'unhappy', DOG, 1, SPIRIT)!;
    const q = l2.addUnit(2, 'unhappy', DOG, 1, SPIRIT)!;
    Object.assign(p, { y: 95, arrived: true });
    Object.assign(q, { y: 95, arrived: true });
    const out2: LaneEvent[] = [];
    l2.stepAbyss(FIXED_DT, out2);
    expect(out2.find((e) => e.type === 'counter')).toMatchObject({ unitId: p.id });
  });

  it('범위 밖이면 반격 없음, 쿨다운 0에서 대기 → 들어온 틱에 즉시 반격', () => {
    const l = abyssLane();
    const u = l.addUnit(1, 'unhappy', DOG, 1, { ...SPIRIT, range: 1000 })!; // 출발선에서 바로 도달(벽 공격)하지만
    const out: LaneEvent[] = [];
    for (let t = 0; t < 120; t++) l.stepAbyss(FIXED_DT, out);
    expect(u.y).toBe(300); // 벽에서 250: counterRange 60 밖
    expect(out.some((e) => e.type === 'counter')).toBe(false);
    expect(l.wall.cd).toBe(0);
    u.y = 105; // 범위 안으로
    l.stepAbyss(FIXED_DT, out);
    expect(out.filter((e) => e.type === 'counter')).toHaveLength(1);
  });

  it('층 HP = layerHpBase × layerHpGrowth^(층-1)', () => {
    expect(layerBaseHp(WALL, 1)).toBe(1000);
    expect(layerBaseHp(WALL, 3)).toBeCloseTo(1000 * 1.44, 9);
  });
});

// ── GameState ──

describe('층 돌파', () => {
  it('전진 중 유닛 포함 전원 귀환: 1·2단계 → +1, 3단계 → 와일드카드 + heroFirstPurify (중복 없음)', () => {
    const g = game();
    g.wave.paused = true;
    for (const [c, t] of [[DOG, 1], [BLANKET, 2], [DOG, 3]] as const) g.summon(g.debugGrant(c, t)!, 'unhappy');
    ticks(g, 30); // 모두 아직 전진 중
    expect(g.abyss.units.every((u) => !u.arrived)).toBe(true);
    g.debugBreakLayer();
    const [clear] = ofType(ticks(g, 1), 'layerClear');
    expect(clear.layer).toBe(1);
    expect(clear.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([
      [DOG, 2],
      [BLANKET, 3],
      [WILDCARD, 0],
    ]);
    expect(clear.returns.every((r) => r.placedAt !== null && r.piece.bornAt === g.playTime)).toBe(true);
    expect(g.abyss.units).toEqual([]);
    expect(g.heroFirstPurify).toEqual([DOG]);
    expect(g.stats.layersCleared).toBe(1);
    for (const r of clear.returns) expect(g.grid.cells[r.placedAt!]).toBe(r.piece);

    // 같은 체인 영웅을 한 번 더 정화해도 heroFirstPurify는 중복 없음
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.debugBreakLayer();
    ticks(g, 1);
    expect(g.heroFirstPurify).toEqual([DOG]);
    expect(g.abyss.wall.layer).toBe(3);
  });

  it('extraHp는 현재 층에만 누적, 돌파하면 0 / 다음 층 HP = 기본 공식', () => {
    const g = game();
    g.wave.paused = true;
    g.abyss.addExtraHp(15);
    expect(g.abyss.wall).toMatchObject({ extraHp: 15, maxHp: base.balance.abyss.layerHpBase + 15 });
    g.debugBreakLayer();
    ticks(g, 1);
    const hp2 = base.balance.abyss.layerHpBase * base.balance.abyss.layerHpGrowth;
    expect(g.abyss.wall).toMatchObject({ layer: 2, extraHp: 0 });
    expect(g.abyss.wall.hp).toBeCloseTo(hp2, 9);
  });

  it('그림자 감소량 = shadowPurified 증가량 (0 미만 불가)', () => {
    const g = game();
    g.wave.paused = true;
    g.debugSetShadow(40);
    g.debugBreakLayer();
    ticks(g, 1);
    const reduce = base.balance.abyss.layerClearShadowReduce;
    expect(g.shadow).toBe(40 - reduce);
    expect(g.stats.shadowPurified).toBe(reduce);

    g.debugSetShadow(5);
    g.debugBreakLayer();
    ticks(g, 1);
    expect(g.shadow).toBe(0);
    expect(g.stats.shadowPurified).toBe(reduce + 5);
  });
});

describe('귀환 칸 부족 → 대기열 → 상한 초과 소실', () => {
  it('그리드가 가득이면 대기열, returnQueueCap을 넘으면 소실', () => {
    const cap = base.balance.grid.returnQueueCap;
    const g = game();
    g.wave.paused = true;
    for (let k = 0; k < 5; k++) g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    while (g.debugGrant(BLANKET, 1) !== null); // 그리드 가득
    for (let k = 0; k < cap - 2; k++) g.enqueueReturn(g.newPiece(BLANKET, 1)); // 대기열에 cap-2개
    g.debugBreakLayer();
    const [clear] = ofType(ticks(g, 1), 'layerClear');
    expect(clear.returns.map((r) => (r.lost ? 'lost' : r.queued ? 'queued' : 'placed'))).toEqual([
      'queued',
      'queued',
      'lost',
      'lost',
      'lost',
    ]);
    expect(g.returnQueue).toHaveLength(cap);
    expect(g.lostReturns).toBe(3);
  });
});

describe('심연 유닛 사망', () => {
  it('조각 소실 + 그림자 +abyssDeathShadow, 슬롯이 빈다', () => {
    const g = game();
    g.wave.paused = true;
    g.summon(g.debugGrant(DOG, 2)!, 'unhappy');
    const gridBefore = structuredClone(g.grid.cells);
    g.debugKillAbyssUnits();
    const es = ticks(g, 1);
    expect(ofType(es, 'abyssUnitDie')).toHaveLength(1);
    expect(g.shadow).toBe(base.balance.abyss.abyssDeathShadow);
    expect(g.stats.abyssDeaths).toBe(1);
    expect(g.grid.cells).toEqual(gridBefore); // 귀환 없음
    expect(g.abyss.units).toEqual([]);
  });
});

describe('Unhappy 멈춤', () => {
  const rate = base.balance.abyss.unhappyStallShadowPerSec;

  it('심연 유닛 0기 + 웨이브 진행 중에만 그림자 증가 (stallStart / stallEnd)', () => {
    const g = game();
    g.wave.startNext(); // 대기 건너뛰기 → 다음 틱에 아침 웨이브 시작
    const es = ticks(g, 1);
    g.wave.paused = true; // 이후 걱정은 더 안 나오게
    expect(g.wave.active).toBe(true);
    es.push(...ticks(g, 59));
    expect(g.unhappyStalled).toBe(true);
    expect(ofType(es, 'stallStart')).toHaveLength(1);
    expect(g.shadow).toBeCloseTo(rate * 1, 9);
    expect(g.stats.stallSeconds).toBeCloseTo(1, 9);

    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    const es2 = ticks(g, 60);
    expect(ofType(es2, 'stallEnd')).toHaveLength(1);
    expect(g.shadow).toBeCloseTo(rate * 1, 9); // 더 늘지 않음
  });

  it('waiting·gap에는 증가 없음', () => {
    const g = game();
    ticks(g, 60); // waiting (첫 웨이브 전)
    expect(g.shadow).toBe(0);
    expect(g.unhappyStalled).toBe(false);
    g.wave.phase = 'gap';
    g.wave.timer = 100;
    ticks(g, 120);
    expect(g.shadow).toBe(0);
  });
});

describe('가라앉음 → 그림자·층 HP', () => {
  it('가라앉으면 그림자 +sinkShadow, 현재 층 extraHp +sinkLayerHp', () => {
    const g = game((d) => {
      d.balance.happy.atk = 0; // Happy가 걱정을 치지 않게
      d.balance.lane.abyssAdvanceSpeed = 0; // 심연 유닛은 제자리 (멈춤 방지용)
    });
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.wave.startNext();
    let sink: CoreEvent | undefined;
    let shadowBefore = 0;
    for (let k = 0; k < 60 * 30 && !sink; k++) {
      shadowBefore = g.shadow;
      sink = g.tick(FIXED_DT).find((e) => e.type === 'sink');
    }
    expect(sink).toBeDefined();
    expect(g.shadow - shadowBefore).toBe(base.balance.shadow.sinkShadow);
    expect(g.abyss.wall.extraHp).toBe(base.balance.shadow.sinkLayerHp);
    expect(g.stats.sunkCount).toBe(1);
  });
});

describe('역류', () => {
  const S = base.balance.shadow;
  const BOSS = base.monsters.backflowBoss;

  /** 심연 유닛 1기(제자리)로 멈춤을 막고 그림자를 가득 채운다 */
  function maxed(defenders: number): GameState {
    const g = game((d) => {
      d.balance.lane.abyssAdvanceSpeed = 0;
      d.balance.happy.atk = 0;
    });
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    for (let k = 0; k < defenders; k++) g.summon(g.debugGrant(DOG, 3)!, 'happy');
    g.debugSetShadow(S.shadowMax);
    return g;
  }

  it('shadowMax 도달 → 역류 예약 → 남은 다음 웨이브 칸(아침)이 보스로 교체', () => {
    const g = maxed(3);
    const es = ticks(g, 1);
    expect(ofType(es, 'backflowPending')).toHaveLength(1);
    expect(g.pendingBackflow).toBe(true);
    // 예약 중에는 shadowMax에 머문다 (층 돌파로도 줄지 않음)
    g.debugBreakLayer();
    ticks(g, 1);
    expect(g.shadow).toBe(S.shadowMax);
    expect(g.stats.shadowPurified).toBe(0);

    // 첫 웨이브 시작 시각(dayStartDelay)에 아침 칸이 보스로 나온다
    const start = ticks(g, 60 * base.balance.wave.dayStartDelay);
    expect(ofType(start, 'backflowStart')).toHaveLength(1);
    expect(g.wave).toMatchObject({ isBoss: true, slot: 0 });
    expect(g.defense.worries).toHaveLength(1);
    expect(g.defense.worries[0]).toMatchObject({ boss: true, hp: BOSS.hp });
    expect(g.stats.backflows).toBe(1);
  });

  it('처치: 그림자 = shadowAfterBossWin (감소분은 shadowCalmed, shadowPurified 아님 D-023), 기쁨 +joyReward, 다음 칸(낮)은 일반 웨이브', () => {
    const g = maxed(3);
    const joy = g.joy;
    const es: CoreEvent[] = [];
    for (let k = 0; k < 60 * 60 && !es.some((e) => e.type === 'backflowEnd'); k++) es.push(...g.tick(FIXED_DT));
    expect(ofType(es, 'backflowEnd')).toEqual([{ type: 'backflowEnd', win: true }]);
    expect(g.shadow).toBe(S.shadowAfterBossWin);
    expect(g.stats.shadowCalmed).toBe(S.shadowMax - S.shadowAfterBossWin);
    expect(g.stats.shadowPurified).toBe(0);
    expect(g.joy).toBe(joy + BOSS.joyReward);
    expect(g.stats).toMatchObject({ bossWins: 1, bossLosses: 0 });
    // 보스(아침)가 끝나면 낮 웨이브는 일반 (하루는 항상 3웨이브)
    for (let k = 0; k < 60 * 10 && !(g.wave.slot === 1 && g.wave.active); k++) g.tick(FIXED_DT);
    expect(g.wave).toMatchObject({ slot: 1, isBoss: false });
  });

  it('가라앉음: 그림자 = shadowAfterBossLose, 기쁨 −joyPenalty(0 미만 불가), 층 extraHp +sinkLayerHp, 일반 규칙 미적용', () => {
    const g = maxed(0); // 방어 없음 → 보스가 가라앉음
    g.joy = 10;
    const es: CoreEvent[] = [];
    for (let k = 0; k < 60 * 60 && !es.some((e) => e.type === 'backflowEnd'); k++) es.push(...g.tick(FIXED_DT));
    expect(ofType(es, 'backflowEnd')).toEqual([{ type: 'backflowEnd', win: false }]);
    expect(g.shadow).toBe(S.shadowAfterBossLose); // +sinkShadow 없음
    expect(g.joy).toBe(0); // 10 − 30 → 0
    expect(g.abyss.wall.extraHp).toBe(BOSS.sinkLayerHp); // +sinkLayerHp(일반) 없음
    expect(g.stats).toMatchObject({ sunkCount: 0, bossLosses: 1 });
  });
});

describe('마음 날씨', () => {
  it('weatherThresholds 경계: 0~24 맑음 / 25~49 흐림 / 50~74 비 / 75~ 폭우', () => {
    const t = base.balance.shadow.weatherThresholds;
    expect([0, 24.9, 25, 49, 50, 74, 75, 100].map((v) => weatherOf(v, t))).toEqual([
      '맑음', '맑음', '흐림', '흐림', '비', '비', '폭우', '폭우',
    ]);
  });

  it('그림자가 바뀐 틱에 shadowChange { value, weather }', () => {
    const g = game();
    g.wave.paused = true;
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugKillAbyssUnits();
    const [ch] = ofType(ticks(g, 1), 'shadowChange');
    expect(ch).toEqual({ type: 'shadowChange', value: base.balance.abyss.abyssDeathShadow, weather: '맑음' });
  });
});

// ── 결정성 (심연 포함) ──

function snapshot(g: GameState) {
  return {
    tick: g.tickCount,
    joy: g.joy,
    shadow: g.shadow,
    wave: { day: g.day, slot: g.wave.slot, phase: g.wave.phase, boss: g.wave.isBoss },
    grid: g.grid.cells.map((c) => (c ? `${c.id}:${c.chain}:${c.tier}` : null)),
    defense: g.defense.units.map((u) => [u.id, u.hp, u.cd]),
    worries: g.defense.worries.map((w) => [w.id, w.x, w.y, w.hp]),
    abyss: g.abyss.units.map((u) => [u.id, u.y, u.hp, u.cd, u.arrived]),
    wall: { ...g.abyss.wall },
    stats: { ...g.stats },
    heroes: [...g.heroFirstPurify],
  };
}

function scenario(seed: number, advance: (g: GameState, s: number) => string[]) {
  const g = game(() => {}, seed, 5, 4);
  const ev: string[] = [];
  ev.push(...advance(g, 3));
  g.summon(g.debugGrant(DOG, 3)!, 'happy');
  g.summon(g.debugGrant(BLANKET, 2)!, 'unhappy');
  g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
  ev.push(...advance(g, 10));
  g.summon(g.debugGrant(BLANKET, 1)!, 'unhappy');
  ev.push(...advance(g, 20));
  return { snap: snapshot(g), ev };
}
const big = (g: GameState, s: number) => {
  const o: string[] = [];
  for (let k = 0; k < s; k++) o.push(...g.tick(1).map((e) => JSON.stringify(e)));
  return o;
};
const small = (g: GameState, s: number) => {
  const o: string[] = [];
  for (let k = 0; k < s * 60; k++) o.push(...g.tick(1 / 60).map((e) => JSON.stringify(e)));
  return o;
};

describe('결정성 (심연 포함)', () => {
  it('같은 시드·같은 입력이면 같은 결과, 큰 dt와 작은 dt도 같음', () => {
    const a = scenario(9, small);
    expect(scenario(9, small)).toEqual(a);
    expect(scenario(9, big)).toEqual(a);
    expect(a.snap.stats.layersCleared).toBeGreaterThan(0); // 심연이 실제로 돌았는지
  });
});

describe('역류 보스 HP 성장 (monsters.backflowBoss.hpGrowthPerDay)', () => {
  it('bossHp = hp × hpGrowthPerDay^(일차-1)', () => {
    const boss = { hp: 350, hpGrowthPerDay: 1.1 };
    expect(bossHp(boss, 1)).toBe(350);
    expect(bossHp(boss, 3)).toBeCloseTo(350 * 1.21, 9);
    expect(bossHp(boss, 0)).toBe(350); // 1일차 미만은 1일차로
  });

  it('보스 HP는 그날 일차 기준: 1일차 = hp', () => {
    const g = game((d) => {
      d.monsters.backflowBoss.hpGrowthPerDay = 1.5;
      d.balance.lane.abyssAdvanceSpeed = 0;
    });
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugScheduleBackflow();
    ticks(g, 60 * base.balance.wave.dayStartDelay + 1);
    expect(g.defense.worries.find((w) => w.boss)?.hp).toBe(base.monsters.backflowBoss.hp);
  });

  it('3일차 보스 HP = hp × hpGrowthPerDay²', () => {
    const g = game((d) => {
      d.monsters.backflowBoss.hpGrowthPerDay = 1.5;
      d.balance.lane.abyssAdvanceSpeed = 0;
    });
    g.debugGotoDay(3);
    g.debugForceEvent('plain');
    g.confirmDay();
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugScheduleBackflow();
    ticks(g, 60 * base.balance.wave.dayStartDelay + 1);
    expect(g.defense.worries.find((w) => w.boss)?.hp).toBeCloseTo(base.monsters.backflowBoss.hp * 2.25, 9);
  });
});

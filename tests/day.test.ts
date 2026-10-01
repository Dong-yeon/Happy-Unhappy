// M5: 하루 구조 (스펙 §5.1~5.4, §5.7 "테스트 (필수)")
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { emptyDayStats, resolveDayEvent, type DailyUse, type DayStats } from '../src/core/day';
import { diaryCategory, nightCategory, pickAvoiding, writeDiary } from '../src/core/diary';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { waveCount, waveHp } from '../src/core/wave';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const W = base.balance.wave;

/** dayStart 상태 그대로 (카드를 닫지 않음) */
function fresh(edit: (d: GameData) => void = () => {}, seed = 1): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, { cols: 5, rows: 4 }, mulberry32(seed), gameGeometry(d.balance.lane.laneCap));
}

function ticks(g: GameState, n: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...g.tick(FIXED_DT));
  return out;
}

/** 지금 날을 낮·밤을 거쳐 diary까지 (최대 seconds) */
function runDay(g: GameState, seconds = 600): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < seconds * 60 && g.timeFlows; k++) out.push(...g.tick(FIXED_DT));
  return out;
}

/** 오늘을 강제 이벤트로 시작 */
function begin(g: GameState, eventId = 'plain', choice?: string): CoreEvent[] {
  g.debugForceEvent(eventId);
  expect(g.confirmDay(choice)).toEqual({ ok: true });
  return g.tick(0);
}

const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

describe('상태 흐름', () => {
  it('dayStart에서 시간 정지 → 카드 닫으면 day → 저녁 종료 후 night → 달이 지면 diary → 다음 날', () => {
    const g = fresh();
    expect(g.phase).toBe('dayStart');
    ticks(g, 600);
    expect(g.tickCount).toBe(0); // 시간이 흐르지 않음
    expect(g.defense.worries).toHaveLength(0);

    begin(g);
    expect(g.phase).toBe('day');
    const es = runDay(g);
    expect(g.phase).toBe('diary');
    const [end] = ofType(es, 'dayEnd');
    expect(end.day).toBe(1);
    expect(g.diary).toHaveLength(1);
    const t = g.tickCount;
    ticks(g, 300);
    expect(g.tickCount).toBe(t); // diary에서도 정지

    expect(g.nextDay()).toBe(true);
    expect(g).toMatchObject({ phase: 'dayStart', day: 2 });
  });

  it('카드를 닫지 않고 틱을 돌려도 걱정이 나오지 않고, 이정표는 선택이 필요하다', () => {
    const g = fresh();
    g.debugForceEvent('first_tooth');
    expect(g.confirmDay()).toEqual({ ok: false, reason: 'needChoice' });
    expect(g.confirmDay('nope')).toEqual({ ok: false, reason: 'badChoice' });
    expect(g.phase).toBe('dayStart');
    expect(g.confirmDay('happy')).toEqual({ ok: true });
  });

  it('14일째 diary 뒤 → lifeEnd', () => {
    const g = fresh();
    g.debugGotoDay(14);
    begin(g);
    runDay(g);
    expect(g.phase).toBe('diary');
    g.nextDay();
    expect(g.phase).toBe('lifeEnd');
    expect(g.nextDay()).toBe(false);
  });

  it('하루 웨이브 수는 항상 3 (보스로 교체돼도)', () => {
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy'); // 멈춤으로 인한 그림자 방지
    g.debugScheduleBackflow(); // 아침 칸 → 보스
    const es = runDay(g);
    const bossSpawns = ofType(es, 'spawnWorry').filter((e) => e.boss).length;
    const normal = ofType(es, 'spawnWorry').filter((e) => !e.boss).length;
    expect(bossSpawns).toBe(1);
    expect(normal).toBe(waveCount({ ...W, hpBase: 1 }, 1) * 2); // 낮·저녁
  });
});

describe('웨이브: 일차 기준 수·HP, worryMultiplier', () => {
  it('일차 d의 걱정 수·HP 공식', () => {
    // 가라앉음·멈춤으로 역류가 와서 웨이브 칸이 보스로 바뀌지 않게 그림자 증가를 끈다
    const g = fresh((d) => {
      d.balance.shadow.sinkShadow = 0;
      d.balance.night.stallShadowPerSec = 0;
    });
    g.debugGotoDay(4);
    begin(g);
    const es = runDay(g, 3000); // 방어 없음: Happy 거점 혼자 막으므로 하루가 길다
    expect(g.phase).toBe('diary');
    const spawns = ofType(es, 'spawnWorry').filter((e) => !e.boss);
    expect(spawns).toHaveLength(waveCount({ ...W, hpBase: 1 }, 4) * 3);
  });

  it('worryMultiplier는 수와 HP 모두에 곱한다 (넘어져 다친 날 ×1.4)', () => {
    const g = fresh();
    begin(g, 'scraped_knee');
    ticks(g, 60 * W.dayStartDelay + 1);
    const w = g.defense.worries[0];
    expect(w.maxHp).toBeCloseTo(waveHp({ ...W, hpBase: base.monsters.worry.hpBase }, 1, 1.4), 9);
    expect(g.wave.count).toBe(Math.round((W.countBase) * 1.4));
  });
});

describe('하루 시작 처리', () => {
  it('spawnedToday 리셋, 기쁨 가감(0 미만 불가)', () => {
    const g = fresh();
    begin(g);
    g.spawn();
    g.spawn();
    expect(g.spawnedToday).toBe(2);
    g.debugEndDay();
    g.nextDay();
    const joy = g.joy;
    begin(g, 'favorite_lunch');
    expect(g.spawnedToday).toBe(0);
    expect(g.joy).toBe(joy + 15);
  });

  it('freePieces: 빈 칸 rng 배치 (생일: 강아지 2단계)', () => {
    const g = fresh();
    const es = begin(g, 'birthday');
    const [fp] = ofType(es, 'freePiece');
    expect(fp.ret.piece).toMatchObject({ chain: DOG, tier: 2 });
    expect(g.grid.cells[fp.ret.placedAt!]).toBe(fp.ret.piece);
  });

  it('freePieces: 칸이 없으면 귀환 대기열 규칙', () => {
    const g = fresh();
    while (g.debugGrant(BLANKET, 1) !== null);
    const es = begin(g, 'birthday');
    expect(ofType(es, 'freePiece')[0].ret).toMatchObject({ placedAt: null, queued: true });
    expect(g.returnQueue).toHaveLength(1);
  });

  it('chainWeight가 조각 생성 확률에 반영 (비 오는 날: 담요 ×2 → 약 2/3)', () => {
    const g = fresh();
    begin(g, 'rainy_day');
    expect(g.chainWeight(BLANKET)).toBe(2);
    expect(g.chainWeight(DOG)).toBe(1);
    let blanket = 0;
    const N = 600;
    for (let k = 0; k < N; k++) {
      g.joy = 1000;
      g.spawnedToday = 0;
      const r = g.spawn()!;
      if (r.piece.chain === BLANKET) blanket += 1;
      g.grid.cells[r.index] = null;
    }
    expect(blanket / N).toBeGreaterThan(0.6);
    expect(blanket / N).toBeLessThan(0.73);
    // 다음 날은 원래대로
    g.debugEndDay();
    g.nextDay();
    begin(g);
    expect(g.chainWeight(BLANKET)).toBe(1);
  });
});

describe('이정표', () => {
  const tooth = base.events.milestones[0];
  const happy = tooth.choices.find((c) => c.id === 'happy')!;
  const unhappy = tooth.choices.find((c) => c.id === 'unhappy')!;

  it('Happy가 맡는다: 기쁨 +, 그림자 +, flag avoid', () => {
    const g = fresh();
    const joy = g.joy;
    begin(g, 'first_tooth', 'happy');
    expect(g.joy).toBe(joy + happy.joy);
    expect(g.shadow).toBe(happy.shadow);
    expect(g.flags).toEqual(['avoid']);
  });

  it('Happy 선택의 그림자로 가득 차면 역류 예약 (남은 칸 = 아침)', () => {
    const g = fresh();
    g.debugSetShadow(base.balance.shadow.shadowMax - 5);
    const es = begin(g, 'first_tooth', 'happy');
    expect(ofType(es, 'backflowPending')).toEqual([{ type: 'backflowPending', slot: 'morning' }]);
  });

  it('Unhappy가 맡는다: 기쁨 −(0 미만 불가), flag face, 층 남은 HP × (1 − reduce)는 그날 밤(해질녘)에 1회', () => {
    const g = fresh((d) => (d.balance.days.morningJoyFloor = 0)); // 바닥은 따로 테스트
    g.joy = 5;
    const hp = g.abyss.wall.hp;
    begin(g, 'first_tooth', 'unhappy');
    expect(g.joy).toBe(0);
    expect(g.flags).toEqual(['face']);
    expect(g.abyss.wall.hp).toBe(hp); // 낮에는 아직
    g.debugToNight();
    expect(g.abyss.wall.hp).toBeCloseTo(hp * (1 - unhappy.faceLayerHpReduce!), 9);
    ticks(g, 120);
    expect(g.abyss.wall.hp).toBeCloseTo(hp * (1 - unhappy.faceLayerHpReduce!), 9); // 다시 줄지 않음
  });

  it('face: 그날 밤 첫 층 돌파 때만 귀환 조각 +1 (첫 비영웅 체인 1단계)', () => {
    const g = fresh();
    begin(g, 'first_tooth', 'unhappy');
    g.debugToNight();
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.summon(g.debugGrant(BLANKET, 2)!, 'unhappy');
    g.debugBreakLayer();
    const [c1] = ofType(ticks(g, 1), 'layerClear');
    expect(c1.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([
      [WILDCARD, 0],
      [BLANKET, 3],
      [BLANKET, 1], // 보너스
    ]);
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugBreakLayer();
    const [c2] = ofType(ticks(g, 1), 'layerClear');
    expect(c2.returns).toHaveLength(1); // 두 번째 돌파에는 없음
  });

  it('face: 돌파 유닛이 영웅뿐이면 보너스는 와일드카드', () => {
    const g = fresh();
    begin(g, 'first_tooth', 'unhappy');
    g.debugToNight();
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.debugBreakLayer();
    const [c] = ofType(ticks(g, 1), 'layerClear');
    expect(c.returns.map((r) => r.piece.chain)).toEqual([WILDCARD, WILDCARD]);
  });
});

describe('역류의 시점 (D-021)', () => {
  /** 심연 유닛 1기(제자리)로 멈춤을 막는다 */
  function calm(): GameState {
    const g = fresh((d) => {
      d.balance.lane.abyssAdvanceSpeed = 0;
      d.balance.happy.atk = 0;
    });
    begin(g);
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    return g;
  }
  function untilSlot(g: GameState, slot: number) {
    for (let k = 0; k < 60 * 300 && !(g.wave.slot === slot && g.wave.active); k++) g.tick(FIXED_DT);
  }

  it('낮 도중 예약 → 저녁 웨이브가 보스', () => {
    const g = calm();
    untilSlot(g, 1);
    g.debugScheduleBackflow();
    expect(g.wave.bossSlots.has(2)).toBe(true);
    untilSlot(g, 2);
    expect(g.wave.isBoss).toBe(true);
    expect(g.bossLog.at(-1)).toMatchObject({ day: 1, slot: 'evening', prep: false });
  });

  it('저녁 도중 예약 → 다음 날 아침 보스 + 준비 시간(bossPrepSeconds)', () => {
    const g = calm();
    untilSlot(g, 2);
    const es: CoreEvent[] = [];
    g.debugScheduleBackflow();
    es.push(...g.tick(0));
    expect(ofType(es, 'backflowPending')).toEqual([{ type: 'backflowPending', slot: 'nextMorning' }]);
    expect(g.carryBackflow).toBe(true);
    runDay(g);
    g.nextDay();
    const begun = begin(g);
    expect(ofType(begun, 'dayBegin')[0].bossMorning).toBe(true);
    expect(g.wave.inBossPrep).toBe(true);
    // 준비 시간 동안 조각 생성·소환 가능, 보스는 아직
    ticks(g, 60 * W.bossPrepSeconds - 2);
    expect(g.defense.worries).toHaveLength(0);
    expect(g.spawn()).not.toBeNull();
    ticks(g, 3);
    expect(g.wave.isBoss).toBe(true);
    expect(g.bossLog.at(-1)).toMatchObject({ day: 2, slot: 'morning', prep: true });
  });

  it('보스 등장 진단 기록 필드', () => {
    const g = calm();
    g.summon(g.debugGrant(DOG, 2)!, 'happy');
    g.debugScheduleBackflow();
    ticks(g, 60 * W.dayStartDelay + 1);
    const rec = g.bossLog[0];
    expect(rec).toMatchObject({
      day: 1,
      slot: 'morning',
      prep: false,
      defenseUnits: 1,
      defenseAvgTier: 2,
      abyssUnits: 0, // 낮에는 심연 레인이 돌지 않는다 (맡긴 조각은 nightParty)
      shadowBefore: base.balance.shadow.shadowMax,
      win: null,
    });
    expect(rec.gridPieces).toBe(g.grid.cells.filter((c) => c !== null).length);
  });
});

describe('하루 끝 처리 (D-022: 방어 유닛도 귀환)', () => {
  it('방어 귀환 → 심연 귀환 → 일기 순서, dayStats 초기화, 그리드·그림자·층은 유지', () => {
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    g.summon(g.debugGrant(DOG, 3)!, 'happy'); // 영웅이면 저녁까지 살아남는다
    g.summon(g.debugGrant(BLANKET, 2)!, 'unhappy');
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.abyss.addExtraHp(7);
    const es = runDay(g);
    const order = es
      .filter((e) => e.type === 'dayReturn' || e.type === 'dayEnd')
      .map((e) => (e.type === 'dayReturn' ? `return:${e.side}` : e.type));
    expect(order).toEqual(['return:happy', 'return:unhappy', 'dayEnd']);
    expect(ofType(es, 'disband' as CoreEvent['type'])).toEqual([]); // 해산 없음
    expect(g.defense.units).toEqual([]);
    expect(g.abyss.units).toEqual([]);
    const [def, aby] = ofType(es, 'dayReturn');
    expect(def.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([[DOG, 3]]);
    expect(aby.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([
      [BLANKET, 2],
      [DOG, 3], // 영웅도 단계 그대로
    ]);
    // 층 진행도 유지: 하루 끝에 초기화되지 않음 (그날 가라앉음분까지 누적)
    expect(g.abyss.wall.extraHp).toBe(7 + g.lastDayStats!.sunk * base.balance.shadow.sinkLayerHp);
    expect(g.dayStats).toMatchObject({ sunk: 0, defeated: 0, sentUp: 0, realSeconds: 0 });
    expect(g.lastDayStats!.sentUp).toBe(1);
    expect(g.lastDayStats!.realSeconds).toBeGreaterThan(30);
  });

  it('살아남은 방어 유닛은 단계 그대로 귀환 (성장 없음), 다친 유닛도 같은 조각', () => {
    const g = fresh();
    begin(g);
    const r1 = g.summon(g.debugGrant(DOG, 1)!, 'happy');
    g.summon(g.debugGrant(BLANKET, 2)!, 'happy');
    if (r1.ok) r1.unit!.hp = 1; // 다쳐 있어도
    g.debugEndDay();
    const [def] = ofType(g.tick(0), 'dayReturn');
    expect(def.side).toBe('happy');
    expect(def.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([
      [DOG, 1],
      [BLANKET, 2],
    ]);
    for (const r of def.returns) expect(g.grid.cells[r.placedAt!]).toBe(r.piece);
    expect(g.defense.units).toEqual([]);
  });

  it('귀환 순서: 방어 → 심연, 각 레인 안에서는 소환 순서 (piece id가 그 순서로 증가)', () => {
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    g.summon(g.debugGrant(BLANKET, 1)!, 'unhappy'); // 심연 먼저 소환해도
    g.summon(g.debugGrant(DOG, 2)!, 'happy');
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.summon(g.debugGrant(BLANKET, 3)!, 'happy');
    g.debugEndDay();
    const rets = ofType(g.tick(0), 'dayReturn');
    const seq = rets.flatMap((e) => e.returns.map((r) => `${e.side}:${r.piece.chain}:${r.piece.tier}`));
    expect(seq).toEqual([
      `happy:${DOG}:2`,
      `happy:${BLANKET}:3`,
      `unhappy:${BLANKET}:1`,
      `unhappy:${DOG}:1`,
    ]);
    const ids = rets.flatMap((e) => e.returns.map((r) => r.piece.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('칸이 모자라면 대기열 → returnQueueCap 초과는 소실', () => {
    const cap = base.balance.grid.returnQueueCap;
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    for (let k = 0; k < 5; k++) g.summon(g.debugGrant(DOG, 1)!, 'happy');
    for (let k = 0; k < 5; k++) g.summon(g.debugGrant(BLANKET, 1)!, 'unhappy');
    while (g.debugGrant(DOG, 1) !== null); // 그리드 가득
    g.debugEndDay();
    const rets = ofType(g.tick(0), 'dayReturn').flatMap((e) => e.returns);
    expect(rets).toHaveLength(10);
    expect(rets.filter((r) => r.placedAt !== null)).toHaveLength(0);
    expect(rets.filter((r) => r.queued)).toHaveLength(cap);
    expect(rets.filter((r) => r.lost)).toHaveLength(10 - cap);
    // 대기열은 방어 유닛부터 찬다
    expect(rets.slice(0, cap).every((r) => r.queued)).toBe(true);
    expect(g.lostReturns).toBe(10 - cap);
  });

  it('방어선에 남은 걱정은 사라진다 (가라앉음 아님: 그림자·층 HP·sunk 변화 없음)', () => {
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy'); // 멈춤 그림자 방지
    ticks(g, 60 * (base.balance.wave.dayStartDelay + 2)); // 아침 걱정 몇 마리 등장
    expect(g.defense.worries.length).toBeGreaterThan(0);
    const shadow = g.shadow;
    const extra = g.abyss.wall.extraHp;
    const sunk = g.stats.sunkCount;
    g.debugEndDay();
    const es = g.tick(0);
    expect(g.defense.worries).toEqual([]);
    expect(ofType(es, 'sink')).toEqual([]);
    expect(g.shadow).toBe(shadow);
    expect(g.abyss.wall.extraHp).toBe(extra);
    expect(g.stats.sunkCount).toBe(sunk);
    expect(g.lastDayStats!.sunk).toBe(0);
  });
});

describe('그림일기', () => {
  const stats = (s: Partial<DayStats>): DayStats => ({
    ...emptyDayStats(0, 3),
    ...s,
  });
  const th = base.balance.diary.diarySinkThreshold;

  it('낮 결과 문장 우선순위: 역류 > 가라앉음 ≥ 기준 > 기본 (층 돌파는 밤 문장으로, v0.8)', () => {
    expect(diaryCategory(stats({ backflow: 1, layersCleared: 2, sunk: 9 }), th)).toBe('backflow');
    expect(diaryCategory(stats({ layersCleared: 1, sunk: 9 }), th)).toBe('manySunk');
    expect(diaryCategory(stats({ sunk: th }), th)).toBe('manySunk');
    expect(diaryCategory(stats({ sunk: th - 1, layersCleared: 3 }), th)).toBe('default');
  });

  it('밤 문장: 층 돌파 > 내려갔지만 돌파 못 함 > 아무도 내려가지 않음', () => {
    expect(nightCategory(stats({ layersCleared: 1, sentDown: 2 }))).toBe('layerCleared');
    expect(nightCategory(stats({ sentDown: 1 }))).toBe('tried');
    expect(nightCategory(stats({}))).toBe('none');
  });

  it('직전 날과 같은 결과 문장은 피한다 (후보가 둘 이상이면)', () => {
    const lines = base.diary.result.default;
    for (let s = 1; s <= 50; s++) expect(pickAvoiding(mulberry32(s), lines, lines[0])).toBe(lines[1]);
    expect(pickAvoiding(mulberry32(1), ['하나'], '하나')).toBe('하나');
  });

  it('문장 = 이벤트 문장 + 낮 결과 문장 + 밤 문장, 직전 밤 문장은 피한다', () => {
    const plain = { kind: 'plain' as const, id: 'plain' as const, title: '평범한 하루', text: '', effects: {} };
    const e = writeDiary(base, 3, plain, stats({}), mulberry32(2), null);
    expect(base.events.plainDay.diaryLines).toContain(e.eventLine);
    expect(base.diary.result.default).toContain(e.resultLine);
    expect(base.diary.night.none).toContain(e.nightLine);
    expect(e.line).toBe(`${e.eventLine} ${e.resultLine} ${e.nightLine}`);
    expect(e).toMatchObject({ day: 3, eventTitle: '평범한 하루', category: 'default', nightCategory: 'none' });
    for (let s = 1; s <= 20; s++) {
      const next = writeDiary(base, 4, plain, stats({}), mulberry32(s), e);
      expect(next.nightLine).not.toBe(e.nightLine);
    }
  });
});

describe('캘린더', () => {
  it('7일째 이정표, 10일째 생일', () => {
    const rng = mulberry32(1);
    expect(resolveDayEvent(base, 7, rng, [])).toMatchObject({ kind: 'milestone', id: 'first_tooth' });
    expect(resolveDayEvent(base, 10, rng, [])).toMatchObject({ kind: 'seasonal', id: 'birthday' });
  });

  it('일상 이벤트 쿨다운: dailyEventCooldownDays일 안에 반복하지 않음', () => {
    const d = structuredClone(base);
    d.days.dailyEventChance = 1;
    d.events.daily = d.events.daily.slice(0, 2); // 두 개만
    const used: DailyUse[] = [{ id: d.events.daily[0].id, day: 5 }];
    for (let s = 1; s <= 40; s++) {
      const e = resolveDayEvent(d, 5 + d.days.dailyEventCooldownDays, mulberry32(s), used);
      expect(e.id).toBe(d.events.daily[1].id);
    }
    // 쿨다운이 지나면 다시 나올 수 있음
    const later = new Set(
      Array.from({ length: 40 }, (_, s) => resolveDayEvent(d, 5 + d.days.dailyEventCooldownDays + 1, mulberry32(s + 1), used).id),
    );
    expect(later.has(d.events.daily[0].id)).toBe(true);
    // 모두 쿨다운이면 평범한 하루
    const all: DailyUse[] = d.events.daily.map((e) => ({ id: e.id, day: 5 }));
    expect(resolveDayEvent(d, 6, mulberry32(1), all).kind).toBe('plain');
  });

  it('14일 동안 GameState가 7일째 이정표·10일째 생일을 띄운다', () => {
    const g = fresh();
    const kinds: string[] = [];
    for (let day = 1; day <= 14; day++) {
      kinds.push(g.today.id);
      g.confirmDay(g.today.kind === 'milestone' ? 'unhappy' : undefined);
      g.debugEndDay();
      g.nextDay();
    }
    expect(kinds[6]).toBe('first_tooth');
    expect(kinds[9]).toBe('birthday');
    expect(g.phase).toBe('lifeEnd');
    expect(g.diary).toHaveLength(14);
  });
});

describe('조용한 날 (D-024)', () => {
  const NO_FIXED = (d: GameData) => {
    d.days.fixed = {};
    d.days.dailyEventChance = 1; // 조용한 날이 아니면 반드시 일상 이벤트
  };

  it('1 ~ quietDays일차는 평범한 하루, rng를 소비하지 않는다', () => {
    const d = structuredClone(base);
    NO_FIXED(d);
    for (let day = 1; day <= d.days.quietDays; day++) {
      let calls = 0;
      const rng = () => (calls++, 0);
      expect(resolveDayEvent(d, day, rng, []).kind).toBe('plain');
      expect(calls).toBe(0);
    }
  });

  it('quietDays + 1일차부터 기존 확률 (dailyEventChance)', () => {
    const d = structuredClone(base);
    NO_FIXED(d);
    const day = d.days.quietDays + 1;
    expect(resolveDayEvent(d, day, mulberry32(1), []).kind).toBe('daily');
    d.days.dailyEventChance = 0;
    let calls = 0;
    expect(resolveDayEvent(d, day, () => (calls++, 0.5), []).kind).toBe('plain');
    expect(calls).toBe(1);
  });

  it('고정 이벤트가 조용한 날보다 먼저 (quietDays 안의 고정 일차는 고정 이벤트)', () => {
    const d = structuredClone(base);
    d.days.fixed = { '1': 'birthday' };
    expect(resolveDayEvent(d, 1, mulberry32(1), []).id).toBe('birthday');
  });

  it('GameState: 1~2일차 카드는 평범한 하루', () => {
    const g = fresh(NO_FIXED);
    expect(g.today.kind).toBe('plain');
    g.confirmDay();
    g.debugEndDay();
    g.nextDay();
    expect(g.today.kind).toBe('plain');
    g.confirmDay();
    g.debugEndDay();
    g.nextDay();
    expect(g.today.kind).toBe('daily');
  });
});

describe('아침 기쁨 바닥 (D-024)', () => {
  const FLOOR = base.balance.days.morningJoyFloor;

  it('이벤트 효과 직후 joy = max(joy, morningJoyFloor): 바닥 미만이면 바닥으로', () => {
    const g = fresh();
    g.joy = 0;
    begin(g, 'plain');
    expect(g.joy).toBe(FLOOR);
    expect(g.dayStats.joyStart).toBe(FLOOR);
  });

  it('이미 바닥 이상이면 그대로 (가산이 아니다)', () => {
    const g = fresh();
    g.joy = FLOOR + 7;
    begin(g, 'plain');
    expect(g.joy).toBe(FLOOR + 7);
  });

  it('순서: 이벤트 joy 가감 뒤에 바닥 → 그다음 이정표 선택 효과', () => {
    // 이벤트 joy 감소로 바닥 밑으로 내려가도 바닥에서 시작
    const g = fresh((d) => d.events.daily.push({ id: 'bad_day', world: d.days.world, title: '나쁜 날', effects: { joy: -50 }, diaryLine: '나빴다.' }));
    g.joy = 30;
    begin(g, 'bad_day');
    expect(g.joy).toBe(FLOOR);

    // 이정표 선택(Unhappy: joy −10)은 바닥 뒤에 적용 → 바닥 − 10
    const m = fresh();
    const unhappy = base.events.milestones[0].choices.find((c) => c.id === 'unhappy')!;
    m.joy = 0;
    begin(m, 'first_tooth', 'unhappy');
    expect(m.joy).toBe(Math.max(0, FLOOR + unhappy.joy));
  });
});

describe('결정성', () => {
  /** 14일 일생: 간단한 입력 (매일 몇 번 생성·소환) */
  function life(seed: number) {
    const g = fresh(() => {}, seed);
    const log: string[] = [];
    while (g.phase !== 'lifeEnd') {
      if (g.phase === 'dayStart') g.confirmDay(g.today.kind === 'milestone' ? 'unhappy' : undefined);
      else if (g.timeFlows) {
        for (let k = 0; k < 600 && g.timeFlows; k++) {
          if (k % 120 === 0) {
            const s = g.spawn();
            if (s) g.summon(s.index, k % 240 === 0 ? 'happy' : 'unhappy');
          }
          log.push(...g.tick(FIXED_DT).map((e) => e.type));
        }
      } else g.nextDay();
    }
    return { log, diary: g.diary.map((d) => d.line), stats: { ...g.stats }, joy: g.joy, shadow: g.shadow, ticks: g.tickCount };
  }

  it('같은 시드·같은 입력이면 14일 결과 동일', () => {
    const a = life(7);
    expect(life(7)).toEqual(a);
    expect(a.diary).toHaveLength(14);
  });
});

describe('디버그 하루 끝', () => {
  it('아직 오지 않은 보스 칸을 건너뛰면 다음 날 아침 보스로 넘어간다', () => {
    const g = fresh();
    begin(g);
    g.debugScheduleBackflow(); // 아침 칸이 보스
    g.debugEndDay();
    expect(g.carryBackflow).toBe(true);
    g.nextDay();
    begin(g);
    expect(g.wave.inBossPrep).toBe(true);
  });
});

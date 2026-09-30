// M5: 하루 구조 (스펙 §5.1~5.4, §5.7 "테스트 (필수)")
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { resolveDayEvent, type DailyUse, type DayStats } from '../src/core/day';
import { diaryCategory, pickAvoiding, writeDiary } from '../src/core/diary';
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

/** 지금 날을 waves에서 diary까지 (최대 seconds) */
function runDay(g: GameState, seconds = 600): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < seconds * 60 && g.phase === 'waves'; k++) out.push(...g.tick(FIXED_DT));
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
  it('dayStart에서 시간 정지 → 카드 닫으면 waves → 저녁 종료 후 dayEnd → diary → 다음 날', () => {
    const g = fresh();
    expect(g.phase).toBe('dayStart');
    ticks(g, 600);
    expect(g.tickCount).toBe(0); // 시간이 흐르지 않음
    expect(g.defense.worries).toHaveLength(0);

    begin(g);
    expect(g.phase).toBe('waves');
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
    const g = fresh();
    g.debugGotoDay(4);
    begin(g);
    const es = runDay(g);
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

  it('Unhappy가 맡는다: 기쁨 −(0 미만 불가), 층 남은 HP × (1 − reduce) 1회, flag face', () => {
    const g = fresh();
    g.joy = 5;
    const hp = g.abyss.wall.hp;
    begin(g, 'first_tooth', 'unhappy');
    expect(g.joy).toBe(0);
    expect(g.abyss.wall.hp).toBeCloseTo(hp * (1 - unhappy.faceLayerHpReduce!), 9);
    expect(g.flags).toEqual(['face']);
    ticks(g, 120);
    expect(g.abyss.wall.hp).toBeCloseTo(hp * (1 - unhappy.faceLayerHpReduce!), 9); // 다시 줄지 않음
  });

  it('face: 그날 첫 층 돌파 때만 귀환 조각 +1 (첫 비영웅 체인 1단계)', () => {
    const g = fresh();
    begin(g, 'first_tooth', 'unhappy');
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
      abyssUnits: 1,
      shadowBefore: base.balance.shadow.shadowMax,
      win: null,
    });
    expect(rec.gridPieces).toBe(g.grid.cells.filter((c) => c !== null).length);
  });
});

describe('하루 끝 처리', () => {
  it('해산 → 심연 귀환(단계 그대로) → 일기 순서, dayStats 초기화, 그리드·그림자·층은 유지', () => {
    const g = fresh((d) => (d.balance.lane.abyssAdvanceSpeed = 0));
    begin(g);
    g.summon(g.debugGrant(DOG, 2)!, 'happy');
    g.summon(g.debugGrant(BLANKET, 2)!, 'unhappy');
    g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    g.abyss.addExtraHp(7);
    const es = runDay(g);
    const order = es.filter((e) => ['disband', 'dayReturn', 'dayEnd'].includes(e.type)).map((e) => e.type);
    expect(order).toEqual(['disband', 'dayReturn', 'dayEnd']);
    expect(g.defense.units).toEqual([]);
    expect(g.abyss.units).toEqual([]);
    const [ret] = ofType(es, 'dayReturn');
    expect(ret.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([
      [BLANKET, 2],
      [DOG, 3], // 영웅도 단계 그대로
    ]);
    // 층 진행도 유지: 하루 끝에 초기화되지 않음 (그날 가라앉음분까지 누적)
    expect(g.abyss.wall.extraHp).toBe(7 + g.lastDayStats!.sunk * base.balance.shadow.sinkLayerHp);
    expect(g.dayStats).toMatchObject({ sunk: 0, defeated: 0, sentUp: 0, realSeconds: 0 });
    expect(g.lastDayStats!.sentUp).toBe(1);
    expect(g.lastDayStats!.realSeconds).toBeGreaterThan(30);
  });
});

describe('그림일기', () => {
  const stats = (s: Partial<DayStats>): DayStats => ({
    sunk: 0, defeated: 0, layersCleared: 0, backflow: 0, bossWin: null,
    sentUp: 0, sentDown: 0, joyStart: 0, joyEnd: 0, realSeconds: 0, ...s,
  });
  const th = base.balance.diary.diarySinkThreshold;

  it('결과 문장 우선순위: 역류 > 층 돌파 > 가라앉음 ≥ 기준 > 기본', () => {
    expect(diaryCategory(stats({ backflow: 1, layersCleared: 2, sunk: 9 }), th)).toBe('backflow');
    expect(diaryCategory(stats({ layersCleared: 1, sunk: 9 }), th)).toBe('layerCleared');
    expect(diaryCategory(stats({ sunk: th }), th)).toBe('manySunk');
    expect(diaryCategory(stats({ sunk: th - 1 }), th)).toBe('default');
  });

  it('직전 날과 같은 결과 문장은 피한다 (후보가 둘 이상이면)', () => {
    const lines = base.diary.result.default;
    for (let s = 1; s <= 50; s++) expect(pickAvoiding(mulberry32(s), lines, lines[0])).toBe(lines[1]);
    expect(pickAvoiding(mulberry32(1), ['하나'], '하나')).toBe('하나');
  });

  it('문장 = 이벤트 문장 + 결과 문장, 일기장에 쌓인다', () => {
    const e = writeDiary(base, 3, { kind: 'plain', id: 'plain', title: '평범한 하루', text: '', effects: {} }, stats({}), mulberry32(2), null);
    expect(base.events.plainDay.diaryLines).toContain(e.eventLine);
    expect(base.diary.result.default).toContain(e.resultLine);
    expect(e.line).toBe(`${e.eventLine} ${e.resultLine}`);
    expect(e).toMatchObject({ day: 3, eventTitle: '평범한 하루', category: 'default' });
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

describe('결정성', () => {
  /** 14일 일생: 간단한 입력 (매일 몇 번 생성·소환) */
  function life(seed: number) {
    const g = fresh(() => {}, seed);
    const log: string[] = [];
    while (g.phase !== 'lifeEnd') {
      if (g.phase === 'dayStart') g.confirmDay(g.today.kind === 'milestone' ? 'unhappy' : undefined);
      else if (g.phase === 'waves') {
        for (let k = 0; k < 600 && g.phase === 'waves'; k++) {
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

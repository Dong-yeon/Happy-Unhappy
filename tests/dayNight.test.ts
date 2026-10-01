// M8: 낮(디펜스) → 밤(오펜스) 하루 구조 (스펙 §5.11, D-027)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const CAP = base.balance.lane.laneCap;
const NIGHT = base.balance.night;
const geo = () => gameGeometry(CAP);

function fresh(edit: (d: GameData) => void = () => {}, seed = 1): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, { cols: 5, rows: 4 }, mulberry32(seed), geo(), seed);
}
/** 평범한 하루로 시작 → day */
function begin(g: GameState): GameState {
  g.debugForceEvent('plain');
  expect(g.confirmDay()).toEqual({ ok: true });
  g.tick(0);
  return g;
}
function ticks(g: GameState, n: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...g.tick(FIXED_DT));
  return out;
}
function untilPhase(g: GameState, phase: string, max = 60 * 900): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let k = 0; k < max && g.phase !== phase; k++) out.push(...g.tick(FIXED_DT));
  return out;
}
const types = (es: CoreEvent[]) => es.map((e) => e.type);
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

describe('하루 흐름: dayStart → day → (해질녘) → night → (새벽) → diary', () => {
  it('저녁 웨이브가 끝나면 해질녘: 방어 유닛 귀환(dayReturn happy) → 맡긴 추억 소환(dusk) → night, 밤은 nightSeconds', () => {
    const g = begin(fresh());
    expect(g.phase).toBe('day');
    g.summon(g.debugGrant(DOG, 3)!, 'happy'); // 영웅은 저녁까지 살아남는다
    g.summon(g.debugGrant(BLANKET, 2)!, 'unhappy'); // 맡김
    const es = untilPhase(g, 'night');
    const i = types(es).indexOf('dayReturn');
    expect(types(es).slice(i, i + 2)).toEqual(['dayReturn', 'dusk']);
    const [ret] = ofType(es, 'dayReturn');
    expect(ret.side).toBe('happy');
    expect(ret.returns.map((r) => [r.piece.chain, r.piece.tier])).toEqual([[DOG, 3]]); // 단계 그대로
    expect(g.defense.units).toHaveLength(0);
    expect(g.defense.worries).toHaveLength(0);
    const [dusk] = ofType(es, 'dusk');
    expect(dusk.units.map((u) => [u.chain, u.tier, u.y])).toEqual([[BLANKET, 2, geo().abyss.startY]]);
    expect(g.abyss.units).toHaveLength(1);
    expect(g.nightParty).toEqual([]);
    expect(g.nightTimer).toBe(NIGHT.nightSeconds);
    expect(g.dayStats.nightSeconds).toBe(0);
    const daySeconds = g.dayStats.daySeconds;
    expect(daySeconds).toBeGreaterThan(0);

    // 밤: nightSeconds 뒤 새벽 → 심연 유닛 단계 그대로 귀환 → 그림일기
    const night = untilPhase(g, 'diary');
    expect(g.lastDayStats!.nightSeconds).toBeCloseTo(NIGHT.nightSeconds, 6);
    expect(g.lastDayStats!.daySeconds).toBe(daySeconds);
    expect(g.lastDayStats!.realSeconds).toBeCloseTo(daySeconds + NIGHT.nightSeconds, 6);
    const back = ofType(night, 'dayReturn');
    expect(back.map((r) => r.side)).toEqual(['unhappy']);
    expect(types(night).slice(-2)).toEqual(['dayReturn', 'dayEnd']);
  });

  it('시간은 day·night에만 흐른다 (dayStart·diary 정지)', () => {
    const g = fresh();
    ticks(g, 120);
    expect(g.tickCount).toBe(0);
    begin(g);
    g.debugEndDay();
    expect(g.phase).toBe('diary');
    const t = g.tickCount;
    ticks(g, 120);
    expect(g.tickCount).toBe(t);
  });

  it('낮에는 심연 레인이 돌지 않고, 밤에는 방어 레인·웨이브가 돌지 않는다', () => {
    const g = begin(fresh());
    g.abyss.wall.hp = 0; // 낮에는 층 돌파 처리도 없다
    ticks(g, 60);
    expect(g.stats.layersCleared).toBe(0);
    g.debugToNight();
    expect(ofType(ticks(g, 1), 'layerClear')).toHaveLength(1);
    ticks(g, 600);
    expect(g.defense.worries).toHaveLength(0);
    expect(g.stats.worriesDefeated + g.stats.sunkCount).toBe(0);
  });
});

describe('맡기기 (낮의 손거울, §5.11-3)', () => {
  it('그리드에서 빠져 nightParty로, 기록은 맡긴 순간 (sentDownTierSum, reserved)', () => {
    const g = begin(fresh());
    const i = g.debugGrant(DOG, 2)!;
    const r = g.summon(i, 'unhappy');
    expect(r).toMatchObject({ ok: true, unit: null });
    expect(r.ok && r.reserved?.chain).toBe(DOG);
    expect(g.grid.cells[i]).toBeNull();
    expect(g.nightParty.map((p) => [p.chain, p.tier])).toEqual([[DOG, 2]]);
    expect(g.abyss.units).toHaveLength(0);
    expect(g.stats.sentDownTierSum).toBe(2);
    expect(g.summonLog.at(-1)).toMatchObject({ side: 'unhappy', reserved: true, tier: 2 });
    expect(g.dayStats).toMatchObject({ reserved: 1, sentDown: 1 });
    expect(types(g.tick(0))).toContain('reserve');
  });

  it('거부: wildcard / partyFull (laneCap), 되돌리기 API 없음', () => {
    const g = begin(fresh());
    const w = g.debugGrant(WILDCARD, 0)!;
    expect(g.summon(w, 'unhappy')).toEqual({ ok: false, reason: 'wildcard' });
    for (let k = 0; k < CAP; k++) expect(g.summon(g.debugGrant(BLANKET, 1)!, 'unhappy').ok).toBe(true);
    const extra = g.debugGrant(DOG, 1)!;
    expect(g.canSummon(extra, 'unhappy')).toBe('partyFull');
    expect(g.summon(extra, 'unhappy')).toEqual({ ok: false, reason: 'partyFull' });
    expect(g.nightParty).toHaveLength(CAP);
    // 창문은 정원과 무관하게 열려 있다
    expect(g.canSummon(extra, 'happy')).toBeNull();
  });

  it('해질녘에 맡긴 순서대로 심연 출발선 슬롯에 소환된다', () => {
    const g = begin(fresh());
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.summon(g.debugGrant(BLANKET, 3)!, 'unhappy');
    g.summon(g.debugGrant(DOG, 2)!, 'unhappy');
    g.debugToNight();
    expect(g.abyss.units.map((u) => [u.chain, u.tier])).toEqual([
      [DOG, 1],
      [BLANKET, 3],
      [DOG, 2],
    ]);
    expect(new Set(g.abyss.units.map((u) => u.slot)).size).toBe(3);
    expect(g.abyss.units.every((u) => !u.arrived && u.y === geo().abyss.startY)).toBe(true);
    expect(g.stats.sentDownTierSum).toBe(6); // 해질녘에 다시 세지 않음
  });
});

describe('밤 (§5.11-4)', () => {
  it('창문은 닫힘 (closed), 손거울은 즉시 소환, 그리드 조작은 된다', () => {
    const g = begin(fresh());
    g.debugToNight();
    const a = g.debugGrant(DOG, 2)!;
    expect(g.canSummon(a, 'happy')).toBe('closed');
    expect(g.summon(a, 'happy')).toEqual({ ok: false, reason: 'closed' });
    const r = g.summon(a, 'unhappy');
    expect(r.ok && r.unit?.side).toBe('unhappy');
    expect(g.abyss.units).toHaveLength(1);
    g.joy = 100;
    expect(g.spawn()).not.toBeNull();
  });

  it('dayStart·diary에서는 두 포탈 모두 closed', () => {
    const g = fresh();
    const a = g.debugGrant(DOG, 1)!;
    expect(g.canSummon(a, 'happy')).toBe('closed');
    expect(g.canSummon(a, 'unhappy')).toBe('closed');
  });

  it('잠들기: 낮·심연 유닛 있음·맡긴 추억 있음이면 불가', () => {
    const g = begin(fresh());
    expect(g.sleep()).toBe(false);
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugToNight();
    expect(g.canSleep).toBe(false); // 내려간 추억이 있다
    expect(g.sleep()).toBe(false);
  });

  it('잠들기: 남은 시간 × stallShadowPerSec를 한 번에 → 새벽 (멈춤 시간도 같은 만큼)', () => {
    const g = begin(fresh());
    g.debugToNight();
    ticks(g, 60 * 10); // 10초 멈춤
    const remaining = g.nightTimer;
    expect(remaining).toBeCloseTo(NIGHT.nightSeconds - 10, 6);
    const shadow = g.shadow;
    expect(g.canSleep).toBe(true);
    expect(g.sleep()).toBe(true);
    expect(g.phase).toBe('diary');
    expect(g.shadow).toBeCloseTo(shadow + remaining * NIGHT.stallShadowPerSec, 6);
    expect(g.stats.stallSeconds).toBeCloseTo(NIGHT.nightSeconds, 6);
    expect(g.lastDayStats!.stallSeconds).toBeCloseTo(NIGHT.nightSeconds, 6);
    expect(g.lastDayStats!.nightSeconds).toBeCloseTo(10, 6); // 건너뛴 시간은 흐르지 않음
    expect(types(g.tick(0))).toEqual(expect.arrayContaining(['sleep', 'dayEnd']));
  });

  it('잠들기 = 끝까지 기다린 것과 그림자 같음 (시간만 아낀다)', () => {
    const a = begin(fresh());
    a.debugToNight();
    untilPhase(a, 'diary');
    const b = begin(fresh());
    b.debugToNight();
    b.sleep();
    expect(b.shadow).toBeCloseTo(a.shadow, 6);
  });
});

describe('역류 시점 (§5.11-5)', () => {
  it('밤에 shadowMax에 닿으면 다음 날 아침 보스 + 준비 시간', () => {
    const g = begin(fresh());
    g.debugToNight();
    g.nightTimer = 1e6;
    g.debugSetShadow(base.balance.shadow.shadowMax - 0.1);
    const es = ticks(g, 60);
    expect(ofType(es, 'backflowPending')).toEqual([{ type: 'backflowPending', slot: 'nextMorning' }]);
    expect(g.carryBackflow).toBe(true);
    g.debugEndNight();
    g.nextDay();
    begin(g);
    expect(g.wave.inBossPrep).toBe(true);
    expect(g.wave.timer).toBe(base.balance.wave.bossPrepSeconds);
  });

  it('잠들기로 shadowMax를 넘어도 다음 날 아침 보스', () => {
    const g = begin(fresh());
    g.debugToNight();
    g.debugSetShadow(base.balance.shadow.shadowMax - 1);
    g.sleep();
    expect(g.carryBackflow).toBe(true);
    expect(g.shadow).toBe(base.balance.shadow.shadowMax);
  });

  it('낮에 닿으면 남은 웨이브 칸 하나를 보스로 교체 (하루는 3웨이브)', () => {
    const g = begin(fresh());
    g.debugScheduleBackflow();
    expect(g.wave.bossSlots.has(0)).toBe(true);
    expect(g.carryBackflow).toBe(false);
  });
});

describe('저장 경계 (§5.11-1)', () => {
  it('낮·밤에는 저장할 수 없고, 맡긴 추억이 있으면 거부', () => {
    const g = begin(fresh());
    expect(() => serializeGame(g)).toThrow(/경계/);
    g.debugToNight();
    expect(() => serializeGame(g)).toThrow(/경계/);
  });

  it('밤에 종료해도 그날 dayStart로 복원 (같은 이벤트·같은 진행)', () => {
    const g = fresh(() => {}, 4);
    const save = JSON.parse(JSON.stringify(serializeGame(g)));
    g.confirmDay(g.today.kind === 'milestone' ? 'unhappy' : undefined);
    g.summon(g.debugGrant(DOG, 2)!, 'unhappy');
    untilPhase(g, 'night');
    ticks(g, 60 * 5);
    // 종료 → 복원
    const back = GameState.fromSave(base, save, mulberry32(save.seed), geo(), { cols: 5, rows: 4 });
    expect(back.phase).toBe('dayStart');
    expect(back.day).toBe(1);
    expect(back.nightParty).toEqual([]);
    expect(back.abyss.units).toEqual([]);
    expect(back.today).toEqual(fresh(() => {}, 4).today);
  });
});

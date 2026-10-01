// 자라는 날 (스펙 §5.14-2·7, D-030)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { applyGrowth, branchOf, emptyGrowth, traitMult } from '../src/core/growth';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { makeSaveData, parseSave, serializeGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const GR = base.balance.growth;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const SIZE = { cols: 5, rows: 4 };
const GATING = { openableDays: 1, lastGrantDate: '2026-10-01', forgottenDays: 0, forgottenLog: [] };

function fresh(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(base);
  edit(d);
  return new GameState(d, SIZE, mulberry32(1), gameGeometry(d.balance.lane.laneCap), 1);
}

/** dayStart → (평범한 날) 낮·밤 즉시 끝 → diary */
function playDay(g: GameState): void {
  g.debugForceEvent('plain');
  expect(g.confirmDay().ok).toBe(true);
  g.debugEndDay();
  expect(g.phase).toBe('diary');
  g.tick(0); // 쌓인 이벤트 비우기
}

const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

describe('자라는 날: 시점 (§5.14-2)', () => {
  it('growthDays = [5, 10]: 그 날 dayStart에서 이벤트 카드(dayStart 이벤트)보다 먼저, 다른 날은 없음', () => {
    expect(base.days.growthDays).toEqual([5, 10]);
    const g = fresh();
    g.tick(0);
    const seen: { day: number; order: string[] }[] = [];
    while (g.day < g.lifeLengthDays) {
      playDay(g);
      g.nextDay();
      const es = g.tick(0).filter((e) => e.type === 'growth' || e.type === 'dayStart');
      seen.push({ day: g.day, order: es.map((e) => e.type) });
      expect(g.phase).toBe('dayStart');
    }
    for (const s of seen) {
      expect(s.order, `${s.day}일`).toEqual(base.days.growthDays.includes(s.day) ? ['growth', 'dayStart'] : ['dayStart']);
    }
    expect(g.growthLog.map((r) => r.day)).toEqual([5, 10]);
    // 일생 끝: 14일째 일기 뒤 자동 1회 → lifeEnd
    playDay(g);
    g.nextDay();
    expect(g.phase).toBe('lifeEnd');
    expect(g.growthLog.map((r) => r.day)).toEqual([5, 10, 14]);
    expect(ofType(g.tick(0), 'growth')).toHaveLength(1);
  });

  it('전설이 없어도 자라기는 일어난다 (갈래 slow), 진행이 멈추지 않는다', () => {
    const g = fresh();
    g.debugGotoDay(4);
    playDay(g);
    g.nextDay();
    expect(g.day).toBe(5);
    expect(g.phase).toBe('dayStart');
    expect(g.growthLog[0]).toMatchObject({ day: 5, branch: 'slow', consumed: [], pairs: 0, gained: { happy: 0, unhappy: 0 } });
    expect(g.confirmDay().ok).toBe(true);
  });

  it('그림일기: 자라는 날(5·10일)만 결과 문장 앞에 growth 문장', () => {
    const g = fresh();
    while (g.day < g.lifeLengthDays) {
      playDay(g);
      g.nextDay();
    }
    playDay(g);
    for (const e of g.diary) {
      if (base.days.growthDays.includes(e.day)) {
        expect(base.diary.growth).toContain(e.growthLine);
        expect(e.line).toBe(`${e.eventLine} ${e.growthLine} ${e.resultLine} ${e.nightLine}`);
      } else {
        expect(e.growthLine).toBeUndefined();
        expect(e.line).toBe(`${e.eventLine} ${e.resultLine} ${e.nightLine}`);
      }
    }
  });
});

describe('자라는 날: 소진 (§5.14-2-1)', () => {
  it('그리드 + 대기열의 전설만 전부 소진 (쉬는 전설 포함). 영웅·1~2단계·와일드카드는 남는다', () => {
    const g = fresh();
    g.grid.cells.fill(null);
    const c = g.grid.cells;
    c[0] = g.newPiece(DOG, 4, { legend: 'sunny_picnic' });
    c[1] = g.newPiece(BLANKET, 4, { legend: 'nap_friend', restUntil: 'dawn' }); // 쉬는 전설
    c[2] = g.newPiece(DOG, 4, { legend: 'park_walk' });
    c[3] = g.newPiece(DOG, 3); // 영웅
    c[4] = g.newPiece(BLANKET, 3, { shining: true, restUntil: 'dusk' }); // 빛나는 쉬는 영웅
    c[5] = g.newPiece(DOG, 1);
    c[6] = g.newPiece(BLANKET, 2);
    c[7] = g.newPiece(WILDCARD, 0);
    for (let i = 8; i < c.length; i++) c[i] = g.newPiece(DOG, 1);
    g.returnQueue.push(g.newPiece(BLANKET, 4, { legend: 'cozy_nap', restUntil: 'dusk' }), g.newPiece(BLANKET, 1));
    const kept = [3, 4, 5, 6, 7].map((i) => c[i]!.id);
    const r = g.grow();
    expect(r.consumed.map((x) => [x.recipe, x.cell])).toEqual([
      ['sunny_picnic', 0],
      ['nap_friend', 1],
      ['park_walk', 2],
      ['cozy_nap', null],
    ]);
    expect([...c, ...g.returnQueue].some((p) => p?.legend !== undefined)).toBe(false);
    for (const id of kept) expect(c.some((p) => p?.id === id)).toBe(true);
    // 대기열의 1단계는 빈 칸으로 들어간다
    expect(g.returnQueue).toHaveLength(0);
    expect(c.filter((p) => p?.chain === BLANKET && p.tier === 1)).toHaveLength(1);
    expect(r).toMatchObject({ happyCount: 2, purifiedCount: 2, pairs: 2, branch: 'together' });
  });

  it('특성 체인 = 전설의 첫 재료 체인 (Piece.chain)', () => {
    const g = fresh();
    g.grid.cells.fill(null);
    g.grid.cells[0] = g.newPiece(BLANKET, 4, { legend: 'nap_friend' });
    g.grid.cells[1] = g.newPiece(DOG, 4, { legend: 'not_alone_night' });
    g.grow();
    expect(g.traits).toEqual({ [`${BLANKET}:happy`]: 1, [`${DOG}:purified`]: 1 });
  });
});

describe('성장치·기억·특성·갈래·나이 (§5.14-2-2~6)', () => {
  const item = (recipe: string, kind: 'happy' | 'purified', chain = DOG) => ({ recipe, kind, chain, cell: null });

  it('성장치 = 종류별 수 × growthPerLegend, 기억(min 짝)마다 양쪽 + memoryBonus, 앨범 기록', () => {
    const growth = emptyGrowth();
    const traits = {};
    const r = applyGrowth(
      growth,
      traits,
      [item('sunny_picnic', 'happy'), item('nap_friend', 'happy', BLANKET), item('sunny_picnic', 'happy'), item('park_walk', 'purified')],
      GR,
      5,
      9,
    );
    expect(r.pairs).toBe(1);
    expect(r.gained).toEqual({ happy: 3 * GR.growthPerLegend + GR.memoryBonus, unhappy: GR.growthPerLegend + GR.memoryBonus });
    expect(growth).toMatchObject({
      happy: r.gained.happy,
      unhappy: r.gained.unhappy,
      memories: 1,
      branches: ['together'],
      album: [{ day: 5, happy: 'sunny_picnic', purified: 'park_walk' }],
      given: { happy: 3, purified: 1 },
    });
    // 두 번째 자라기는 누적
    applyGrowth(growth, traits, [item('cozy_nap', 'purified', BLANKET), item('not_alone_night', 'purified')], GR, 10, 10);
    expect(growth.memories).toBe(1);
    expect(growth.unhappy).toBe(r.gained.unhappy + 2 * GR.growthPerLegend);
    expect(growth.branches).toEqual(['together', 'unhappy']);
  });

  it('갈래 4종', () => {
    expect(branchOf(2, 0)).toBe('happy');
    expect(branchOf(0, 1)).toBe('unhappy');
    expect(branchOf(1, 3)).toBe('together');
    expect(branchOf(0, 0)).toBe('slow');
  });

  it('특성 스택: 전설마다 +1, 상한 traitMaxStacks (막힌 것은 traitsUp에서 빠짐)', () => {
    const traits: Record<string, number> = { [`${DOG}:happy`]: GR.traitMaxStacks - 1 };
    const r = applyGrowth(emptyGrowth(), traits, [item('sunny_picnic', 'happy'), item('sunny_picnic', 'happy'), item('park_walk', 'purified')], GR, 5, 9);
    expect(traits[`${DOG}:happy`]).toBe(GR.traitMaxStacks);
    expect(traits[`${DOG}:purified`]).toBe(1);
    expect(r.traitsUp).toEqual({ [`${DOG}:happy`]: 1, [`${DOG}:purified`]: 1 });
    expect(r.traits).toEqual(traits);
  });

  it('나이 +1, 걱정 HP × ageWorryMult^(자란 횟수) — 실제로 나오는 걱정에 적용 (역류 보스는 제외)', () => {
    const g = fresh();
    expect(g.age).toBe(base.days.age);
    const hp0 = g.worryHp;
    expect(hp0).toBe(g.wave.hp);
    g.grow();
    g.grow();
    expect(g.age).toBe(base.days.age + 2);
    expect(g.worryHp).toBeCloseTo(g.wave.hp * GR.ageWorryMult ** 2, 9);
    g.debugForceEvent('plain');
    g.confirmDay();
    let spawned: number | null = null;
    for (let i = 0; i < 60 * 120 && spawned === null; i++) {
      g.tick(FIXED_DT);
      const w = g.defense.worries.find((x) => !x.boss);
      if (w) spawned = w.maxHp;
    }
    expect(spawned).toBeCloseTo(g.wave.hp * GR.ageWorryMult ** 2, 6);
  });
});

describe('특성 적용 범위 (§5.14-2-4)', () => {
  it('happy 특성 = 낮 방어 레인만, purified 특성 = 밤 심연 레인만, 해당 체인만 (1~4단계)', () => {
    const g = fresh();
    Object.assign(g.traits, { [`${DOG}:happy`]: 2, [`${BLANKET}:purified`]: 3 });
    const m = (chain: string, lane: 'defense' | 'abyss') => traitMult(g.traits, chain, lane, GR);
    expect(m(DOG, 'defense')).toBeCloseTo(1 + 2 * GR.traitPerStack);
    expect(m(DOG, 'abyss')).toBe(1);
    expect(m(BLANKET, 'defense')).toBe(1);
    expect(m(BLANKET, 'abyss')).toBeCloseTo(1 + 3 * GR.traitPerStack);
    for (const tier of [1, 2, 3]) {
      const s = g.pieceStats({ chain: DOG, tier });
      expect(g.pieceStats({ chain: DOG, tier }, 'defense')).toMatchObject({ hp: s.hp * m(DOG, 'defense'), atk: s.atk * m(DOG, 'defense'), range: s.range });
      expect(g.pieceStats({ chain: DOG, tier }, 'abyss')).toEqual(s);
    }
    const legend = g.pieceStats({ chain: BLANKET, tier: 4, legend: 'cozy_nap' });
    expect(g.pieceStats({ chain: BLANKET, tier: 4, legend: 'cozy_nap' }, 'abyss').hp).toBeCloseTo(legend.hp * m(BLANKET, 'abyss'));
    expect(g.pieceStats({ chain: BLANKET, tier: 4, legend: 'cozy_nap' }, 'defense')).toEqual(legend);
  });

  it('실제 소환: 낮 창문 유닛은 happy 특성, 밤 손거울 유닛은 purified 특성', () => {
    const g = fresh((d) => (d.balance.lane.defenseInterceptRange = 0));
    Object.assign(g.traits, { [`${DOG}:happy`]: 1, [`${DOG}:purified`]: 4 });
    g.debugForceEvent('plain');
    g.confirmDay();
    g.wave.paused = true;
    const base3 = g.unitStats(DOG, 3);
    const r = g.summon(g.debugGrant(DOG, 3)!, 'happy');
    expect(r.ok && r.unit?.maxHp).toBeCloseTo(base3.hp * (1 + GR.traitPerStack));
    g.debugToNight();
    const r2 = g.summon(g.debugGrant(DOG, 3)!, 'unhappy');
    expect(r2.ok && r2.unit?.maxHp).toBeCloseTo(base3.hp * (1 + 4 * GR.traitPerStack));
  });
});

describe('저장·결정성 (§5.14-6)', () => {
  it('자라기 뒤 dayStart 저장 round-trip: growth·traits·age·growthLog 보존, 옛 저장(필드 없음)은 초기화', () => {
    const g = fresh();
    g.debugGotoDay(4);
    playDay(g);
    g.grid.cells.fill(null);
    g.grid.cells[0] = g.newPiece(DOG, 4, { legend: 'sunny_picnic' });
    g.grid.cells[1] = g.newPiece(DOG, 4, { legend: 'park_walk' });
    g.nextDay();
    g.tick(0);
    expect(g.growth.memories).toBe(1);
    const raw = JSON.stringify(makeSaveData(SIZE, GATING, serializeGame(g), 'x'));
    const r = parseSave(raw, base, SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = GameState.fromSave(base, r.save.game!, mulberry32(1), gameGeometry(5), SIZE);
    expect(back.growth).toEqual(g.growth);
    expect(back.traits).toEqual(g.traits);
    expect(back.age).toBe(g.age);
    expect(back.worryHp).toBe(g.worryHp);
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(serializeGame(g)));
    // 같은 입력이면 이후 진행도 같다
    for (const s of [g, back]) {
      s.debugForceEvent('plain');
      s.confirmDay();
      for (let i = 0; i < 600; i++) s.tick(FIXED_DT);
    }
    expect(back.defense.worries.map((w) => [w.x, w.y, w.hp])).toEqual(g.defense.worries.map((w) => [w.x, w.y, w.hp]));
    // 옛 저장 (growth·traits·age·growthLog 없음) → 스키마 불일치
    const old = JSON.parse(raw);
    for (const k of ['growth', 'traits', 'age', 'growthLog']) delete old.game[k];
    expect(parseSave(JSON.stringify(old), base, SIZE).ok).toBe(false);
    // 상한을 넘는 특성 스택은 거부
    const bad = JSON.parse(raw);
    bad.game.traits[`${DOG}:happy`] = GR.traitMaxStacks + 1;
    expect(parseSave(JSON.stringify(bad), base, SIZE).ok).toBe(false);
  });
});

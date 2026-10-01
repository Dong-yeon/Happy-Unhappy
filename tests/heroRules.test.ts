// M8.6 (a): 영웅 규칙 개편 — 부상 · 빛나는 영웅 · 조합표 · 보스 층 (스펙 §5.13, D-029)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent, type SummonResult } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT, layerBaseHp } from '../src/core/lane';
import { findRecipe } from '../src/core/recipes';
import { mulberry32 } from '../src/core/rng';
import { parseSave, makeSaveData, serializeGame } from '../src/core/save';
import { validateGameData } from '../src/data/validate';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { runLife } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const base = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';
const BLANKET = 'comfort_object';
const A = base.balance.abyss;
const SHINE = base.balance.hero.shineMult;
const SIZE = { cols: 5, rows: 4 };

function fresh(edit: (d: GameData) => void = () => {}): GameState {
  const d = structuredClone(base);
  d.balance.lane.defenseInterceptRange = 0; // 부상 판정만 보려고 유닛은 방어선에 고정
  edit(d);
  const g = new GameState(d, SIZE, mulberry32(1), gameGeometry(d.balance.lane.laneCap), 1);
  g.debugForceEvent('plain');
  g.confirmDay();
  g.tick(0);
  return g;
}
function ticks(g: GameState, n: number): CoreEvent[] {
  const out: CoreEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...g.tick(FIXED_DT));
  return out;
}
/** 즉시 소환 결과의 유닛 */
const unitOf = (r: SummonResult) => {
  if (!r.ok || !r.unit) throw new Error('즉시 소환이 아님');
  return r.unit;
};
const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);
/** 그리드에서 조건에 맞는 조각 칸 */
const find = (g: GameState, pred: (p: NonNullable<GameState['grid']['cells'][number]>) => boolean) =>
  g.grid.cells.findIndex((p) => p !== null && pred(p));

describe('부상 (§5.13-2)', () => {
  it('낮: 영웅 HP 0 → 즉시 그리드 귀환·restUntil dawn·포탈 거부(injured) → 새벽에 해제', () => {
    const g = fresh();
    g.wave.paused = true;
    const r = g.summon(g.debugGrant(DOG, 3)!, 'happy');
    unitOf(r).hp = 0;
    const es = ticks(g, 1);
    const [inj] = ofType(es, 'injured');
    expect(inj.side).toBe('happy');
    expect(inj.ret.piece).toMatchObject({ chain: DOG, tier: 3, restUntil: 'dawn' });
    expect(g.defense.units).toHaveLength(0);
    expect(g.stats.injuriesDay).toBe(1);
    const cell = find(g, (p) => p.restUntil === 'dawn');
    expect(cell).toBeGreaterThanOrEqual(0);
    expect(g.canSummon(cell, 'happy')).toBe('injured');
    expect(g.summon(cell, 'unhappy')).toEqual({ ok: false, reason: 'injured' }); // 맡기기도 거부
    g.debugToNight();
    expect(g.canSummon(cell, 'unhappy')).toBe('injured'); // 그날 밤까지 쉼
    g.debugEndNight();
    expect(g.grid.cells[cell]!.restUntil ?? null).toBeNull(); // 새벽에 해제
  });

  it('밤: 영웅 HP 0 → 그림자 abyssDeathShadow + restUntil dusk → 다음 날 낮 거부 → 해질녘 해제', () => {
    const g = fresh((d) => (d.balance.night.stallShadowPerSec = 0));
    g.debugToNight();
    g.nightTimer = 1e6;
    const r = g.summon(g.debugGrant(DOG, 3, { shining: true })!, 'unhappy');
    unitOf(r).hp = 0;
    const es = ticks(g, 1);
    const [inj] = ofType(es, 'injured');
    expect(inj.side).toBe('unhappy');
    expect(inj.ret.piece).toMatchObject({ chain: DOG, tier: 3, shining: true, restUntil: 'dusk' });
    expect(g.shadow).toBe(A.abyssDeathShadow);
    expect(g.stats).toMatchObject({ injuriesNight: 1, abyssDeaths: 0 });
    const cell = find(g, (p) => p.restUntil === 'dusk');
    g.debugEndNight();
    expect(g.grid.cells[cell]!.restUntil).toBe('dusk'); // 새벽에는 안 풀림
    g.nextDay();
    g.debugForceEvent('plain');
    g.confirmDay();
    expect(g.canSummon(cell, 'happy')).toBe('injured'); // 다음 날 낮 거부
    g.debugToNight();
    expect(g.grid.cells[cell]!.restUntil ?? null).toBeNull(); // 해질녘 해제
    expect(g.canSummon(cell, 'unhappy')).toBeNull();
  });

  it('1~2단계는 기존대로 쓰러지면 사라진다 (낮 소멸 / 밤 조각 소실 + 그림자)', () => {
    const g = fresh((d) => (d.balance.night.stallShadowPerSec = 0));
    g.wave.paused = true;
    const r = g.summon(g.debugGrant(DOG, 2)!, 'happy');
    unitOf(r).hp = 0;
    const before = g.grid.cells.filter(Boolean).length;
    expect(ofType(ticks(g, 1), 'injured')).toHaveLength(0);
    expect(g.grid.cells.filter(Boolean).length).toBe(before);
    g.debugToNight();
    g.nightTimer = 1e6;
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
    g.debugKillAbyssUnits();
    expect(ofType(ticks(g, 1), 'injured')).toHaveLength(0);
    expect(g.stats.abyssDeaths).toBe(1);
  });

  it('전설도 영웅과 같은 부상 규칙', () => {
    const g = fresh();
    g.wave.paused = true;
    const r = g.summon(g.debugGrant(DOG, 4, { legend: 'park_walk' })!, 'happy');
    expect(unitOf(r)).toMatchObject({ legend: 'park_walk', hp: base.recipes.recipes.find((x) => x.id === 'park_walk')!.legend.hp });
    unitOf(r).hp = 0;
    const [inj] = ofType(ticks(g, 1), 'injured');
    expect(inj.ret.piece).toMatchObject({ tier: 4, legend: 'park_walk', restUntil: 'dawn' });
  });

  it('영웅·전설은 귀환 대기열 상한을 무시 (사라지지 않음), 1~2단계·와일드카드는 상한 적용', () => {
    const g = fresh((d) => (d.balance.grid.returnQueueCap = 0));
    while (g.debugGrant(BLANKET, 1) !== null); // 그리드 가득
    expect(g.enqueueReturn(g.newPiece(DOG, 1))).toMatchObject({ lost: 1 });
    expect(g.enqueueReturn(g.newPiece(WILDCARD, 0))).toMatchObject({ lost: 1 });
    expect(g.enqueueReturn(g.newPiece(DOG, 3))).toMatchObject({ queued: true, lost: 0 });
    expect(g.enqueueReturn(g.newPiece(DOG, 4, { legend: 'park_walk' }))).toMatchObject({ queued: true, lost: 0 });
    expect(g.returnQueue).toHaveLength(2);
  });
});

describe('정화 (§5.13-3)', () => {
  function clearWith(pieces: [string, number, { shining?: boolean; legend?: string }?][]) {
    const g = fresh((d) => (d.balance.night.stallShadowPerSec = 0));
    g.debugToNight();
    g.nightTimer = 1e6;
    for (const [c, t, x] of pieces) g.summon(g.debugGrant(c, t, x ?? {})!, 'unhappy');
    g.debugBreakLayer();
    const [clear] = ofType(ticks(g, 1), 'layerClear');
    return { g, clear };
  }

  it('영웅 → 빛나는 영웅 (능력치 × shineMult), 와일드카드 미생성', () => {
    const { g, clear } = clearWith([[DOG, 3]]);
    expect(clear.returns.map((r) => r.piece)).toEqual([expect.objectContaining({ chain: DOG, tier: 3, shining: true })]);
    expect(g.grid.cells.some((p) => p?.chain === WILDCARD)).toBe(false);
    expect(g.stats).toMatchObject({ shiningMade: 1, wildcardsGained: 0 });
    const hero = base.chains.find((c) => c.archetypeId === DOG)!.hero;
    expect(g.pieceStats({ chain: DOG, tier: 3, shining: true })).toMatchObject({ hp: hero.hp * SHINE, atk: hero.atk * SHINE, range: hero.range });
  });

  it('이미 빛나는 영웅은 그대로 (shiningMade 늘지 않음)', () => {
    const { g, clear } = clearWith([[DOG, 3, { shining: true }]]);
    expect(clear.returns[0].piece).toMatchObject({ tier: 3, shining: true });
    expect(g.stats.shiningMade).toBe(0);
  });

  it('전설 → 그대로 + 도감 legendPurified', () => {
    const { g, clear } = clearWith([[DOG, 4, { legend: 'cozy_nap' }]]);
    expect(clear.returns[0].piece).toMatchObject({ tier: 4, legend: 'cozy_nap' });
    expect(g.legendPurified).toEqual(['cozy_nap']);
  });
});

describe('보스 층 (§5.13-4)', () => {
  it('bossFloorEvery 배수 층: HP × bossFloorHpMult, 반격 × bossFloorCounterMult', () => {
    const g = fresh();
    g.debugToNight();
    g.nightTimer = 1e6;
    while (g.abyss.wall.layer < A.bossFloorEvery) {
      g.debugBreakLayer();
      ticks(g, 1);
    }
    const w = g.abyss.wall;
    expect(w.layer).toBe(10);
    expect(w.maxHp).toBeCloseTo(layerBaseHp(A, 10) * A.bossFloorHpMult, 6);
    expect(w.atk).toBeCloseTo(A.counterAtk * A.bossFloorCounterMult, 9);
    expect(g.stats.bossFloorsReached).toBe(1);
    // 다음 층은 보통 층
    g.debugBreakLayer();
    ticks(g, 1);
    expect(g.abyss.wall.maxHp).toBeCloseTo(layerBaseHp(A, 11), 6);
    expect(g.abyss.wall.atk).toBe(A.counterAtk);
  });

  it('보스 층 돌파: 와일드카드 bossFloorWildcards개 + 그림자 감소 × 2 + bossFloorsCleared', () => {
    const g = fresh((d) => (d.balance.night.stallShadowPerSec = 0));
    g.debugToNight();
    g.nightTimer = 1e6;
    while (g.abyss.wall.layer < A.bossFloorEvery) {
      g.debugBreakLayer();
      ticks(g, 1);
    }
    g.summon(g.debugGrant(DOG, 1)!, 'unhappy'); // 멈춤 방지
    g.debugSetShadow(60);
    g.debugBreakLayer();
    const es = ticks(g, 1);
    const [boss] = ofType(es, 'bossFloorClear');
    expect(boss.layer).toBe(10);
    expect(boss.returns.map((r) => r.piece.chain)).toEqual(Array(A.bossFloorWildcards).fill(WILDCARD));
    expect(g.shadow).toBeCloseTo(60 - A.layerClearShadowReduce * 2, 6);
    expect(g.stats).toMatchObject({ bossFloorsCleared: 1, wildcardsGained: A.bossFloorWildcards });
  });

  it('보스 층 저장 복원 뒤에도 반격 배수 유지', () => {
    const g = fresh();
    g.debugToNight();
    g.nightTimer = 1e6;
    while (g.abyss.wall.layer < A.bossFloorEvery) {
      g.debugBreakLayer();
      ticks(g, 1);
    }
    g.debugEndNight();
    const save = JSON.parse(JSON.stringify(serializeGame(g)));
    const back = GameState.fromSave(base, save, mulberry32(save.seed), gameGeometry(5), SIZE);
    expect(back.abyss.wall.atk).toBeCloseTo(A.counterAtk * A.bossFloorCounterMult, 9);
  });
});

describe('조합 (§5.13-5)', () => {
  const R = base.recipes.recipes;
  function grid(): GameState {
    const g = fresh();
    g.wave.paused = true;
    g.grid.cells.fill(null);
    return g;
  }

  it('순서 무관: (빛나는 강아지, 담요 2) / (담요 2, 빛나는 강아지) 모두 공원 산책, B 칸에 전설·A 칸은 빈칸', () => {
    for (const [ia, ib] of [[0, 1], [1, 0]] as const) {
      const g = grid();
      g.grid.cells[0] = g.newPiece(DOG, 3, { shining: true });
      g.grid.cells[1] = g.newPiece(BLANKET, 2);
      expect(g.drop(ia, ib)).toBe('combine');
      expect(g.grid.cells[ia]).toBeNull();
      expect(g.grid.cells[ib]).toMatchObject({ tier: 4, legend: 'park_walk' });
      expect(g.stats).toMatchObject({ legendsMade: 1, legendsByRecipe: { park_walk: 1 } });
      expect(g.lastDayStats).toBeNull();
      expect(g.dayStats.combines[0]).toMatchObject({ recipe: 'park_walk' });
    }
  });

  it('shining: true 조건: 빛나지 않은 영웅이면 정화된 추억 조합 안 됨 → 교환', () => {
    const g = grid();
    g.grid.cells[0] = g.newPiece(DOG, 3);
    g.grid.cells[1] = g.newPiece(BLANKET, 3);
    expect(g.combinePreview(0, 1)).toBeNull(); // not_alone_night는 둘 다 빛나야 함
    expect(g.drop(0, 1)).toBe('swap');
  });

  it('shining: false 조건 (§5.14-1): 빛나지 않은 영웅 → 행복한 추억, 빛나는 영웅 → 정화된 추억', () => {
    const g = grid();
    const kindOf = (id: string | undefined) => R.find((x) => x.id === id)?.kind;
    // 강아지 영웅 + 담요 2단계
    const plainDog = g.newPiece(DOG, 3);
    const shinyDog = g.newPiece(DOG, 3, { shining: true });
    const blanket2 = g.newPiece(BLANKET, 2);
    expect(findRecipe(R, plainDog, blanket2)?.id).toBe('sunny_picnic');
    expect(findRecipe(R, shinyDog, blanket2)?.id).toBe('park_walk');
    expect(kindOf('sunny_picnic')).toBe('happy');
    expect(kindOf('park_walk')).toBe('purified');
    // 담요 영웅 + 강아지 2단계
    const plainBlanket = g.newPiece(BLANKET, 3);
    const shinyBlanket = g.newPiece(BLANKET, 3, { shining: true });
    const dog2 = g.newPiece(DOG, 2);
    expect(findRecipe(R, plainBlanket, dog2)?.id).toBe('nap_friend');
    expect(findRecipe(R, shinyBlanket, dog2)?.id).toBe('cozy_nap');
    // 빛나는 영웅은 shining: false 재료가 될 수 없다
    const onlyHappy = R.filter((x) => x.kind === 'happy');
    expect(findRecipe(onlyHappy, shinyDog, blanket2)).toBeNull();
    expect(findRecipe(onlyHappy, shinyBlanket, dog2)).toBeNull();
    // 실제 drop
    g.grid.cells[0] = plainDog;
    g.grid.cells[1] = blanket2;
    expect(g.drop(0, 1)).toBe('combine');
    expect(g.grid.cells[1]).toMatchObject({ tier: 4, legend: 'sunny_picnic', chain: DOG });
  });

  it('쉬는 재료 허용, 결과 전설은 쉬지 않는 새 조각', () => {
    const g = grid();
    g.grid.cells[0] = g.newPiece(DOG, 3, { shining: true, restUntil: 'dusk' });
    g.grid.cells[1] = g.newPiece(BLANKET, 3, { shining: true, restUntil: 'dawn' });
    expect(g.drop(0, 1)).toBe('combine');
    const p = g.grid.cells[1]!;
    expect(p.legend).toBe('not_alone_night');
    expect(p.restUntil ?? null).toBeNull();
    expect(g.canSummon(1, 'happy')).toBeNull();
  });

  it('우선순위: 여러 조합이 맞으면 조합표 순서상 앞의 것 (findRecipe)', () => {
    const g = grid();
    const park = R.find((x) => x.id === 'park_walk')!;
    const recipes = [park, { ...park, id: 'dup', name: '중복' }];
    const a = g.newPiece(DOG, 3, { shining: true });
    const b = g.newPiece(BLANKET, 2);
    expect(findRecipe(recipes, a, b)?.id).toBe('park_walk');
  });

  it('와일드카드·전설은 재료가 될 수 없다, 같은 체인·같은 단계는 기존 머지', () => {
    const g = grid();
    g.grid.cells[0] = g.newPiece(WILDCARD, 0);
    g.grid.cells[1] = g.newPiece(BLANKET, 2);
    expect(g.drop(0, 1)).toBe('merge'); // 와일드카드 + 2단계 = 기존 머지
    g.grid.cells[2] = g.newPiece(DOG, 4, { legend: 'park_walk' });
    g.grid.cells[3] = g.newPiece(BLANKET, 2);
    expect(g.combinePreview(2, 3)).toBeNull();
    g.grid.cells[4] = g.newPiece(DOG, 2);
    g.grid.cells[5] = g.newPiece(DOG, 2);
    expect(g.drop(4, 5)).toBe('merge');
  });

  it('일치하는 조합이 없으면 교환', () => {
    const g = grid();
    g.grid.cells[0] = g.newPiece(DOG, 2);
    g.grid.cells[1] = g.newPiece(BLANKET, 1);
    expect(g.drop(0, 1)).toBe('swap');
    expect(g.grid.cells[0]).toMatchObject({ chain: BLANKET });
  });

  it('검증: 재료 chain 존재·tier 2~3·재료 2개·id 중복·알 수 없는 키', () => {
    const d = structuredClone(rawGameData) as unknown as Record<string, unknown> & typeof rawGameData;
    const rs = d.recipes.recipes as unknown as Record<string, unknown>[];
    (rs[0].inputs as Record<string, unknown>[])[0].chain = 'nope';
    (rs[1].inputs as Record<string, unknown>[])[1].tier = 4;
    rs[2].id = 'park_walk';
    rs[2].extra = 1;
    const r = validateGameData(d);
    expect(r.ok).toBe(false);
    const issues = r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.reason}`).join('\n');
    expect(issues).toMatch(/recipes\.recipes\[0\]\.inputs\[0\]\.chain/);
    expect(issues).toMatch(/recipes\.recipes\[1\]\.inputs\[1\]\.tier/);
    expect(issues).toMatch(/조합 id 중복/);
    expect(issues).toMatch(/recipes\.recipes\[2\]\.extra.*알 수 없는 키/);
  });
});

describe('저장·결정성 (새 Piece 필드 포함)', () => {
  it('shining·restUntil·legend 조각 + legendPurified가 round-trip, 잘못된 legend는 초기화', () => {
    const g = fresh();
    g.debugGrant(DOG, 3, { shining: true, restUntil: 'dusk' });
    g.debugGrant(BLANKET, 4, { legend: 'cozy_nap' });
    g.legendPurified.push('cozy_nap');
    g.debugEndDay();
    const raw = JSON.stringify(makeSaveData(SIZE, { openableDays: 1, lastGrantDate: '2026-10-01', forgottenDays: 0, forgottenLog: [] }, serializeGame(g), 'x'));
    const r = parseSave(raw, base, SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = GameState.fromSave(base, r.save.game!, mulberry32(1), gameGeometry(5), SIZE);
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(serializeGame(g)));
    const bad = raw.replace('"legend":"cozy_nap"', '"legend":"nope"');
    expect(parseSave(bad, base, SIZE).ok).toBe(false);
  });

  it.each([
    ['balanced', 5],
    ['balanced', 17],
    ['alwaysHappy', 5],
  ] as const)('%s 시드 %i: 끊김 없이 vs 매 경계 round-trip → 동일', (policy, seed) => {
    const cfg = simJson as SimConfig;
    const a = runLife(base, cfg, POLICIES[policy], { seed, grid: SIZE });
    const b = runLife(base, cfg, POLICIES[policy], { seed, grid: SIZE, saveRoundTrip: true });
    expect(b.result).toEqual(a.result);
    expect(JSON.stringify(serializeGame(b.state))).toBe(JSON.stringify(serializeGame(a.state)));
  });

  it('balanced 일생에서 실제로 빛나는 영웅·전설·부상이 생긴다 (규칙이 연결됨)', () => {
    const r = runLife(base, simJson as SimConfig, POLICIES.balanced, { seed: 4, grid: SIZE }).result;
    expect(r.shiningMade).toBeGreaterThan(0);
    expect(r.legendsMade).toBeGreaterThan(0);
    // v0.11: balanced는 특성·짧은 판(1챕터)으로 부상이 드물다 → 부상은 hoarder(영웅만 창문으로)로 확인
    const injured = [1, 2, 3, 4].some((seed) => {
      const r = runLife(base, simJson as SimConfig, POLICIES.hoarder, { seed, grid: SIZE }).result;
      return r.injuriesDay + r.injuriesNight > 0;
    });
    expect(injured).toBe(true);
  });
});

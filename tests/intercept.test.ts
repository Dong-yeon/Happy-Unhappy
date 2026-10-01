// M8.5 (a): 방어 유닛 제한 이동 (§4.3.3, D-026) · 봇 밤 규칙 (§5.12-1, D-028) · 영웅 경고 (§5.12-2)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { FIXED_DT, Lane, type InterceptConfig, type LaneEvent, type Worry } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import { showHeroWarning } from '../src/scenes/heroWarning';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { runLife } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const base = structuredClone(rawGameData) as unknown as GameData;
const GEO = gameGeometry(base.balance.lane.laneCap).defense;
const LINE = GEO.lineY;
const HAPPY = { atk: 0, atkInterval: 1, range: 0 }; // Happy는 끼어들지 않게
const SPIRIT = { hp: 1000, atk: 1, atkInterval: 1, range: 20 };
const WORRY = { hp: 1000, speed: 60, atk: 0, atkInterval: 1, joyReward: 0 };
const IC: InterceptConfig = { range: 80, speed: 60, contact: 8 };

function lane(ic: InterceptConfig | null): Lane<'defense'> {
  return new Lane('defense', GEO, HAPPY, ic);
}
function step(l: Lane<'defense'>, n: number): LaneEvent[] {
  const out: LaneEvent[] = [];
  for (let i = 0; i < n; i++) l.step(FIXED_DT, out);
  return out;
}
/** 걱정을 y에 바로 놓는다 */
function worryAt(l: Lane<'defense'>, x: number, y: number, stats = WORRY): Worry {
  const w = l.spawnWorry(stats, x, []);
  w.y = y;
  return w;
}

describe('§4.3.3: defenseInterceptRange 0이면 기존 규칙과 같다', () => {
  it('같은 장면: intercept 없음 vs range 0 → 이벤트·상태 동일', () => {
    const run = (ic: InterceptConfig | null) => {
      const l = lane(ic);
      l.addUnit(1, 'happy', 'companion_animal', 1, { ...SPIRIT, hp: 30, range: 40, atk: 4 });
      l.addUnit(2, 'happy', 'comfort_object', 1, { ...SPIRIT, hp: 30, range: 40, atk: 4 });
      const ev: LaneEvent[] = [];
      for (let k = 0; k < 600; k++) {
        if (k % 50 === 0) l.spawnWorry({ ...WORRY, hp: 18, atk: 3, speed: 35 }, GEO.spawnXMin + ((k * 37) % 140), ev);
        l.step(FIXED_DT, ev);
      }
      return { ev, units: l.units.map((u) => [u.x, u.y, u.hp]), worries: l.worries.map((w) => [w.x, w.y, w.hp, w.state]) };
    };
    expect(run({ range: 0, speed: 60, contact: 8 })).toEqual(run(null));
  });

  it('range 0이면 유닛은 슬롯(방어선)에서 움직이지 않는다', () => {
    const l = lane({ range: 0, speed: 60, contact: 8 });
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    worryAt(l, u.x, LINE - 30);
    step(l, 60);
    expect([u.x, u.y]).toEqual([GEO.slotXs[u.slot], LINE]);
  });
});

describe('§4.3.3: 출격 구역·목줄', () => {
  it('손이 닿는 걱정(w.y ≥ lineY − range − u.range)을 향해 나가 w.y + contact에 선다', () => {
    const l = lane(IC);
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    const w = worryAt(l, 100, LINE - 60, { ...WORRY, speed: 0 });
    step(l, 120);
    expect(u.x).toBeCloseTo(100, 6);
    expect(u.y).toBeCloseTo(w.y + IC.contact, 6);
    expect(u.returning).toBe(false);
  });

  it('출격 구역(lineY − range) 밖으로는 나가지 않는다 (목줄)', () => {
    const l = lane(IC);
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    worryAt(l, 100, LINE - IC.range - SPIRIT.range + 1, { ...WORRY, speed: 0 }); // 손은 닿지만 구역 밖
    step(l, 300);
    expect(u.y).toBeCloseTo(LINE - IC.range, 6);
  });

  it('손이 닿지 않는 걱정은 쫓지 않고 홈에 머문다', () => {
    const l = lane(IC);
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    worryAt(l, 100, LINE - IC.range - SPIRIT.range - 5, { ...WORRY, speed: 0 });
    step(l, 60);
    expect([u.x, u.y]).toEqual([GEO.slotXs[u.slot], LINE]);
  });

  it('할 일이 없으면 홈으로 돌아간다 (돌아가는 동안 returning)', () => {
    const l = lane(IC);
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    const w = worryAt(l, 100, LINE - 60, { ...WORRY, speed: 0 });
    step(l, 120);
    l.worries.splice(l.worries.indexOf(w), 1);
    step(l, 1);
    expect(u.returning).toBe(true);
    step(l, 300);
    expect([u.x, u.y]).toEqual([GEO.slotXs[u.slot], LINE]);
    expect(u.returning).toBe(false);
  });

  it('이동 속도: 한 틱에 speed × dt 이하 (직선)', () => {
    const l = lane(IC);
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    worryAt(l, 20, LINE - 70, { ...WORRY, speed: 0 });
    const [x0, y0] = [u.x, u.y];
    step(l, 1);
    expect(Math.hypot(u.x - x0, u.y - y0)).toBeCloseTo(IC.speed * FIXED_DT, 9);
  });
});

describe('§4.3.3: 대상 분산', () => {
  it('앞선 유닛이 고른 걱정은 건너뛴다 → 두 유닛이 서로 다른 걱정으로', () => {
    const l = lane(IC);
    const a = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    const b = l.addUnit(2, 'happy', 'comfort_object', 1, SPIRIT)!;
    const near = worryAt(l, 40, LINE - 20, { ...WORRY, speed: 0 });
    const far = worryAt(l, 140, LINE - 50, { ...WORRY, speed: 0 });
    step(l, 240);
    expect(a.x).toBeCloseTo(near.x, 6); // 먼저 소환된 유닛 = 방어선에 가까운 걱정
    expect(b.x).toBeCloseTo(far.x, 6);
  });

  it('남은 걱정이 없으면 이미 고른 걱정을 함께 노린다', () => {
    const l = lane(IC);
    const a = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    const b = l.addUnit(2, 'happy', 'comfort_object', 1, SPIRIT)!;
    const w = worryAt(l, 90, LINE - 40, { ...WORRY, speed: 0 });
    step(l, 240);
    expect(a.x).toBeCloseTo(w.x, 6);
    expect(b.x).toBeCloseTo(w.x, 6);
  });
});

describe('§4.3.3: 걱정은 막는 유닛(x 최근접)의 y에서 멈추고, 물러나면 다시 이동', () => {
  it('moving 걱정이 막는 유닛 y에 닿으면 stopped (첫 공격 쿨다운 0)', () => {
    const l = lane({ ...IC, speed: 0 }); // 유닛은 제자리 (방어선)
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    u.y = LINE - 50; // 앞에 나가 있는 유닛
    const w = worryAt(l, u.x, LINE - 100);
    const ev = step(l, 120);
    expect(w.state).toBe('stopped');
    expect(w.y).toBe(u.y);
    expect(ev.some((e) => e.type === 'worryStop')).toBe(true);
  });

  it('막는 유닛이 아래로 물러나면(w.y < blocker.y) 다시 moving → 새 위치에서 다시 멈춤', () => {
    const l = lane({ ...IC, speed: 0 });
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    u.y = LINE - 50;
    const w = worryAt(l, u.x, LINE - 60);
    step(l, 60);
    expect(w.state).toBe('stopped');
    u.y = LINE - 20; // 물러남
    step(l, 1);
    expect(w.state).toBe('moving');
    step(l, 120);
    expect(w.state).toBe('stopped');
    expect(w.y).toBe(LINE - 20);
  });

  it('막는 유닛이 모두 사라지면 방어선 위에서는 moving → 방어선을 지나 passing', () => {
    const l = lane({ ...IC, speed: 0 });
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, SPIRIT)!;
    u.y = LINE - 50;
    const w = worryAt(l, u.x, LINE - 60);
    step(l, 60);
    l.units.length = 0;
    step(l, 1);
    expect(w.state).toBe('moving');
    step(l, 120);
    expect(w.state).toBe('passing');
  });
});

describe('§4.3.3: 유닛 사거리는 자기 y 기준 (Happy는 방어선 기준)', () => {
  it('앞에 나간 유닛은 방어선에서 먼 걱정도 친다, 자기 y에서 range 밖은 못 친다', () => {
    const l = lane({ ...IC, speed: 0 });
    const u = l.addUnit(1, 'happy', 'companion_animal', 1, { ...SPIRIT, range: 20 })!;
    u.y = LINE - 70;
    const inRange = worryAt(l, 10, LINE - 85, { ...WORRY, speed: 0 }); // |Δy| 15
    const ev = step(l, 1);
    const hits = ev.filter((e) => e.type === 'attack' && e.attacker.kind === 'unit');
    expect(hits.map((e) => (e as { targetId: number }).targetId)).toEqual([inRange.id]);
    const l2 = lane({ ...IC, speed: 0 });
    const u2 = l2.addUnit(1, 'happy', 'companion_animal', 1, { ...SPIRIT, range: 20 })!;
    u2.y = LINE - 70;
    worryAt(l2, 10, LINE - 5, { ...WORRY, speed: 0 }); // 방어선에는 가깝지만 유닛에서 |Δy| 65
    expect(step(l2, 1).filter((e) => e.type === 'attack' && e.attacker.kind === 'unit')).toHaveLength(0);
  });
});

// ── GameState·결정성 ──

function withRange(range: number): GameData {
  const d = structuredClone(base);
  d.balance.lane.defenseInterceptRange = range;
  return d;
}

describe('결정성 (제한 이동 켬)', () => {
  it.each([11, 22])('balanced 시드 %i, range 80: 끊김 없이 vs 매 경계 round-trip → 동일', (seed) => {
    const d = withRange(80);
    const cfg = simJson as SimConfig;
    const a = runLife(d, cfg, POLICIES.balanced, { seed, grid: { cols: 5, rows: 4 } });
    const b = runLife(d, cfg, POLICIES.balanced, { seed, grid: { cols: 5, rows: 4 }, saveRoundTrip: true });
    expect(b.result).toEqual(a.result);
    expect(JSON.stringify(serializeGame(b.state))).toBe(JSON.stringify(serializeGame(a.state)));
  });

  it('range > 0이면 실제로 결과가 달라진다 (설정이 core에 전달됨)', () => {
    const cfg = simJson as SimConfig;
    const a = runLife(withRange(0), cfg, POLICIES.balanced, { seed: 3, grid: { cols: 5, rows: 4 } });
    const b = runLife(withRange(120), cfg, POLICIES.balanced, { seed: 3, grid: { cols: 5, rows: 4 } });
    expect(b.result).not.toEqual(a.result);
  });
});

// ── 봇 balanced 밤 규칙 (§5.12-1) ──

describe('봇 balanced: 영웅은 손거울로 보내지 않는다', () => {
  const cfg = simJson as SimConfig;
  const DOG = 'companion_animal';
  function night(): GameState {
    const g = new GameState(structuredClone(base), { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(5), 1);
    g.debugForceEvent('plain');
    g.confirmDay();
    g.debugToNight();
    g.grid.cells.fill(null);
    return g;
  }
  const decide = (g: GameState) => POLICIES.balanced.decide({ state: g, rng: mulberry32(1), cfg });

  it('밤: 영웅만 있으면 아무것도 보내지 않음, abyssMinTier ≤ 단계 < maxTier는 보냄', () => {
    const g = night();
    g.grid.cells[0] = g.newPiece(DOG, 3);
    expect(decide(g)).toBeNull();
    g.grid.cells[5] = g.newPiece('comfort_object', 2);
    expect(decide(g)).toEqual({ type: 'summon', cell: 5, side: 'unhappy' });
  });

  it('밤: 와일드카드는 머지에만 (머지 우선)', () => {
    const g = night();
    g.grid.cells[0] = g.newPiece(WILDCARD, 0);
    g.grid.cells[1] = g.newPiece(DOG, 2);
    expect(decide(g)).toMatchObject({ type: 'drop' });
    const solo = night();
    solo.grid.cells[0] = solo.newPiece(WILDCARD, 0);
    expect(decide(solo)).toBeNull();
  });

  it('낮의 맡기기도 영웅 제외 (안전할 때 abyssMinTier 이상만)', () => {
    const g = new GameState(structuredClone(base), { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(5), 1);
    g.debugForceEvent('plain');
    g.confirmDay();
    g.wave.paused = true;
    g.grid.cells.fill(null);
    for (let k = 0; k < cfg.balanced.minUnits; k++) g.summon(g.debugGrant(DOG, 1)!, 'happy'); // 방어 충분 = 안전
    g.joy = 0; // 생성 불가
    g.grid.cells[0] = g.newPiece(DOG, 3);
    const a = decide(g);
    expect(a === null || a.type !== 'summon' || a.side !== 'unhappy').toBe(true);
    g.grid.cells[7] = g.newPiece('comfort_object', 2);
    expect(decide(g)).toEqual({ type: 'summon', cell: 7, side: 'unhappy' });
  });
});

// ── 영웅 경고 (§5.12-2) ──

describe('영웅 정화 경고', () => {
  function state(phase: 'day' | 'night'): GameState {
    const g = new GameState(structuredClone(base), { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(5), 1);
    g.debugForceEvent('plain');
    g.confirmDay();
    if (phase === 'night') g.debugToNight();
    g.grid.cells.fill(null);
    return g;
  }

  it('영웅을 손거울에 올리면 표시 (낮 = 맡기기, 밤 = 즉시)', () => {
    for (const ph of ['day', 'night'] as const) {
      const g = state(ph);
      g.grid.cells[0] = g.newPiece('companion_animal', 3);
      expect(showHeroWarning(g, 0, 'unhappy'), ph).toBe(true);
    }
  });

  it('다른 단계·와일드카드·창문·보낼 수 없을 때는 미표시', () => {
    const g = state('day');
    g.grid.cells[0] = g.newPiece('companion_animal', 2);
    g.grid.cells[1] = g.newPiece(WILDCARD, 0);
    g.grid.cells[2] = g.newPiece('companion_animal', 3);
    expect(showHeroWarning(g, 0, 'unhappy')).toBe(false);
    expect(showHeroWarning(g, 1, 'unhappy')).toBe(false);
    expect(showHeroWarning(g, 2, 'happy')).toBe(false);
    expect(showHeroWarning(g, 2, null)).toBe(false);
    for (let k = 0; k < base.balance.lane.laneCap; k++) g.summon(g.debugGrant('comfort_object', 1)!, 'unhappy');
    expect(showHeroWarning(g, 2, 'unhappy')).toBe(false); // partyFull
  });
});

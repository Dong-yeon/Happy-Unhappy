// 디펜스 영웅·병사 제한 이동 (§4.3.3, D-026: v0.13에서 방어 유닛 → 디펜스 영웅·병사, 레인 규칙 그대로)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { FIXED_DT, Lane, type InterceptConfig, type LaneEvent, type Worry } from '../src/core/lane';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const GEO = gameGeometry(base.balance.merge.soldierCap + 1).defense;
const LINE = GEO.lineY;
const HAPPY = { atk: 0, atkInterval: 1, range: 0 }; // Happy는 끼어들지 않게
const SPIRIT = { hp: 1000, atk: 1, atkInterval: 1, range: 20 };
const WORRY = { type: 'shadow', hp: 1000, speed: 60, atk: 0, atkInterval: 1, joyReward: 0 };
const IC: InterceptConfig = { range: 80, speed: 60, contact: 8 };

function lane(ic: InterceptConfig | null): Lane {
  return new Lane('defense', GEO, HAPPY, ic);
}
function step(l: Lane, n: number): LaneEvent[] {
  const out: LaneEvent[] = [];
  for (let i = 0; i < n; i++) l.step(FIXED_DT, out);
  return out;
}
/** 걱정을 y에 바로 놓는다 */
function worryAt(l: Lane, x: number, y: number, stats = WORRY): Worry {
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

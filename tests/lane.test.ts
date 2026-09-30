import { describe, expect, it } from 'vitest';
import { FIXED_DT, Lane, stepAttack, type LaneEvent, type LaneGeometry, type WorryStats } from '../src/core/lane';

// 단순한 좌표: 방어선 y=100, 가라앉음 y=116, 슬롯 x 10~90, 가운데 50
const GEO: LaneGeometry = {
  spawnY: 0,
  lineY: 100,
  sinkY: 116,
  spawnXMin: 0,
  spawnXMax: 100,
  centerX: 50,
  slotXs: [10, 30, 50, 70, 90],
  happyX: 200,
};
/** Happy가 끼어들지 않도록 사거리 밖 */
const NO_HAPPY = { atk: 0, atkInterval: 1, range: -1e6 };

const WORRY: WorryStats = { hp: 18, speed: 60, atk: 3, atkInterval: 1.2, joyReward: 3 };
const SPIRIT = { hp: 20, atk: 4, atkInterval: 1.0, range: 40 };

function lane(happy = NO_HAPPY): Lane {
  return new Lane('defense', GEO, happy);
}
function run(l: Lane, seconds: number, out: LaneEvent[] = []): LaneEvent[] {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) l.step(FIXED_DT, out);
  return out;
}
let unitId = 1;
function unit(l: Lane, stats = SPIRIT) {
  return l.addUnit(unitId++, 'happy', 'companion_animal', 1, stats)!;
}

describe('stepAttack (공용 쿨다운)', () => {
  it('쿨다운 0 → 대상이 있으면 즉시 공격, 이후 atkInterval마다', () => {
    const a = { atk: 1, atkInterval: 0.5, cd: 0 };
    const hits: number[] = [];
    for (let t = 1; t <= 90; t++) if (stepAttack(a, FIXED_DT, true)) hits.push(t);
    expect(hits).toEqual([1, 31, 61]);
  });

  it('대상이 없으면 쿨다운은 0에서 대기 → 대상이 생긴 틱에 바로 공격', () => {
    const a = { atk: 1, atkInterval: 0.5, cd: 0 };
    for (let i = 0; i < 100; i++) expect(stepAttack(a, FIXED_DT, false)).toBe(false);
    expect(a.cd).toBe(0);
    expect(stepAttack(a, FIXED_DT, true)).toBe(true);
  });
});

describe('걱정 이동: 방어선', () => {
  it('유닛 0기 → 방어선을 통과해 sinkY를 지나면 가라앉음', () => {
    const l = lane();
    const out: LaneEvent[] = [];
    l.spawnWorry(WORRY, 50, out);
    run(l, 1.5, out); // 60px/s × 1.5 = 90 → 아직 방어선 위
    expect(l.worries[0].state).toBe('moving');
    run(l, 0.5, out); // 120 ≥ 116 → 가라앉음
    expect(l.worries).toHaveLength(0);
    expect(out.filter((e) => e.type === 'sink')).toHaveLength(1);
    expect(out.some((e) => e.type === 'worryStop')).toBe(false);
  });

  it('유닛 1기 이상 → 방어선에서 멈춤', () => {
    const l = lane();
    unit(l, { ...SPIRIT, atk: 0 }); // 죽이지 않도록 공격력 0
    const out: LaneEvent[] = [];
    l.spawnWorry(WORRY, 50, out);
    run(l, 5, out);
    expect(l.worries[0].state).toBe('stopped');
    expect(l.worries[0].y).toBe(GEO.lineY);
    expect(out.filter((e) => e.type === 'worryStop')).toHaveLength(1);
    expect(out.some((e) => e.type === 'sink')).toBe(false);
  });

  it('막던 유닛이 모두 죽으면 다시 이동 → 가라앉음', () => {
    const l = lane();
    unit(l, { hp: 3, atk: 0, atkInterval: 1, range: 40 }); // 걱정 공격 한 번(3)에 죽음
    const out: LaneEvent[] = [];
    l.spawnWorry(WORRY, 50, out);
    run(l, 1.8, out); // 100px 도달(≈1.67s) → 멈춤 + 도착 틱에 첫 공격 → 유닛 사망
    expect(out.some((e) => e.type === 'unitDie')).toBe(true);
    expect(l.units).toHaveLength(0);
    run(l, 0.5, out);
    expect(out.some((e) => e.type === 'sink')).toBe(true);
  });

  it('걱정은 방어선에 도착한 틱에 첫 공격, 이후 atkInterval마다', () => {
    const l = lane();
    const u = unit(l, { hp: 1000, atk: 0, atkInterval: 1, range: 40 });
    const out: LaneEvent[] = [];
    l.spawnWorry({ ...WORRY, speed: 1e6 }, 50, out); // 첫 틱에 바로 도착
    l.step(FIXED_DT, out); // 도착 틱 = 첫 공격
    expect(u.hp).toBe(1000 - WORRY.atk);
    const intervalTicks = Math.round(WORRY.atkInterval / FIXED_DT); // 72
    for (let i = 0; i < intervalTicks - 1; i++) l.step(FIXED_DT, out);
    expect(u.hp).toBe(1000 - WORRY.atk); // 아직 두 번째 공격 전
    l.step(FIXED_DT, out); // 첫 공격 + 72틱
    expect(u.hp).toBe(1000 - WORRY.atk * 2);
  });
});

describe('타깃 선택', () => {
  it('걱정의 공격 대상 = x 거리가 가장 가까운 유닛 (같으면 먼저 소환)', () => {
    const l = lane();
    const a = unit(l, { hp: 100, atk: 0, atkInterval: 1, range: 40 }); // 슬롯 x=50
    const b = unit(l, { hp: 100, atk: 0, atkInterval: 1, range: 40 }); // 슬롯 x=30 (가운데 다음은 작은 x)
    expect([a.x, b.x]).toEqual([50, 30]);
    const out: LaneEvent[] = [];
    l.spawnWorry({ ...WORRY, speed: 1e6 }, 34, out);
    l.step(FIXED_DT, out);
    const hit = out.find((e) => e.type === 'attack' && e.attacker.kind === 'worry');
    expect(hit && hit.type === 'attack' && hit.targetId).toBe(b.id);

    // x가 두 유닛 정확히 가운데 → 먼저 소환된 a
    const l2 = lane();
    const a2 = unit(l2, { hp: 100, atk: 0, atkInterval: 1, range: 40 });
    unit(l2, { hp: 100, atk: 0, atkInterval: 1, range: 40 });
    const out2: LaneEvent[] = [];
    l2.spawnWorry({ ...WORRY, speed: 1e6 }, 40, out2);
    l2.step(FIXED_DT, out2);
    const hit2 = out2.find((e) => e.type === 'attack' && e.attacker.kind === 'worry');
    expect(hit2 && hit2.type === 'attack' && hit2.targetId).toBe(a2.id);
  });

  it('유닛의 타깃 = 사거리 안 걱정 중 방어선에 가장 가까운(y 최대) 걱정', () => {
    const l = lane();
    const out: LaneEvent[] = [];
    const far = l.spawnWorry({ ...WORRY, speed: 0 }, 50, out);
    const near = l.spawnWorry({ ...WORRY, speed: 0 }, 50, out);
    const outOfRange = l.spawnWorry({ ...WORRY, speed: 0 }, 50, out);
    far.y = 70; // 사거리 40 안 (100-70=30)
    near.y = 90; // 사거리 안, 더 가까움
    outOfRange.y = 50; // 사거리 밖 (100-50=50)
    unit(l);
    l.step(FIXED_DT, out);
    expect(near.hp).toBe(WORRY.hp - SPIRIT.atk);
    expect(far.hp).toBe(WORRY.hp);
    expect(outOfRange.hp).toBe(WORRY.hp);
  });

  it('사거리 밖이면 공격하지 않고 쿨다운 0에서 대기', () => {
    const l = lane();
    const out: LaneEvent[] = [];
    const w = l.spawnWorry({ ...WORRY, speed: 0 }, 50, out);
    w.y = 10;
    const u = unit(l);
    run(l, 3, out);
    expect(w.hp).toBe(WORRY.hp);
    expect(u.cd).toBe(0);
  });

  it('Happy는 쓰러지지 않고 슬롯을 차지하지 않으며 걱정의 대상이 아니다', () => {
    const l = lane({ atk: 2, atkInterval: 1, range: 60 });
    const out: LaneEvent[] = [];
    const w = l.spawnWorry({ ...WORRY, speed: 0 }, 50, out);
    w.y = 60;
    l.step(FIXED_DT, out);
    expect(w.hp).toBe(WORRY.hp - 2);
    expect(l.units).toHaveLength(0);
    expect(l.pickSlot()).not.toBeNull();
    expect(out.some((e) => e.type === 'attack' && e.attacker.kind === 'worry')).toBe(false);
  });
});

describe('같은 틱 중복 타깃 (오버킬 방지)', () => {
  it('앞 유닛이 죽인 걱정을 뒤 유닛이 다시 노리지 않고 다음 타깃을 친다', () => {
    const l = lane();
    const out: LaneEvent[] = [];
    const first = l.spawnWorry({ ...WORRY, hp: 4, speed: 0 }, 50, out);
    const second = l.spawnWorry({ ...WORRY, hp: 18, speed: 0 }, 50, out);
    first.y = 95; // 방어선에 더 가까움 → 둘 다 먼저 노림
    second.y = 80;
    const u1 = unit(l);
    const u2 = unit(l);
    l.step(FIXED_DT, out);
    const attacks = out.filter((e) => e.type === 'attack');
    expect(attacks).toHaveLength(2);
    expect(attacks.map((e) => e.type === 'attack' && [e.attacker, e.targetId])).toEqual([
      [{ kind: 'unit', id: u1.id }, first.id],
      [{ kind: 'unit', id: u2.id }, second.id],
    ]);
    expect(second.hp).toBe(18 - SPIRIT.atk);
    expect(out.filter((e) => e.type === 'worryDie').map((e) => e.type === 'worryDie' && e.worryId)).toEqual([first.id]);
  });

  it('유닛이 이번 틱에 죽인 걱정은 4단계에서 공격하지 않는다', () => {
    const l = lane();
    const u = unit(l, { hp: 100, atk: 50, atkInterval: 1, range: 40 });
    const out: LaneEvent[] = [];
    l.spawnWorry({ ...WORRY, speed: 1e6 }, 50, out); // 첫 틱에 도착·멈춤
    l.step(FIXED_DT, out);
    expect(l.worries).toHaveLength(0);
    expect(u.hp).toBe(100);
  });
});

describe('슬롯', () => {
  it('빈 슬롯 중 가운데에 가장 가까운 슬롯 (같으면 x가 작은 쪽), 소멸하면 그 슬롯이 빈다', () => {
    const l = lane();
    const xs = [1, 2, 3, 4, 5].map(() => unit(l).x);
    expect(xs).toEqual([50, 30, 70, 10, 90]);
    expect(l.isFull).toBe(true);
    expect(l.addUnit(99, 'happy', 'c', 1, SPIRIT)).toBeNull();

    // x=30 유닛 소멸 → 나머지는 그대로, 다음 유닛은 30에
    l.units[1].hp = 0;
    l.step(FIXED_DT, []);
    expect(l.units.map((u) => u.x)).toEqual([50, 70, 10, 90]);
    expect(unit(l).x).toBe(30);
  });
});

// 공용 레인 전투 모듈 (스펙 §4.3, §4.3.1). Phaser 의존 없음.
// M3: defense(방어 레인)만 구현. abyss(심연 레인)는 M4에서 같은 모듈에 추가한다.
//
// 좌표: 레인 안의 논리 px. y는 아래로 증가. 전투 판정은 y축만, x는 표시와 "걱정이 누구를 때리는지"에만.
// 한 번의 step(dt)는 고정 틱 하나. 처리 순서(§4.3.1)의 2~6단계를 담당하고, 1단계(웨이브)는 GameState가 먼저 한다.

import type { CombatStats } from '../data/types';

export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
/** 쿨다운 비교용 부동소수 여유 */
const EPS = 1e-9;

export type LaneKind = 'defense' | 'abyss';
export type Side = 'happy' | 'unhappy';

/** 레인 좌표 (scene의 layout.ts에서 만들어 넘긴다) */
export interface LaneGeometry {
  /** 걱정 등장 y */
  spawnY: number;
  /** 방어선 y: 걱정이 멈추는 곳, 사거리 기준 */
  lineY: number;
  /** 이 y를 지나면 가라앉음 (방어선 + sinkMargin) */
  sinkY: number;
  /** 걱정 등장 x 범위 (양 끝 여백 제외) */
  spawnXMin: number;
  spawnXMax: number;
  /** 새 유닛이 설 슬롯을 고르는 기준 x (레인 가운데) */
  centerX: number;
  /** 방어선 슬롯 x (길이 = laneCap) */
  slotXs: number[];
  /** Happy 위치 x (슬롯을 차지하지 않음) */
  happyX: number;
}

// ── 공용: 쿨다운 공격 ──

export interface Attacker {
  atk: number;
  atkInterval: number;
  /** 남은 쿨다운(초). 0이면 대상이 생기는 즉시 공격 */
  cd: number;
}

/**
 * 한 틱의 공격 판정 + 쿨다운 진행. 쿨다운이 0 이하이고 대상이 있으면 공격(true)하고 atkInterval만큼 다시 찬다.
 * 대상이 없으면 쿨다운은 0에서 대기. 첫 공격이 k틱이면 다음 공격은 k + atkInterval/dt틱.
 */
export function stepAttack(a: Attacker, dt: number, hasTarget: boolean): boolean {
  let attacked = false;
  if (hasTarget && a.cd <= EPS) {
    a.cd += a.atkInterval;
    attacked = true;
  }
  a.cd -= dt;
  if (!hasTarget && a.cd < 0) a.cd = 0;
  return attacked;
}

// ── 레인 위의 개체 ──

export interface Unit extends Attacker {
  id: number;
  side: Side;
  chain: string;
  tier: number;
  hp: number;
  maxHp: number;
  range: number;
  /** 방어선 슬롯 번호 */
  slot: number;
  x: number;
}

export type WorryState = 'moving' | 'stopped' | 'passing';

export interface Worry extends Attacker {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  joyReward: number;
  /** moving: 방어선 위에서 내려오는 중 / stopped: 방어선에 멈춤 / passing: 방어선을 지나 가라앉는 중 */
  state: WorryState;
}

export interface WorryStats {
  hp: number;
  speed: number;
  atk: number;
  atkInterval: number;
  joyReward: number;
}

export type AttackerRef = { kind: 'unit'; id: number } | { kind: 'happy' } | { kind: 'worry'; id: number };

export type LaneEvent =
  | { type: 'spawnWorry'; worryId: number; x: number }
  | { type: 'worryStop'; worryId: number }
  | { type: 'attack'; attacker: AttackerRef; targetId: number; damage: number }
  | { type: 'worryDie'; worryId: number; x: number; y: number; joy: number }
  | { type: 'unitDie'; unitId: number; slot: number }
  | { type: 'sink'; worryId: number; x: number; y: number };

/** 이벤트를 쌓을 곳. GameState는 더 넓은 이벤트 배열을 넘긴다 */
export interface LaneEventSink {
  push(e: LaneEvent): unknown;
}

export class Lane {
  /** 소환 순서대로 */
  readonly units: Unit[] = [];
  /** 등장 순서대로 */
  readonly worries: Worry[] = [];
  readonly happy: Attacker & { range: number };
  private nextWorryId = 1;

  constructor(
    readonly kind: LaneKind,
    readonly geo: LaneGeometry,
    happy: { atk: number; atkInterval: number; range: number },
  ) {
    if (kind !== 'defense') throw new Error('abyss 레인은 M4에서 구현');
    this.happy = { ...happy, cd: 0 };
  }

  get cap(): number {
    return this.geo.slotXs.length;
  }

  get isFull(): boolean {
    return this.units.length >= this.cap;
  }

  // ── 등장·배치 ──

  spawnWorry(stats: WorryStats, x: number, out: LaneEventSink): Worry {
    const w: Worry = {
      id: this.nextWorryId++,
      x,
      y: this.geo.spawnY,
      hp: stats.hp,
      maxHp: stats.hp,
      speed: stats.speed,
      atk: stats.atk,
      atkInterval: stats.atkInterval,
      joyReward: stats.joyReward,
      cd: 0,
      state: 'moving',
    };
    this.worries.push(w);
    out.push({ type: 'spawnWorry', worryId: w.id, x });
    return w;
  }

  /** 비어 있는 슬롯 중 가운데(centerX)에 가장 가까운 슬롯. 같으면 x가 작은 쪽. 가득이면 null */
  pickSlot(): number | null {
    const used = new Set(this.units.map((u) => u.slot));
    let best: number | null = null;
    for (let i = 0; i < this.geo.slotXs.length; i++) {
      if (used.has(i)) continue;
      if (best === null) {
        best = i;
        continue;
      }
      const d = Math.abs(this.geo.slotXs[i] - this.geo.centerX);
      const bd = Math.abs(this.geo.slotXs[best] - this.geo.centerX);
      if (d < bd - EPS || (Math.abs(d - bd) <= EPS && this.geo.slotXs[i] < this.geo.slotXs[best])) best = i;
    }
    return best;
  }

  /** 소환된 순간 쿨다운 0 → 사거리 안에 적이 있으면 다음 틱에 즉시 공격. 가득이면 null */
  addUnit(id: number, side: Side, chain: string, tier: number, stats: CombatStats): Unit | null {
    const slot = this.pickSlot();
    if (slot === null) return null;
    const u: Unit = {
      id,
      side,
      chain,
      tier,
      hp: stats.hp,
      maxHp: stats.hp,
      atk: stats.atk,
      atkInterval: stats.atkInterval,
      range: stats.range,
      cd: 0,
      slot,
      x: this.geo.slotXs[slot],
    };
    this.units.push(u);
    return u;
  }

  // ── 한 틱 (§4.3.1 처리 순서 2~6) ──

  step(dt: number, out: LaneEventSink): void {
    this.moveWorries(dt, out); // 2
    this.unitAttacks(dt, out); // 3
    this.worryAttacks(dt, out); // 4
    this.removeDead(out); // 5
    this.sinkPassed(out); // 6
  }

  /** 2. 걱정 이동 (방어선 도달 판정) */
  private moveWorries(dt: number, out: LaneEventSink): void {
    const { lineY } = this.geo;
    const hasUnits = this.units.length > 0;
    for (const w of this.worries) {
      if (w.state === 'stopped') {
        if (hasUnits) continue;
        // 막아서던 유닛이 모두 사라짐 → 다시 이동 (이미 방어선이므로 통과)
        w.state = 'passing';
      }
      const ny = w.y + w.speed * dt;
      if (w.state === 'moving' && ny >= lineY) {
        if (hasUnits) {
          w.y = lineY;
          w.state = 'stopped';
          w.cd = 0; // 도착 틱에 첫 공격 (4단계)
          out.push({ type: 'worryStop', worryId: w.id });
          continue;
        }
        w.state = 'passing';
      }
      w.y = ny;
    }
  }

  /** 사거리(방어선에서 위로의 y 거리) 안의 살아 있는 걱정 중 방어선에 가장 가까운(y 최대) 걱정. 같으면 먼저 등장 */
  private pickWorryTarget(range: number): Worry | null {
    let best: Worry | null = null;
    for (const w of this.worries) {
      if (w.hp <= 0) continue; // 같은 틱에 이미 죽은 걱정은 건너뜀 (헛방 없음)
      if (this.geo.lineY - w.y > range + EPS) continue;
      if (!best || w.y > best.y + EPS) best = w;
    }
    return best;
  }

  /** 3. 유닛 공격 (소환 순서대로) → Happy */
  private unitAttacks(dt: number, out: LaneEventSink): void {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const t = this.pickWorryTarget(u.range);
      if (stepAttack(u, dt, t !== null)) {
        t!.hp -= u.atk;
        out.push({ type: 'attack', attacker: { kind: 'unit', id: u.id }, targetId: t!.id, damage: u.atk });
      }
    }
    const t = this.pickWorryTarget(this.happy.range);
    if (stepAttack(this.happy, dt, t !== null)) {
      t!.hp -= this.happy.atk;
      out.push({ type: 'attack', attacker: { kind: 'happy' }, targetId: t!.id, damage: this.happy.atk });
    }
  }

  /** x 거리가 가장 가까운 살아 있는 유닛. 같으면 먼저 소환된 유닛 */
  private pickUnitTarget(x: number): Unit | null {
    let best: Unit | null = null;
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (!best || Math.abs(u.x - x) < Math.abs(best.x - x) - EPS) best = u;
    }
    return best;
  }

  /** 4. 방어선에 멈춘 걱정의 공격 */
  private worryAttacks(dt: number, out: LaneEventSink): void {
    for (const w of this.worries) {
      if (w.state !== 'stopped' || w.hp <= 0) continue;
      const t = this.pickUnitTarget(w.x);
      if (stepAttack(w, dt, t !== null)) {
        t!.hp -= w.atk;
        out.push({ type: 'attack', attacker: { kind: 'worry', id: w.id }, targetId: t!.id, damage: w.atk });
      }
    }
  }

  /** 5. 사망 처리. 기쁨 적용은 GameState가 worryDie 이벤트로 한다 */
  private removeDead(out: LaneEventSink): void {
    for (const w of removeWhere(this.worries, (w) => w.hp <= 0)) {
      out.push({ type: 'worryDie', worryId: w.id, x: w.x, y: w.y, joy: w.joyReward });
    }
    // 슬롯이 빈다. 나머지 유닛은 움직이지 않음
    for (const u of removeWhere(this.units, (u) => u.hp <= 0)) {
      out.push({ type: 'unitDie', unitId: u.id, slot: u.slot });
    }
  }

  /** 6. 방어선 통과 처리 (가라앉음) */
  private sinkPassed(out: LaneEventSink): void {
    for (const w of removeWhere(this.worries, (w) => w.y >= this.geo.sinkY)) {
      out.push({ type: 'sink', worryId: w.id, x: w.x, y: w.y });
    }
  }
}

/** 조건에 맞는 항목을 제자리에서 제거하고, 제거된 항목을 원래 순서대로 돌려준다 */
function removeWhere<T>(arr: T[], pred: (t: T) => boolean): T[] {
  const removed: T[] = [];
  let k = 0;
  for (const t of arr) {
    if (pred(t)) removed.push(t);
    else arr[k++] = t;
  }
  arr.length = k;
  return removed;
}

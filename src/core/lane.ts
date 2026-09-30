// 공용 레인 전투 모듈 (스펙 §4.3, §4.3.1, §4.3.2). Phaser 의존 없음.
// 같은 Lane 클래스가 두 레인을 맡는다. 차이는 이동 주체와 방향, 적 종류뿐.
//   defense (왼쪽): 적(걱정)이 위에서 내려오고, 유닛은 아래쪽 방어선에 정지
//   abyss   (오른쪽): 적(그림자 벽)은 위쪽 끝에 고정, 유닛이 아래쪽 출발선에서 위로 전진
//   두 레인 모두 거점 = 아래(그리드 쪽). 유닛 슬롯·쿨다운 공격(stepAttack)·사망 처리는 공용.
//
// 좌표: 레인 안의 논리 px. y는 아래로 증가. 전투 판정은 y축만, x는 표시와 "걱정이 누구를 때리는지"에만.
// 한 번의 step(dt)는 고정 틱 하나. 틱 전체 순서(웨이브·그림자·역류 포함)는 GameState가 정한다.

import type { CombatStats } from '../data/types';

export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
/** 쿨다운 비교용 부동소수 여유 */
const EPS = 1e-9;

export type LaneKind = 'defense' | 'abyss';
export type Side = 'happy' | 'unhappy';

/** 두 레인 공용: 유닛 슬롯 */
interface SlotGeometry {
  /** 새 유닛이 설 슬롯을 고르는 기준 x (레인 가운데) */
  centerX: number;
  /** 슬롯 x (길이 = laneCap) */
  slotXs: number[];
}

/** 방어 레인 좌표 (scene의 layout.ts에서 만들어 넘긴다) */
export interface LaneGeometry extends SlotGeometry {
  /** 걱정 등장 y */
  spawnY: number;
  /** 방어선 y: 걱정이 멈추는 곳, 사거리 기준 */
  lineY: number;
  /** 이 y를 지나면 가라앉음 (방어선 + sinkMargin) */
  sinkY: number;
  /** 걱정 등장 x 범위 (양 끝 여백 제외) */
  spawnXMin: number;
  spawnXMax: number;
  /** Happy 위치 x (슬롯을 차지하지 않음) */
  happyX: number;
}

/** 심연 레인 좌표 */
export interface AbyssGeometry extends SlotGeometry {
  /** 유닛 출발선 y (손거울 포탈 바로 위) */
  startY: number;
  /** 그림자 벽의 아래 변 y. 유닛 사거리·반격 사거리의 기준 */
  wallY: number;
}

type GeoOf<K extends LaneKind> = K extends 'defense' ? LaneGeometry : AbyssGeometry;

export interface HappyStats {
  atk: number;
  atkInterval: number;
  range: number;
}

/** balance.abyss에서 벽에 필요한 값 */
export interface WallStats {
  layerHpBase: number;
  layerHpGrowth: number;
  counterAtk: number;
  counterAtkInterval: number;
  counterRange: number;
}

type OptsOf<K extends LaneKind> = K extends 'defense' ? HappyStats : { wall: WallStats; advanceSpeed: number };

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

/** 층 HP 기본값 = layerHpBase × layerHpGrowth^(층-1) */
export function layerBaseHp(w: WallStats, layer: number): number {
  return w.layerHpBase * Math.pow(w.layerHpGrowth, layer - 1);
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
  /** 슬롯 번호 (표시 x) */
  slot: number;
  x: number;
  /** defense: 방어선 y 고정 / abyss: 출발선에서 위로 전진 */
  y: number;
  /** abyss: 벽이 사거리 안에 들어와 멈춰 공격 중. defense는 항상 true */
  arrived: boolean;
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
  /** 역류 보스 (§4.3.2) */
  boss: boolean;
  /** moving: 방어선 위에서 내려오는 중 / stopped: 방어선에 멈춤 / passing: 방어선을 지나 가라앉는 중 */
  state: WorryState;
}

export interface WorryStats {
  hp: number;
  speed: number;
  atk: number;
  atkInterval: number;
  joyReward: number;
  boss?: boolean;
}

/** 그림자 벽 (현재 층) */
export interface Wall extends Attacker {
  layer: number;
  hp: number;
  /** 층 기본 HP + extraHp */
  maxHp: number;
  /** 가라앉음·보스 가라앉음으로 현재 층에만 누적되는 추가 HP. 돌파하면 0 */
  extraHp: number;
  range: number;
}

export type AttackerRef = { kind: 'unit'; id: number } | { kind: 'happy' } | { kind: 'worry'; id: number };

export type LaneEvent =
  | { type: 'spawnWorry'; worryId: number; x: number; boss: boolean }
  | { type: 'worryStop'; worryId: number }
  | { type: 'attack'; attacker: AttackerRef; targetId: number; damage: number }
  | { type: 'worryDie'; worryId: number; x: number; y: number; joy: number; boss: boolean }
  | { type: 'unitDie'; unitId: number; slot: number }
  | { type: 'sink'; worryId: number; x: number; y: number; boss: boolean }
  // 심연 (§4.3.2)
  | { type: 'abyssArrive'; unitId: number }
  | { type: 'wallHit'; unitId: number; damage: number }
  | { type: 'counter'; unitId: number; damage: number }
  | { type: 'abyssUnitDie'; unitId: number; slot: number; chain: string; tier: number; x: number; y: number };

/** 이벤트를 쌓을 곳. GameState는 더 넓은 이벤트 배열을 넘긴다 */
export interface LaneEventSink {
  push(e: LaneEvent): unknown;
}

/** 심연 step의 결과: 층 돌파가 있었으면 돌파한 층과 그 순간 살아 있던 유닛(소환 순서) */
export interface AbyssStepResult {
  cleared: { layer: number; units: Unit[] } | null;
}

export class Lane<K extends LaneKind = LaneKind> {
  /** 소환 순서대로 */
  readonly units: Unit[] = [];
  /** 등장 순서대로 (defense만) */
  readonly worries: Worry[] = [];
  /** defense만: Happy 거점 */
  readonly happy!: Attacker & { range: number };
  /** abyss만: 현재 층의 그림자 벽 */
  readonly wall!: Wall;
  private readonly wallStats?: WallStats;
  private readonly advanceSpeed: number = 0;
  private nextWorryId = 1;

  constructor(
    readonly kind: K,
    readonly geo: GeoOf<K>,
    opts: OptsOf<K>,
  ) {
    if (kind === 'defense') {
      this.happy = { ...(opts as HappyStats), cd: 0 };
    } else {
      const o = opts as OptsOf<'abyss'>;
      this.wallStats = o.wall;
      this.advanceSpeed = o.advanceSpeed;
      const hp = layerBaseHp(o.wall, 1);
      this.wall = { layer: 1, hp, maxHp: hp, extraHp: 0, atk: o.wall.counterAtk, atkInterval: o.wall.counterAtkInterval, range: o.wall.counterRange, cd: 0 };
    }
  }

  get cap(): number {
    return this.geo.slotXs.length;
  }

  get isFull(): boolean {
    return this.units.length >= this.cap;
  }

  // ── 등장·배치 ──

  spawnWorry(stats: WorryStats, x: number, out: LaneEventSink): Worry {
    const geo = this.geo as LaneGeometry;
    const w: Worry = {
      id: this.nextWorryId++,
      x,
      y: geo.spawnY,
      hp: stats.hp,
      maxHp: stats.hp,
      speed: stats.speed,
      atk: stats.atk,
      atkInterval: stats.atkInterval,
      joyReward: stats.joyReward,
      boss: stats.boss ?? false,
      cd: 0,
      state: 'moving',
    };
    this.worries.push(w);
    out.push({ type: 'spawnWorry', worryId: w.id, x, boss: w.boss });
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

  /**
   * 소환된 순간 쿨다운 0 → 사거리 안에 적이 있으면 다음 틱에 즉시 공격. 가득이면 null.
   * abyss 유닛은 출발선의 빈 슬롯에서 시작한다.
   */
  addUnit(id: number, side: Side, chain: string, tier: number, stats: CombatStats): Unit | null {
    const slot = this.pickSlot();
    if (slot === null) return null;
    const abyss = this.kind === 'abyss';
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
      y: abyss ? (this.geo as AbyssGeometry).startY : (this.geo as LaneGeometry).lineY,
      arrived: !abyss,
    };
    this.units.push(u);
    return u;
  }

  // ── 그림자 벽 (abyss) ──

  /** 현재 층에만 누적되는 추가 HP (가라앉음·보스 가라앉음) */
  addExtraHp(amount: number): void {
    if (amount <= 0) return;
    this.wall.extraHp += amount;
    this.wall.hp += amount;
    this.wall.maxHp += amount;
  }

  private nextLayer(): void {
    const w = this.wall;
    w.layer += 1;
    w.extraHp = 0;
    w.hp = layerBaseHp(this.wallStats!, w.layer);
    w.maxHp = w.hp;
    w.cd = 0;
  }

  // ── 한 틱 ──

  /** defense: §4.3.1 처리 순서 2~6 */
  step(dt: number, out: LaneEventSink): void {
    if (this.kind !== 'defense') throw new Error('abyss 레인은 stepAbyss()');
    this.moveWorries(dt, out); // 2
    this.unitAttacks(dt, out); // 3
    this.worryAttacks(dt, out); // 4
    this.removeDead(out); // 5
    this.sinkPassed(out); // 6
  }

  /** abyss: 유닛 전진 → 유닛의 벽 공격 → 벽의 반격 → 사망 처리 → 층 돌파 처리 (§4.3.2 처리 순서 3) */
  stepAbyss(dt: number, out: LaneEventSink): AbyssStepResult {
    if (this.kind !== 'abyss') throw new Error('defense 레인은 step()');
    const geo = this.geo as AbyssGeometry;
    const wall = this.wall;

    // 전진: 벽 아래 변까지의 거리가 range 이하가 되면 멈춤. 유닛끼리는 막지 않는다
    for (const u of this.units) {
      if (u.arrived) continue;
      const ny = u.y - this.advanceSpeed * dt;
      if (ny - geo.wallY <= u.range + EPS) {
        // 사거리 지점에서 멈춤. 사거리가 남은 거리보다 길면 제자리 (뒤로 물러나지 않는다)
        u.y = Math.min(u.y, geo.wallY + u.range);
        u.arrived = true;
        u.cd = 0; // 사거리에 들어온 틱에 즉시 첫 공격
        out.push({ type: 'abyssArrive', unitId: u.id });
      } else {
        u.y = ny;
      }
    }

    // 유닛의 벽 공격 (소환 순서). 벽이 이미 무너졌으면 더 치지 않는다 (헛방 없음)
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (stepAttack(u, dt, u.arrived && wall.hp > 0)) {
        wall.hp -= u.atk;
        out.push({ type: 'wallHit', unitId: u.id, damage: u.atk });
      }
    }

    // 벽의 반격: counterRange 안 유닛 중 가장 앞(y 최소, 같으면 먼저 소환). 무너진 벽은 반격하지 않음
    let target: Unit | null = null;
    if (wall.hp > 0) {
      for (const u of this.units) {
        if (u.hp <= 0 || u.y - geo.wallY > wall.range + EPS) continue;
        if (!target || u.y < target.y - EPS) target = u;
      }
    }
    if (stepAttack(wall, dt, target !== null)) {
      target!.hp -= wall.atk;
      out.push({ type: 'counter', unitId: target!.id, damage: wall.atk });
    }

    // 사망 처리: 조각 소실 (그림자는 GameState가 이벤트로)
    for (const u of removeWhere(this.units, (u) => u.hp <= 0)) {
      out.push({ type: 'abyssUnitDie', unitId: u.id, slot: u.slot, chain: u.chain, tier: u.tier, x: u.x, y: u.y });
    }

    // 층 돌파: 그 틱에 살아 있는 모든 유닛(전진 중 포함)이 귀환 대상
    if (wall.hp <= 0) {
      const layer = wall.layer;
      const units = this.units.splice(0, this.units.length);
      this.nextLayer();
      return { cleared: { layer, units } };
    }
    return { cleared: null };
  }

  /** 2. 걱정 이동 (방어선 도달 판정) */
  private moveWorries(dt: number, out: LaneEventSink): void {
    const { lineY } = this.geo as LaneGeometry;
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
    const { lineY } = this.geo as LaneGeometry;
    let best: Worry | null = null;
    for (const w of this.worries) {
      if (w.hp <= 0) continue; // 같은 틱에 이미 죽은 걱정은 건너뜀 (헛방 없음)
      if (lineY - w.y > range + EPS) continue;
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
      out.push({ type: 'worryDie', worryId: w.id, x: w.x, y: w.y, joy: w.joyReward, boss: w.boss });
    }
    // 슬롯이 빈다. 나머지 유닛은 움직이지 않음
    for (const u of removeWhere(this.units, (u) => u.hp <= 0)) {
      out.push({ type: 'unitDie', unitId: u.id, slot: u.slot });
    }
  }

  /** 6. 방어선 통과 처리 (가라앉음) */
  private sinkPassed(out: LaneEventSink): void {
    const { sinkY } = this.geo as LaneGeometry;
    for (const w of removeWhere(this.worries, (w) => w.y >= sinkY)) {
      out.push({ type: 'sink', worryId: w.id, x: w.x, y: w.y, boss: w.boss });
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

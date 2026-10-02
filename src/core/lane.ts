// 공용 레인 전투 모듈 (스펙 §4.3, §4.3.1, §4.3.3, §5.17, §5.19). Phaser 의존 없음.
// UnitHost = 우리 편 슬롯·유닛(영웅 + 전투 중 머지 병사)·쿨다운 공격을 두 레인이 같이 쓴다.
//   Lane (밤 디펜스): 적(걱정)이 위에서 내려오고, 영웅·병사는 방어선 근처에서 제한 이동 (§4.3.3)
//   Expedition (낮 오펜스, expedition.ts): 핵 찾아 돌아오기 (§5.19-2)
//
// 좌표: 레인 안의 논리 px. y는 아래로 증가. 전투 판정은 y축만, x는 표시와 "걱정이 누구를 때리는지"에만.
// 한 번의 step(dt)는 고정 틱 하나. 틱 전체 순서(웨이브·핵 HP 포함)는 GameState가 정한다.

import type { CombatStats } from '../data/types';

export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
/** 쿨다운 비교용 부동소수 여유 */
const EPS = 1e-9;

export type Side = 'happy' | 'unhappy';

/** 두 레인 공용: 유닛 슬롯 */
export interface SlotGeometry {
  /** 새 유닛이 설 슬롯을 고르는 기준 x (레인 가운데) */
  centerX: number;
  /** 슬롯 x (길이 = 영웅 1 + soldierCap) */
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

/** 낮(오펜스) 레인 좌표 (§5.19-2) */
export interface AbyssGeometry extends SlotGeometry {
  /** 이야기책 (출발·도착) y */
  startY: number;
  /** 핵을 쥔 그림자(guardian) 자리 y. 유닛 사거리·반격 사거리의 기준 */
  wallY: number;
}

export interface HappyStats {
  atk: number;
  atkInterval: number;
  range: number;
}

/** 방어 유닛 제한 이동 (§4.3.3, D-026). range ≤ 0이면 이동 처리를 아예 건너뛴다 (기존 규칙과 1비트도 같음) */
export interface InterceptConfig {
  /** 방어선에서 위(core y 감소)로 나갈 수 있는 최대 거리 */
  range: number;
  /** 이동 속도 (px/초, 직선 거리) */
  speed: number;
  /** 걱정 바로 아래 몇 px에 서는지 */
  contact: number;
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
 * 대상이 없으면 쿨다운은 0에서 대기. 첫 공격이 k틱이면 다음 공격은 k + atkInterval/dt틱. interval: 운반자처럼 간격을 늘릴 때
 */
export function stepAttack(a: Attacker, dt: number, hasTarget: boolean, interval = a.atkInterval): boolean {
  let attacked = false;
  if (hasTarget && a.cd <= EPS) {
    a.cd += interval;
    attacked = true;
  }
  a.cd -= dt;
  if (!hasTarget && a.cd < 0) a.cd = 0;
  return attacked;
}

// ── 레인 위의 개체 ──

/** 레인 위 우리 편: 영웅 (판 내내 한 명씩, §5.17-1) / 병사 (전투 중 머지, 일회성, [11]-1) */
export type UnitRole = 'hero' | 'soldier';
/** shield = 걱정을 막고 층 반격을 먼저 받음 / snare = 맞힌 걱정 감속, 걱정을 막지 않음 */
export type SoldierKind = 'shield' | 'snare' | 'charger' | 'bell';

export interface Unit extends Attacker {
  id: number;
  side: Side;
  role: UnitRole;
  /** 영웅 id (heroes.json) / 병사의 체인 */
  chain: string;
  /** 병사 단 (1·2). 영웅은 0 */
  tier: number;
  hp: number;
  maxHp: number;
  range: number;
  /** 받는 피해 배율 (떡 성장 피해 감소, §5.17-2). 1 = 그대로 */
  dmgMult: number;
  /** 병사 종류·남은 수명(초)·수명 전체 */
  soldier?: SoldierKind;
  /** 근접 = 붙어서 / 원거리 = 사거리 끝에서 (§5.20-3-1). 병사는 근접 */
  attackType: 'melee' | 'ranged';
  /** 보호막: 받는 피해를 먼저 깎는다 (수호의 울타리·보름달) */
  shield: number;
  life?: number;
  lifeMax?: number;
  /** 올가미병: 맞힌 걱정 감속 비율·시간 */
  slow?: number;
  slowSeconds?: number;
  /** 슬롯 번호 (표시 x) */
  slot: number;
  x: number;
  /** 진행 축 위치 */
  y: number;
  /** 낮: 적·guardian이 사거리 안에 들어와 멈춰 공격 중. 밤은 항상 true */
  arrived: boolean;
  /** 제한 이동·호위: 할 일이 없어 홈(슬롯·운반자 곁)으로 돌아가는 중 (표시용, §4.3.3) */
  returning?: boolean;
}

/** 걱정을 막는 유닛 (영웅·방패병). 올가미병은 막지 않는다 */
export function blocks(u: Unit): boolean {
  return u.soldier !== 'snare' && u.soldier !== 'bell';
}

/** 유닛이 받는 피해: × dmgMult → 보호막 먼저 → hp. 실제 hp 감소량 */
export function damageUnit(u: Unit, raw: number): number {
  let dmg = raw * u.dmgMult;
  if (u.shield > 0) {
    const absorbed = Math.min(u.shield, dmg);
    u.shield -= absorbed;
    dmg -= absorbed;
  }
  u.hp -= dmg;
  return dmg;
}

export type WorryState = 'moving' | 'stopped' | 'passing';

export interface Worry extends Attacker {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  /** 적 종류 (monsters.enemies id, 표시용) */
  type: string;
  /** 보스 웨이브의 적: 거점에 닿으면 핵 피해 bossSinkDamage (§5.19-3) */
  boss: boolean;
  /** 올가미 감속 ([11]-1): 남은 초·비율 */
  slowTimer: number;
  slowMult: number;
  /** moving: 방어선 위에서 내려오는 중 / stopped: 방어선에 멈춤 / passing: 방어선을 지나 가라앉는 중 */
  state: WorryState;
}

export interface WorryStats {
  type: string;
  hp: number;
  speed: number;
  atk: number;
  atkInterval: number;
  boss?: boolean;
}

export type AttackerRef = { kind: 'unit'; id: number } | { kind: 'happy' } | { kind: 'worry'; id: number };

export type LaneEvent =
  | { type: 'spawnWorry'; worryId: number; x: number; boss: boolean; enemy: string }
  | { type: 'worryStop'; worryId: number }
  | { type: 'attack'; attacker: AttackerRef; targetId: number; damage: number }
  | { type: 'worryDie'; worryId: number; x: number; y: number; boss: boolean }
  /** 밤 유닛 쓰러짐 (영웅은 GameState가 쓰러짐 → reviveSeconds 뒤 일어남, §5.17-10) */
  | { type: 'unitDie'; unitId: number; role: UnitRole; slot: number; chain: string; tier: number; x: number; y: number }
  | { type: 'sink'; worryId: number; x: number; y: number; boss: boolean };

/** 이벤트를 쌓을 곳. GameState는 더 넓은 이벤트 배열을 넘긴다 */
export interface LaneEventSink {
  push(e: LaneEvent): unknown;
}

/** 감속(올가미)을 맞은 적: 이번 틱 이동 거리 + 감속 시간 감소 */
export function slowedStep(w: { speed: number; slowTimer: number; slowMult: number }, dt: number): number {
  const slow = w.slowTimer > EPS ? w.slowMult : 0;
  if (w.slowTimer > 0) w.slowTimer = Math.max(0, w.slowTimer - dt);
  return w.speed * (1 - slow) * dt;
}

/** 유닛의 한 방: 피해(atk × mult) + 올가미 감속·방울 정지 ([11]-1). 준 피해 */
export function applyHit(u: Unit, t: { hp: number; slowTimer: number; slowMult: number }, mult = 1): number {
  const dmg = u.atk * mult;
  t.hp -= dmg;
  if (u.slow !== undefined && u.slowSeconds !== undefined) {
    t.slowMult = Math.max(t.slowTimer > EPS ? t.slowMult : 0, u.slow);
    t.slowTimer = Math.max(t.slowTimer, u.slowSeconds);
  }
  return dmg;
}

/** 정지(slow 100%)를 건다: 수호의 울타리·보름달·방울병 */
export function stun(t: { slowTimer: number; slowMult: number }, seconds: number): void {
  t.slowMult = 1;
  t.slowTimer = Math.max(t.slowTimer, seconds);
}

/** addUnit의 추가 옵션: 영웅·병사 표시, 시작 hp, 시작 y (없으면 레인의 시작선) */
export type UnitExtra = Partial<Pick<Unit, 'role' | 'dmgMult' | 'soldier' | 'life' | 'slow' | 'slowSeconds' | 'hp' | 'y' | 'attackType'>>;

/** 두 레인 공용: 우리 편 슬롯·유닛 */
export abstract class UnitHost<G extends SlotGeometry = SlotGeometry> {
  /** 레인에 오른 순서대로 */
  readonly units: Unit[] = [];
  /** 우리 편 공격 배수 (한낮 특별 버프, §5.18-9). GameState가 매 틱 맞춘다 */
  atkMult = 1;

  constructor(readonly geo: G) {}

  /** 새 유닛이 서는 진행 축 위치 */
  protected abstract startY(): number;
  /** 새 유닛이 처음부터 멈춰 싸우는 상태인지 (밤 true) */
  protected abstract startArrived(): boolean;

  get cap(): number {
    return this.geo.slotXs.length;
  }

  get isFull(): boolean {
    return this.units.length >= this.cap;
  }

  // ── 배치 ──

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
   * 레인에 올린 순간 쿨다운 0 → 사거리 안에 적이 있으면 다음 틱에 즉시 공격. 빈 슬롯이 없으면 null.
   * extra: 영웅·병사 표시 (role 기본 soldier), 시작 hp·y
   */
  addUnit(id: number, side: Side, chain: string, tier: number, stats: CombatStats, extra: UnitExtra = {}): Unit | null {
    const slot = this.pickSlot();
    if (slot === null) return null;
    const u: Unit = {
      id,
      side,
      role: extra.role ?? 'soldier',
      chain,
      tier,
      hp: extra.hp ?? stats.hp,
      maxHp: stats.hp,
      atk: stats.atk,
      atkInterval: stats.atkInterval,
      range: stats.range,
      dmgMult: extra.dmgMult ?? 1,
      attackType: extra.attackType ?? 'melee',
      shield: 0,
      cd: 0,
      slot,
      x: this.geo.slotXs[slot],
      y: extra.y ?? this.startY(),
      arrived: this.startArrived(),
    };
    if (extra.soldier) u.soldier = extra.soldier;
    if (extra.life !== undefined) {
      u.life = extra.life;
      u.lifeMax = extra.life;
    }
    if (extra.slow !== undefined) u.slow = extra.slow;
    if (extra.slowSeconds !== undefined) u.slowSeconds = extra.slowSeconds;
    this.units.push(u);
    return u;
  }

  /** 병사 수 (영웅 제외) */
  get soldierCount(): number {
    return this.units.reduce((n, u) => n + (u.role === 'soldier' ? 1 : 0), 0);
  }

  /** 병사 수명 감소 → 다 된 병사 제거 (이벤트 없음, 귀환 없음). 제거된 병사를 돌려준다 */
  expireSoldiers(dt: number): Unit[] {
    for (const u of this.units) if (u.life !== undefined) u.life -= dt;
    return removeWhere(this.units, (u) => u.life !== undefined && u.life <= EPS);
  }
}

/** 밤(디펜스) 레인: 걱정·Happy 거점·제한 이동 */
export class Lane extends UnitHost<LaneGeometry> {
  /** 등장 순서대로 */
  readonly worries: Worry[] = [];
  /** Happy 거점 */
  readonly happy: Attacker & { range: number };
  /** 저장(save.ts)이 읽고 쓴다 */
  nextWorryId = 1;

  constructor(
    readonly kind: 'defense',
    geo: LaneGeometry,
    opts: HappyStats,
    /** 방어 유닛 제한 이동 (§4.3.3). 없거나 range ≤ 0이면 기존 규칙 */
    private readonly intercept: InterceptConfig | null = null,
  ) {
    super(geo);
    this.happy = { ...opts, cd: 0 };
  }

  protected startY(): number {
    return this.geo.lineY;
  }

  protected startArrived(): boolean {
    return true;
  }

  spawnWorry(stats: WorryStats, x: number, out: LaneEventSink): Worry {
    const geo = this.geo;
    const w: Worry = {
      id: this.nextWorryId++,
      x,
      y: geo.spawnY,
      hp: stats.hp,
      maxHp: stats.hp,
      speed: stats.speed,
      atk: stats.atk,
      atkInterval: stats.atkInterval,
      type: stats.type,
      boss: stats.boss ?? false,
      cd: 0,
      state: 'moving',
      slowTimer: 0,
      slowMult: 0,
    };
    this.worries.push(w);
    out.push({ type: 'spawnWorry', worryId: w.id, x, boss: w.boss, enemy: w.type });
    return w;
  }

  // ── 한 틱 ──

  /** defense: §4.3.1 처리 순서 2~6 */
  step(dt: number, out: LaneEventSink): void {
    if (this.intercept && this.intercept.range > 0) {
      // §4.3.3: 1. 유닛 이동 → 2. 걱정 이동(막는 유닛의 y에서 정지) → 3. 유닛 공격(자기 y 기준) → 4~6 기존
      this.moveUnits(dt, this.intercept);
      this.moveWorriesIntercept(dt, out);
      this.unitAttacksIntercept(dt, out);
      this.worryAttacks(dt, out);
      this.removeDead(out);
      this.sinkPassed(out);
      return;
    }
    this.moveWorries(dt, out); // 2
    this.unitAttacks(dt, out); // 3
    this.worryAttacks(dt, out); // 4
    this.removeDead(out); // 5
    this.sinkPassed(out); // 6
  }

  private worryStep(w: Worry, dt: number): number {
    return slowedStep(w, dt);
  }

  /** 2. 걱정 이동 (방어선 도달 판정) */
  private moveWorries(dt: number, out: LaneEventSink): void {
    const { lineY } = this.geo;
    const hasUnits = this.units.some((u) => blocks(u));
    for (const w of this.worries) {
      if (w.state === 'stopped') {
        if (hasUnits) continue;
        // 막아서던 유닛이 모두 사라짐 → 다시 이동 (이미 방어선이므로 통과)
        w.state = 'passing';
      }
      const ny = w.y + this.worryStep(w, dt);
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
    const { lineY } = this.geo;
    let best: Worry | null = null;
    for (const w of this.worries) {
      if (w.hp <= 0) continue; // 같은 틱에 이미 죽은 걱정은 건너뜀 (헛방 없음)
      if (lineY - w.y > range + EPS) continue;
      if (!best || w.y > best.y + EPS) best = w;
    }
    return best;
  }

  /** 유닛의 한 방: 피해 + 올가미 감속 */
  private hit(u: Unit, t: Worry, out: LaneEventSink): void {
    const dmg = applyHit(u, t, this.atkMult);
    out.push({ type: 'attack', attacker: { kind: 'unit', id: u.id }, targetId: t.id, damage: dmg });
  }

  /** 3. 유닛 공격 (레인에 오른 순서대로) → Happy */
  private unitAttacks(dt: number, out: LaneEventSink): void {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const t = this.pickWorryTarget(u.range);
      if (stepAttack(u, dt, t !== null)) this.hit(u, t!, out);
    }
    const t = this.pickWorryTarget(this.happy.range);
    if (stepAttack(this.happy, dt, t !== null)) {
      t!.hp -= this.happy.atk;
      out.push({ type: 'attack', attacker: { kind: 'happy' }, targetId: t!.id, damage: this.happy.atk });
    }
  }

  // ── 방어 유닛 제한 이동 (§4.3.3, D-026) ──

  /**
   * 1. 유닛 이동 (소환 순서대로).
   * 추격 대상: 살아 있는 걱정 중 w.y ≥ lineY − range − u.range (손이 닿는 걱정). y가 큰(방어선에 가까운) 걱정, 같으면 먼저 등장.
   * 이번 틱에 앞선 유닛이 고른 걱정은 건너뛴다 (남은 게 없으면 이미 고른 것 중 같은 우선순위로) → 유닛이 퍼진다.
   * 목표 지점: (w.x, clamp(w.y + contact, lineY − range, lineY)) / 대상이 없으면 홈 (slotXs[slot], lineY). 직선으로 speed × dt.
   */
  private moveUnits(dt: number, ic: InterceptConfig): void {
    const geo = this.geo;
    const zoneTop = geo.lineY - ic.range;
    const claimed = new Set<Worry>();
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      let pick: Worry | null = null;
      let fallback: Worry | null = null;
      for (const w of this.worries) {
        if (w.hp <= 0 || w.y < zoneTop - u.range - EPS) continue;
        if (!fallback || w.y > fallback.y + EPS) fallback = w;
        if (claimed.has(w)) continue;
        if (!pick || w.y > pick.y + EPS) pick = w;
      }
      // 원거리는 이야기책 근처(자기 자리)에서 쏜다 — 나가 붙는 것은 근접만 (§5.20-3-1)
      const t = u.attackType === 'ranged' ? null : (pick ?? fallback);
      if (t) claimed.add(t);
      const tx = t ? t.x : geo.slotXs[u.slot];
      const ty = t ? Math.max(zoneTop, Math.min(geo.lineY, t.y + ic.contact)) : geo.lineY;
      u.returning = !t && (Math.abs(u.x - tx) > EPS || Math.abs(u.y - ty) > EPS);
      const dx = tx - u.x;
      const dy = ty - u.y;
      const d = Math.hypot(dx, dy);
      const step = ic.speed * dt;
      if (d <= step + EPS) {
        u.x = tx;
        u.y = ty;
      } else {
        u.x += (dx / d) * step;
        u.y += (dy / d) * step;
      }
    }
  }

  /**
   * 2. 걱정 이동 (제한 이동): moving이 막는 유닛(x 최근접)의 y에 닿으면 그 y에 멈춤.
   * stopped: 막는 유닛이 물러나 w.y < blocker.y가 되면 다시 moving. 유닛이 모두 사라지면 방어선 위는 moving, 아래는 passing.
   */
  private moveWorriesIntercept(dt: number, out: LaneEventSink): void {
    const { lineY } = this.geo;
    for (const w of this.worries) {
      const blocker = this.pickUnitTarget(w);
      if (w.state === 'stopped') {
        if (!blocker) w.state = w.y < lineY ? 'moving' : 'passing';
        else if (w.y < blocker.y - EPS) w.state = 'moving';
        else continue;
      }
      const ny = w.y + this.worryStep(w, dt);
      if (w.state === 'moving') {
        if (blocker && ny >= blocker.y - EPS) {
          w.y = Math.max(w.y, blocker.y); // 막는 유닛이 더 위에 있으면 제자리 (뒤로 밀리지 않는다)
          w.state = 'stopped';
          w.cd = 0; // 도착 틱에 첫 공격 (4단계)
          out.push({ type: 'worryStop', worryId: w.id });
          continue;
        }
        if (!blocker && ny >= lineY) w.state = 'passing';
      }
      w.y = ny;
    }
  }

  /** 3. 유닛 공격 (제한 이동): 대상은 |u.y − w.y| ≤ u.range인 걱정 중 y 최대 (같으면 먼저 등장). Happy는 기존대로 방어선 기준 */
  private unitAttacksIntercept(dt: number, out: LaneEventSink): void {
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      let t: Worry | null = null;
      for (const w of this.worries) {
        if (w.hp <= 0 || Math.abs(u.y - w.y) > u.range + EPS) continue;
        if (!t || w.y > t.y + EPS) t = w;
      }
      if (stepAttack(u, dt, t !== null)) this.hit(u, t!, out);
    }
    const t = this.pickWorryTarget(this.happy.range);
    if (stepAttack(this.happy, dt, t !== null)) {
      t!.hp -= this.happy.atk;
      out.push({ type: 'attack', attacker: { kind: 'happy' }, targetId: t!.id, damage: this.happy.atk });
    }
  }

  /** 적이 노리는 유닛 (§5.20-3-1 "적은 가장 가까운 영웅을 친다"): 막는(영웅·방패병·돌격병) 살아 있는 유닛 중 가장 가까운 유닛. 같으면 먼저 오른 유닛 */
  private pickUnitTarget(w: { x: number; y: number }): Unit | null {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const u of this.units) {
      if (u.hp <= 0 || !blocks(u)) continue;
      const d = Math.hypot(u.x - w.x, u.y - w.y);
      if (d < bd - EPS) {
        best = u;
        bd = d;
      }
    }
    return best;
  }

  /** 4. 방어선에 멈춘 걱정의 공격 */
  private worryAttacks(dt: number, out: LaneEventSink): void {
    for (const w of this.worries) {
      if (w.state !== 'stopped' || w.hp <= 0) continue;
      const t = this.pickUnitTarget(w);
      // 정지(방울·울타리·보름달) 중에는 치지 않는다
      if (stepAttack(w, dt, t !== null && !(w.slowTimer > EPS && w.slowMult >= 1))) {
        const dmg = damageUnit(t!, w.atk);
        out.push({ type: 'attack', attacker: { kind: 'worry', id: w.id }, targetId: t!.id, damage: dmg });
      }
    }
  }

  /** 5. 사망 처리. 경험치·처치 드롭은 GameState가 worryDie 이벤트로 한다 */
  private removeDead(out: LaneEventSink): void {
    for (const w of removeWhere(this.worries, (w) => w.hp <= 0)) {
      out.push({ type: 'worryDie', worryId: w.id, x: w.x, y: w.y, boss: w.boss });
    }
    // 슬롯이 빈다. 나머지 유닛은 움직이지 않음
    for (const u of removeWhere(this.units, (u) => u.hp <= 0)) {
      out.push({ type: 'unitDie', unitId: u.id, role: u.role, slot: u.slot, chain: u.chain, tier: u.tier, x: u.x, y: u.y });
    }
  }

  /** 6. 방어선 통과 처리 (가라앉음) */
  private sinkPassed(out: LaneEventSink): void {
    const { sinkY } = this.geo;
    for (const w of removeWhere(this.worries, (w) => w.y >= sinkY)) {
      out.push({ type: 'sink', worryId: w.id, x: w.x, y: w.y, boss: w.boss });
    }
  }
}

/** 조건에 맞는 항목을 제자리에서 제거하고, 제거된 항목을 원래 순서대로 돌려준다 */
export function removeWhere<T>(arr: T[], pred: (t: T) => boolean): T[] {
  const removed: T[] = [];
  let k = 0;
  for (const t of arr) {
    if (pred(t)) removed.push(t);
    else arr[k++] = t;
  }
  arr.length = k;
  return removed;
}

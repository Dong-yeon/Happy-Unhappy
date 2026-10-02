// 낮(오펜스) — 핵 찾아 돌아오기 (스펙 §5.19-2, D-053). Phaser 의존 없음.
//
// 가는 길: 이야기책(startY)에서 출발한 영웅·병사가 적 무리를 헤치고 레인 끝(wallY)의 핵을 쥔 그림자(guardian)를 친다.
//   guardian은 기존 심연 층 1개 재사용 (HP·반격, 반격은 방패병 먼저). 적은 이야기책 쪽으로 걸어오다 막는 유닛(영웅·방패병)에 멈춘다.
// guardian HP 0 → 핵 획득: 맨 앞 영웅이 든다 (운반자, 병사는 들 수 없음).
// 돌아오는 길: 운반자는 speedMult로 이야기책까지 걷고(멈추지 않음), 사거리 안 적을 atkIntervalMult 간격으로 친다.
//   레인 끝에서 추격 무리가 chaseInterval마다 나온다. 다른 유닛은 운반자 뒤(anchor)에서 디펜스 제한 이동(§4.3.3) 규칙으로 막는다.
// 운반자가 쓰러지면 핵을 그 자리에 떨어뜨린다. 영웅이 닿으면 다시 든다. 적이 떨어진 핵에 닿으면 레인 끝으로 되가져간다
// (guardian은 부활하지 않음). 운반자가 이야기책에 닿으면 낮 성공.
// 낮 시간·쓰러짐 판정(가는 길 쓰러짐 = 낮 실패 / 운반 중 쓰러짐 = 8초 뒤 일어남)은 GameState가 한다.
//
// 좌표는 lane.ts와 같다 (진행 축 y, 아래로 증가 = 이야기책 쪽).

import {
  UnitHost,
  applyHit,
  blocks,
  removeWhere,
  slowedStep,
  stepAttack,
  type AbyssGeometry,
  type Attacker,
  type InterceptConfig,
  type Unit,
  type UnitRole,
} from './lane';
import type { Rng } from './rng';

const EPS = 1e-9;
/** 가는 길 무리를 처음 세우는 구간 (guardian에서 이야기책 쪽으로 레인 길이 비율) */
const PLACE_FROM = 0.15;
const PLACE_TO = 0.6;

export interface EnemyStats {
  /** monsters.enemies id */
  type: string;
  hp: number;
  speed: number;
  atk: number;
  atkInterval: number;
  joyReward: number;
}

export interface Enemy extends Attacker {
  id: number;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  joyReward: number;
  /** 돌아오는 길 추격 무리 */
  chaser: boolean;
  slowTimer: number;
  slowMult: number;
}

/** 핵을 쥔 그림자 (레인 끝에 고정) */
export interface Guardian extends Attacker {
  type: string;
  hp: number;
  maxHp: number;
  range: number;
  boss: boolean;
}

/** 핵 위치: guardian이 쥠 / 영웅이 운반 중 / 떨어짐(y) / 이야기책 도착 */
export type CoreSpot = { at: 'guardian' } | { at: 'carried'; unitId: number } | { at: 'dropped'; y: number } | { at: 'hut' };

export interface ExpeditionConfig {
  /** 영웅·병사 이동 속도 (가는 길) */
  advanceSpeed: number;
  carry: { speedMult: number; atkIntervalMult: number; chaseInterval: number; pickupRange: number };
  /** 운반자 뒤 호위 = 디펜스 제한 이동 규칙 (§4.3.3) */
  escort: InterceptConfig;
}

export type ExpeditionEvent =
  | { type: 'enemySpawn'; enemyId: number; chaser: boolean; enemy: string }
  | { type: 'unitHit'; unitId: number; enemyId: number; damage: number }
  | { type: 'enemyAttack'; enemyId: number; unitId: number; damage: number }
  | { type: 'enemyDie'; enemyId: number; x: number; y: number; joy: number; chaser: boolean }
  | { type: 'guardianHit'; unitId: number; damage: number }
  | { type: 'counter'; unitId: number; damage: number }
  | { type: 'guardianDown' }
  /** 영웅이 핵을 듦 (first: guardian을 쓰러뜨린 순간) */
  | { type: 'corePick'; unitId: number; first: boolean }
  | { type: 'coreDrop'; y: number }
  /** 적이 떨어진 핵을 레인 끝으로 되가져감 */
  | { type: 'coreReturned' }
  /** 운반자가 이야기책에 닿음 = 낮 성공 */
  | { type: 'coreHome' }
  | { type: 'offenseUnitDie'; unitId: number; role: UnitRole; slot: number; chain: string; tier: number; x: number; y: number; carrying: boolean };

export interface ExpeditionEventSink {
  push(e: ExpeditionEvent): unknown;
}

export interface GuardianStats {
  type: string;
  hp: number;
  atk: number;
  atkInterval: number;
  range: number;
  boss: boolean;
}

export class Expedition extends UnitHost<AbyssGeometry> {
  readonly enemies: Enemy[] = [];
  readonly guardian: Guardian = { type: '', hp: 0, maxHp: 1, range: 0, boss: false, atk: 0, atkInterval: 1, cd: 0 };
  core: CoreSpot = { at: 'guardian' };
  /** guardian을 쓰러뜨렸는지 (이후 쓰러짐은 운반 중 규칙) */
  guardianDown = false;
  /** 아직 나오지 않은 추격 무리 */
  readonly chaseQueue: EnemyStats[] = [];
  private chaseTimer = 0;
  /** 핵을 든 채 보낸 시간(초) */
  carryTime = 0;
  /** 핵을 떨어뜨린 수 */
  drops = 0;
  private nextEnemyId = 1;

  constructor(
    geo: AbyssGeometry,
    private readonly cfg: ExpeditionConfig,
  ) {
    super(geo);
  }

  protected startY(): number {
    return this.geo.startY;
  }

  protected startArrived(): boolean {
    return false;
  }

  /** 레인 길이 (이야기책 ~ guardian) */
  get length(): number {
    return this.geo.startY - this.geo.wallY;
  }

  /** 운반자 (없으면 null) */
  get carrier(): Unit | null {
    const c = this.core;
    return c.at === 'carried' ? (this.units.find((u) => u.id === c.unitId) ?? null) : null;
  }

  /** 낮 시작: 레인을 비우고 guardian·가는 길 무리·추격 무리를 세운다 (무리는 PLACE 구간에 고르게, x는 rng) */
  reset(guardian: GuardianStats, enemies: EnemyStats[], chase: EnemyStats[], rng: Rng): void {
    this.units.length = 0;
    this.enemies.length = 0;
    this.chaseQueue.splice(0, this.chaseQueue.length, ...chase);
    this.chaseTimer = this.cfg.carry.chaseInterval;
    this.core = { at: 'guardian' };
    this.guardianDown = false;
    this.carryTime = 0;
    this.drops = 0;
    this.nextEnemyId = 1;
    Object.assign(this.guardian, { ...guardian, maxHp: guardian.hp, cd: 0 });
    const n = enemies.length;
    enemies.forEach((e, k) => {
      const t = n === 1 ? 0.5 : k / (n - 1);
      this.spawnEnemy(e, this.geo.wallY + this.length * (PLACE_FROM + (PLACE_TO - PLACE_FROM) * t), false, rng, null);
    });
  }

  /** 낮이 끝남: 레인 비움 */
  clear(): void {
    this.units.length = 0;
    this.enemies.length = 0;
    this.chaseQueue.length = 0;
  }

  private spawnEnemy(s: EnemyStats, y: number, chaser: boolean, rng: Rng, out: ExpeditionEventSink | null): Enemy {
    const xs = this.geo.slotXs;
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const e: Enemy = {
      id: this.nextEnemyId++,
      type: s.type,
      x: lo + rng() * (hi - lo),
      y,
      hp: s.hp,
      maxHp: s.hp,
      speed: s.speed,
      atk: s.atk,
      atkInterval: s.atkInterval,
      joyReward: s.joyReward,
      chaser,
      cd: 0,
      slowTimer: 0,
      slowMult: 0,
    };
    this.enemies.push(e);
    out?.push({ type: 'enemySpawn', enemyId: e.id, chaser, enemy: e.type });
    return e;
  }

  private heroAlive(): Unit | null {
    let best: Unit | null = null;
    for (const u of this.units) if (u.role === 'hero' && u.hp > 0 && (!best || u.y < best.y - EPS)) best = u;
    return best;
  }

  /** 호위 기준선: 운반자 / (핵이 떨어짐) 줍으러 가는 영웅, 영웅이 없으면 핵 자리 / 그 밖(가는 길) null */
  private anchorY(carrier: Unit | null): number | null {
    if (carrier) return carrier.y;
    if (this.core.at === 'dropped') return this.heroAlive()?.y ?? this.core.y;
    return null;
  }

  /** 적 e가 이야기책 쪽으로 가다 처음 만나는 막는 유닛 (영웅·방패병, u.y ≥ e.y) */
  private blockerFor(e: Enemy): Unit | null {
    let best: Unit | null = null;
    for (const u of this.units) {
      if (u.hp <= 0 || !blocks(u) || u.y < e.y - EPS) continue;
      if (!best || u.y < best.y - EPS) best = u;
    }
    return best;
  }

  /**
   * 고정 틱 하나: 0. 추격 무리 등장 → 1. 유닛 이동 → 2. 적 이동(막는 유닛에서 멈춤·떨어진 핵 되가져감) → 3. 유닛 공격(적 → guardian)
   * → 4. 적 공격 → 5. guardian 반격 → 6. 사망(운반자면 핵 떨어뜨림) → 7. guardian 쓰러짐 → 핵 획득 → 8. 줍기 → 9. 이야기책 도착
   */
  step(dt: number, out: ExpeditionEventSink, rng: Rng): void {
    const geo = this.geo;
    const cfg = this.cfg;
    const g = this.guardian;

    // 0
    if (this.guardianDown && this.core.at !== 'hut' && this.chaseQueue.length) {
      this.chaseTimer -= dt;
      while (this.chaseTimer <= EPS && this.chaseQueue.length) {
        this.spawnEnemy(this.chaseQueue.shift()!, geo.wallY, true, rng, out);
        this.chaseTimer += cfg.carry.chaseInterval;
      }
    }

    // 1
    const carrier = this.carrier;
    const anchor = this.anchorY(carrier);
    const claimed = new Set<Enemy>();
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      if (u === carrier) {
        u.y = Math.min(geo.startY, u.y + cfg.advanceSpeed * cfg.carry.speedMult * dt);
        u.arrived = false;
        u.returning = false;
      } else if (anchor !== null && !(u.role === 'hero' && this.core.at === 'dropped')) {
        this.escortMove(u, anchor, dt, claimed);
      } else {
        this.walk(u, dt);
      }
    }

    // 2
    const reach = cfg.carry.pickupRange;
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const b = this.blockerFor(e);
      const ny = Math.min(geo.startY, e.y + slowedStep(e, dt));
      e.y = b && ny >= b.y - EPS ? Math.max(e.y, b.y) : ny;
      const c = this.core;
      if (c.at === 'dropped' && c.y > geo.wallY + EPS && Math.abs(e.y - c.y) <= reach + EPS) {
        this.core = { at: 'dropped', y: geo.wallY };
        out.push({ type: 'coreReturned' });
      }
    }

    // 3
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const interval = u === carrier ? u.atkInterval * cfg.carry.atkIntervalMult : u.atkInterval;
      let t: Enemy | null = null;
      for (const e of this.enemies) {
        if (e.hp <= 0) continue;
        const d = Math.abs(e.y - u.y);
        if (d > u.range + EPS) continue;
        if (!t || d < Math.abs(t.y - u.y) - EPS) t = e;
      }
      if (t) {
        if (stepAttack(u, dt, true, interval)) {
          applyHit(u, t);
          out.push({ type: 'unitHit', unitId: u.id, enemyId: t.id, damage: u.atk });
        }
      } else if (g.hp > 0 && u.y - geo.wallY <= u.range + EPS) {
        if (stepAttack(u, dt, true, interval)) {
          g.hp -= u.atk;
          out.push({ type: 'guardianHit', unitId: u.id, damage: u.atk });
        }
      } else {
        stepAttack(u, dt, false, interval);
      }
    }

    // 4: 막는 유닛에 붙은 적 (따라붙는 동안에도 쿨다운은 이어진다)
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const b = this.blockerFor(e);
      const contact = b !== null && b.y - e.y <= cfg.escort.contact + EPS;
      if (stepAttack(e, dt, contact)) {
        const dmg = e.atk * b!.dmgMult;
        b!.hp -= dmg;
        out.push({ type: 'enemyAttack', enemyId: e.id, unitId: b!.id, damage: dmg });
      }
    }

    // 5: guardian 반격 — counterRange 안, 방패병 먼저, 그 안에서 가장 앞(y 최소)
    let target: Unit | null = null;
    if (g.hp > 0) {
      for (const u of this.units) {
        if (u.hp <= 0 || u.y - geo.wallY > g.range + EPS) continue;
        const shield = u.soldier === 'shield';
        const tShield = target?.soldier === 'shield';
        if (!target || (shield && !tShield) || (shield === tShield && u.y < target.y - EPS)) target = u;
      }
    }
    if (stepAttack(g, dt, target !== null)) {
      const dmg = g.atk * target!.dmgMult;
      target!.hp -= dmg;
      out.push({ type: 'counter', unitId: target!.id, damage: dmg });
    }

    // 6
    for (const e of removeWhere(this.enemies, (x) => x.hp <= 0)) {
      out.push({ type: 'enemyDie', enemyId: e.id, x: e.x, y: e.y, joy: e.joyReward, chaser: e.chaser });
    }
    for (const u of removeWhere(this.units, (x) => x.hp <= 0)) {
      const c = this.core;
      const carrying = c.at === 'carried' && c.unitId === u.id;
      if (carrying) {
        this.core = { at: 'dropped', y: u.y };
        this.drops += 1;
        out.push({ type: 'coreDrop', y: u.y });
      }
      out.push({ type: 'offenseUnitDie', unitId: u.id, role: u.role, slot: u.slot, chain: u.chain, tier: u.tier, x: u.x, y: u.y, carrying });
    }

    // 7
    if (!this.guardianDown && g.hp <= 0) {
      this.guardianDown = true;
      g.hp = 0;
      out.push({ type: 'guardianDown' });
      const hero = this.heroAlive();
      if (hero) {
        this.core = { at: 'carried', unitId: hero.id };
        out.push({ type: 'corePick', unitId: hero.id, first: true });
      } else {
        this.core = { at: 'dropped', y: geo.wallY };
      }
    }

    // 8
    const c = this.core;
    if (c.at === 'dropped') {
      const hero = this.heroAlive();
      if (hero && Math.abs(hero.y - c.y) <= reach + EPS) {
        this.core = { at: 'carried', unitId: hero.id };
        out.push({ type: 'corePick', unitId: hero.id, first: false });
      }
    }

    // 9
    const now = this.carrier;
    if (now) {
      this.carryTime += dt;
      if (now.y >= geo.startY - EPS) {
        this.core = { at: 'hut' };
        out.push({ type: 'coreHome' });
      }
    }
  }

  /**
   * 가는 길 걷기: 목표 = guardian 사거리 지점(guardian이 있으면) / 떨어진 핵(영웅). 사거리 안에 적이 있으면 멈춰 싸운다.
   * 유닛끼리는 막지 않는다.
   */
  private walk(u: Unit, dt: number): void {
    const geo = this.geo;
    const c = this.core;
    let goal: number;
    if (this.guardian.hp > 0) goal = Math.min(u.y, geo.wallY + u.range);
    else if (c.at === 'dropped' && u.role === 'hero') goal = c.y;
    else goal = u.y;
    u.returning = false;
    const engaged = this.enemies.some((e) => e.hp > 0 && Math.abs(e.y - u.y) <= u.range + EPS);
    if (engaged) {
      if (!u.arrived) u.cd = Math.min(u.cd, 0);
      u.arrived = true;
      return;
    }
    const d = goal - u.y;
    const step = this.cfg.advanceSpeed * dt;
    if (Math.abs(d) <= step + EPS) {
      u.y = goal;
      u.arrived = this.guardian.hp > 0;
    } else {
      u.y += Math.sign(d) * step;
      u.arrived = false;
    }
  }

  /**
   * 호위 (§4.3.3 제한 이동을 운반자 기준으로): 기준선 anchorY에서 레인 끝 쪽으로 escort.range까지 나가 적을 막는다.
   * 대상 = 손이 닿는 적 중 기준선에 가장 가까운(y 최대) 적, 앞선 유닛이 고른 적은 건너뜀. 대상이 없으면 기준선의 자기 슬롯으로.
   */
  private escortMove(u: Unit, anchorY: number, dt: number, claimed: Set<Enemy>): void {
    const ic = this.cfg.escort;
    const zoneTop = anchorY - ic.range;
    let pick: Enemy | null = null;
    let fallback: Enemy | null = null;
    for (const e of this.enemies) {
      if (e.hp <= 0 || e.y < zoneTop - u.range - EPS || e.y > anchorY + ic.contact + EPS) continue;
      if (!fallback || e.y > fallback.y + EPS) fallback = e;
      if (claimed.has(e)) continue;
      if (!pick || e.y > pick.y + EPS) pick = e;
    }
    const t = pick ?? fallback;
    if (t) claimed.add(t);
    const tx = t ? t.x : this.geo.slotXs[u.slot];
    const ty = t ? Math.max(zoneTop, Math.min(anchorY, t.y + ic.contact)) : anchorY;
    u.returning = !t && (Math.abs(u.x - tx) > EPS || Math.abs(u.y - ty) > EPS);
    u.arrived = true;
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

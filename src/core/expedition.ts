// 낮(오펜스) — 핵 찾아 돌아오기 (스펙 §5.19-2, §5.20-3·3-1·9, D-053·D-059). Phaser 의존 없음.
//
// 레인에는 한 번에 한 팀(+ 전투 중 머지 병사). 팀은 이야기책(startY)에서 앞·가운데·뒤 순서로 뭉쳐 출발한다.
// 근접은 적(또는 guardian)에 붙을 때까지 다가가서, 원거리는 사거리 끝에서 멈춰 친다. 병사는 근접.
// 적은 가장 가까운 우리 편(영웅·막는 병사)을 향해 걸어가 붙어서 친다. guardian(핵)은 레인 끝에 고정, 반격은 방패병 먼저.
// guardian HP 0 → 핵 획득: 맨 앞 영웅이 든다 (운반자, 병사는 들 수 없음).
// 돌아오는 길: 운반자는 공격하지 않고 speedMult로 이야기책까지 걷는다. 운반이 시작되는 순간부터 레인 끝에서 추격 무리가
//   chaseInterval마다 나와 운반자를 향해 chaseSpeedMult로 쫓는다. 다른 팀원·병사는 운반자 뒤(anchor)에서 막는다
//   (§5.22-10 4a: 추격 무리는 호위·병사에 막히지 않고 운반자만 친다. 운반자가 맞으면 staggerSeconds 동안 멈칫)
//   (근접 = 디펜스 제한 이동 §4.3.3, 원거리 = 운반자 곁에서 쏨).
// 운반자가 쓰러지면 핵을 그 자리에 떨어뜨린다. 같은 팀 영웅이 닿으면 다시 든다. 적이 떨어진 핵에 닿으면 레인 끝으로 되가져간다
// (guardian은 부활하지 않음). 운반자가 이야기책에 닿으면 그 핵 성공.
// 팀 전멸 → 다음 팀, 낮 시간·실패 판정은 GameState가 한다.
//
// 좌표는 lane.ts와 같다 (진행 축 y, 아래로 증가 = 이야기책 쪽).

import {
  UnitHost,
  applyHit,
  blocks,
  damageUnit,
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
}

export interface Enemy extends Attacker {
  id: number;
  type: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
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
  /** 정지(수호의 울타리·보름달): 남은 초 동안 반격하지 않음 */
  slowTimer: number;
  slowMult: number;
}

/** 핵 위치: guardian이 쥠 / 영웅이 운반 중 / 떨어짐(y) / 이야기책 도착 */
export type CoreSpot = { at: 'guardian' } | { at: 'carried'; unitId: number } | { at: 'dropped'; y: number } | { at: 'hut' };

export interface ExpeditionConfig {
  /** 영웅·병사 이동 속도 (가는 길) */
  advanceSpeed: number;
  carry: { speedMult: number; atkIntervalMult: number; chaseInterval: number; pickupRange: number; chaseSpeedMult: number; staggerSeconds: number };
  /** 운반자 뒤 호위 = 디펜스 제한 이동 규칙 (§4.3.3) */
  escort: InterceptConfig;
  /** 레인 동시 적 최대 (§5.20-13). 넘는 가는 길 무리·추격 무리는 대기열에서 자리가 나면 레인 끝에서 나온다 */
  maxEnemies: number;
}

export type ExpeditionEvent =
  | { type: 'enemySpawn'; enemyId: number; chaser: boolean; enemy: string }
  | { type: 'unitHit'; unitId: number; enemyId: number; damage: number }
  | { type: 'enemyAttack'; enemyId: number; unitId: number; damage: number }
  | { type: 'enemyDie'; enemyId: number; x: number; y: number; chaser: boolean }
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
  readonly guardian: Guardian = { type: '', hp: 0, maxHp: 1, range: 0, boss: false, atk: 0, atkInterval: 1, cd: 0, slowTimer: 0, slowMult: 0 };
  core: CoreSpot = { at: 'guardian' };
  /** guardian을 쓰러뜨렸는지 (이후 쓰러짐은 운반 중 규칙) */
  guardianDown = false;
  /** 아직 나오지 않은 추격 무리 */
  readonly chaseQueue: EnemyStats[] = [];
  /** 동시 적 상한을 넘어 아직 나오지 않은 가는 길 무리 (자리가 나면 레인 끝에서) */
  readonly roadQueue: EnemyStats[] = [];
  private chaseTimer = 0;
  /** 운반자 멈칫 남은 초 (맞으면 staggerSeconds) */
  stagger = 0;
  /** 핵을 든 채 보낸 시간(초) */
  carryTime = 0;
  /** 핵을 떨어뜨린 수 */
  drops = 0;
  /** 마지막으로 핵을 이야기책에 들인 영웅 id (이야기책 문장, §5.20-8) */
  lastCarrier: string | null = null;
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

  /** 낮 시작: 레인을 비우고 guardian·가는 길 무리·추격 무리를 세운다 (무리는 PLACE 구간에 고르게, x는 rng). 상한 넘는 무리는 대기열 */
  reset(guardian: GuardianStats, enemies: EnemyStats[], chase: EnemyStats[], rng: Rng): void {
    this.units.length = 0;
    this.enemies.length = 0;
    this.chaseQueue.splice(0, this.chaseQueue.length, ...chase);
    this.chaseTimer = 0; // 운반이 시작되는 순간 첫 추격 (§5.20-9)
    this.stagger = 0;
    this.core = { at: 'guardian' };
    this.guardianDown = false;
    this.carryTime = 0;
    this.drops = 0;
    this.lastCarrier = null;
    this.nextEnemyId = 1;
    Object.assign(this.guardian, { ...guardian, maxHp: guardian.hp, cd: 0, slowTimer: 0, slowMult: 0 });
    const placed = enemies.slice(0, this.cfg.maxEnemies);
    this.roadQueue.splice(0, this.roadQueue.length, ...enemies.slice(this.cfg.maxEnemies));
    const n = placed.length;
    placed.forEach((e, k) => {
      const t = n === 1 ? 0.5 : k / (n - 1);
      this.spawnEnemy(e, this.geo.wallY + this.length * (PLACE_FROM + (PLACE_TO - PLACE_FROM) * t), false, rng, null);
    });
  }

  /**
   * 팀 출발: 이야기책에서 앞·가운데·뒤 순서로 (앞자리가 레인 쪽으로 spacing씩 앞). 영웅 유닛 id를 돌려준다.
   * 유닛 추가 자체는 GameState가 addUnit으로 하고, 이 함수는 출발 y만 계산한다.
   */
  teamStartY(index: number, size: number, spacing: number): number {
    return this.geo.startY - (size - 1 - index) * spacing;
  }

  /** 낮이 끝남: 레인 비움 */
  clear(): void {
    this.units.length = 0;
    this.enemies.length = 0;
    this.chaseQueue.length = 0;
    this.roadQueue.length = 0;
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
      chaser,
      cd: 0,
      slowTimer: 0,
      slowMult: 0,
    };
    this.enemies.push(e);
    out?.push({ type: 'enemySpawn', enemyId: e.id, chaser, enemy: e.type });
    return e;
  }

  private heroesAlive(): Unit[] {
    return this.units.filter((u) => u.role === 'hero' && u.hp > 0);
  }

  /** 맨 앞(guardian 쪽, y 최소) 살아 있는 영웅 */
  private frontHero(): Unit | null {
    let best: Unit | null = null;
    for (const u of this.heroesAlive()) if (!best || u.y < best.y - EPS) best = u;
    return best;
  }

  /** 호위 기준선: 운반자 / (핵이 떨어짐) 줍으러 가는 영웅 중 핵에 가장 가까운 영웅, 없으면 핵 자리 / 그 밖(가는 길) null */
  private anchorY(carrier: Unit | null): number | null {
    if (carrier) return carrier.y;
    const c = this.core;
    if (c.at === 'dropped') {
      let best: Unit | null = null;
      for (const u of this.heroesAlive()) if (!best || Math.abs(u.y - c.y) < Math.abs(best.y - c.y)) best = u;
      return best?.y ?? c.y;
    }
    return null;
  }

  /** 적이 노리는 유닛: 추격 무리는 운반자, 그 밖은 가장 가까운 우리 편(영웅·막는 병사) */
  private targetFor(e: Enemy, carrier: Unit | null): Unit | null {
    if (e.chaser && carrier) return carrier;
    let best: Unit | null = null;
    for (const u of this.units) {
      if (u.hp <= 0 || !blocks(u)) continue;
      if (!best || Math.abs(u.y - e.y) < Math.abs(best.y - e.y) - EPS) best = u;
    }
    return best;
  }

  /** 적이 지금 붙어 있는(contact 안) 막는 유닛 중 가장 가까운 유닛 */
  private contactFor(e: Enemy): Unit | null {
    const contact = this.cfg.escort.contact;
    let best: Unit | null = null;
    for (const u of this.units) {
      if (u.hp <= 0 || !blocks(u)) continue;
      const d = Math.abs(u.y - e.y);
      if (d > contact + EPS) continue;
      if (!best || d < Math.abs(best.y - e.y) - EPS) best = u;
    }
    return best;
  }

  /** 유닛 u의 공격 대상: 사거리 안 가장 가까운 적 (없으면 사거리 안 guardian) */
  private attackTarget(u: Unit): Enemy | 'guardian' | null {
    let t: Enemy | null = null;
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const d = Math.abs(e.y - u.y);
      if (d > u.range + EPS) continue;
      if (!t || d < Math.abs(t.y - u.y) - EPS) t = e;
    }
    if (t) return t;
    if (this.guardian.hp > 0 && u.y - this.geo.wallY <= u.range + EPS) return 'guardian';
    return null;
  }

  /**
   * 고정 틱 하나: 0. 추격 무리 등장 → 1. 유닛 이동 → 2. 적 이동(노리는 유닛을 향해, 붙으면 멈춤·떨어진 핵 되가져감)
   * → 3. 유닛 공격(운반자 제외, 적 → guardian) → 4. 적 공격 → 5. guardian 반격 → 6. 사망(운반자면 핵 떨어뜨림)
   * → 7. guardian 쓰러짐 → 핵 획득 → 8. 줍기 → 9. 이야기책 도착
   */
  step(dt: number, out: ExpeditionEventSink, rng: Rng): void {
    const geo = this.geo;
    const cfg = this.cfg;
    const g = this.guardian;

    // 0: 대기 중인 가는 길 무리 (상한 아래로 자리가 나면 레인 끝에서, 틱당 하나)
    if (this.roadQueue.length && this.enemies.length < cfg.maxEnemies) this.spawnEnemy(this.roadQueue.shift()!, geo.wallY, false, rng, out);
    // 0: 운반이 시작되면(guardian 처치 뒤) 레인 끝에서 chaseInterval마다 (상한이면 자리가 날 때까지 대기)
    if (this.guardianDown && this.core.at !== 'hut' && this.chaseQueue.length) {
      this.chaseTimer = Math.max(0, this.chaseTimer - dt);
      while (this.chaseTimer <= EPS && this.chaseQueue.length && this.enemies.length < cfg.maxEnemies) {
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
        if (this.stagger > EPS) this.stagger = Math.max(0, this.stagger - dt);
        else u.y = Math.min(geo.startY, u.y + cfg.advanceSpeed * cfg.carry.speedMult * dt);
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
    const contact = cfg.escort.contact;
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const target = this.targetFor(e, carrier);
      const speed = slowedStep(e, dt) * (e.chaser ? cfg.carry.chaseSpeedMult : 1);
      let goal = target ? target.y : geo.startY;
      if (target) goal += target.y > e.y ? -contact : contact; // 붙을 자리
      // 가는 길의 막는 유닛에 먼저 닿으면 거기서 멈춘다 (추격 무리는 운반자 말고는 막히지 않는다)
      const dir = Math.sign(goal - e.y);
      const ignoreEscort = e.chaser && carrier !== null;
      if (dir !== 0) {
        let ny = e.y + dir * Math.min(speed, Math.abs(goal - e.y));
        for (const u of this.units) {
          if (ignoreEscort && u !== carrier) continue;
          if (u.hp <= 0 || !blocks(u)) continue;
          const edge = u.y - dir * contact;
          if (dir > 0 && u.y > e.y && ny > edge) ny = Math.max(e.y, edge);
          if (dir < 0 && u.y < e.y && ny < edge) ny = Math.min(e.y, edge);
        }
        e.y = Math.max(geo.wallY, Math.min(geo.startY, ny));
      }
      const c = this.core;
      if (c.at === 'dropped' && c.y > geo.wallY + EPS && Math.abs(e.y - c.y) <= reach + EPS) {
        this.core = { at: 'dropped', y: geo.wallY };
        out.push({ type: 'coreReturned' });
      }
    }

    // 3: 운반자는 공격하지 않는다 (§5.20-3-1)
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      const t = u === carrier ? null : this.attackTarget(u);
      if (!stepAttack(u, dt, t !== null)) continue;
      if (t === 'guardian') {
        const dmg = u.atk * this.atkMult;
        g.hp -= dmg;
        out.push({ type: 'guardianHit', unitId: u.id, damage: dmg });
      } else if (t) {
        const dmg = applyHit(u, t, this.atkMult);
        out.push({ type: 'unitHit', unitId: u.id, enemyId: t.id, damage: dmg });
      }
    }

    // 4: 붙은 적이 가장 가까운 우리 편을 친다 (쿨다운은 따라붙는 동안에도 이어진다)
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      // 추격 무리는 운반자만 친다 (호위 무시)
      const b = e.chaser && carrier ? (Math.abs(carrier.y - e.y) <= contact + EPS ? carrier : null) : this.contactFor(e);
      if (stepAttack(e, dt, b !== null && !(e.slowTimer > EPS && e.slowMult >= 1))) {
        const dmg = damageUnit(b!, e.atk);
        out.push({ type: 'enemyAttack', enemyId: e.id, unitId: b!.id, damage: dmg });
        if (b === carrier) this.stagger = cfg.carry.staggerSeconds;
      }
    }

    // 5: guardian 반격 — counterRange 안, 방패병 먼저, 그 안에서 가장 앞(y 최소). 정지 중이면 쉰다
    if (g.slowTimer > 0) g.slowTimer = Math.max(0, g.slowTimer - dt);
    let target: Unit | null = null;
    if (g.hp > 0 && g.slowTimer <= EPS) {
      for (const u of this.units) {
        if (u.hp <= 0 || u.y - geo.wallY > g.range + EPS) continue;
        const shield = u.soldier === 'shield';
        const tShield = target?.soldier === 'shield';
        if (!target || (shield && !tShield) || (shield === tShield && u.y < target.y - EPS)) target = u;
      }
    }
    if (stepAttack(g, dt, target !== null)) {
      const dmg = damageUnit(target!, g.atk);
      out.push({ type: 'counter', unitId: target!.id, damage: dmg });
    }

    // 6
    for (const e of removeWhere(this.enemies, (x) => x.hp <= 0)) {
      out.push({ type: 'enemyDie', enemyId: e.id, x: e.x, y: e.y, chaser: e.chaser });
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
      const hero = this.frontHero();
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
      let hero: Unit | null = null;
      for (const u of this.heroesAlive()) if (Math.abs(u.y - c.y) <= reach + EPS && (!hero || Math.abs(u.y - c.y) < Math.abs(hero.y - c.y))) hero = u;
      if (hero) {
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
        this.lastCarrier = now.chain;
        out.push({ type: 'coreHome' });
      }
    }
  }

  /**
   * 가는 길 걷기 (§5.20-3-1): 사거리 안에 적(또는 guardian)이 있으면 멈춰 친다. 없으면 가장 가까운 적·guardian을 향해 간다
   * (근접은 붙을 때까지, 원거리는 사거리 끝까지). guardian을 쓰러뜨린 뒤 핵이 떨어져 있으면 영웅은 핵으로 간다.
   */
  private walk(u: Unit, dt: number): void {
    const geo = this.geo;
    const c = this.core;
    u.returning = false;
    if (this.attackTarget(u)) {
      if (!u.arrived) u.cd = Math.min(u.cd, 0);
      u.arrived = true;
      return;
    }
    let goal: number | null = null;
    if (c.at === 'dropped' && u.role === 'hero') goal = c.y;
    else {
      let best: Enemy | null = null;
      for (const e of this.enemies) if (e.hp > 0 && (!best || Math.abs(e.y - u.y) < Math.abs(best.y - u.y))) best = e;
      if (best) goal = best.y + (best.y < u.y ? u.range : -u.range);
      else if (this.guardian.hp > 0) goal = geo.wallY + u.range;
      else goal = u.y;
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
    u.y = Math.max(geo.wallY, Math.min(geo.startY, u.y));
  }

  /**
   * 호위 (§4.3.3 제한 이동을 운반자 기준으로): 근접은 기준선에서 레인 끝 쪽으로 escort.range까지 나가 적을 막는다
   * (대상 = 손이 닿는 적 중 기준선에 가장 가까운 적, 앞선 유닛이 고른 적은 건너뜀). 원거리·대상 없음 = 기준선의 자기 슬롯.
   */
  private escortMove(u: Unit, anchorY: number, dt: number, claimed: Set<Enemy>): void {
    const ic = this.cfg.escort;
    const zoneTop = anchorY - ic.range;
    let pick: Enemy | null = null;
    let fallback: Enemy | null = null;
    if (u.attackType === 'melee') {
      for (const e of this.enemies) {
        if (e.hp <= 0 || e.y < zoneTop - u.range - EPS || e.y > anchorY + ic.contact + EPS) continue;
        if (!fallback || e.y > fallback.y + EPS) fallback = e;
        if (claimed.has(e)) continue;
        if (!pick || e.y > pick.y + EPS) pick = e;
      }
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

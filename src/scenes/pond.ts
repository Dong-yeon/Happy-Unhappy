// 이야기 우물 헤엄 모델 (§5.21, D-065). 화면 전용 — Phaser 의존 없음, core 상태는 읽기만 한다.
// 조각마다 화면 위치(px)를 따로 가진다 (core의 칸 번호와 별개, piece.id로 묶음). core 규칙·시뮬·저장은 그대로:
// 합치기는 놓은 곳 반지름 MERGE_RADIUS 안의 "core가 머지로 판정하는"(resolveDrop) 조각에만, core에는 기존 drop(칸 A, 칸 B)으로 전달.
// 판을 누르는 동안(frozen) 아무도 움직이지 않고, 끄는 조각만 손가락을 따라간다.
// 아래 헤엄 수치는 화면 연출 값이라 layout.ts와 같이 코드에 둔다 (게임 밸런스 수치가 아님, balance.json 대상 아님).

import { isWildcard, resolveDrop, type DropKind, type Grid, type Piece } from '../core/grid';
import { MERGE_RADIUS, WELL, WELL_TOKEN_R, wellDistance } from './layout';

/**
 * 헤엄 튜닝 값 (화면 연출, DBG 패널 슬라이더로 바로 바꿀 수 있게 한 객체에 모음 — 게임 밸런스 수치 아님).
 * 물살(위치·시간 사인 합 + 20~40초마다 천천히 바뀌는 큰 소용돌이) + 곡선 회전(각속도 wander) + 단계별 성격 + 돌진·떠 있음 박자.
 */
export const POND = {
  /** 물살 세기 (px/s, 조각 속도에 더함) */
  flowStrength: 6,
  /** 물살 무늬 크기 (공간 주파수, 1/px) */
  flowScale: 0.011,
  /** 큰 소용돌이 중심·방향이 바뀌는 주기 (초) */
  vortexMin: 20,
  vortexMax: 40,
  /** 헤엄 속도: 5단계(묵직함) ~ 1단계(빠름), 최고 속도 */
  speedMin: 4,
  speedMax: 22,
  speedCap: 30,
  /** 각속도 상한 (rad/s): 1단계 자주 돎 ~ 5단계 */
  turnFast: 2.4,
  turnSlow: 0.6,
  /** 원하는 속도로 맞춰 가는 빠르기 (1/s) */
  steer: 1.6,
  /** 짧은 돌진: 초당 확률 · 배율 · 길이(초). 끝나면 미끄러지며 감속 */
  dashRate: 0.08,
  dashMult: 1.6,
  dashTime: 0.4,
  /** 떠 있음(거의 정지): 초당 확률 · 길이(초) 범위 */
  restRate: 0.05,
  restMin: 1,
  restMax: 2,
  /** 같은 조각 끌림 가속 (px/s², 물살보다 강하게) · 와일드카드 · 자동 뭉침 단계 */
  attract: 12,
  wildAttract: 5,
  autoAttract: 22,
  /** 머지 물결: 반경 · 바깥으로 미는 세기 (px/s) */
  rippleRadius: 60,
  rippleKick: 40,
  /** 끄는 조각 주변에서 비켜나는 반경 (px) */
  avoidRadius: 30,
  /** 말랑함 세기 (squash & stretch 배율, D-073) */
  squash: 1,
};

/** 같은 조각끼리 끌림 (§5.21-4) 거리 */
export const ATTRACT_RANGE = 120;
/** 조각끼리 밀어냄: 이 간격까지 겹치지 않게 */
const GAP = 2;
/** 가장자리: 이만큼 안쪽부터 부드럽게 안으로 밀고, 닿으면 튕김 (감쇠) */
const EDGE_SOFT = 12;
const EDGE_PUSH = 30;
const BOUNCE = 0.8;
/** 떠 있을 때 속도 배율 */
const REST_MULT = 0.08;

export type Rng = () => number;

export interface Fish {
  /** piece.id */
  id: number;
  /** 지금 core 칸 번호 */
  cell: number;
  chain: string;
  tier: number;
  wild: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** 원하는 헤엄 속도 (단계별 성격, px/s). 0이면 헤엄치지 않음 (물살·끌림만) */
  speed: number;
  /** 각속도 (rad/s, wander로 조금씩 바뀜 → S자) · 이 조각의 최대 각속도 */
  angVel: number;
  agility: number;
  /** 박자: 돌진 남은 초 · 떠 있음 남은 초 · 이 조각의 박자 배율 (조각마다 다름) */
  dash: number;
  rest: number;
  tempo: number;
  /** 그림 출렁임 주기(초)·위상 (표시 전용) */
  wobblePeriod: number;
  wobblePhase: number;
  /** 이 시간(초) 동안은 제자리 (날아오는 중) */
  hold: number;
}

/** 원형 장애물 (스킬 버튼): 조각이 아래로 숨지 않게 밀어냄 */
export interface Obstacle {
  x: number;
  y: number;
  r: number;
}

/** chained = 연쇄로 이어 합쳐져 사라진 조각 (core가 합친 순서, D-073) — 화면이 단계별로 빨아들이는 연출에 씀 */
export type ReleaseResult = { kind: 'merge'; from: number; to: number; kept: number; chained: Fish[] } | { kind: 'swim' };

/** 놓은 조각을 core에 전달할 곳 (GameState.drop과 같은 모양) */
export interface DropSink {
  readonly grid: Grid;
  /** touching = 결과 조각과 맞닿은 조각 id (가까운 순, 연쇄 D-073) */
  drop(from: number, to: number | null, touching?: readonly number[]): DropKind;
  /** 연쇄 맞닿음 여유 (px) */
  readonly chainGap?: number;
}

export class Pond {
  readonly fish = new Map<number, Fish>();
  /** 판을 누르는 동안 true: 모든 조각 정지 (§5.21-3) */
  frozen = false;
  /** 끄는 조각 (piece.id) */
  dragging: number | null = null;
  readonly r = WELL_TOKEN_R;
  /** 헤엄 누적 시간 (물살 시간 축) */
  private time = 0;
  /** 큰 소용돌이: 지금 중심·방향 → 목표로 천천히 */
  private readonly vortex = { x: WELL.x + WELL.w / 2, y: WELL.y + WELL.h / 2, dir: 1, tx: WELL.x + WELL.w / 2, ty: WELL.y + WELL.h / 2, tdir: 1, left: 0 };

  constructor(
    private readonly rng: Rng = Math.random,
    private readonly obstacles: readonly Obstacle[] = [],
  ) {}

  // ── core와 맞추기 ──

  /**
   * core 그리드와 맞춘다: 없어진 조각은 지우고, 새 조각은 place(없으면 우물 안 빈 곳)에, 남은 조각은 칸·단계만 갱신.
   * 위치는 그대로 둔다 (core가 칸을 바꿔도 화면 위치는 별개).
   */
  sync(grid: Grid, place?: (p: Piece, cell: number) => { x: number; y: number } | null): { added: Fish[]; removed: Fish[]; changed: Fish[] } {
    const live = new Set<number>();
    const added: Fish[] = [];
    const changed: Fish[] = [];
    grid.cells.forEach((p, cell) => {
      if (!p) return;
      live.add(p.id);
      const f = this.fish.get(p.id);
      const tier = p.tier;
      if (f) {
        if (f.cell !== cell || f.tier !== tier || f.chain !== p.chain) {
          const grew = f.tier !== tier || f.chain !== p.chain;
          if (grew) changed.push(f);
          Object.assign(f, { cell, tier, chain: p.chain, wild: isWildcard(p) });
          if (grew) this.personality(f);
        }
        return;
      }
      const at = place?.(p, cell) ?? this.randomPoint();
      const nf = this.makeFish(p, cell, at.x, at.y);
      this.fish.set(p.id, nf);
      added.push(nf);
    });
    const removed: Fish[] = [];
    for (const [id, f] of this.fish) {
      if (live.has(id)) continue;
      this.fish.delete(id);
      removed.push(f);
      if (this.dragging === id) this.dragging = null;
    }
    return { added, removed, changed };
  }

  private makeFish(p: Piece, cell: number, x: number, y: number): Fish {
    const heading = this.rng() * Math.PI * 2;
    const f: Fish = {
      id: p.id,
      cell,
      chain: p.chain,
      tier: p.tier,
      wild: isWildcard(p),
      x,
      y,
      vx: 0,
      vy: 0,
      heading,
      speed: 0,
      angVel: 0,
      agility: 0,
      dash: 0,
      rest: 0,
      tempo: 0.7 + 0.6 * this.rng(),
      wobblePeriod: 1.5 + this.rng(),
      wobblePhase: this.rng() * Math.PI * 2,
      hold: 0,
    };
    this.personality(f);
    f.vx = Math.cos(heading) * f.speed;
    f.vy = Math.sin(heading) * f.speed;
    return f;
  }

  /** 단계별 성격: 1단계 빠르고 자주 돎 ~ 5단계 느리고 묵직함 (±15% 개체차) */
  private personality(f: Fish): void {
    const t = f.wild ? 0.5 : Math.max(0, Math.min(1, (f.tier - 1) / 4));
    const jitter = 0.85 + 0.3 * this.rng();
    f.speed = (POND.speedMax + (POND.speedMin - POND.speedMax) * t) * jitter;
    f.agility = POND.turnFast + (POND.turnSlow - POND.turnFast) * t;
  }

  /** 우물 안 무작위 점 (다른 조각과 덜 겹치게 몇 번 다시 뽑음) */
  randomPoint(): { x: number; y: number } {
    let best = { x: WELL.x + WELL.w / 2, y: WELL.y + WELL.h / 2 };
    let bestGap = -Infinity;
    for (let k = 0; k < 24; k++) {
      const x = WELL.x + this.rng() * WELL.w;
      const y = WELL.y + this.rng() * WELL.h;
      if (wellDistance(x, y) > -(this.r + 4)) continue;
      let gap = Infinity;
      for (const f of this.fish.values()) gap = Math.min(gap, Math.hypot(f.x - x, f.y - y));
      for (const o of this.obstacles) gap = Math.min(gap, Math.hypot(o.x - x, o.y - y) - o.r);
      if (gap > bestGap) {
        best = { x, y };
        bestGap = gap;
      }
      if (gap > this.r * 2.5) break;
    }
    return best;
  }

  /** 우물 가장자리 바로 안쪽 무작위 점 (저절로 생긴 조각이 퐁 들어오는 곳) */
  rimPoint(): { x: number; y: number } {
    for (let k = 0; k < 40; k++) {
      const x = WELL.x + this.rng() * WELL.w;
      const y = WELL.y + this.rng() * WELL.h;
      const d = wellDistance(x, y);
      if (d <= -(this.r + 2) && d >= -(this.r + 14) && !this.obstacles.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + this.r)) return { x, y };
    }
    return this.randomPoint();
  }

  // ── 헤엄 ──

  /** 두 조각이 서로 끌리는 가속 (0이면 없음): 같은 체인·단계(최고 단계 아님) / 와일드카드 ↔ 아무 조각 (약하게) / 자동 뭉침 단계 (세게) */
  attraction(a: Fish, b: Fish, maxTier: number, autoMax = 0): number {
    if (a.wild && b.wild) return 0;
    if (a.wild || b.wild) return (a.wild ? b.tier : a.tier) < maxTier ? POND.wildAttract : 0;
    if (a.chain !== b.chain || a.tier !== b.tier || a.tier >= maxTier) return 0;
    return a.tier <= autoMax ? POND.autoAttract : POND.attract;
  }

  /** 물살 (px/s): 사인 몇 개의 합(부드러운 흐름) + 천천히 자리·방향이 바뀌는 큰 소용돌이. 위치·시간만의 함수 */
  flow(x: number, y: number): { x: number; y: number } {
    const k = POND.flowScale;
    const t = this.time;
    let fx = Math.sin(y * k + t * 0.21) + 0.6 * Math.sin((x + y) * k * 0.7 - t * 0.17) + 0.35 * Math.cos(y * k * 1.9 + x * k * 0.4 + t * 0.29);
    let fy = Math.cos(x * k * 1.1 - t * 0.19) + 0.6 * Math.sin((x - y) * k * 0.8 + t * 0.23) + 0.35 * Math.sin(x * k * 1.7 - y * k * 0.5 - t * 0.31);
    // 큰 소용돌이: 중심 둘레로 도는 흐름 (방향·중심은 vortex 상태가 천천히 보간)
    const v = this.vortex;
    const dx = x - v.x;
    const dy = y - v.y;
    const d = Math.hypot(dx, dy) || 1;
    const fall = Math.exp(-d / 120);
    fx += (-dy / d) * v.dir * 1.2 * fall;
    fy += (dx / d) * v.dir * 1.2 * fall;
    const m = Math.hypot(fx, fy) || 1;
    const s = POND.flowStrength * Math.min(1, m / 2);
    return { x: (fx / m) * s, y: (fy / m) * s };
  }

  /** 소용돌이: 20~40초마다 새 목표(중심·방향)로, 그 사이는 천천히 보간 */
  private stepVortex(dt: number): void {
    const v = this.vortex;
    v.left -= dt;
    if (v.left <= 0) {
      v.left = POND.vortexMin + (POND.vortexMax - POND.vortexMin) * this.rng();
      const p = this.randomPoint();
      v.tx = p.x;
      v.ty = p.y;
      v.tdir = this.rng() < 0.5 ? -1 : 1;
    }
    const k = Math.min(1, dt * 0.15);
    v.x += (v.tx - v.x) * k;
    v.y += (v.ty - v.y) * k;
    v.dir += (v.tdir - v.dir) * k;
  }

  /** 머지 물결: (x, y) 반경 rippleRadius 안 조각을 바깥으로 살짝 (가까울수록 세게, 감쇠는 steer가) */
  ripple(x: number, y: number): void {
    for (const f of this.fish.values()) {
      if (f.id === this.dragging) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d < 1 || d > POND.rippleRadius) continue;
      const kick = POND.rippleKick * (1 - d / POND.rippleRadius);
      f.vx += (dx / d) * kick;
      f.vy += (dy / d) * kick;
    }
  }

  /** 한 프레임. 누르는 동안(frozen)은 아무것도 움직이지 않는다. core 상태는 읽지도 쓰지도 않는다 */
  step(dt: number, maxTier: number, autoMax = 0): void {
    if (this.frozen || dt <= 0) return;
    this.time += dt;
    this.stepVortex(dt);
    const list = [...this.fish.values()];
    const r = this.r;
    for (const f of list) {
      if (f.id === this.dragging) continue;
      if (f.hold > 0) {
        f.hold = Math.max(0, f.hold - dt);
        continue;
      }
      // 박자: 가끔 짧은 돌진(→ 미끄러지며 감속), 가끔 1~2초 떠 있음. 조각마다 tempo가 달라 엇갈린다
      if (f.dash > 0) f.dash = Math.max(0, f.dash - dt);
      else if (f.rest > 0) f.rest = Math.max(0, f.rest - dt);
      else if (this.rng() < POND.dashRate * f.tempo * dt) f.dash = POND.dashTime;
      else if (this.rng() < POND.restRate * f.tempo * dt) f.rest = POND.restMin + (POND.restMax - POND.restMin) * this.rng();
      // 곡선 회전: 각속도가 조금씩 랜덤하게 바뀜 (S자)
      f.angVel += (this.rng() * 2 - 1) * f.agility * 1.8 * dt;
      f.angVel = Math.max(-f.agility, Math.min(f.agility, f.angVel * (1 - 0.4 * dt)));
      f.heading += f.angVel * dt;
      const want = f.speed * (f.dash > 0 ? POND.dashMult : f.rest > 0 ? REST_MULT : 1);
      // 돌진은 바로 붙고, 끝나면 steer로 미끄러지며 감속
      const k = Math.min(1, (f.dash > 0 ? POND.steer * 4 : POND.steer) * dt);
      f.vx += (Math.cos(f.heading) * want - f.vx) * k;
      f.vy += (Math.sin(f.heading) * want - f.vy) * k;
      // 같은 조각끼리 끌림 (물살보다 세게 — 짝이 결국 만나도록)
      for (const g of list) {
        if (g === f || g.hold > 0) continue;
        const a = this.attraction(f, g, maxTier, autoMax);
        if (!a) continue;
        const dx = g.x - f.x;
        const dy = g.y - f.y;
        const d = Math.hypot(dx, dy);
        if (d > ATTRACT_RANGE || d < r * 2 + GAP) continue;
        f.vx += (dx / d) * a * dt;
        f.vy += (dy / d) * a * dt;
      }
      // 가장자리: 부드럽게 안으로 (가던 방향도 안쪽으로 서서히 꺾음)
      const n = this.inward(f.x, f.y);
      const dist = wellDistance(f.x, f.y);
      if (dist > -(r + EDGE_SOFT)) {
        const t = Math.min(1, (dist + r + EDGE_SOFT) / EDGE_SOFT);
        f.vx += n.x * EDGE_PUSH * t * dt;
        f.vy += n.y * EDGE_PUSH * t * dt;
        const inwardAngle = Math.atan2(n.y, n.x);
        const diff = Math.atan2(Math.sin(inwardAngle - f.heading), Math.cos(inwardAngle - f.heading));
        f.heading += diff * Math.min(1, 1.5 * t * dt);
      }
      const sp = Math.hypot(f.vx, f.vy);
      if (sp > POND.speedCap) {
        f.vx *= POND.speedCap / sp;
        f.vy *= POND.speedCap / sp;
      }
      // 물살은 위치에 더한다 (조각 속도와 별개)
      const fl = this.flow(f.x, f.y);
      f.x += (f.vx + fl.x) * dt;
      f.y += (f.vy + fl.y) * dt;
      this.bounce(f);
    }
    this.separate(list);
  }

  /** 끈적한 다리 후보 (D-073): 같은 체인·단계(최고 아님) 쌍 중 중심 거리 range 안 — 화면이 그 사이에 다리를 그린다 */
  bridges(maxTier: number, range: number): [Fish, Fish][] {
    const list = [...this.fish.values()];
    const out: [Fish, Fish][] = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.wild || a.tier >= maxTier) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.wild || b.chain !== a.chain || b.tier !== a.tier) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= range) out.push([a, b]);
      }
    }
    return out;
  }

  /** 우물 안쪽 방향 (단위 벡터, 부호 거리의 기울기 반대) */
  private inward(x: number, y: number): { x: number; y: number } {
    const e = 0.5;
    const gx = wellDistance(x + e, y) - wellDistance(x - e, y);
    const gy = wellDistance(x, y + e) - wellDistance(x, y - e);
    const l = Math.hypot(gx, gy) || 1;
    return { x: -gx / l, y: -gy / l };
  }

  /** 테에 닿으면 안쪽으로 되돌리고 바깥 성분을 감쇠해 튕긴다 (방향도 튕긴 쪽으로) */
  private bounce(f: Fish): void {
    const dist = wellDistance(f.x, f.y);
    if (dist <= -this.r) return;
    const n = this.inward(f.x, f.y);
    const over = dist + this.r;
    f.x += n.x * over;
    f.y += n.y * over;
    const out = -(f.vx * n.x + f.vy * n.y);
    if (out > 0) {
      f.vx += n.x * out * (1 + BOUNCE);
      f.vy += n.y * out * (1 + BOUNCE);
      f.heading = Math.atan2(f.vy, f.vx);
    }
  }

  /** 조각끼리·스킬 버튼과 겹치지 않게 살짝 밀어냄 (끄는 조각·날아오는 조각은 밀리지 않음) */
  private separate(list: Fish[]): void {
    const r = this.r;
    const fixed = (f: Fish) => f.id === this.dragging || f.hold > 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = r * 2 + GAP;
        if (d >= min) continue;
        const push = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        const fa = fixed(a);
        const fb = fixed(b);
        if (fa && fb) continue;
        const sa = fa ? 0 : fb ? 2 : 1;
        const sb = fb ? 0 : fa ? 2 : 1;
        a.x -= ux * push * sa;
        a.y -= uy * push * sa;
        b.x += ux * push * sb;
        b.y += uy * push * sb;
      }
      for (const o of this.obstacles) {
        if (fixed(a)) continue;
        const dx = a.x - o.x;
        const dy = a.y - o.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = o.r + r;
        if (d < min) {
          a.x += (dx / d) * (min - d);
          a.y += (dy / d) * (min - d);
        }
      }
    }
    for (const f of list) if (!fixed(f)) this.bounce(f);
  }

  // ── 손가락 ──

  /** 판을 누름: 전부 정지. 손가락 아래 조각이 있으면 그 조각을 집는다 (piece.id, 없으면 null) */
  press(x: number, y: number): number | null {
    this.frozen = true;
    this.dragging = this.fishAt(x, y)?.id ?? null;
    return this.dragging;
  }

  /** 끄는 조각만 손가락을 따라감 */
  moveTo(x: number, y: number): void {
    const f = this.dragging === null ? null : this.fish.get(this.dragging);
    if (!f) return;
    f.x = x;
    f.y = y;
    // 누르는 동안 헤엄은 멈춰 있지만, 끄는 조각 곁(avoidRadius 안)의 조각은 살짝 비켜난다 (위치만)
    const min = this.r * 2 + POND.avoidRadius;
    for (const g of this.fish.values()) {
      // 합칠 수 있는 짝(같은 체인·단계, 와일드카드)은 비키지 않는다 — 놓을 자리를 피해 도망가지 않게
      if (g === f || f.wild || g.wild || (g.chain === f.chain && g.tier === f.tier)) continue;
      const dx = g.x - x;
      const dy = g.y - y;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d >= min) continue;
      const push = Math.min(3, (min - d) * 0.25);
      g.x += (dx / d) * push;
      g.y += (dy / d) * push;
      this.bounce(g);
    }
  }

  /** 손가락 아래(반지름 안) 가장 가까운 조각 */
  fishAt(x: number, y: number): Fish | null {
    let best: Fish | null = null;
    let bd = Infinity;
    for (const f of this.fish.values()) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d <= this.r + 4 && d < bd) {
        best = f;
        bd = d;
      }
    }
    return best;
  }

  /** 놓은 곳 (x, y)에서 MERGE_RADIUS 안, core가 머지로 판정하는 조각 중 가장 가까운 것 */
  mergeTarget(id: number, x: number, y: number, grid: Grid): Fish | null {
    const from = this.fish.get(id);
    if (!from) return null;
    let best: Fish | null = null;
    let bd = Infinity;
    for (const f of this.fish.values()) {
      if (f.id === id) continue;
      const d = Math.hypot(f.x - x, f.y - y);
      if (d > MERGE_RADIUS || d >= bd) continue;
      if (resolveDrop(grid, from.cell, f.cell) !== 'merge') continue;
      best = f;
      bd = d;
    }
    return best;
  }

  /**
   * 손을 뗌: 끄는 조각이 있으면 놓은 곳 반지름 안 같은 조각과 합친다 (core에는 drop(칸 A, 칸 B)).
   * 아니면 그 자리(우물 안으로 당김)에서 다시 헤엄. 어느 쪽이든 정지 풀림.
   * kept = 머지 뒤 남은 조각 id (core가 결과에 물려준 id)
   */
  release(x: number, y: number, sink: DropSink): ReleaseResult {
    const id = this.dragging;
    this.dragging = null;
    this.frozen = false;
    const f = id === null ? null : this.fish.get(id);
    if (!f) return { kind: 'swim' };
    const target = this.mergeTarget(f.id, x, y, sink.grid);
    if (target) {
      const from = f.cell;
      const to = target.cell;
      // 연쇄 (D-073): 머지 순간 결과 조각(짝 자리)과 맞닿은 조각 = 중심 거리 ≤ 2r + chainGap, 가까운 순
      const reach = this.r * 2 + (sink.chainGap ?? 0);
      const touching = [...this.fish.values()]
        .filter((g) => g.id !== f.id && g.id !== target.id)
        .map((g) => ({ g, d: Math.hypot(g.x - target.x, g.y - target.y) }))
        .filter((o) => o.d <= reach)
        .sort((a, b) => a.d - b.d)
        .map((o) => o.g);
      if (sink.drop(from, to, touching.map((g) => g.id)) === 'merge') {
        const kept = sink.grid.cells[to]!.id;
        const live = new Set(sink.grid.cells.flatMap((p) => (p ? [p.id] : [])));
        const chained = touching.filter((g) => !live.has(g.id)).sort((a, b) => a.tier - b.tier); // core는 낮은 단계부터 이어 합침
        this.sync(sink.grid);
        const k = this.fish.get(kept);
        if (k) {
          // 합쳐진 조각은 짝이 있던 자리에서
          k.x = target.x;
          k.y = target.y;
          k.vx = 0;
          k.vy = 0;
        }
        return { kind: 'merge', from, to, kept, chained };
      }
    }
    f.x = x;
    f.y = y;
    f.vx = 0;
    f.vy = 0;
    this.bounce(f);
    return { kind: 'swim' };
  }

  /** 자동 뭉침 (D-070): core가 이미 합친 쌍에서 사라진 쪽 물고기를 뺀다 (표시 연출은 WellView). 남은 쪽은 그대로 */
  absorb(fromCell: number, toCell: number): { from: Fish | null; to: Fish | null } {
    let from: Fish | null = null;
    let to: Fish | null = null;
    for (const f of this.fish.values()) {
      if (f.cell === fromCell) from = f;
      else if (f.cell === toCell) to = f;
    }
    if (from) {
      this.fish.delete(from.id);
      if (this.dragging === from.id) this.dragging = null;
    }
    return { from, to };
  }

  /** 팀 교대 이어받기 (D-072): core가 회수한 칸들의 물고기를 뺀다 (표시 연출은 WellView) */
  take(cells: readonly number[]): Fish[] {
    const set = new Set(cells);
    const out: Fish[] = [];
    for (const f of this.fish.values()) if (set.has(f.cell)) out.push(f);
    for (const f of out) {
      this.fish.delete(f.id);
      if (this.dragging === f.id) this.dragging = null;
    }
    return out;
  }

  /** 끌기 취소 (모달·단계 전환): 그 자리에서 다시 헤엄 */
  cancel(): void {
    const f = this.dragging === null ? null : this.fish.get(this.dragging);
    this.dragging = null;
    this.frozen = false;
    if (f) this.bounce(f);
  }
}

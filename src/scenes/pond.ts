// 이야기 우물 헤엄 모델 (§5.21, D-065). 화면 전용 — Phaser 의존 없음, core 상태는 읽기만 한다.
// 조각마다 화면 위치(px)를 따로 가진다 (core의 칸 번호와 별개, piece.id로 묶음). core 규칙·시뮬·저장은 그대로:
// 합치기는 놓은 곳 반지름 MERGE_RADIUS 안의 "core가 머지로 판정하는"(resolveDrop) 조각에만, core에는 기존 drop(칸 A, 칸 B)으로 전달.
// 판을 누르는 동안(frozen) 아무도 움직이지 않고, 끄는 조각만 손가락을 따라간다.
// 아래 헤엄 수치는 화면 연출 값이라 layout.ts와 같이 코드에 둔다 (게임 밸런스 수치가 아님, balance.json 대상 아님).

import { isWildcard, resolveDrop, type DropKind, type Grid, type Piece } from '../core/grid';
import { MERGE_RADIUS, WELL, WELL_TOKEN_R, wellDistance } from './layout';

/** 헤엄 속도 범위 (px/s) */
const SPEED_MIN = 8;
const SPEED_MAX = 14;
/** 방향을 살짝 바꾸는 주기 (초) · 한 번에 바꾸는 최대 각 (rad) */
const TURN_MIN = 2;
const TURN_MAX = 4;
const TURN_ANGLE = 0.6;
/** 원하는 속도로 맞춰 가는 빠르기 (1/s) · 최고 속도 (끌림이 더해져도) */
const STEER = 1.5;
const SPEED_CAP = 24;
/** 같은 조각끼리 끌림 (§5.21-4): 거리 안 · 가속 (px/s²). 와일드카드는 모든 조각에 약하게 */
export const ATTRACT_RANGE = 120;
export const ATTRACT_ACCEL = 4;
export const WILD_ACCEL = 2;
/** 자동 뭉침 단계(autoMergeMaxTier 이하) 같은 조각끼리는 더 세게 끌림 (D-070) — 판정은 core, 이건 보기만 */
export const AUTO_ATTRACT_ACCEL = 14;
/** 조각끼리 밀어냄: 이 간격까지 겹치지 않게 */
const GAP = 2;
/** 가장자리: 이만큼 안쪽부터 부드럽게 안으로 밀고, 닿으면 튕김 (감쇠) */
const EDGE_SOFT = 12;
const EDGE_PUSH = 30;
const BOUNCE = 0.8;

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
  speed: number;
  /** 다음 방향 바꿈까지 (초) */
  turnIn: number;
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
          if (f.tier !== tier || f.chain !== p.chain) changed.push(f);
          Object.assign(f, { cell, tier, chain: p.chain, wild: isWildcard(p) });
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
    const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * this.rng();
    return {
      id: p.id,
      cell,
      chain: p.chain,
      tier: p.tier,
      wild: isWildcard(p),
      x,
      y,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      heading,
      speed,
      turnIn: TURN_MIN + (TURN_MAX - TURN_MIN) * this.rng(),
      hold: 0,
    };
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

  /** 두 조각이 서로 끌리는 가속 (0이면 없음): 같은 체인·단계(최고 단계 아님) 4 / 와일드카드 ↔ 아무 조각 2 */
  attraction(a: Fish, b: Fish, maxTier: number, autoMax = 0): number {
    if (a.wild && b.wild) return 0;
    if (a.wild || b.wild) return (a.wild ? b.tier : a.tier) < maxTier ? WILD_ACCEL : 0;
    if (a.chain !== b.chain || a.tier !== b.tier || a.tier >= maxTier) return 0;
    return a.tier <= autoMax ? AUTO_ATTRACT_ACCEL : ATTRACT_ACCEL;
  }

  /** 한 프레임. 누르는 동안(frozen)은 아무것도 움직이지 않는다. core 상태는 읽지도 쓰지도 않는다 */
  step(dt: number, maxTier: number, autoMax = 0): void {
    if (this.frozen || dt <= 0) return;
    const list = [...this.fish.values()];
    const r = this.r;
    for (const f of list) {
      if (f.id === this.dragging) continue;
      if (f.hold > 0) {
        f.hold = Math.max(0, f.hold - dt);
        continue;
      }
      // 방향을 가끔 살짝
      f.turnIn -= dt;
      if (f.turnIn <= 0) {
        f.heading += (this.rng() * 2 - 1) * TURN_ANGLE;
        f.speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * this.rng();
        f.turnIn = TURN_MIN + (TURN_MAX - TURN_MIN) * this.rng();
      }
      const k = Math.min(1, STEER * dt);
      f.vx += (Math.cos(f.heading) * f.speed - f.vx) * k;
      f.vy += (Math.sin(f.heading) * f.speed - f.vy) * k;
      // 같은 조각끼리 약한 끌림
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
      // 가장자리: 부드럽게 안으로
      const n = this.inward(f.x, f.y);
      const dist = wellDistance(f.x, f.y);
      if (dist > -(r + EDGE_SOFT)) {
        const t = Math.min(1, (dist + r + EDGE_SOFT) / EDGE_SOFT);
        f.vx += n.x * EDGE_PUSH * t * dt;
        f.vy += n.y * EDGE_PUSH * t * dt;
      }
      const sp = Math.hypot(f.vx, f.vy);
      if (sp > SPEED_CAP) {
        f.vx *= SPEED_CAP / sp;
        f.vy *= SPEED_CAP / sp;
      }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      this.bounce(f);
    }
    this.separate(list);
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

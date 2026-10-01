// 화면 레이아웃 좌표 (논리 해상도 360×640, 스펙 v0.8 §5.11-2, D-027).
// 화면 좌표는 이 파일에만 둔다 (balance.json에 넣지 않음).
//
//  0 ┌ HUD ─────────────────────────┐
// 36 ├ 하늘 띠: 해/달 궤적 ───────────┤
//136 ├ 땅 띠: 가로 레인 하나 ─────────┤  우리 편 왼쪽, 적 오른쪽. 낮 = 방어 레인, 밤 = 심연 레인
//376 ├ 포탈 받침  (☀ 창문)(◐ 손거울) ─┤
//424 ├ 머지 그리드 (4행) ─────────────┤
//584 ├ 하단 바 ──────────────────────┤
//640 └──────────────────────────────┘
//
// core 좌표는 바꾸지 않는다 (v0.7까지의 세로 레인 좌표 그대로: 진행 축 y + 표시용 옆 축 x).
// 화면은 toScreen()으로 변환: 진행 축 → screenX (core y가 큰 쪽 = 거점 = 화면 왼쪽), 옆 축 → screenY.

import type { GameGeometry } from '../core/game';
import type { AbyssGeometry, LaneGeometry } from '../core/lane';

export const VIEW_W = 360;
export const VIEW_H = 640;
/** 폰 고해상도 화면에서 글자가 흐려지지 않도록 내부 캔버스를 배율로 키운다. 좌표계는 논리 해상도 그대로. */
export const RENDER_SCALE = 2;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HUD_H = 36;
const SKY_BOTTOM = 136;
const GROUND_BOTTOM = 376;

export const REGION = {
  hud: { x: 0, y: 0, w: VIEW_W, h: HUD_H },
  /** 하늘 띠: 해(낮)·달(밤)이 왼쪽에서 떠서 오른쪽으로 진다 */
  sky: { x: 0, y: HUD_H, w: VIEW_W, h: SKY_BOTTOM - HUD_H },
  /** 땅 띠: 레인 하나 (낮 = 방어, 밤 = 심연). 드롭하면 그 단계의 포탈 */
  ground: { x: 0, y: SKY_BOTTOM, w: VIEW_W, h: GROUND_BOTTOM - SKY_BOTTOM },
  portalBase: { x: 0, y: GROUND_BOTTOM, w: VIEW_W, h: 48 },
  grid: { x: 0, y: 424, w: VIEW_W, h: 160 },
  bottomBar: { x: 0, y: 584, w: VIEW_W, h: 56 },
  /** 디버그 패널이 펼쳐지는 자리 (하늘·땅 왼쪽 절반) */
  debugPanel: { x: 0, y: HUD_H, w: 176, h: GROUND_BOTTOM - HUD_H },
} as const satisfies Record<string, Rect>;

// ── 포탈 (D-018): 받침 가운데에 나란히. 그리드 밖, 그리드 양 끝이 아님 ──
export type PortalId = 'happy' | 'unhappy';
export const PORTAL_RADIUS = 24; // 지름 48
/** 드롭 판정 반경 (스펙 §4.2 portalHitRadius) */
export const PORTAL_HIT_RADIUS = 40;
const PORTAL_OFFSET_X = 44; // 화면 중심에서 좌우 거리 (판정 원이 서로 겹치지 않는 값)
const PORTAL_Y = REGION.portalBase.y + REGION.portalBase.h / 2;
export const PORTAL: Record<PortalId, { x: number; y: number }> = {
  happy: { x: VIEW_W / 2 - PORTAL_OFFSET_X, y: PORTAL_Y }, // ☀ 창문
  unhappy: { x: VIEW_W / 2 + PORTAL_OFFSET_X, y: PORTAL_Y }, // ◐ 손거울
};

/** 맡긴 추억 줄 (손거울 오른쪽, laneCap칸) */
export const PARTY_ROW = { x: PORTAL.unhappy.x + PORTAL_RADIUS + 8, y: PORTAL_Y, cell: 12, gap: 3 };

// ── core 좌표 (v0.7 세로 레인 그대로. 바꾸면 core·시뮬 결과가 달라진다) ──
const CORE_TOP = 36;
const CORE_BOTTOM = 376;
const CORE_LANE_W = 176;
/** 심연 레인의 core x 시작 (v0.7 화면에서 거울 오른쪽) */
const CORE_ABYSS_X = 184;
const CORE_PORTAL_HAPPY_X = 136;
const CORE_PORTAL_UNHAPPY_X = 224;
export const CORE = {
  top: CORE_TOP,
  bottom: CORE_BOTTOM,
  /** Happy·Unhappy가 서는 진행 축 위치 */
  homeY: CORE_BOTTOM - 14,
  /** 방어 레인: 걱정이 멈추고 방어 유닛이 서는 선 */
  lineY: CORE_BOTTOM - 28,
  /** 방어 레인: 걱정 등장 */
  spawnY: CORE_TOP + 8,
  /** 방어선 이만큼 지나면 가라앉음 */
  sinkMargin: 16,
  /** 걱정 등장 옆 축 여백 */
  worryXMargin: 12,
  /** 그림자 벽 두께 (진행 축). 벽 아래 변 = wallY */
  wallH: 16,
  wallY: CORE_TOP + 16,
  /** Happy의 옆 축 위치 (v0.7 창문 x) */
  happyX: CORE_PORTAL_HAPPY_X,
  /** Unhappy의 옆 축 위치 (v0.7 손거울 x) */
  unhappyX: CORE_PORTAL_UNHAPPY_X,
} as const;

/**
 * 레인 슬롯 x: 레인 폭을 (laneCap + 1)칸으로 균등 분할한 중심 중 캐릭터 자리에 가장 가까운 하나를 뺀다.
 */
function laneSlotXs(laneX: number, avoidX: number, laneCap: number): number[] {
  const step = CORE_LANE_W / (laneCap + 1);
  const xs = Array.from({ length: laneCap + 1 }, (_, i) => laneX + step * (i + 0.5));
  let idx = 0;
  xs.forEach((sx, i) => {
    if (Math.abs(sx - avoidX) < Math.abs(xs[idx] - avoidX)) idx = i;
  });
  xs.splice(idx, 1);
  return xs;
}

/** core/lane.ts의 LaneGeometry (import type만 쓰므로 core 의존은 타입뿐) */
export function defenseGeometry(laneCap: number): LaneGeometry {
  return {
    spawnY: CORE.spawnY,
    lineY: CORE.lineY,
    sinkY: CORE.lineY + CORE.sinkMargin,
    spawnXMin: CORE.worryXMargin,
    spawnXMax: CORE_LANE_W - CORE.worryXMargin,
    centerX: CORE_LANE_W / 2,
    slotXs: laneSlotXs(0, CORE.happyX, laneCap),
    happyX: CORE.happyX,
  };
}

/** core/lane.ts의 AbyssGeometry: 출발선 → 그림자 벽 아래 변 */
export function abyssGeometry(laneCap: number): AbyssGeometry {
  return {
    startY: CORE.lineY,
    wallY: CORE.wallY,
    centerX: CORE_ABYSS_X + CORE_LANE_W / 2,
    slotXs: laneSlotXs(CORE_ABYSS_X, CORE.unhappyX, laneCap),
  };
}

/** GameState에 넘기는 두 레인 좌표 */
export function gameGeometry(laneCap: number): GameGeometry {
  return { defense: defenseGeometry(laneCap), abyss: abyssGeometry(laneCap) };
}

// ── core 좌표 → 화면 (§5.11-2) ──
export type LaneKind = 'defense' | 'abyss';
/** 땅 띠 안의 레인 표시 영역 (옆 축 위아래 여백) */
const LANE_PAD_Y = 16;
const LANE_LEFT = REGION.ground.x;
const LANE_RIGHT = REGION.ground.x + REGION.ground.w;
/** 진행 축 배율: core 레인 길이(top~bottom) → 화면 너비 */
export const PROGRESS_SCALE = (LANE_RIGHT - LANE_LEFT) / (CORE_BOTTOM - CORE_TOP);
/** 옆 축 배율: core 레인 폭 → 땅 띠 높이(여백 제외) */
export const LATERAL_SCALE = (REGION.ground.h - LANE_PAD_Y * 2) / CORE_LANE_W;

const laneX0 = (kind: LaneKind) => (kind === 'defense' ? 0 : CORE_ABYSS_X);

/** core (x = 옆 축, y = 진행 축) → 화면. 두 레인 모두 core y가 큰 쪽(거점)이 화면 왼쪽 */
export function toScreen(kind: LaneKind, x: number, y: number): { x: number; y: number } {
  return {
    x: LANE_LEFT + (CORE_BOTTOM - y) * PROGRESS_SCALE,
    y: REGION.ground.y + LANE_PAD_Y + (x - laneX0(kind)) * LATERAL_SCALE,
  };
}

/** 화면 → core (toScreen의 역) */
export function fromScreen(kind: LaneKind, sx: number, sy: number): { x: number; y: number } {
  return {
    x: laneX0(kind) + (sy - REGION.ground.y - LANE_PAD_Y) / LATERAL_SCALE,
    y: CORE_BOTTOM - (sx - LANE_LEFT) / PROGRESS_SCALE,
  };
}

/** 화면 x: 진행 축 값 하나만 (선·벽) */
export function progressX(y: number): number {
  return LANE_LEFT + (CORE_BOTTOM - y) * PROGRESS_SCALE;
}

/** Happy·Unhappy 자리 (화면) */
export const HOME: Record<LaneKind, { x: number; y: number }> = {
  defense: toScreen('defense', CORE.happyX, CORE.homeY),
  abyss: toScreen('abyss', CORE.unhappyX, CORE.homeY),
};

// ── 하늘 띠: 해/달 궤적 ──
/** p ∈ [0, 1] (뜸 → 짐) → 하늘 띠 안의 호 위 점 */
export function skyArc(p: number): { x: number; y: number } {
  const t = Math.max(0, Math.min(1, p));
  const r = REGION.sky;
  const margin = 18;
  return {
    x: r.x + margin + t * (r.w - margin * 2),
    y: r.y + r.h - 14 - Math.sin(Math.PI * t) * (r.h - 34),
  };
}

// ── 그리드 ──
export const CELL_W = 52;
export const CELL_H = 40;

export interface GridLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  cellW: number;
  cellH: number;
}

/** 그리드 영역 안에서 가로·세로 가운데 정렬 */
export function gridLayout(cols: number, rows: number): GridLayout {
  const width = cols * CELL_W;
  const height = rows * CELL_H;
  return {
    x: REGION.grid.x + Math.round((REGION.grid.w - width) / 2),
    y: REGION.grid.y + Math.round((REGION.grid.h - height) / 2),
    width,
    height,
    cellW: CELL_W,
    cellH: CELL_H,
  };
}

/** 좌표 → 그리드 칸 인덱스. 칸 밖이면 null */
export function cellAt(cols: number, rows: number, x: number, y: number): number | null {
  const l = gridLayout(cols, rows);
  const col = Math.floor((x - l.x) / l.cellW);
  const row = Math.floor((y - l.y) / l.cellH);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return row * cols + col;
}

/** 칸 중심 좌표 */
export function cellCenter(cols: number, rows: number, index: number): { x: number; y: number } {
  const l = gridLayout(cols, rows);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: l.x + col * l.cellW + l.cellW / 2, y: l.y + row * l.cellH + l.cellH / 2 };
}

/** 드래그 시작 임계값 (논리 px). 미만 이동은 탭 */
export const DRAG_THRESHOLD = 6;

/** 그리드가 영역 안에 들어가는지 (폰에서 칸 최소 40×40) */
export function gridFits(cols: number, rows: number): boolean {
  return cols * CELL_W <= REGION.grid.w && rows * CELL_H <= REGION.grid.h && CELL_W >= 40 && CELL_H >= 40;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ── 놓아주기 영역 (v0.3.2, D-019): 하단 바의 [놓아주기] 자리 ──
/** 표시 사각형 */
export const RELEASE_ZONE: Rect = { x: 122, y: REGION.bottomBar.y + 11, w: 76, h: 34 };
/** 판정은 표시보다 상하좌우 이만큼 넓게 */
export const RELEASE_ZONE_PAD = 6;
export const RELEASE_HIT: Rect = {
  x: RELEASE_ZONE.x - RELEASE_ZONE_PAD,
  y: RELEASE_ZONE.y - RELEASE_ZONE_PAD,
  w: RELEASE_ZONE.w + RELEASE_ZONE_PAD * 2,
  h: RELEASE_ZONE.h + RELEASE_ZONE_PAD * 2,
};

export type DropTarget =
  | { kind: 'cell'; index: number }
  | { kind: 'release' }
  | { kind: 'summon'; portal: PortalId }
  | { kind: 'none' };

/**
 * 드롭 위치 → 대상 (스펙 §4.1.1, §4.2 "판정은 넓게", §5.11-2).
 * 우선순위: 그리드 칸 → 놓아주기 영역 → 포탈 판정 원(가까운 쪽) → 땅 띠 전체 = 그 단계의 포탈(낮 창문 / 밤 손거울) → 무효.
 * groundPortal: 지금 단계에서 땅 띠가 맡는 포탈 (낮·밤이 아니면 null)
 */
export function dropTarget(size: { cols: number; rows: number }, x: number, y: number, groundPortal: PortalId | null = null): DropTarget {
  const index = cellAt(size.cols, size.rows, x, y);
  if (index !== null) return { kind: 'cell', index };
  if (inRect(RELEASE_HIT, x, y)) return { kind: 'release' };
  let best: PortalId | null = null;
  let bestDist = PORTAL_HIT_RADIUS;
  for (const id of ['happy', 'unhappy'] as const) {
    const d = Math.hypot(x - PORTAL[id].x, y - PORTAL[id].y);
    if (d <= bestDist) {
      best = id;
      bestDist = d;
    }
  }
  if (best) return { kind: 'summon', portal: best };
  if (groundPortal && inRect(REGION.ground, x, y)) return { kind: 'summon', portal: groundPortal };
  return { kind: 'none' };
}

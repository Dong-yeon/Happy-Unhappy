// 화면 레이아웃 좌표 (논리 해상도 360×640, 스펙 v0.3 §3 "화면", D-017·D-018).
// 화면 좌표는 이 파일에만 둔다 (balance.json에 넣지 않음).
//
//  0 ┌ HUD ─────────────────────────┐
// 36 ├ 방어 레인 ┃거울┃ 심연 레인 ──────┤  왼쪽 = 양(Happy), 오른쪽 = 음(Unhappy)
//376 ├ 포탈 받침  (☀ 창문)(◐ 손거울) ─┤  포탈은 레인 바닥과 그리드 윗변에 걸침
//424 ├ 머지 그리드 (4행) ─────────────┤
//584 ├ 하단 바 ──────────────────────┤
//640 └──────────────────────────────┘

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

const LANE_TOP = 36;
const LANE_BOTTOM = 376;
const MIRROR_W = 8;
const MIRROR_X = (VIEW_W - MIRROR_W) / 2; // 176

export const REGION = {
  hud: { x: 0, y: 0, w: VIEW_W, h: LANE_TOP },
  defenseLane: { x: 0, y: LANE_TOP, w: MIRROR_X, h: LANE_BOTTOM - LANE_TOP },
  mirror: { x: MIRROR_X, y: LANE_TOP, w: MIRROR_W, h: LANE_BOTTOM - LANE_TOP },
  abyssLane: { x: MIRROR_X + MIRROR_W, y: LANE_TOP, w: VIEW_W - MIRROR_X - MIRROR_W, h: LANE_BOTTOM - LANE_TOP },
  portalBase: { x: 0, y: LANE_BOTTOM, w: VIEW_W, h: 48 },
  grid: { x: 0, y: 424, w: VIEW_W, h: 160 },
  bottomBar: { x: 0, y: 584, w: VIEW_W, h: 56 },
} as const satisfies Record<string, Rect>;

// ── 포탈 (D-018): 거울 받침 가운데에 나란히. 그리드 밖, 그리드 양 끝이 아님 ──
export type PortalId = 'happy' | 'unhappy';
export const PORTAL_RADIUS = 24; // 지름 48
/** 드롭 판정 반경 (스펙 §4.2 portalHitRadius) */
export const PORTAL_HIT_RADIUS = 40;
const PORTAL_OFFSET_X = 44; // 거울 중심에서 좌우 거리. 판정 원이 거울에 닿지 않고 서로 겹치지 않는 값
const PORTAL_Y = REGION.portalBase.y + REGION.portalBase.h / 2;
export const PORTAL: Record<PortalId, { x: number; y: number }> = {
  happy: { x: VIEW_W / 2 - PORTAL_OFFSET_X, y: PORTAL_Y }, // ☀ 창문
  unhappy: { x: VIEW_W / 2 + PORTAL_OFFSET_X, y: PORTAL_Y }, // ◐ 손거울
};

// ── 레인 안의 기준선. 두 레인 모두 거점은 아래(그리드 쪽) ──
/** Happy·Unhappy가 서는 y (각자의 포탈 바로 위) */
export const HOME_Y = LANE_BOTTOM - 14;
/** 방어 레인: 걱정이 멈추고 방어 유닛이 서는 선 */
export const DEFENSE_LINE_Y = LANE_BOTTOM - 28;
/** 방어 레인: 걱정 등장 y */
export const WORRY_SPAWN_Y = LANE_TOP + 8;
/** 심연 레인: 추억 유닛 출발 y (방어선과 거울 대칭) */
export const ABYSS_START_Y = DEFENSE_LINE_Y;
/** 심연 레인: 그림자 벽 (레인 위쪽 끝) */
export const SHADOW_WALL: Rect = { x: REGION.abyssLane.x, y: LANE_TOP, w: REGION.abyssLane.w, h: 16 };

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

/** 그리드가 영역 안에 들어가는지 (폰에서 칸 최소 40×40) */
export function gridFits(cols: number, rows: number): boolean {
  return cols * CELL_W <= REGION.grid.w && rows * CELL_H <= REGION.grid.h && CELL_W >= 40 && CELL_H >= 40;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/**
 * 드롭 위치 → 보낼 대상 (스펙 §4.2 "판정은 넓게").
 * 우선순위: 그리드 안(무효, 머지·교환용) → 포탈 판정 원(가까운 쪽) → 해당 레인 전체 → 그 외 무효.
 */
export function dropTarget(x: number, y: number): PortalId | null {
  if (inRect(REGION.grid, x, y)) return null;
  let best: PortalId | null = null;
  let bestDist = PORTAL_HIT_RADIUS;
  for (const id of ['happy', 'unhappy'] as const) {
    const d = Math.hypot(x - PORTAL[id].x, y - PORTAL[id].y);
    if (d <= bestDist) {
      best = id;
      bestDist = d;
    }
  }
  if (best) return best;
  if (inRect(REGION.defenseLane, x, y)) return 'happy';
  if (inRect(REGION.abyssLane, x, y)) return 'unhappy';
  return null;
}

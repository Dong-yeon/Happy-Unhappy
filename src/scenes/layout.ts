// 화면 레이아웃 좌표 (논리 해상도 360×640, 스펙 §5.20-13 화면 배치 표, 목업 layout-proposal.html v2).
// 화면 좌표는 이 파일에만 둔다 (balance.json에 넣지 않음).
//
//  0 ┌ HUD: 스테이지명·시도 / 해·달 아이콘·남은 시간·잉크 / [자동] [편성] [책] ┐
// 32 ├ 해·달 진행선 (4px 막대) ─────────────────────┤
// 36 ├ 전장: 가로 레인 하나 (유닛·적·guardian·씨앗은 36~382) ┤  우리 편(이야기책) 왼쪽, 적·guardian 오른쪽
//382 ├ 초상 선반 (전장 배경 위 어두운 띠): 왼쪽 "1팀 출격" / 오른쪽 지금 팀 초상 3개 ┤
//430 ├ 이야기 우물 (§5.21, 높이 210): 조각이 헤엄친다. 오른쪽 아래 안쪽 모서리에 🍃 놓아주기 원 ┤
//640 └───────────────────────────────────────────┘
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

const HUD_H = 32;
const SKY_BOTTOM = 36;
/** 유닛·적이 서는 화면 y 범위 끝 (그 아래는 초상 선반) */
const LANE_BOTTOM = 382;
const GROUND_BOTTOM = 430;
const BOARD_BOTTOM = VIEW_H;

export const REGION = {
  hud: { x: 0, y: 0, w: VIEW_W, h: HUD_H },
  /** 해·달 진행선: 4px 막대 (해 = 낮 남은 시간, 달 = 밤 웨이브 진행). 아이콘은 HUD 오른쪽 */
  sky: { x: 0, y: HUD_H, w: VIEW_W, h: SKY_BOTTOM - HUD_H },
  /** 전장 배경 (레인 + 초상 선반 뒤까지) */
  ground: { x: 0, y: SKY_BOTTOM, w: VIEW_W, h: GROUND_BOTTOM - SKY_BOTTOM },
  /** 유닛·적·guardian·씨앗이 서는 화면 범위 (toScreen 옆 축이 여기로) */
  lane: { x: 0, y: SKY_BOTTOM, w: VIEW_W, h: LANE_BOTTOM - SKY_BOTTOM },
  /** 초상 선반: 전장 배경 위 살짝 어두운 띠 */
  shelf: { x: 0, y: LANE_BOTTOM, w: VIEW_W, h: GROUND_BOTTOM - LANE_BOTTOM },
  /** 이야기 우물 */
  board: { x: 0, y: GROUND_BOTTOM, w: VIEW_W, h: BOARD_BOTTOM - GROUND_BOTTOM },
  /** 디버그 패널이 펼쳐지는 자리 (전장 왼쪽 절반) */
  debugPanel: { x: 0, y: HUD_H, w: 176, h: LANE_BOTTOM - HUD_H },
} as const satisfies Record<string, Rect>;

// ── 이야기 우물 (§5.21-1): 머지 판 안의 둥근 테 우물. 조각은 이 안(테 안쪽)에서 헤엄친다. 자리(칸)는 core에만 있고 화면엔 없다 ──
/** 우물 물 영역 (모서리를 크게 둥글린 사각형) + 돌테 두께 */
export const WELL = { x: 8, y: REGION.board.y + 6, w: VIEW_W - 16, h: REGION.board.h - 10, r: 44, rim: 4 } as const;
/** 우물 안 조각 반지름 */
export const WELL_TOKEN_R = 21;
/** 놓은 곳에서 이 반지름 안의 같은 조각과 합쳐진다 (§5.21-3) */
export const MERGE_RADIUS = 30;

/** 점이 우물 물 영역 안인지 (inset만큼 안쪽으로 줄인 둥근 사각형) */
export function inWell(x: number, y: number, inset = 0): boolean {
  return wellDistance(x, y) <= -inset;
}

/** 둥근 사각형 우물 테두리까지의 부호 거리 (안쪽 음수). 가장자리 튕김·안쪽 방향 계산용 */
export function wellDistance(x: number, y: number): number {
  const hw = WELL.w / 2;
  const hh = WELL.h / 2;
  const qx = Math.abs(x - (WELL.x + hw)) - (hw - WELL.r);
  const qy = Math.abs(y - (WELL.y + hh)) - (hh - WELL.r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - WELL.r;
}

// ── 초상 선반 (전장 아래 띠): 지금 팀 초상 = 스킬 버튼. 오른쪽 정렬 (지름 40, 간격 8, 오른쪽 여백 8). 둘레 = 스킬 게이지 ──
export const SKILL_BTN_R = 20;
const SKILL_BTN_GAP = 8;
const SKILL_BTN_RIGHT = 8;
/** i번째(0 = 앞) 초상 중심. 팀 인원 n — 오른쪽 끝에 붙여 오른쪽부터 채운다 (n과 상관없이 마지막 영웅이 오른쪽 끝) */
export function skillButtonCenter(i: number, n: number): { x: number; y: number } {
  const step = SKILL_BTN_R * 2 + SKILL_BTN_GAP;
  return { x: VIEW_W - SKILL_BTN_RIGHT - SKILL_BTN_R - (n - 1 - i) * step, y: REGION.shelf.y + 1 + SKILL_BTN_R };
}

// ── core 좌표 (v0.7 세로 레인 그대로. 바꾸면 core·시뮬 결과가 달라진다) ──
// 레인 슬롯 수는 영웅 1 + soldierCap (gameGeometry 인자)
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
  // wallY = guardian 서 있는 위치 (옛 그림자 벽 이름, D-053 이후 벽 없음)
  wallY: CORE_TOP + 16,
  /** Happy의 옆 축 위치 (v0.7 창문 x) */
  happyX: CORE_PORTAL_HAPPY_X,
  /** Unhappy의 옆 축 위치 (v0.7 손거울 x) */
  unhappyX: CORE_PORTAL_UNHAPPY_X,
} as const;

/**
 * 레인 슬롯 x: 레인 폭을 (슬롯 수 + 1)칸으로 균등 분할한 중심 중 거점 자리에 가장 가까운 하나를 뺀다.
 */
function laneSlotXs(laneX: number, avoidX: number, slots: number): number[] {
  const step = CORE_LANE_W / (slots + 1);
  const xs = Array.from({ length: slots + 1 }, (_, i) => laneX + step * (i + 0.5));
  let idx = 0;
  xs.forEach((sx, i) => {
    if (Math.abs(sx - avoidX) < Math.abs(xs[idx] - avoidX)) idx = i;
  });
  xs.splice(idx, 1);
  return xs;
}

/** core/lane.ts의 LaneGeometry (import type만 쓰므로 core 의존은 타입뿐) */
export function defenseGeometry(slots: number): LaneGeometry {
  return {
    spawnY: CORE.spawnY,
    lineY: CORE.lineY,
    sinkY: CORE.lineY + CORE.sinkMargin,
    spawnXMin: CORE.worryXMargin,
    spawnXMax: CORE_LANE_W - CORE.worryXMargin,
    centerX: CORE_LANE_W / 2,
    slotXs: laneSlotXs(0, CORE.happyX, slots),
    happyX: CORE.happyX,
  };
}

/** core/lane.ts의 AbyssGeometry: 출발선 → 그림자 벽 아래 변 */
export function abyssGeometry(slots: number): AbyssGeometry {
  return {
    startY: CORE.lineY,
    wallY: CORE.wallY,
    centerX: CORE_ABYSS_X + CORE_LANE_W / 2,
    slotXs: laneSlotXs(CORE_ABYSS_X, CORE.unhappyX, slots),
  };
}

/** GameState에 넘기는 두 레인 좌표 */
export function gameGeometry(slots: number): GameGeometry {
  return { defense: defenseGeometry(slots), abyss: abyssGeometry(slots) };
}

// ── core 좌표 → 화면 (§5.11-2) ──
export type LaneKind = 'defense' | 'abyss';
/** 땅 띠 안의 레인 표시 영역 (옆 축 위아래 여백) */
const LANE_PAD_Y = 16;
const LANE_LEFT = REGION.lane.x;
const LANE_RIGHT = REGION.lane.x + REGION.lane.w;
/** 진행 축 배율: core 레인 길이(top~bottom) → 화면 너비 */
export const PROGRESS_SCALE = (LANE_RIGHT - LANE_LEFT) / (CORE_BOTTOM - CORE_TOP);
/** 옆 축 배율: core 레인 폭 → 땅 띠 높이(여백 제외) */
export const LATERAL_SCALE = (REGION.lane.h - LANE_PAD_Y * 2) / CORE_LANE_W;

const laneX0 = (kind: LaneKind) => (kind === 'defense' ? 0 : CORE_ABYSS_X);

/** core (x = 옆 축, y = 진행 축) → 화면. 두 레인 모두 core y가 큰 쪽(거점)이 화면 왼쪽 */
export function toScreen(kind: LaneKind, x: number, y: number): { x: number; y: number } {
  return {
    x: LANE_LEFT + (CORE_BOTTOM - y) * PROGRESS_SCALE,
    y: REGION.lane.y + LANE_PAD_Y + (x - laneX0(kind)) * LATERAL_SCALE,
  };
}

/** 화면 → core (toScreen의 역) */
export function fromScreen(kind: LaneKind, sx: number, sy: number): { x: number; y: number } {
  return {
    x: laneX0(kind) + (sy - REGION.lane.y - LANE_PAD_Y) / LATERAL_SCALE,
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

// ── 해·달 진행선 (4px 막대) ──
/** p ∈ [0, 1] (뜸 → 짐) → 진행선 위 점 (막대가 차오른 끝) */
export function skyArc(p: number): { x: number; y: number } {
  const t = Math.max(0, Math.min(1, p));
  const r = REGION.sky;
  return { x: r.x + t * r.w, y: r.y + r.h / 2 };
}
/** HUD 오른쪽 해·달 아이콘 자리 ([자동] 왼쪽, 위 줄) */
export const SKY_ICON = { x: 168, y: 9, r: 5 } as const;

// ── 머지 판 (§5.20-13): 칸 테두리 없이 자리(빈 자리 = 작은 점) + 원형 조각 ──
/** 자리 간격 (가로·세로, 목업 56+10 / 52+6). 열이 많으면 판 폭에 맞춰 줄인다 */
const SLOT_PITCH_X = 64;
const SLOT_PITCH_Y = 58;
/** 판 위쪽 여백 (옛 칸 판정용, 지금 판은 우물 헤엄) */
const BOARD_TOP_PAD = 4;
const BOARD_SIDE_PAD = 8;
/** 원형 조각 최대 반지름 / 드롭 판정 원 반지름 (자리 중심 기준) */
export const TOKEN_R = 24;
export const DROP_R = 26;

export interface GridLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 자리 간격 */
  cellW: number;
  cellH: number;
  /** 이 판의 원형 조각 반지름 */
  tokenR: number;
}

/** 머지 판 안에서 가로 가운데, 위쪽은 스킬 버튼 아래부터 */
export function gridLayout(cols: number, rows: number): GridLayout {
  const b = REGION.board;
  const cellW = Math.min(SLOT_PITCH_X, (b.w - BOARD_SIDE_PAD * 2) / cols);
  const cellH = Math.min(SLOT_PITCH_Y, (b.h - BOARD_TOP_PAD - 4) / rows);
  const width = cols * cellW;
  const height = rows * cellH;
  return {
    x: b.x + Math.round((b.w - width) / 2),
    y: b.y + BOARD_TOP_PAD,
    width,
    height,
    cellW,
    cellH,
    tokenR: Math.min(TOKEN_R, cellW / 2 - 4, cellH / 2 - 3),
  };
}

/** 좌표 → 자리 인덱스: 가장 가까운 자리 중심에서 DROP_R 안이면 그 자리, 아니면 null */
export function cellAt(cols: number, rows: number, x: number, y: number): number | null {
  if (inRelease(x, y)) return null; // 놓아주기 원 위는 칸이 아니다
  const l = gridLayout(cols, rows);
  const col = Math.floor((x - l.x) / l.cellW);
  const row = Math.floor((y - l.y) / l.cellH);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  const c = cellCenter(cols, rows, row * cols + col);
  return Math.hypot(x - c.x, y - c.y) <= DROP_R ? row * cols + col : null;
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

/** 판이 영역 안에 들어가는지 (폰에서 원형 조각 지름 최소 40) */
export function gridFits(cols: number, rows: number): boolean {
  return gridLayout(cols, rows).tokenR * 2 >= 40;
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ── 놓아주기 (D-019): 우물 안쪽 오른쪽 아래 모서리의 🍃 잎사귀 원 (지름 40, 판정 반경 28). 초상 선반과 겹치지 않는 아래쪽 ──
export const RELEASE = { x: WELL.x + WELL.w - 34, y: WELL.y + WELL.h - 34, r: 20, hitR: 28 } as const;

/** 놓아주기 원 판정 안인지 */
export function inRelease(x: number, y: number): boolean {
  return Math.hypot(x - RELEASE.x, y - RELEASE.y) <= RELEASE.hitR;
}

export type DropTarget = { kind: 'cell'; index: number } | { kind: 'release' } | { kind: 'none' };

/** 드롭 위치 → 대상 (스펙 §4.1.1). 우선순위: 자리(중심 원, §5.20-13) → 놓아주기 영역 → 무효 (먹이기 슬롯은 §5.20에서 삭제) */
export function dropTarget(size: { cols: number; rows: number }, x: number, y: number): DropTarget {
  const index = cellAt(size.cols, size.rows, x, y);
  if (index !== null) return { kind: 'cell', index };
  if (inRelease(x, y)) return { kind: 'release' };
  return { kind: 'none' };
}

// ── 레인 유닛 표시 크기 (M9 스킨 후속, 표시만 — core 판정 범위는 그대로) ──
/** 일반 적(줄무늬 그림자) 한 마리 표시 지름 = 보스 배율의 기준 */
export const ENEMY_BASE_SIZE = 20;
/** 보스·guardian 표시 배율 (일반 적 크기 기준). 밤 보스 웨이브 적도 같은 배율. 팩 그림은 정수 배율로 내림, 도형은 반지름으로 */
export const BOSS_SCALE = { guardian: 1.5, mitten: 2, boss: 2.5 } as const;
/** 적 종류 → 보스 배율 (털장갑 손 ×2, 성난 호랑이 그림자 ×2.5, 그 밖의 guardian ×1.5) */
export function bossScale(type: string): number {
  return type === 'mitten' ? BOSS_SCALE.mitten : type === 'boss' ? BOSS_SCALE.boss : BOSS_SCALE.guardian;
}
/** 보스 HP 막대 (몸 위, 굵고 넓게) */
export const BOSS_HP = { w: 48, h: 5, gap: 5 } as const;
/** 보스 등장: 이 배율에서 1로 커짐 */
export const BOSS_POP = { from: 0.6, ms: 300 } as const;
/** 보스 이름 띠 중심 y (레인 위쪽 — 보스 몸·HP 막대와 겹치지 않게) */
export const NAME_BAND_Y = REGION.lane.y + 20;
/** 낮 guardian 몸 중심 y (레인 가운데보다 아래: 위쪽은 이름 띠·운반 막대 자리) */
export const GUARDIAN_Y = REGION.lane.y + REGION.lane.h * 0.6;
/** 그림(스킨) 영웅 표시 높이 / 병사는 영웅의 0.75배 */
export const HERO_PIC_SIZE = 32;
export const SOLDIER_PIC_SIZE = HERO_PIC_SIZE * 0.75;

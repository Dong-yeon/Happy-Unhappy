import { describe, expect, it } from 'vitest';
import balance from '../src/data/balance.json';

const SLOTS = balance.merge.soldierCap + 1;
import {
  CORE,
  HERO_SLOT,
  HERO_SLOT_PAD,
  HOME,
  REGION,
  RELEASE_HIT,
  RELEASE_ZONE,
  RELEASE_ZONE_PAD,
  VIEW_H,
  VIEW_W,
  cellAt,
  cellCenter,
  dropTarget,
  fromScreen,
  gameGeometry,
  gridFits,
  gridLayout,
  inRect,
  progressX,
  skyArc,
  toScreen,
  type DropTarget,
} from '../src/scenes/layout';

describe('레이아웃 영역 (v0.8 §5.11-2)', () => {
  it('세로: HUD → 하늘 띠 → 땅 띠 → 영웅 슬롯(구 포탈 받침) → 그리드 → 하단 바가 0~640을 빈틈없이 덮는다', () => {
    const rows = [REGION.hud, REGION.sky, REGION.ground, REGION.portalBase, REGION.grid, REGION.bottomBar];
    expect(rows[0].y).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].y).toBe(rows[i - 1].y + rows[i - 1].h);
    const last = rows[rows.length - 1];
    expect(last.y + last.h).toBe(VIEW_H);
    expect([REGION.sky.y, REGION.ground.y, REGION.portalBase.y]).toEqual([36, 136, 376]);
  });

  it('하늘·땅 띠는 화면 너비 전체 (레인 폭 360)', () => {
    for (const r of [REGION.sky, REGION.ground]) expect([r.x, r.w]).toEqual([0, VIEW_W]);
  });

  it('그리드는 4행(160px)이 들어가는 높이', () => {
    expect(REGION.grid.h).toBeGreaterThanOrEqual(4 * 40);
  });
});

describe('core 좌표는 v0.7 그대로 (§5.11-2 구현 원칙)', () => {
  it('레인 기하 수치 (core·테스트·시뮬이 쓰는 값)', () => {
    const g = gameGeometry(SLOTS);
    expect(g.defense).toMatchObject({ spawnY: 44, lineY: 348, sinkY: 364, spawnXMin: 12, spawnXMax: 164, centerX: 88, happyX: 136 });
    expect(g.abyss).toMatchObject({ startY: 348, wallY: 52, centerX: 272 });
    expect(g.defense.slotXs).toHaveLength(SLOTS);
    expect(g.abyss.slotXs).toHaveLength(SLOTS);
    expect(g.defense.slotXs.every((x) => x > 0 && x < 176)).toBe(true);
    expect(g.abyss.slotXs.every((x) => x > 184 && x < 360)).toBe(true);
  });

  it('balance.json에 화면 좌표가 없다 (v0.3에서 defenseLineY 삭제)', () => {
    expect('defenseLineY' in balance.lane).toBe(false);
  });
});

describe('core 좌표 → 화면 변환 (진행 축 → screenX, 옆 축 → screenY)', () => {
  const g = gameGeometry(SLOTS);

  it('왕복: fromScreen(toScreen(p)) = p (두 레인)', () => {
    for (const kind of ['defense', 'abyss'] as const) {
      const xs = kind === 'defense' ? [0, g.defense.centerX, ...g.defense.slotXs, 176] : [184, g.abyss.centerX, ...g.abyss.slotXs, 360];
      for (const x of xs) {
        for (const y of [CORE.top, g.defense.spawnY, 200, CORE.lineY, CORE.homeY, CORE.bottom]) {
          const s = toScreen(kind, x, y);
          const back = fromScreen(kind, s.x, s.y);
          expect(back.x).toBeCloseTo(x, 9);
          expect(back.y).toBeCloseTo(y, 9);
        }
      }
    }
  });

  it('우리 편은 왼쪽, 적은 오른쪽: 거점(core y 큼) → 화면 왼쪽, 걱정 등장·그림자 벽 → 오른쪽', () => {
    expect(toScreen('defense', 88, CORE.homeY).x).toBeLessThan(toScreen('defense', 88, CORE.lineY).x);
    expect(toScreen('defense', 88, g.defense.spawnY).x).toBeGreaterThan(VIEW_W * 0.9);
    expect(progressX(g.abyss.wallY)).toBeGreaterThan(VIEW_W * 0.9);
    expect(toScreen('defense', 88, CORE.bottom).x).toBe(REGION.ground.x);
    expect(toScreen('defense', 88, CORE.top).x).toBe(REGION.ground.x + REGION.ground.w);
    // 두 레인 같은 식: 같은 core y면 같은 screenX
    expect(toScreen('abyss', 272, 200).x).toBe(toScreen('defense', 88, 200).x);
  });

  it('옆 축은 땅 띠 안 (슬롯·걱정 등장 범위·거점이 전부 땅 띠 안)', () => {
    const pts = [
      ...g.defense.slotXs.map((x) => toScreen('defense', x, CORE.lineY)),
      toScreen('defense', g.defense.spawnXMin, g.defense.spawnY),
      toScreen('defense', g.defense.spawnXMax, g.defense.spawnY),
      ...g.abyss.slotXs.map((x) => toScreen('abyss', x, g.abyss.startY)),
      HOME.defense,
      HOME.abyss,
    ];
    for (const p of pts) expect(inRect(REGION.ground, p.x, p.y)).toBe(true);
  });

  it('해/달 궤적: 왼쪽에서 떠서 오른쪽으로 지고, 가운데가 가장 높다 (하늘 띠 안)', () => {
    const [a, m, b] = [skyArc(0), skyArc(0.5), skyArc(1)];
    expect(a.x).toBeLessThan(m.x);
    expect(m.x).toBeLessThan(b.x);
    expect(m.y).toBeLessThan(a.y);
    expect(a.y).toBeCloseTo(b.y, 9);
    for (const p of [a, m, b]) expect(inRect(REGION.sky, p.x, p.y)).toBe(true);
  });
});

describe('영웅 슬롯 (§5.17-9)', () => {
  it('구 포탈 받침 안에 두 칸, 왼쪽 ☀ 낮덱 / 오른쪽 ☾ 밤덱, 겹치지 않음', () => {
    for (const r of Object.values(HERO_SLOT)) {
      expect(r.y).toBeGreaterThanOrEqual(REGION.portalBase.y);
      expect(r.y + r.h).toBeLessThanOrEqual(REGION.portalBase.y + REGION.portalBase.h);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(VIEW_W);
    }
    expect(HERO_SLOT.offense.x + HERO_SLOT.offense.w).toBeLessThan(HERO_SLOT.defense.x);
  });
});

const G54 = { cols: 5, rows: 4 };
const NONE: DropTarget = { kind: 'none' };
const RELEASE: DropTarget = { kind: 'release' };
const OFF: DropTarget = { kind: 'feed', role: 'offense' };
const DEF: DropTarget = { kind: 'feed', role: 'defense' };
const mid = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

describe('dropTarget — 우선순위: 그리드 칸 → 놓아주기 영역 → 영웅 슬롯 → 무효 (§5.17-9)', () => {
  it('그리드 칸', () => {
    const c = cellCenter(G54.cols, G54.rows, 7);
    expect(dropTarget(G54, c.x, c.y)).toEqual({ kind: 'cell', index: 7 });
  });

  it('그리드 칸이 슬롯 판정 여유보다 우선 (슬롯 아래 여유가 그리드 윗줄과 겹쳐도)', () => {
    const c = cellCenter(G54.cols, G54.rows, 1);
    expect(dropTarget(G54, c.x, REGION.grid.y + 2).kind).toBe('cell');
  });

  it('그리드 영역이라도 칸이 아닌 여백은 무효 (4×4 좌우 여백)', () => {
    const l = gridLayout(4, 4);
    expect(dropTarget({ cols: 4, rows: 4 }, l.x - 4, l.y + 10)).toEqual(NONE);
  });

  it('놓아주기 영역: 표시 사각형 안', () => {
    const cx = RELEASE_ZONE.x + RELEASE_ZONE.w / 2;
    const cy = RELEASE_ZONE.y + RELEASE_ZONE.h / 2;
    expect(dropTarget(G54, cx, cy)).toEqual(RELEASE);
  });

  it(`놓아주기 영역: 판정은 표시보다 상하좌우 ${RELEASE_ZONE_PAD}px 넓게`, () => {
    const z = RELEASE_ZONE;
    const p = RELEASE_ZONE_PAD;
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    // 경계 안쪽 (여유 끝)
    expect(dropTarget(G54, z.x - p, cy)).toEqual(RELEASE);
    expect(dropTarget(G54, z.x + z.w + p - 0.5, cy)).toEqual(RELEASE);
    expect(dropTarget(G54, cx, z.y - p)).toEqual(RELEASE);
    expect(dropTarget(G54, cx, z.y + z.h + p - 0.5)).toEqual(RELEASE);
    // 여유 밖
    expect(dropTarget(G54, z.x - p - 1, cy)).toEqual(NONE);
    expect(dropTarget(G54, z.x + z.w + p + 1, cy)).toEqual(NONE);
    expect(dropTarget(G54, cx, z.y + z.h + p + 1)).toEqual(NONE);
  });

  it('놓아주기 판정은 그리드·영웅 슬롯과 겹치지 않는다', () => {
    expect(RELEASE_HIT.y).toBeGreaterThanOrEqual(REGION.grid.y + REGION.grid.h);
    for (const r of Object.values(HERO_SLOT)) expect(RELEASE_HIT.y).toBeGreaterThan(r.y + r.h + HERO_SLOT_PAD);
  });

  it('영웅 슬롯 사각형 안 = 그 덱 먹이기, 위·아래 여유까지', () => {
    expect(dropTarget(G54, mid(HERO_SLOT.offense).x, mid(HERO_SLOT.offense).y)).toEqual(OFF);
    expect(dropTarget(G54, mid(HERO_SLOT.defense).x, mid(HERO_SLOT.defense).y)).toEqual(DEF);
    expect(dropTarget(G54, HERO_SLOT.offense.x + 2, HERO_SLOT.offense.y - HERO_SLOT_PAD + 1)).toEqual(OFF);
    expect(dropTarget(G54, HERO_SLOT.defense.x + HERO_SLOT.defense.w - 2, HERO_SLOT.defense.y + 2)).toEqual(DEF);
  });

  it('땅 띠(레인)·하늘·HUD·두 슬롯 사이·하단 바 나머지는 무효 (구 포탈·땅 띠 소환 없음)', () => {
    expect(dropTarget(G54, 10, 200)).toEqual(NONE); // 땅 띠
    expect(dropTarget(G54, 350, 200)).toEqual(NONE);
    expect(dropTarget(G54, VIEW_W / 2, 80)).toEqual(NONE); // 하늘
    expect(dropTarget(G54, VIEW_W / 2, mid(HERO_SLOT.offense).y)).toEqual(NONE); // 두 슬롯 사이
    expect(dropTarget(G54, 100, 10)).toEqual(NONE); // HUD
    expect(dropTarget(G54, 60, 612)).toEqual(NONE); // 조각 생성 버튼 위
    expect(dropTarget(G54, 300, 612)).toEqual(NONE); // 그림자 게이지 위
  });
});

describe('그리드 배치', () => {
  it.each(balance.grid.gridPresets as [number, number][])('%i×%i 프리셋이 그리드 영역에 들어가고 가운데 정렬', (cols, rows) => {
    expect(gridFits(cols, rows)).toBe(true);
    const l = gridLayout(cols, rows);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(Math.abs(VIEW_W - (l.x * 2 + l.width))).toBeLessThanOrEqual(1);
    expect(l.y).toBeGreaterThanOrEqual(REGION.grid.y);
    expect(l.y + l.height).toBeLessThanOrEqual(REGION.grid.y + REGION.grid.h);
  });
});

describe('cellAt / cellCenter', () => {
  it.each(balance.grid.gridPresets as [number, number][])('%i×%i: 칸 중심 → 같은 칸, 그리드 밖 → null', (cols, rows) => {
    for (let i = 0; i < cols * rows; i++) {
      const c = cellCenter(cols, rows, i);
      expect(cellAt(cols, rows, c.x, c.y)).toBe(i);
    }
    const l = gridLayout(cols, rows);
    expect(cellAt(cols, rows, l.x - 1, l.y + 1)).toBeNull();
    expect(cellAt(cols, rows, l.x + 1, l.y - 1)).toBeNull();
    expect(cellAt(cols, rows, l.x + l.width, l.y + 1)).toBeNull();
    expect(cellAt(cols, rows, l.x + 1, l.y + l.height)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import balance from '../src/data/balance.json';
import {
  ABYSS_START_Y,
  DEFENSE_LINE_Y,
  HOME_Y,
  PORTAL,
  PORTAL_HIT_RADIUS,
  PORTAL_RADIUS,
  REGION,
  RELEASE_HIT,
  RELEASE_ZONE,
  RELEASE_ZONE_PAD,
  SHADOW_WALL,
  VIEW_H,
  VIEW_W,
  cellAt,
  cellCenter,
  dropTarget,
  gridFits,
  gridLayout,
  inRect,
  type DropTarget,
} from '../src/scenes/layout';

describe('레이아웃 영역 (v0.3)', () => {
  it('세로: HUD → 레인 → 포탈 받침 → 그리드 → 하단 바가 0~640을 빈틈없이 덮는다', () => {
    const rows = [REGION.hud, REGION.defenseLane, REGION.portalBase, REGION.grid, REGION.bottomBar];
    expect(rows[0].y).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].y).toBe(rows[i - 1].y + rows[i - 1].h);
    const last = rows[rows.length - 1];
    expect(last.y + last.h).toBe(VIEW_H);
  });

  it('가로: 방어 레인 ┃ 거울 ┃ 심연 레인이 0~360을 덮고 좌우 대칭', () => {
    const { defenseLane: d, mirror: m, abyssLane: a } = REGION;
    expect(d.x).toBe(0);
    expect(m.x).toBe(d.x + d.w);
    expect(a.x).toBe(m.x + m.w);
    expect(a.x + a.w).toBe(VIEW_W);
    expect(d.w).toBe(a.w);
    expect(m.w).toBe(8);
    expect(d.y).toBe(m.y);
    expect(a.y).toBe(m.y);
    expect(d.h).toBe(a.h);
  });

  it('그리드는 4행(160px)이 들어가는 높이', () => {
    expect(REGION.grid.h).toBeGreaterThanOrEqual(4 * 40);
  });
});

describe('포탈 (D-018)', () => {
  it('거울 중심 기준 좌우 대칭, 지름 48', () => {
    expect(PORTAL_RADIUS * 2).toBe(48);
    expect(PORTAL.happy.y).toBe(PORTAL.unhappy.y);
    expect(VIEW_W / 2 - PORTAL.happy.x).toBe(PORTAL.unhappy.x - VIEW_W / 2);
  });

  it('각 포탈은 자기 레인 아래, 레인 바닥과 그리드 윗변에 걸친다', () => {
    expect(PORTAL.happy.x + PORTAL_RADIUS).toBeLessThanOrEqual(REGION.mirror.x);
    expect(PORTAL.unhappy.x - PORTAL_RADIUS).toBeGreaterThanOrEqual(REGION.mirror.x + REGION.mirror.w);
    for (const p of Object.values(PORTAL)) {
      expect(p.y - PORTAL_RADIUS).toBeLessThanOrEqual(REGION.portalBase.y);
      expect(p.y + PORTAL_RADIUS).toBeGreaterThanOrEqual(REGION.grid.y);
    }
  });

  it('판정 원이 서로 겹치지 않는다', () => {
    expect(PORTAL.unhappy.x - PORTAL.happy.x).toBeGreaterThan(PORTAL_HIT_RADIUS * 2);
  });

  it('Happy·Unhappy는 각자의 포탈 바로 위', () => {
    expect(HOME_Y).toBeLessThan(PORTAL.happy.y - PORTAL_RADIUS);
    expect(inRect(REGION.defenseLane, PORTAL.happy.x, HOME_Y)).toBe(true);
    expect(inRect(REGION.abyssLane, PORTAL.unhappy.x, HOME_Y)).toBe(true);
  });
});

describe('레인 기준선', () => {
  it('두 레인 모두 거점은 아래: 방어선·출발점이 레인 아래쪽, 그림자 벽은 심연 레인 위쪽 끝', () => {
    const laneMid = REGION.defenseLane.y + REGION.defenseLane.h / 2;
    expect(DEFENSE_LINE_Y).toBeGreaterThan(laneMid);
    expect(ABYSS_START_Y).toBe(DEFENSE_LINE_Y);
    expect(SHADOW_WALL.y).toBe(REGION.abyssLane.y);
    expect(SHADOW_WALL.x).toBe(REGION.abyssLane.x);
    expect(SHADOW_WALL.w).toBe(REGION.abyssLane.w);
  });

  it('balance.json에 화면 좌표가 없다 (v0.3에서 defenseLineY 삭제)', () => {
    expect('defenseLineY' in balance.lane).toBe(false);
  });
});

const G54 = { cols: 5, rows: 4 };
const NONE: DropTarget = { kind: 'none' };
const RELEASE: DropTarget = { kind: 'release' };
const HAPPY: DropTarget = { kind: 'summon', portal: 'happy' };
const UNHAPPY: DropTarget = { kind: 'summon', portal: 'unhappy' };

describe('dropTarget — 우선순위: 그리드 칸 → 놓아주기 영역 → 포탈 판정 원 → 레인 → 무효', () => {
  it('그리드 칸', () => {
    const c = cellCenter(G54.cols, G54.rows, 7);
    expect(dropTarget(G54, c.x, c.y)).toEqual({ kind: 'cell', index: 7 });
  });

  it('그리드 칸이 포탈 판정 원보다 우선 (윗줄이 판정 원과 겹침)', () => {
    const y = REGION.grid.y + 5;
    expect(Math.hypot(0, y - PORTAL.happy.y)).toBeLessThanOrEqual(PORTAL_HIT_RADIUS);
    expect(dropTarget(G54, PORTAL.happy.x, y).kind).toBe('cell');
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

  it('놓아주기 판정은 그리드·포탈 판정 원과 겹치지 않는다', () => {
    expect(RELEASE_HIT.y).toBeGreaterThanOrEqual(REGION.grid.y + REGION.grid.h);
    for (const pt of Object.values(PORTAL)) {
      expect(RELEASE_HIT.y - pt.y).toBeGreaterThan(PORTAL_HIT_RADIUS);
    }
  });

  it('포탈 위와 판정 반경 안', () => {
    expect(dropTarget(G54, PORTAL.happy.x, PORTAL.happy.y)).toEqual(HAPPY);
    expect(dropTarget(G54, PORTAL.unhappy.x, PORTAL.unhappy.y)).toEqual(UNHAPPY);
    expect(dropTarget(G54, PORTAL.happy.x - 30, PORTAL.happy.y)).toEqual(HAPPY);
    expect(dropTarget(G54, PORTAL.unhappy.x + 30, PORTAL.unhappy.y)).toEqual(UNHAPPY);
  });

  it('레인 영역 전체', () => {
    expect(dropTarget(G54, 10, 100)).toEqual(HAPPY);
    expect(dropTarget(G54, 350, 100)).toEqual(UNHAPPY);
    expect(dropTarget(G54, PORTAL.happy.x, SHADOW_WALL.y + 1)).toEqual(HAPPY);
  });

  it('거울·HUD·포탈 받침의 빈 곳·하단 바의 나머지는 무효', () => {
    expect(dropTarget(G54, VIEW_W / 2, 200)).toEqual(NONE); // 거울
    expect(dropTarget(G54, VIEW_W / 2, PORTAL.happy.y)).toEqual(NONE); // 두 포탈 사이
    expect(dropTarget(G54, 100, 10)).toEqual(NONE); // HUD
    expect(dropTarget(G54, 10, PORTAL.happy.y)).toEqual(NONE); // 포탈 받침 왼쪽 끝
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

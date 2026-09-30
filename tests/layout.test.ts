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
  SHADOW_WALL,
  VIEW_H,
  VIEW_W,
  dropTarget,
  gridFits,
  gridLayout,
  inRect,
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

describe('dropTarget (판정은 넓게)', () => {
  it('포탈 위와 판정 반경 안', () => {
    expect(dropTarget(PORTAL.happy.x, PORTAL.happy.y)).toBe('happy');
    expect(dropTarget(PORTAL.unhappy.x, PORTAL.unhappy.y)).toBe('unhappy');
    expect(dropTarget(PORTAL.happy.x - 30, PORTAL.happy.y)).toBe('happy');
    expect(dropTarget(PORTAL.unhappy.x + 30, PORTAL.unhappy.y)).toBe('unhappy');
  });

  it('레인 영역 전체', () => {
    expect(dropTarget(10, 100)).toBe('happy');
    expect(dropTarget(350, 100)).toBe('unhappy');
    expect(dropTarget(PORTAL.happy.x, SHADOW_WALL.y + 1)).toBe('happy');
  });

  it('거울·HUD·그리드 안·포탈 받침의 빈 곳은 무효', () => {
    expect(dropTarget(VIEW_W / 2, 200)).toBeNull(); // 거울
    expect(dropTarget(VIEW_W / 2, PORTAL.happy.y)).toBeNull(); // 두 포탈 사이
    expect(dropTarget(100, 10)).toBeNull(); // HUD
    expect(dropTarget(PORTAL.happy.x, REGION.grid.y + 5)).toBeNull(); // 그리드 윗줄 (포탈 판정 원과 겹쳐도 그리드 우선)
    expect(dropTarget(10, PORTAL.happy.y)).toBeNull(); // 포탈 받침 왼쪽 끝
    expect(dropTarget(100, 610)).toBeNull(); // 하단 바
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

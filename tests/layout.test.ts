import { describe, expect, it } from 'vitest';
import balance from '../src/data/balance.json';

const SLOTS = balance.merge.soldierCap + balance.team.teamSize;
import {
  CORE,
  DROP_R,
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
  SKILL_BTN_R,
  skillButtonCenter,
  skyArc,
  toScreen,
  type DropTarget,
} from '../src/scenes/layout';

describe('레이아웃 영역 (§5.20-13 화면 배치 표)', () => {
  it('세로: HUD 40 → 해·달 띠 24 → 전장 236 → 머지 판 → 놓아주기가 0~640을 빈틈없이 덮는다', () => {
    const rows = [REGION.hud, REGION.sky, REGION.ground, REGION.board, REGION.bottomBar];
    expect(rows[0].y).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].y).toBe(rows[i - 1].y + rows[i - 1].h);
    const last = rows[rows.length - 1];
    expect(last.y + last.h).toBe(VIEW_H);
    expect(rows.map((r) => r.h).slice(0, 3)).toEqual([40, 24, 236]);
    expect(REGION.board.h).toBeGreaterThanOrEqual(276);
    expect(REGION.bottomBar.h).toBeGreaterThanOrEqual(62);
  });

  it('해·달 띠·전장은 화면 너비 전체 (레인 폭 360)', () => {
    for (const r of [REGION.sky, REGION.ground]) expect([r.x, r.w]).toEqual([0, VIEW_W]);
  });
});

describe('원형 스킬 버튼 (§5.20-13)', () => {
  it('전장과 머지 판 경계에 걸쳐 떠 있고, 오른쪽 정렬·겹치지 않음·화면 안', () => {
    for (const n of [1, 2, 3]) {
      const cs = Array.from({ length: n }, (_, i) => skillButtonCenter(i, n));
      for (const c of cs) {
        expect(c.y - SKILL_BTN_R).toBeLessThan(REGION.board.y);
        expect(c.y + SKILL_BTN_R).toBeGreaterThan(REGION.board.y);
        expect(c.x + SKILL_BTN_R).toBeLessThanOrEqual(VIEW_W);
        expect(c.x - SKILL_BTN_R).toBeGreaterThanOrEqual(0);
      }
      for (let i = 1; i < n; i++) expect(cs[i].x - cs[i - 1].x).toBeGreaterThan(SKILL_BTN_R * 2);
      expect(cs[n - 1].x).toBe(skillButtonCenter(2, 3).x);
    }
  });

  it('스킬 버튼은 머지 판 자리(드롭 판정 원)와 겹치지 않는다', () => {
    for (let i = 0; i < 3; i++) {
      const b = skillButtonCenter(i, 3);
      for (let k = 0; k < 20; k++) {
        const c = cellCenter(5, 4, k);
        expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThan(SKILL_BTN_R + DROP_R - 12);
      }
    }
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

  it('해/달 진행도: 왼쪽에서 오른쪽으로, 얇은 띠 가운데 줄 (해·달 띠 안)', () => {
    const [a, m, b] = [skyArc(0), skyArc(0.5), skyArc(1)];
    expect(a.x).toBeLessThan(m.x);
    expect(m.x).toBeLessThan(b.x);
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(m.y).toBeCloseTo(a.y, 9);
    for (const p of [a, m, b]) expect(inRect(REGION.sky, p.x, p.y)).toBe(true);
  });
});

const G54 = { cols: 5, rows: 4 };
const NONE: DropTarget = { kind: 'none' };
const RELEASE: DropTarget = { kind: 'release' };

describe('dropTarget — 우선순위: 자리(중심 원) → 놓아주기 영역 → 무효 (먹이기 슬롯 삭제, §5.20-13)', () => {
  it('자리 중심 + 판정 원 반지름 안', () => {
    const c = cellCenter(G54.cols, G54.rows, 7);
    expect(dropTarget(G54, c.x, c.y)).toEqual({ kind: 'cell', index: 7 });
    expect(dropTarget(G54, c.x + DROP_R - 1, c.y)).toEqual({ kind: 'cell', index: 7 });
    expect(dropTarget(G54, c.x, c.y - DROP_R + 1)).toEqual({ kind: 'cell', index: 7 });
  });

  it('자리 사이 빈 곳(판정 원 밖)은 무효', () => {
    const a = cellCenter(G54.cols, G54.rows, 0);
    const b = cellCenter(G54.cols, G54.rows, 6);
    expect(dropTarget(G54, (a.x + b.x) / 2, (a.y + b.y) / 2)).toEqual(NONE);
  });

  it('판 영역이라도 자리 밖 여백은 무효 (4×4 좌우 여백)', () => {
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

  it('놓아주기 판정은 머지 판 자리와 겹치지 않는다 (하단 칸, 넓게)', () => {
    const l = gridLayout(G54.cols, G54.rows);
    expect(RELEASE_HIT.y).toBeGreaterThanOrEqual(l.y + l.height);
    expect(RELEASE_ZONE.w).toBeGreaterThanOrEqual(VIEW_W * 0.8);
  });

  it('전장(레인)·해·달 띠·HUD·스킬 버튼 자리는 무효', () => {
    expect(dropTarget(G54, 10, 200)).toEqual(NONE); // 전장
    expect(dropTarget(G54, 350, 200)).toEqual(NONE);
    expect(dropTarget(G54, VIEW_W / 2, 50)).toEqual(NONE); // 해·달 띠
    expect(dropTarget(G54, 100, 10)).toEqual(NONE); // HUD
    const b = skillButtonCenter(2, 3);
    expect(dropTarget(G54, b.x, b.y)).toEqual(NONE);
  });
});

describe('머지 판 배치 (칸 테두리 없음, 원형 조각)', () => {
  it.each(balance.grid.gridPresets as [number, number][])('%i×%i 프리셋이 머지 판에 들어가고 가운데 정렬, 조각 지름 40 이상', (cols, rows) => {
    expect(gridFits(cols, rows)).toBe(true);
    const l = gridLayout(cols, rows);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(Math.abs(VIEW_W - (l.x * 2 + l.width))).toBeLessThanOrEqual(1);
    expect(l.y).toBeGreaterThanOrEqual(REGION.board.y);
    expect(l.y + l.height).toBeLessThanOrEqual(REGION.board.y + REGION.board.h);
    expect(l.tokenR * 2).toBeGreaterThanOrEqual(40);
    expect(l.tokenR * 2).toBeLessThan(Math.min(l.cellW, l.cellH));
  });
});

describe('cellAt / cellCenter', () => {
  it.each(balance.grid.gridPresets as [number, number][])('%i×%i: 자리 중심 → 같은 자리, 판 밖 → null', (cols, rows) => {
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

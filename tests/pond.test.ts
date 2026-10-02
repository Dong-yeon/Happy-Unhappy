// 이야기 우물 헤엄 모델 (§5.21-9): 위치 갱신은 core를 안 바꿈 / 누르는 동안 정지 / 30px 안 같은 조각만 합쳐짐 / 다른 조각 위는 안 합쳐지고 밀려남
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { WILDCARD } from '../src/core/grid';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import { MERGE_RADIUS, WELL, WELL_TOKEN_R, gameGeometry, wellDistance } from '../src/scenes/layout';
import { ATTRACT_RANGE, Pond } from '../src/scenes/pond';

const data = structuredClone(rawGameData) as unknown as GameData;
const MAX = data.balance.grid.maxTier;
const CX = WELL.x + WELL.w / 2;
const CY = WELL.y + WELL.h / 2;

function game(): GameState {
  return new GameState(data, { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(data.balance.merge.soldierCap + data.balance.team.teamSize), 1);
}
function put(g: GameState, cell: number, chain: string, tier: number): number {
  const p = g.newPiece(chain, tier);
  g.grid.cells[cell] = p;
  return p.id;
}
/** 조각을 원하는 화면 위치에 */
function place(pond: Pond, id: number, x: number, y: number): void {
  const f = pond.fish.get(id)!;
  Object.assign(f, { x, y, vx: 0, vy: 0 });
}
const steps = (pond: Pond, seconds: number) => {
  for (let k = 0; k < Math.round(seconds * 60); k++) pond.step(1 / 60, MAX);
};

describe('헤엄 (§5.21-2)', () => {
  it('위치 갱신은 core 상태를 바꾸지 않는다 (그리드·rng·저장 내용 그대로)', () => {
    const g = game();
    for (let i = 0; i < 12; i++) put(g, i, i % 2 ? 'bone' : 'bell', (i % 3) + 1);
    put(g, 15, WILDCARD, 0);
    const before = JSON.stringify(serializeGame(g));
    const rng = g.rng.getState();
    const pond = new Pond(mulberry32(5));
    pond.sync(g.grid);
    const pos0 = [...pond.fish.values()].map((f) => [f.x, f.y]);
    steps(pond, 30);
    expect([...pond.fish.values()].map((f) => [f.x, f.y])).not.toEqual(pos0);
    expect(JSON.stringify(serializeGame(g))).toBe(before);
    expect(g.rng.getState()).toBe(rng);
  });

  it('조각은 우물 안에 머물고 (가장자리에서 튕김) 서로 크게 겹치지 않는다, 속도는 느리다', () => {
    const g = game();
    for (let i = 0; i < 20; i++) put(g, i, ['bone', 'bell', 'companion_animal', 'comfort_object'][i % 4], (i % 4) + 1);
    const pond = new Pond(mulberry32(9));
    pond.sync(g.grid);
    steps(pond, 60);
    const list = [...pond.fish.values()];
    for (const f of list) {
      expect(wellDistance(f.x, f.y)).toBeLessThanOrEqual(-WELL_TOKEN_R + 0.5);
      expect(Math.hypot(f.vx, f.vy)).toBeLessThanOrEqual(24 + 1e-9);
    }
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) expect(Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y)).toBeGreaterThan(WELL_TOKEN_R * 1.6);
  });

  it('같은 체인·단계끼리 끌림 (120px 안), 다른 조각끼리는 없음, 와일드카드는 약하게 모두와', () => {
    const g = game();
    const a = put(g, 0, 'bone', 1);
    const b = put(g, 1, 'bone', 1);
    const c = put(g, 2, 'bell', 1);
    const w = put(g, 3, WILDCARD, 0);
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    const [fa, fb, fc, fw] = [a, b, c, w].map((id) => pond.fish.get(id)!);
    expect(pond.attraction(fa, fb, MAX)).toBe(4);
    expect(pond.attraction(fa, fc, MAX)).toBe(0);
    expect(pond.attraction(fw, fc, MAX)).toBe(2);
    expect(ATTRACT_RANGE).toBe(120);
    // 헤엄 없이 끌림만 보려고 속도 0으로 두고 짧게: 같은 조각 쌍은 가까워진다
    place(pond, a, CX - 50, CY);
    place(pond, b, CX + 50, CY);
    place(pond, c, CX, CY - 200 < WELL.y ? WELL.y + 40 : CY - 100);
    place(pond, w, WELL.x + 40, WELL.y + WELL.h - 40);
    const d0 = Math.hypot(fa.x - fb.x, fa.y - fb.y);
    let closer = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const p2 = new Pond(mulberry32(seed));
      p2.sync(g.grid);
      for (const id of [a, b, c, w]) Object.assign(p2.fish.get(id)!, { x: pond.fish.get(id)!.x, y: pond.fish.get(id)!.y, vx: 0, vy: 0, speed: 0 });
      for (let k = 0; k < 120; k++) {
        for (const f of p2.fish.values()) f.speed = 0; // 헤엄 속도를 빼고 끌림만
        p2.step(1 / 60, MAX);
      }
      const A = p2.fish.get(a)!;
      const B = p2.fish.get(b)!;
      if (Math.hypot(A.x - B.x, A.y - B.y) < d0) closer += 1;
    }
    expect(closer).toBe(10);
  });
});

describe('손가락 (§5.21-3)', () => {
  it('판을 누르는 동안 모든 조각 정지, 끄는 조각만 손가락을 따라감', () => {
    const g = game();
    for (let i = 0; i < 8; i++) put(g, i, 'bell', 1 + (i % 2));
    const pond = new Pond(mulberry32(3));
    pond.sync(g.grid);
    steps(pond, 1);
    const grab = [...pond.fish.values()][0];
    const id = pond.press(grab.x, grab.y);
    expect(id).toBe(grab.id);
    expect(pond.frozen).toBe(true);
    const others = () => [...pond.fish.values()].filter((f) => f.id !== id).map((f) => [f.x, f.y]);
    const before = others();
    pond.moveTo(CX, CY);
    steps(pond, 3);
    expect(others()).toEqual(before);
    expect([grab.x, grab.y]).toEqual([CX, CY]);
    // 빈 물을 눌러도 정지
    pond.cancel();
    expect(pond.press(WELL.x + 2, WELL.y + 2)).toBeNull();
    expect(pond.frozen).toBe(true);
    const b2 = [...pond.fish.values()].map((f) => [f.x, f.y]);
    steps(pond, 1);
    expect([...pond.fish.values()].map((f) => [f.x, f.y])).toEqual(b2);
    pond.cancel();
    steps(pond, 1);
    expect([...pond.fish.values()].map((f) => [f.x, f.y])).not.toEqual(b2);
  });

  it(`놓은 곳 반지름 ${MERGE_RADIUS}px 안 같은 조각과 합쳐짐 → core에는 칸 A → 칸 B 머지`, () => {
    const g = game();
    const a = put(g, 0, 'bone', 2);
    const b = put(g, 7, 'bone', 2);
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    place(pond, a, CX - 100, CY);
    place(pond, b, CX + 60, CY);
    pond.press(CX - 100, CY);
    pond.moveTo(CX + 60 - (MERGE_RADIUS - 2), CY);
    const r = pond.release(CX + 60 - (MERGE_RADIUS - 2), CY, g);
    expect(r).toMatchObject({ kind: 'merge', from: 0, to: 7, kept: b });
    expect(g.grid.cells[0]).toBeNull();
    expect(g.grid.cells[7]).toMatchObject({ id: b, chain: 'bone', tier: 3 });
    expect(pond.fish.has(a)).toBe(false);
    expect(pond.fish.get(b)).toMatchObject({ tier: 3, x: CX + 60, y: CY });
    expect(pond.frozen).toBe(false);
  });

  it('반지름 밖이면 합쳐지지 않고 그 자리에서 다시 헤엄 (core 그대로)', () => {
    const g = game();
    const a = put(g, 0, 'bone', 2);
    const b = put(g, 7, 'bone', 2);
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    place(pond, a, CX - 100, CY);
    place(pond, b, CX + 60, CY);
    const cells = JSON.stringify(g.grid.cells);
    pond.press(CX - 100, CY);
    const x = CX + 60 - (MERGE_RADIUS + 3);
    pond.moveTo(x, CY);
    expect(pond.release(x, CY, g)).toEqual({ kind: 'swim' });
    expect(JSON.stringify(g.grid.cells)).toBe(cells);
    expect(pond.fish.get(a)).toMatchObject({ x, y: CY });
  });

  it('다른 조각(체인·단계가 다름) 위에 놓으면 합쳐지지 않고 밀려남, 가까이 있는 같은 조각이 우선', () => {
    const g = game();
    const a = put(g, 0, 'bone', 2);
    const other = put(g, 1, 'bell', 2); // 다른 체인
    const higher = put(g, 2, 'bone', 3); // 다른 단계
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    place(pond, a, CX - 120, CY);
    place(pond, other, CX, CY);
    place(pond, higher, CX + 120, CY);
    const cells = JSON.stringify(g.grid.cells);
    for (const [tx, ty] of [
      [CX, CY],
      [CX + 120, CY],
    ]) {
      pond.press(pond.fish.get(a)!.x, pond.fish.get(a)!.y);
      pond.moveTo(tx, ty);
      expect(pond.release(tx, ty, g)).toEqual({ kind: 'swim' });
      expect(JSON.stringify(g.grid.cells)).toBe(cells);
      steps(pond, 0.2); // 겹친 채로 두지 않는다
      const A = pond.fish.get(a)!;
      const T = pond.fish.get(tx === CX ? other : higher)!;
      expect(Math.hypot(A.x - T.x, A.y - T.y)).toBeGreaterThan(WELL_TOKEN_R * 2 - 1);
    }
    // 최고 단계끼리도 합쳐지지 않는다 (core 규칙 그대로)
    const g2 = game();
    const t1 = put(g2, 0, 'bone', MAX);
    const t2 = put(g2, 1, 'bone', MAX);
    const p2 = new Pond(mulberry32(1));
    p2.sync(g2.grid);
    place(p2, t1, CX - 80, CY);
    place(p2, t2, CX + 40, CY);
    p2.press(CX - 80, CY);
    expect(p2.release(CX + 40, CY, g2)).toEqual({ kind: 'swim' });
  });

  it('와일드카드는 아무 조각과 합쳐진다 (core 규칙), 결과는 짝 자리에서', () => {
    const g = game();
    const w = put(g, 0, WILDCARD, 0);
    const b = put(g, 5, 'bell', 1);
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    place(pond, w, CX - 80, CY);
    place(pond, b, CX + 40, CY);
    pond.press(CX - 80, CY);
    const r = pond.release(CX + 40 + 10, CY, g);
    expect(r).toMatchObject({ kind: 'merge', from: 0, to: 5 });
    expect(g.grid.cells[5]).toMatchObject({ chain: 'bell', tier: 2 });
    expect(pond.fish.size).toBe(1);
  });

  it('sync: core에서 없어진 조각은 지우고 새 조각은 추가, 남은 조각 위치는 그대로', () => {
    const g = game();
    const a = put(g, 0, 'bone', 1);
    const b = put(g, 1, 'bell', 1);
    const pond = new Pond(mulberry32(1));
    pond.sync(g.grid);
    place(pond, b, CX, CY);
    g.grid.cells[0] = null;
    g.grid.cells[9] = g.grid.cells[1];
    g.grid.cells[1] = null;
    const c = put(g, 3, 'bone', 2);
    const res = pond.sync(g.grid);
    expect(res.removed.map((f) => f.id)).toEqual([a]);
    expect(res.added.map((f) => f.id)).toEqual([c]);
    expect(pond.fish.get(b)).toMatchObject({ cell: 9, x: CX, y: CY });
  });
});

import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { WILDCARD, emptyIndices } from '../src/core/grid';
import { mulberry32, parseSeed } from '../src/core/rng';
import { RELEASE_ZONE, defenseGeometry, dropTarget } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const { spawnCostBase, spawnCostStep, releaseRefund, returnQueueCap } = data.balance.grid;
const DOG = 'companion_animal';

function game(seed = 1, cols = 4, rows = 4): GameState {
  return new GameState(data, { cols, rows }, mulberry32(seed), defenseGeometry(data.balance.lane.laneCap));
}

describe('GameState — 조각 생성', () => {
  it('기쁨 소모, 1단계 조각, 비용 증가, id 증가', () => {
    const g = game();
    const joy0 = g.joy;
    const a = g.spawn()!;
    expect(g.joy).toBe(joy0 - spawnCostBase);
    expect(a.piece).toMatchObject({ tier: 1, id: 1 });
    expect(g.grid.cells[a.index]).toBe(a.piece);
    expect(g.spawnCost).toBe(spawnCostBase + spawnCostStep);
    expect(g.spawn()!.piece.id).toBe(2);
  });

  it('bornAt = 생성 시점의 playTime (tick 누적)', () => {
    const g = game();
    g.tick(1.5);
    g.tick(2);
    g.tick(-1); // 음수 무시
    expect(g.playTime).toBe(3.5);
    expect(g.spawn()!.piece.bornAt).toBe(3.5);
  });

  it('같은 시드 → 같은 배치·체인', () => {
    const run = () => {
      const g = game(123);
      g.debugAddJoy(1000);
      return Array.from({ length: 8 }, () => {
        const r = g.spawn()!;
        return `${r.index}:${r.piece.chain}`;
      });
    };
    expect(run()).toEqual(run());
  });

  it('기쁨 부족이면 생성 안 함 (noJoy)', () => {
    const g = game();
    g.joy = spawnCostBase - 1;
    expect(g.spawnBlock).toBe('noJoy');
    expect(g.spawn()).toBeNull();
    expect(g.joy).toBe(spawnCostBase - 1);
    expect(emptyIndices(g.grid)).toHaveLength(16);
  });

  it('칸 가득이면 생성 안 함 (full)', () => {
    const g = game(1, 4, 4);
    for (let i = 0; i < 16; i++) g.debugGrant(DOG, 1);
    g.debugAddJoy(1000);
    const joy = g.joy;
    expect(g.spawnBlock).toBe('full');
    expect(g.spawn()).toBeNull();
    expect(g.joy).toBe(joy);
    expect(g.debugGrant(DOG, 1)).toBeNull();
  });
});

describe('GameState — 놓아주기·머지 후 귀환 대기열 flush', () => {
  it('놓아주기: 환급 + 와일드카드 무시', () => {
    const g = game();
    const i2 = g.debugGrant(DOG, 2)!;
    const iw = g.debugGrant(WILDCARD, 1)!;
    const joy = g.joy;
    expect(g.release(i2)).toBe(releaseRefund * 2);
    expect(g.joy).toBe(joy + releaseRefund * 2);
    expect(g.release(iw)).toBeNull();
    expect(g.grid.cells[iw]?.chain).toBe(WILDCARD);
    expect(g.joy).toBe(joy + releaseRefund * 2);
  });

  it('놓아주기 영역에 드롭 → 즉시 제거·환급, 미리보기 값과 같음', () => {
    const g = game();
    const i = g.debugGrant(DOG, 3)!;
    const cx = RELEASE_ZONE.x + RELEASE_ZONE.w / 2;
    const cy = RELEASE_ZONE.y + RELEASE_ZONE.h / 2;
    expect(dropTarget(g.grid, cx, cy)).toEqual({ kind: 'release' });
    const preview = g.releasePreview(i);
    expect(preview).toBe(releaseRefund * 3);
    const joy = g.joy;
    expect(g.release(i)).toBe(preview);
    expect(g.grid.cells[i]).toBeNull();
    expect(g.joy).toBe(joy + preview!);
  });

  it('와일드카드를 놓아주기 영역에 드롭 → 미리보기 null(비활성), 원위치(그리드 그대로)', () => {
    const g = game();
    const i = g.debugGrant(WILDCARD, 0)!;
    const before = structuredClone(g.grid);
    const joy = g.joy;
    expect(g.releasePreview(i)).toBeNull();
    expect(g.release(i)).toBeNull();
    expect(g.grid).toEqual(before);
    expect(g.joy).toBe(joy);
  });

  it('와일드카드는 tier 0으로 만든다', () => {
    const g = game();
    const i = g.debugGrant(WILDCARD, 3)!;
    expect(g.grid.cells[i]!.tier).toBe(0);
  });

  it('칸이 가득할 때 귀환은 대기 → 머지로 칸이 비면 바로 배치', () => {
    const g = game(1, 4, 4);
    for (let i = 0; i < 16; i++) g.debugGrant(DOG, 1);
    const back = g.newPiece(DOG, 2);
    expect(g.enqueueReturn(back).queued).toBe(true);
    const kind = g.drop(0, 1);
    expect(kind).toBe('merge');
    expect(g.grid.cells[0]).toBe(back);
    expect(g.returnQueue).toEqual([]);
  });

  it('놓아주기로 칸이 비면 바로 배치 (빈 칸이 하나뿐이면 그 칸)', () => {
    const g = game(1, 4, 4);
    for (let i = 0; i < 16; i++) g.debugGrant(DOG, 1);
    const back = g.newPiece(DOG, 2);
    g.enqueueReturn(back);
    g.release(5);
    expect(g.grid.cells[5]).toBe(back);
  });

  it('같은 시드 → 같은 귀환 배치 칸', () => {
    const run = () => {
      const g = game(77, 5, 4);
      return [1, 2, 3].map(() => g.enqueueReturn(g.newPiece(DOG, 2)).placedAt);
    };
    expect(run()).toEqual(run());
  });

  it(`상한(${returnQueueCap}) 초과분은 소실 수에 누적`, () => {
    const g = game(1, 4, 4);
    for (let i = 0; i < 16; i++) g.debugGrant(DOG, 1);
    for (let i = 0; i < returnQueueCap + 2; i++) g.enqueueReturn(g.newPiece(DOG, 2));
    expect(g.returnQueue).toHaveLength(returnQueueCap);
    expect(g.lostReturns).toBe(2);
  });
});

describe('rng', () => {
  it('mulberry32: 같은 시드 같은 수열, [0,1)', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('parseSeed', () => {
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed(null)).toBeNull();
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('abc')).toBeNull();
    expect(parseSeed('1.5')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createGrid, isPreset, resolveGridSize, toCell, toIndex } from '../src/core/grid';

const presets: [number, number][] = [[4, 4], [5, 4], [6, 4]];

describe('createGrid', () => {
  it.each(presets)('%i×%i 빈 그리드', (cols, rows) => {
    const g = createGrid({ cols, rows });
    expect(g.cells).toHaveLength(cols * rows);
    expect(g.cells.every((c) => c === null)).toBe(true);
  });

  it('잘못된 크기는 거부', () => {
    expect(() => createGrid({ cols: 0, rows: 4 })).toThrow();
    expect(() => createGrid({ cols: 4.5, rows: 4 })).toThrow();
  });
});

describe('좌표 변환', () => {
  const size = { cols: 5, rows: 4 };

  it('index ↔ (col,row) 왕복', () => {
    for (let i = 0; i < 20; i++) {
      const { col, row } = toCell(size, i);
      expect(toIndex(size, col, row)).toBe(i);
    }
  });

  it('행 우선 배치', () => {
    expect(toCell(size, 5)).toEqual({ col: 0, row: 1 });
    expect(toIndex(size, 4, 3)).toBe(19);
  });

  it('범위 밖은 예외', () => {
    expect(() => toIndex(size, 5, 0)).toThrow(RangeError);
    expect(() => toCell(size, 20)).toThrow(RangeError);
    expect(() => toCell(size, -1)).toThrow(RangeError);
  });
});

describe('resolveGridSize', () => {
  const fallback = { cols: 5, rows: 4 };

  it('프리셋에 있는 요청은 채택', () => {
    expect(resolveGridSize(presets, fallback, { cols: 6, rows: 4 })).toEqual({ cols: 6, rows: 4 });
  });

  it('프리셋에 없는 요청이나 요청 없음은 기본값', () => {
    expect(resolveGridSize(presets, fallback, { cols: 3, rows: 3 })).toEqual(fallback);
    expect(resolveGridSize(presets, fallback, null)).toEqual(fallback);
  });

  it('isPreset', () => {
    expect(isPreset(presets, { cols: 4, rows: 4 })).toBe(true);
    expect(isPreset(presets, { cols: 4, rows: 5 })).toBe(false);
  });
});

// 머지 그리드 상태. Phaser 의존 없음.
// M1: 크기·좌표 변환만. 생성·머지·와일드카드·놓아주기·귀환 대기열은 M2.

export type ChainId = string;
export const WILDCARD = 'wildcard' as const;

export interface Piece {
  chain: ChainId | typeof WILDCARD;
  tier: number;
}

export interface GridSize {
  cols: number;
  rows: number;
}

export interface Grid extends GridSize {
  /** 행 우선(row-major). 길이 = cols × rows */
  cells: (Piece | null)[];
}

export function createGrid({ cols, rows }: GridSize): Grid {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`잘못된 그리드 크기: ${cols}×${rows}`);
  }
  return { cols, rows, cells: new Array<Piece | null>(cols * rows).fill(null) };
}

export function toIndex(size: GridSize, col: number, row: number): number {
  if (col < 0 || col >= size.cols || row < 0 || row >= size.rows) {
    throw new RangeError(`칸 범위 밖: (${col}, ${row}) / ${size.cols}×${size.rows}`);
  }
  return row * size.cols + col;
}

export function toCell(size: GridSize, index: number): { col: number; row: number } {
  if (!Number.isInteger(index) || index < 0 || index >= size.cols * size.rows) {
    throw new RangeError(`인덱스 범위 밖: ${index} / ${size.cols}×${size.rows}`);
  }
  return { col: index % size.cols, row: Math.floor(index / size.cols) };
}

export function isPreset(presets: [number, number][], size: GridSize): boolean {
  return presets.some(([c, r]) => c === size.cols && r === size.rows);
}

/** 요청한 크기가 프리셋에 있으면 그것을, 아니면 기본 크기를 쓴다. */
export function resolveGridSize(presets: [number, number][], fallback: GridSize, requested?: GridSize | null): GridSize {
  if (requested && isPreset(presets, requested)) return { cols: requested.cols, rows: requested.rows };
  return { cols: fallback.cols, rows: fallback.rows };
}

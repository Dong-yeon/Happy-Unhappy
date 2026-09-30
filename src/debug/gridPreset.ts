// 디버그 전용 그리드 프리셋 오버라이드. M7 디버그 패널에 흡수 예정.
// 저장(M6)이 생기면 프리셋 전환 시 저장 초기화를 함께 한다 (스펙 §8).

import type { GridSize } from '../core/grid';

const KEY = 'hau_debug_grid';

export function isDebug(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

export function loadGridOverride(): GridSize | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<GridSize>;
    if (typeof v.cols === 'number' && typeof v.rows === 'number') return { cols: v.cols, rows: v.rows };
  } catch {
    console.warn(`[debug] ${KEY} 파싱 실패, 무시함`);
  }
  return null;
}

export function saveGridOverride(size: GridSize): void {
  window.localStorage.setItem(KEY, JSON.stringify(size));
}

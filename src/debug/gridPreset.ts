// 디버그 전용 그리드 프리셋 오버라이드. M7 디버그 패널에 흡수 예정.
// 프리셋 전환 시 게임 저장만 초기화하고 gating은 유지한다 (스펙 §5.8-2, DebugPanel).

import type { GridSize } from '../core/grid';
import { readKey, writeKey } from '../platform/storage';

const KEY = 'hau_debug_grid';

export function isDebug(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

export function loadGridOverride(): GridSize | null {
  const raw = readKey(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GridSize>;
    if (typeof v.cols === 'number' && typeof v.rows === 'number') return { cols: v.cols, rows: v.rows };
  } catch {
    console.warn(`[debug] ${KEY} 파싱 실패, 무시함`);
  }
  return null;
}

export function saveGridOverride(size: GridSize): void {
  writeKey(KEY, JSON.stringify(size));
}

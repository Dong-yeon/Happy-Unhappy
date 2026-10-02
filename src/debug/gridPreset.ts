// 디버그 전용 그리드 프리셋 오버라이드. M7 디버그 패널에 흡수 예정.
// 프리셋 전환 시 게임 저장을 초기화한다 (DebugPanel).

import type { GridSize } from '../core/grid';
import { readKey, writeKey } from '../platform/storage';

const KEY = 'hau_debug_grid';

export function isDebug(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

/** 사람 플레이 테스트 URL (§5.10-4): 평가 버튼만 보이고 디버그 패널은 숨긴다 */
export function isPlaytest(): boolean {
  return new URLSearchParams(window.location.search).get('playtest') === '1';
}

/** 디버그 패널·디버그 표시 (?playtest=1이면 ?debug=1이어도 숨김) */
export function showDebugUi(): boolean {
  return isDebug() && !isPlaytest();
}

/** 시도 끝·결말 주관 평가 버튼 (§5.20-12: ?playtest=1일 때만) */
export function showRatings(): boolean {
  return isPlaytest();
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

// localStorage 읽기/쓰기 (스펙 §5.8-2). 브라우저 의존은 platform/에만.
// 모든 접근은 try/catch: 실패하면 console.warn 후 저장 없이 계속 진행하고, 디버그 패널에 "저장 실패"를 표시한다.

export const SAVE_KEY = 'hau_save_v4';
/** v2·v3 저장 (M8.9까지)·gating 디버그 날짜: 스키마가 바뀌어 읽지 않고 지운다 (§5.19-7) */
export const LEGACY_SAVE_KEYS = ['hau_save_v2', 'hau_save_v3', 'hau_debug_date_offset', 'hau_metrics_v3'];
export const METRICS_KEY = 'hau_metrics_v4';

/** 마지막 쓰기 실패 사유 (디버그 표시). 성공하면 null로 돌아온다 */
export const storageStatus: { lastError: string | null } = { lastError: null };

function fail(op: string, key: string, e: unknown): void {
  const msg = `${op} ${key}: ${(e as Error)?.message ?? String(e)}`;
  storageStatus.lastError = msg;
  console.warn(`[storage] 실패 — ${msg}`);
}

export function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    fail('읽기', key, e);
    return null;
  }
}

/** 성공 여부 */
export function writeKey(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    storageStatus.lastError = null;
    return true;
  } catch (e) {
    fail('쓰기', key, e);
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch (e) {
    fail('삭제', key, e);
  }
}

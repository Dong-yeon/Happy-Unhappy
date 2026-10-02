// 기기 로컬 날짜·시각 (metrics 기록용). v0.15에서 gating(하루 열림)이 없어져 디버그 날짜 오프셋도 없다 (D-054).

function localDate(d: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 오늘 (기기 로컬 날짜, metrics realDate) */
export function realToday(): string {
  return localDate(new Date());
}

// ── 잉크 시간 (§5.22-2): 실제 시각 ms + 디버그 시간 앞당김 ("시간 +1시간/+8시간", 새로고침해도 유지) ──
const OFFSET_KEY = 'hau_debug_clock_offset';

function readOffset(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(OFFSET_KEY) ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** 지금 실제 시각 (ms, 디버그 앞당김 포함) */
export function nowMs(): number {
  return Date.now() + readOffset();
}

/** 디버그: 시계를 hours만큼 앞당긴다 */
export function debugAdvanceClock(hours: number): void {
  try {
    globalThis.localStorage?.setItem(OFFSET_KEY, String(readOffset() + hours * 3_600_000));
  } catch {
    /* 저장 못 해도 이번 세션 계산엔 영향 없음 */
  }
}

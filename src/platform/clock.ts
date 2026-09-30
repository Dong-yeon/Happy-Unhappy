// 기기 로컬 날짜 'YYYY-MM-DD' (+ 디버그 날짜 오프셋). gating(core)은 이 문자열만 받는다 (스펙 §5.8-1).

import { addDays } from '../core/gating';
import { DATE_OFFSET_KEY, readKey, removeKey, writeKey } from './storage';

function localDate(d: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 디버그 날짜 오프셋(일). 저장값이 없거나 잘못되면 0 */
export function dateOffset(): number {
  const n = Number(readKey(DATE_OFFSET_KEY) ?? 0);
  return Number.isInteger(n) ? n : 0;
}

export function setDateOffset(n: number): void {
  if (n === 0) removeKey(DATE_OFFSET_KEY);
  else writeKey(DATE_OFFSET_KEY, String(n));
}

/** 오늘 (기기 로컬 날짜 + 디버그 오프셋) */
export function today(): string {
  return addDays(localDate(new Date()), dateOffset());
}

/** 기기 로컬 자정까지 남은 분 (올림) */
export function minutesUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 60_000));
}

export function nowIso(): string {
  return new Date().toISOString();
}

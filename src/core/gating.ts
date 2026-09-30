// 하루 진행 C안: 날짜 지급·보관·소비 (스펙 §5.5, §5.8-1). 순수 함수, Phaser·브라우저 의존 없음.
// 날짜는 기기 로컬 'YYYY-MM-DD' 문자열 인자로만 받는다 (Date.now()·new Date() 호출 금지. 현재 날짜는 platform/clock.ts).
// GameState는 gating을 모른다. gating은 앱(씬) 층의 메타 상태이며 시뮬은 쓰지 않는다.

/** 보관 한도를 넘어 버려진 날 (지급 1회당 1항목) */
export interface ForgottenEntry {
  date: string;
  count: number;
  /** 지급 시점의 게임 일차 (일기장에서 이 날 앞에 표시) */
  atDay: number;
}

export interface GatingState {
  openableDays: number;
  /** null = 첫 실행 전 */
  lastGrantDate: string | null;
  /** 누적 (metrics용, 새 일생에서도 유지) */
  forgottenDays: number;
  /** 이번 일생의 "기억나지 않는 날" (새 일생에서 비움) */
  forgottenLog: ForgottenEntry[];
}

export interface GatingConfig {
  dailyLimit: number;
  storeCap: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function emptyGating(): GatingState {
  return { openableDays: 0, lastGrantDate: null, forgottenDays: 0, forgottenLog: [] };
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** 형식(YYYY-MM-DD) + 실제 존재하는 날짜인지 (2026-02-30 불가) */
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function utcOf(s: string): number {
  if (!isValidDate(s)) throw new Error(`잘못된 날짜: "${s}"`);
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** b − a (일). Date.UTC 차이라 시간대·DST 영향 없음 */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
}

/** 'YYYY-MM-DD' + n일 (디버그 날짜 오프셋·테스트용). 날짜 객체 없이 달력 계산 */
export function addDays(s: string, n: number): string {
  if (!isValidDate(s)) throw new Error(`잘못된 날짜: "${s}"`);
  let [y, m, d] = s.split('-').map(Number);
  d += Math.trunc(n);
  while (d > daysInMonth(y, m)) {
    d -= daysInMonth(y, m);
    if (++m > 12) [m, y] = [1, y + 1];
  }
  while (d < 1) {
    if (--m < 1) [m, y] = [12, y - 1];
    d += daysInMonth(y, m);
  }
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(y, 4)}-${p(m)}-${p(d)}`;
}

/**
 * 지급 규칙 (§5.8-1 표)
 * - 첫 실행: openable = min(dailyLimit, storeCap), last = today
 * - today == last: 변화 없음
 * - today > last: raw = openable + n × dailyLimit → openable = min(raw, storeCap), forgotten = raw − openable, last = today
 * - today < last (날짜 되돌림): 변화 없음, last 유지
 * forgotten > 0이면 forgottenLog에 1항목, forgottenDays += forgotten.
 */
export function grant(
  g: GatingState,
  today: string,
  atDay: number,
  cfg: GatingConfig,
): { next: GatingState; granted: number; forgotten: number } {
  utcOf(today); // 형식 검사
  if (g.lastGrantDate === null) {
    const openable = Math.min(cfg.dailyLimit, cfg.storeCap);
    return { next: { ...g, forgottenLog: [...g.forgottenLog], openableDays: openable, lastGrantDate: today }, granted: openable, forgotten: 0 };
  }
  const n = daysBetween(g.lastGrantDate, today);
  if (n <= 0) return { next: { ...g, forgottenLog: [...g.forgottenLog] }, granted: 0, forgotten: 0 };
  const raw = g.openableDays + n * cfg.dailyLimit;
  const openable = Math.min(raw, cfg.storeCap);
  const forgotten = raw - openable;
  const next: GatingState = {
    openableDays: openable,
    lastGrantDate: today,
    forgottenDays: g.forgottenDays + forgotten,
    forgottenLog: forgotten > 0 ? [...g.forgottenLog, { date: today, count: forgotten, atDay }] : [...g.forgottenLog],
  };
  return { next, granted: openable - g.openableDays, forgotten };
}

/** 하루를 끝낼 때 1 소비. bypass면 0에서 멈춤, 아니면 0에서 호출 시 예외 */
export function consume(g: GatingState, bypass: boolean): GatingState {
  if (g.openableDays <= 0) {
    if (bypass) return { ...g, forgottenLog: [...g.forgottenLog], openableDays: 0 };
    throw new Error('열 수 있는 날이 없음');
  }
  return { ...g, forgottenLog: [...g.forgottenLog], openableDays: g.openableDays - 1 };
}

/** 새 일생: openable·lastGrantDate·forgottenDays 유지, forgottenLog 비움 (§5.8-3 [처음부터]) */
export function gatingForNewLife(g: GatingState): GatingState {
  return { ...g, forgottenLog: [] };
}

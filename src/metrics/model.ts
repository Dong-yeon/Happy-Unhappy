// metrics 데이터 형식·순수 로직 (스펙 §5.10-3, §5.19). Phaser·브라우저 의존 없음 (저장·시간은 recorder.ts가 platform으로).
// metrics는 관찰만 한다: 게임 규칙은 이 값을 읽지 않는다.
// v4: 일차(day) 대신 시도(attempt) 단위 기록 (D-054). v5: 먹이기·갈림길 기록 삭제, 편성 기록 (§5.20).

import type { AttemptResult, AttemptStats } from '../core/day';
import type { GameStats } from '../core/stats';

export const METRICS_VERSION = 5;
export const MAX_SESSIONS = 500;
export const MAX_LIVES = 20;
/** 직렬화 결과 상한 (localStorage 5MB 대비) */
export const MAX_BYTES = 1.5 * 1024 * 1024;

/** 시도 끝 주관 평가 (§5.10-4): 이번 장 / 다시 하기 */
export interface DayRating {
  day: 'good' | 'meh' | 'bad' | null;
  retry: 'again' | 'tired' | null;
}

export interface DropFails {
  invalid: number;
  laneFull: number;
  wildcard: number;
}

export interface AttemptMetrics {
  /** 판 통산 시도 번호 */
  attempt: number;
  stage: number;
  result: AttemptResult | null;
  /** 시도를 끝낸 날짜 (기기 로컬) */
  realDate: string;
  record: AttemptStats;
  /** 그 시도의 편성 (공격대·수비대 팀별 영웅 id) */
  formation: { offense: string[][]; defense: string[][] };
  dropFails: DropFails;
  dragDistance: number;
  /** 낮 + 밤의 실제 경과 시간(초, 배속·백그라운드 제외) */
  realSeconds: number;
  dayRealSeconds: number;
  nightRealSeconds: number;
  /** ×1이 아닌 배속을 쓴 실제 시간(초) */
  speedUsed: number;
  rating: DayRating | null;
}

export interface LifeMetrics {
  lifeId: string;
  seed: number;
  gridSize: { cols: number; rows: number };
  startedAt: string;
  endedAt: string | null;
  attempts: AttemptMetrics[];
  /** 낮·밤 도중에 앱을 닫았다가 다시 연 횟수 (장면 카드부터 다시) */
  midAttemptRestores: number;
  /** 판의 끝 (챕터 완성): 시도 수·스테이지. 진행 중이면 null */
  chapter: { completed: true; attempts: number; stage: number } | null;
  endingAgree: boolean | null;
  stats: GameStats | null;
}

export interface SessionRecord {
  realDate: string;
  startedAt: string;
  foregroundSeconds: number;
  attemptsCompleted: number;
}

export interface MetricsData {
  version: 5;
  firstSeen: string;
  sessions: SessionRecord[];
  lives: LifeMetrics[];
  /** confirmDay 때 기록, 시도 끝에 지움. 부팅 시 남아 있으면 시도 도중 종료 */
  inProgress: { lifeId: string; attempt: number } | null;
}

export function emptyMetrics(nowIso: string): MetricsData {
  return { version: METRICS_VERSION, firstSeen: nowIso, sessions: [], lives: [], inProgress: null };
}

export function emptyDropFails(): DropFails {
  return { invalid: 0, laneFull: 0, wildcard: 0 };
}

export function newLife(seed: number, gridSize: { cols: number; rows: number }, startedAt: string): LifeMetrics {
  return {
    lifeId: `${seed}-${startedAt}`,
    seed,
    gridSize: { ...gridSize },
    startedAt,
    endedAt: null,
    attempts: [],
    midAttemptRestores: 0,
    chapter: null,
    endingAgree: null,
    stats: null,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 원문 → MetricsData. 파싱 실패·version 불일치·구조 불일치면 { ok: false } (호출부가 키 삭제 + console.warn 후 새로 시작).
 * 구조 검사는 최상위·life·attempt의 뼈대만 본다 (metrics는 관찰 기록이라 게임 저장만큼 엄격하지 않다).
 */
export function parseMetrics(raw: string | null): { ok: true; data: MetricsData } | { ok: false; reason: string } {
  if (raw === null) return { ok: false, reason: '없음' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `JSON 파싱 실패: ${(e as Error).message}` };
  }
  if (!isObj(v)) return { ok: false, reason: '객체가 아님' };
  if (v.version !== METRICS_VERSION) return { ok: false, reason: `version 불일치: ${String(v.version)}` };
  if (typeof v.firstSeen !== 'string' || !Array.isArray(v.sessions) || !Array.isArray(v.lives)) {
    return { ok: false, reason: '구조 불일치 (firstSeen·sessions·lives)' };
  }
  for (const [i, l] of (v.lives as unknown[]).entries()) {
    if (!isObj(l) || typeof l.lifeId !== 'string' || !Array.isArray(l.attempts)) {
      return { ok: false, reason: `구조 불일치 (lives[${i}])` };
    }
    for (const [j, d] of (l.attempts as unknown[]).entries()) {
      if (!isObj(d) || typeof d.attempt !== 'number' || !isObj(d.record) || !isObj(d.formation)) {
        return { ok: false, reason: `구조 불일치 (lives[${i}].attempts[${j}])` };
      }
    }
  }
  const data = v as unknown as MetricsData;
  if (data.inProgress === undefined) data.inProgress = null;
  return { ok: true, data };
}

/**
 * 상한: 세션 500, 일생 20 (오래된 것부터 버림), 직렬화 1.5MB 초과 시 가장 오래된 판의 시도 기록부터 버림.
 * 제자리 수정. 잘라낸 내용을 경고 메시지로 돌려준다 (없으면 빈 배열).
 */
export function enforceLimits(data: MetricsData, maxBytes = MAX_BYTES): string[] {
  const warnings: string[] = [];
  if (data.sessions.length > MAX_SESSIONS) {
    const n = data.sessions.length - MAX_SESSIONS;
    data.sessions.splice(0, n);
    warnings.push(`세션 ${n}개 버림 (상한 ${MAX_SESSIONS})`);
  }
  if (data.lives.length > MAX_LIVES) {
    const n = data.lives.length - MAX_LIVES;
    data.lives.splice(0, n);
    warnings.push(`일생 ${n}개 버림 (상한 ${MAX_LIVES})`);
  }
  let size = byteLength(JSON.stringify(data));
  for (const life of data.lives) {
    let cut = 0;
    while (size > maxBytes && life.attempts.length) {
      life.attempts.shift();
      cut += 1;
      size = byteLength(JSON.stringify(data));
    }
    if (cut) warnings.push(`판 ${life.lifeId}의 시도 기록 ${cut}개 버림 (크기 상한 ${maxBytes}B)`);
    if (size <= maxBytes) break;
  }
  return warnings;
}

/** UTF-8 바이트 수 (TextEncoder 없이) */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * 시도 도중 복원 감지: 부팅 시 inProgress가 남아 있고, 복원된 저장이 같은 lifeId의 장면 카드(dayStart)이며
 * 그 시도가 아직 끝나지 않았으면(저장된 시도 수 < inProgress.attempt) midAttemptRestores += 1. 어느 경우든 inProgress는 지운다.
 */
export function detectMidAttemptRestore(data: MetricsData, life: LifeMetrics, savedAttempt: number, phase: string): boolean {
  const ip = data.inProgress;
  data.inProgress = null;
  if (ip && ip.lifeId === life.lifeId && savedAttempt < ip.attempt && phase === 'dayStart') {
    life.midAttemptRestores += 1;
    return true;
  }
  return false;
}

// ── 요약 (디버그 metrics 탭) ──

export interface MetricsSummary {
  lives: number;
  attemptsCompleted: number;
  sessionDates: number;
  /** 공격대·수비대 팀 수 평균 */
  teamsMean: number | null;
  /** 배속 사용 시도 제외 */
  attemptLengthMedian: number | null;
  gridFullRatio: number | null;
  releases: number;
  /** 결과별 시도 수 */
  results: Record<string, number>;
  ratings: { good: number; meh: number; bad: number; again: number; tired: number };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

export function summarizeMetrics(lives: LifeMetrics[], sessions: SessionRecord[]): MetricsSummary {
  const atts = lives.flatMap((l) => l.attempts);
  const teams = atts.map((d) => d.formation.offense.length + d.formation.defense.length);
  const game = atts.reduce((s, d) => s + d.record.realSeconds, 0);
  const full = atts.reduce((s, d) => s + d.record.gridFullSeconds, 0);
  const results: Record<string, number> = {};
  for (const d of atts) results[d.result ?? '?'] = (results[d.result ?? '?'] ?? 0) + 1;
  const ratings = { good: 0, meh: 0, bad: 0, again: 0, tired: 0 };
  for (const d of atts) {
    if (d.rating?.day) ratings[d.rating.day] += 1;
    if (d.rating?.retry) ratings[d.rating.retry] += 1;
  }
  return {
    lives: lives.length,
    attemptsCompleted: atts.length,
    sessionDates: new Set(sessions.map((s) => s.realDate)).size,
    teamsMean: teams.length ? teams.reduce((a, b) => a + b, 0) / teams.length : null,
    attemptLengthMedian: median(atts.filter((d) => d.speedUsed === 0).map((d) => d.realSeconds)),
    gridFullRatio: game > 0 ? full / game : null,
    releases: atts.reduce((s, d) => s + d.record.releases, 0),
    results,
    ratings,
  };
}

/** 요약 → 디버그 패널 여러 줄 */
export function formatSummary(title: string, s: MetricsSummary): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const r = s.ratings;
  const res = s.results;
  return [
    `[${title}] 판 ${s.lives} · 시도 ${s.attemptsCompleted} · 세션 날짜 ${s.sessionDates}`,
    `편성 팀 수 평균 ${s.teamsMean === null ? '—' : s.teamsMean.toFixed(1)}`,
    `시도 ${s.attemptLengthMedian === null ? '—' : `${Math.round(s.attemptLengthMedian)}초`} · 가득 참 ${pct(s.gridFullRatio)} · 놓아주기 ${s.releases}`,
    `성공 ${res.success ?? 0} · 낮 실패 ${(res.dayTime ?? 0) + (res.dayFall ?? 0) + (res.returnTime ?? 0)} · 밤 실패 ${res.night ?? 0}`,
    `평가 ${r.good}/${r.meh}/${r.bad} · 다시/지침 ${r.again}/${r.tired}`,
  ].join('\n');
}

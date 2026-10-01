// metrics 데이터 형식·순수 로직 (스펙 §5.10-3). Phaser·브라우저 의존 없음 (저장·시간은 recorder.ts가 platform으로).
// metrics는 관찰만 한다: 게임 규칙은 이 값을 읽지 않는다.

import type { DayStats } from '../core/day';
import type { SummonRecord } from '../core/game';
import type { GrowthResult } from '../core/growth';
import type { GameStats } from '../core/stats';

export const METRICS_VERSION = 2;
export const MAX_SESSIONS = 500;
export const MAX_LIVES = 20;
/** 직렬화 결과 상한 (localStorage 5MB 대비) */
export const MAX_BYTES = 1.5 * 1024 * 1024;

export interface DayRating {
  day: 'good' | 'meh' | 'bad' | null;
  backflow: 'tense' | 'annoyed' | null;
}

export interface DropFails {
  invalid: number;
  laneFull: number;
  wildcard: number;
}

export interface DayMetrics {
  day: number;
  /** 그날을 끝낸 날짜 (디버그 날짜 오프셋 반영 / 실제) */
  date: string;
  realDate: string;
  eventId: string;
  dayStats: DayStats;
  summons: SummonRecord[];
  dropFails: DropFails;
  dragDistance: number;
  /** 그날 낮 + 밤의 실제 경과 시간(초, 배속·백그라운드 제외) = dayRealSeconds + nightRealSeconds */
  realSeconds: number;
  /** 낮(day 단계) 실제 시간 (v0.8) */
  dayRealSeconds: number;
  /** 밤(night 단계) 실제 시간 (v0.8) */
  nightRealSeconds: number;
  /** 낮에 손거울로 맡긴 수 (v0.8, = dayStats.reserved) */
  reserved: number;
  /** 그날 ×1이 아닌 배속을 쓴 실제 시간(초) */
  speedUsed: number;
  /** 그날 gating 우회 상태로 시작했는지 */
  bypass: boolean;
  rating: DayRating | null;
}

export interface LifeMetrics {
  lifeId: string;
  seed: number;
  gridSize: { cols: number; rows: number };
  startedAt: string;
  endedAt: string | null;
  days: DayMetrics[];
  milestoneChoices: { day: number; eventId: string; choiceId: string }[];
  midDayRestores: number;
  gatingBypassUsed: boolean;
  /** 판의 끝 (§5.15-5): 완성 여부·끝난 일차·스테이지. 진행 중이면 null */
  chapter: { completed: boolean; day: number; stage: number } | null;
  endingAgree: boolean | null;
  stats: GameStats | null;
  /** 자라기마다 소진 목록·갈래·특성 (§5.14-6). v0.10 이전 기록에는 없다 */
  growths?: GrowthResult[];
}

export interface SessionRecord {
  date: string;
  realDate: string;
  startedAt: string;
  foregroundSeconds: number;
  daysCompleted: number;
}

export interface MetricsData {
  version: 2;
  firstSeen: string;
  sessions: SessionRecord[];
  lives: LifeMetrics[];
  /** confirmDay 때 기록, 하루 끝에 지움. 부팅 시 남아 있으면 판 도중 종료 */
  inProgress: { lifeId: string; day: number } | null;
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
    days: [],
    milestoneChoices: [],
    midDayRestores: 0,
    gatingBypassUsed: false,
    chapter: null,
    endingAgree: null,
    stats: null,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 원문 → MetricsData. 파싱 실패·version 불일치·구조 불일치면 { ok: false } (호출부가 키 삭제 + console.warn 후 새로 시작).
 * 구조 검사는 최상위·life·day의 뼈대만 본다 (metrics는 관찰 기록이라 게임 저장만큼 엄격하지 않다).
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
    if (!isObj(l) || typeof l.lifeId !== 'string' || !Array.isArray(l.days) || !Array.isArray(l.milestoneChoices)) {
      return { ok: false, reason: `구조 불일치 (lives[${i}])` };
    }
    for (const [j, d] of (l.days as unknown[]).entries()) {
      if (!isObj(d) || typeof d.day !== 'number' || !isObj(d.dayStats) || !Array.isArray(d.summons)) {
        return { ok: false, reason: `구조 불일치 (lives[${i}].days[${j}])` };
      }
    }
  }
  const data = v as unknown as MetricsData;
  if (data.inProgress === undefined) data.inProgress = null;
  return { ok: true, data };
}

/**
 * 상한: 세션 500, 일생 20 (오래된 것부터 버림), 직렬화 1.5MB 초과 시 가장 오래된 life의 summons부터 비움.
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
    if (size <= maxBytes) break;
    let cleared = 0;
    for (const d of life.days) {
      if (size <= maxBytes) break;
      if (d.summons.length === 0) continue;
      cleared += d.summons.length;
      d.summons = [];
      size = byteLength(JSON.stringify(data));
    }
    if (cleared) warnings.push(`일생 ${life.lifeId}의 소환 기록 ${cleared}개 비움 (크기 상한 ${maxBytes}B)`);
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
 * 판 도중 복원 감지 (§5.10-3): 부팅 시 inProgress가 남아 있고, 복원된 저장이 같은 lifeId·day의 dayStart면 midDayRestores += 1.
 * 어느 경우든 inProgress는 지운다. 감지했으면 true.
 */
export function detectMidDayRestore(data: MetricsData, life: LifeMetrics, day: number, phase: string): boolean {
  const ip = data.inProgress;
  data.inProgress = null;
  if (ip && ip.lifeId === life.lifeId && ip.day === day && phase === 'dayStart') {
    life.midDayRestores += 1;
    return true;
  }
  return false;
}

// ── 요약 (디버그 metrics 탭) ──

export interface MetricsSummary {
  lives: number;
  daysCompleted: number;
  sessionDates: number;
  unhappyRatio: number | null;
  tierShare: Record<string, number>;
  /** 배속 사용일 제외 */
  dayLengthMedian: number | null;
  gridFullRatio: number | null;
  releases: number;
  backflows: number;
  bossWins: number;
  ratings: { good: number; meh: number; bad: number; tense: number; annoyed: number };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

export function summarizeMetrics(lives: LifeMetrics[], sessions: SessionRecord[]): MetricsSummary {
  const days = lives.flatMap((l) => l.days);
  const summons = days.flatMap((d) => d.summons);
  const down = summons.filter((s) => s.side === 'unhappy').length;
  const tierCount: Record<string, number> = {};
  for (const s of summons) tierCount[s.tier] = (tierCount[s.tier] ?? 0) + 1;
  const tierShare: Record<string, number> = {};
  for (const [t, c] of Object.entries(tierCount)) tierShare[t] = c / summons.length;
  const game = days.reduce((s, d) => s + d.dayStats.realSeconds, 0);
  const full = days.reduce((s, d) => s + d.dayStats.gridFullSeconds, 0);
  const ratings = { good: 0, meh: 0, bad: 0, tense: 0, annoyed: 0 };
  for (const d of days) {
    if (d.rating?.day) ratings[d.rating.day] += 1;
    if (d.rating?.backflow) ratings[d.rating.backflow] += 1;
  }
  return {
    lives: lives.length,
    daysCompleted: days.length,
    sessionDates: new Set(sessions.map((s) => s.realDate)).size,
    unhappyRatio: summons.length ? down / summons.length : null,
    tierShare,
    dayLengthMedian: median(days.filter((d) => d.speedUsed === 0).map((d) => d.realSeconds)),
    gridFullRatio: game > 0 ? full / game : null,
    releases: days.reduce((s, d) => s + d.dayStats.releases, 0),
    backflows: days.filter((d) => d.dayStats.backflow).length,
    bossWins: days.filter((d) => d.dayStats.bossWin === 1).length,
    ratings,
  };
}

/** 요약 → 디버그 패널 여러 줄 */
export function formatSummary(title: string, s: MetricsSummary): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const tiers = Object.entries(s.tierShare)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([t, x]) => `${t}:${pct(x)}`)
    .join(' ');
  const r = s.ratings;
  return [
    `[${title}] 일생 ${s.lives} · 날 ${s.daysCompleted} · 세션 날짜 ${s.sessionDates}`,
    `Unhappy ${pct(s.unhappyRatio)} · 단계 ${tiers || '—'}`,
    `하루 ${s.dayLengthMedian === null ? '—' : `${Math.round(s.dayLengthMedian)}초`} · 가득 참 ${pct(s.gridFullRatio)} · 놓아주기 ${s.releases}`,
    `역류 ${s.backflows} (처치 ${s.bossWins}) · 평가 ${r.good}/${r.meh}/${r.bad} · 긴장/짜증 ${r.tense}/${r.annoyed}`,
  ].join('\n');
}

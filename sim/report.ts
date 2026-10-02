// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1).
// M8.9 (§5.17-7, [11]-4): 챕터 완성률·완성 일차, 영웅별 점수·기세·쓰러짐·버프 회복, 병사 수·피해 비중·때 맞춤·상한.
import type { OverrideValue } from './overrides';
import type { RunResult } from './runner';
import type { SimConfig } from './types';

export interface Summary {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  /** 값이 있는 시드 수 (null 제외) */
  n: number;
}

export interface PolicyReport {
  version: 2;
  policy: string;
  createdAt: string;
  options: {
    seeds: number;
    grid: string;
    /** 실제 하루 구조만 (한 판 = 1챕터, 최대 maxDays일) */
    mode: 'life';
    /** chapter.maxDays */
    days: number;
    wavesPerNight: number;
    /** 이 리포트를 만든 먹이기 배분 r (낮덱 몫, balanced·lazy가 쓴다) */
    feedRatio: number;
    /** --set으로 덮어쓴 값 (전체 경로 → 값). 없으면 JSON 그대로 */
    overrides?: Record<string, OverrideValue>;
  };
  sim: Omit<SimConfig, 'm3Goals' | 'm5Goals' | 'm89Goals'>;
  summary: Record<string, Summary>;
  /** 첫 가라앉음이 없었던 시드 비율 */
  neverSankRatio: number;
  /** 일차별 곡선: 하루 끝 기쁨(중앙값·10/90), 가라앉음(평균), 그림자(중앙값·p90), 하루 길이(중앙값, ×1 초) */
  curves: {
    day: number;
    joyMedian: number;
    joyP10: number;
    joyP90: number;
    sunkMean: number;
    shadowMedian: number;
    shadowP90: number;
    lengthMedian: number;
  }[];
  /** 보스 등장 진단 (§5.7): 슬롯·준비 여부별, 등장 시 디펜스 우리 편 수별 처치율 */
  bossDiag: BossDiag;
  /** 먹인 단계 분포 (전 시드 합산 비율) */
  feedTierShare: Record<string, number>;
  /** 챕터 진행 (§5.15-6) */
  chapter: ChapterStats;
  /** 병사 출전 체인·단별 (전 시드 합) */
  soldiersByKind: Record<string, number>;
  runs: RunResult[];
}

/** 챕터 진행 요약 (§5.15-6) */
export interface ChapterStats {
  /** 판 수 */
  n: number;
  /** 1-length를 정화해 완성한 판 비율 */
  completedRate: number;
  /** maxDays 미완성 비율 (나머지는 시간 상한 중단) */
  unfinishedRate: number;
  /** 완성 일차 (완성한 판만) */
  completeDay: Summary;
  /** 1-turningPoint 도달 일차 (도달한 판만) / 도달 비율 */
  turningPointReachedDay: Summary;
  turningPointReachedRate: number;
  /** 1-turningPoint 정화 일차 (정화한 판만) */
  turningPointClearedDay: Summary;
  /** 끝났을 때 스테이지 */
  stage: Summary;
}

export function chapterStats(runs: RunResult[]): ChapterStats {
  const n = runs.length;
  const done = runs.filter((r) => r.completed === true);
  const reached = runs.filter((r) => r.turningPointReachedDay !== null);
  return {
    n,
    completedRate: n ? done.length / n : 0,
    unfinishedRate: n ? runs.filter((r) => r.completed === false).length / n : 0,
    completeDay: summarize(done.map((r) => r.endDay)),
    turningPointReachedDay: summarize(reached.map((r) => r.turningPointReachedDay)),
    turningPointReachedRate: n ? reached.length / n : 0,
    turningPointClearedDay: summarize(runs.map((r) => r.turningPointClearedDay)),
    stage: summarize(runs.map((r) => r.stage)),
  };
}

/** 중반 가라앉음 구간 (§5.15-6): 6~12일차 */
export const MID_DAYS: [number, number] = [6, 12];

export interface BossDiagRow {
  n: number;
  wins: number;
  /** 결과가 난 보스 중 처치 비율 */
  winRate: number | null;
}

export interface BossDiag {
  total: number;
  /** key = "morning|prep", "noon|-" 처럼 웨이브 칸|준비여부 */
  bySlot: Record<string, BossDiagRow>;
  /** key = 등장 시 디펜스 레인 우리 편 수 (영웅 + 병사) */
  byDefense: Record<string, BossDiagRow>;
}

export function bossDiagnostics(runs: RunResult[]): BossDiag {
  const bySlot: Record<string, BossDiagRow> = {};
  const byDefense: Record<string, BossDiagRow> = {};
  let total = 0;
  const add = (map: Record<string, BossDiagRow>, key: string, win: boolean | null) => {
    const row = (map[key] ??= { n: 0, wins: 0, winRate: null });
    row.n += 1;
    if (win) row.wins += 1;
  };
  const decided: Record<string, number> = {};
  for (const r of runs) {
    for (const b of r.bossLog) {
      total += 1;
      const sk = `${b.slot}|${b.prep ? 'prep' : '-'}`;
      const dk = String(b.defenseUnits);
      add(bySlot, sk, b.win);
      add(byDefense, dk, b.win);
      if (b.win !== null) {
        decided[`s:${sk}`] = (decided[`s:${sk}`] ?? 0) + 1;
        decided[`d:${dk}`] = (decided[`d:${dk}`] ?? 0) + 1;
      }
    }
  }
  for (const [k, row] of Object.entries(bySlot)) row.winRate = decided[`s:${k}`] ? row.wins / decided[`s:${k}`] : null;
  for (const [k, row] of Object.entries(byDefense)) row.winRate = decided[`d:${k}`] ? row.wins / decided[`d:${k}`] : null;
  return { total, bySlot, byDefense };
}

/** 한 판의 일차별 (하루 끝 기쁨 − 하루 시작 기쁨) 중앙값 */
export function dayJoyDeltaMedian(r: RunResult): number | null {
  const d = dayJoyDeltas(r);
  return d.length === 0 ? null : quantile([...d].sort((a, b) => a - b), 0.5);
}

export function dayJoyDeltas(r: RunResult): number[] {
  const out: number[] = [];
  for (let i = 0; i < r.dayEndJoy.length; i++) {
    if (r.dayStartJoy[i] !== undefined && r.dayEndJoy[i] !== undefined) out.push(r.dayEndJoy[i] - r.dayStartJoy[i]);
  }
  return out;
}

/** 선형 보간 백분위 (q ∈ [0,1]) */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(xs: number[]): number | null {
  return xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null;
}

export function summarize(values: (number | null)[]): Summary {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const mean = xs.length === 0 ? NaN : xs.reduce((s, v) => s + v, 0) / xs.length;
  return { mean, median: quantile(xs, 0.5), p10: quantile(xs, 0.1), p90: quantile(xs, 0.9), n: xs.length };
}

const sumPts = (p: Record<string, number>) => Object.values(p).reduce((s, v) => s + v, 0);
const totalDamage = (r: RunResult) => r.damageHero + r.damageSoldier + r.damageBase;

/** 요약에 넣는 지표 (표 순서). 낮 = 오펜스, 밤 = 디펜스 (역할 기준 이름, §5.17-10) */
export const METRICS: { key: string; label: string; get: (r: RunResult) => number | null }[] = [
  { key: 'firstSinkWave', label: '첫 가라앉음 웨이브', get: (r) => r.firstSinkWave },
  { key: 'firstSinkDay', label: '첫 가라앉음 일차', get: (r) => r.firstSinkDay },
  { key: 'dayLength', label: '하루 길이(초, ×1)', get: (r) => median(r.dayLengths) },
  { key: 'dayLengthOffense', label: '오펜스(낮) 길이(초)', get: (r) => median(r.dayLengthsOffense) },
  { key: 'dayLengthDefense', label: '디펜스(밤) 길이(초)', get: (r) => median(r.dayLengthsDefense) },
  { key: 'earlySunk', label: '1~2일차 가라앉음', get: (r) => (r.sunkByDay[0] ?? 0) + (r.sunkByDay[1] ?? 0) },
  {
    key: 'midSunk',
    label: `중반(${MID_DAYS[0]}~${MID_DAYS[1]}일차) 가라앉음`,
    get: (r) => (r.days >= MID_DAYS[0] ? r.sunkByDay.slice(MID_DAYS[0] - 1, MID_DAYS[1]).reduce((a, b) => a + b, 0) : null),
  },
  { key: 'sunk', label: '가라앉은 수', get: (r) => r.sunk },
  { key: 'kills', label: '처치 수', get: (r) => r.kills },
  { key: 'finalJoy', label: '최종 기쁨', get: (r) => r.finalJoy },
  { key: 'gridFullRatio', label: '그리드 가득 참 비율', get: (r) => r.gridFullRatio },
  { key: 'layersCleared', label: '오펜스 층 돌파', get: (r) => r.layersCleared },
  { key: 'backflows', label: '역류', get: (r) => r.backflows },
  { key: 'bossWins', label: '역류 보스 처치', get: (r) => r.bossWins },
  { key: 'maxShadow', label: '최대 그림자', get: (r) => r.maxShadow },
  // §5.17-7
  { key: 'feeds', label: '먹이기 수', get: (r) => r.feeds },
  { key: 'offensePoints', label: '낮덱(오펜스) 점수', get: (r) => sumPts(r.heroPoints.offense) },
  { key: 'defensePoints', label: '밤덱(디펜스) 점수', get: (r) => sumPts(r.heroPoints.defense) },
  { key: 'merges', label: '머지 수', get: (r) => r.merges },
  { key: 'battleMergeRatio', label: '전투 중 머지 비율', get: (r) => (r.merges ? r.battleMerges / r.merges : null) },
  { key: 'momentumAvg', label: '기세 평균 중첩', get: (r) => r.momentumAvg },
  { key: 'offenseFalls', label: '쓰러짐 (낮 오펜스)', get: (r) => r.offenseFalls },
  { key: 'defenseFalls', label: '쓰러짐 (밤 디펜스)', get: (r) => r.defenseFalls },
  { key: 'buffHeal', label: '버프 회복 hp', get: (r) => r.buffHeal },
  // [11]-4
  { key: 'soldiers', label: '병사 출전', get: (r) => r.soldiers },
  { key: 'soldiersCapped', label: '상한으로 막힌 병사', get: (r) => r.soldiersCapped },
  { key: 'soldierShare', label: '피해 중 병사 비중', get: (r) => (totalDamage(r) > 0 ? r.damageSoldier / totalDamage(r) : null) },
  { key: 'affinityRatio', label: '때 맞춤 머지 비율 (전투 중)', get: (r) => (r.battleMerges ? r.affinityMerges / r.battleMerges : null) },
  { key: 'bossFloorsCleared', label: '보스 층 돌파', get: (r) => r.bossFloorsCleared },
  { key: 'wildcardsGained', label: '와일드카드 획득', get: (r) => r.wildcardsGained },
  { key: 'abyssDeaths', label: '오펜스 병사 쓰러짐', get: (r) => r.abyssDeaths },
  { key: 'lostReturns', label: '지급 소실', get: (r) => r.lostReturns },
  { key: 'releases', label: '놓아주기 수', get: (r) => r.releases },
  { key: 'dayJoyDelta', label: '하루 끝−시작 기쁨', get: (r) => dayJoyDeltaMedian(r) },
  { key: 'day1Sunk', label: '1일차 가라앉음', get: (r) => r.day1Sunk },
  { key: 'mistakes', label: '실수(원위치)', get: (r) => r.mistakes },
];

export function buildReport(policy: string, runs: RunResult[], options: PolicyReport['options'], cfg: SimConfig): PolicyReport {
  const summary: Record<string, Summary> = {};
  for (const m of METRICS) summary[m.key] = summarize(runs.map(m.get));

  const maxDay = Math.max(0, ...runs.map((r) => r.days));
  const curves: PolicyReport['curves'] = [];
  for (let k = 0; k < maxDay; k++) {
    const joy = summarize(runs.map((r) => r.joyByDay[k] ?? null));
    const sunk = summarize(runs.map((r) => r.sunkByDay[k] ?? null));
    const sh = summarize(runs.map((r) => r.shadowByDay[k] ?? null));
    const len = summarize(runs.map((r) => r.dayLengths[k] ?? null));
    curves.push({
      day: k + 1,
      joyMedian: joy.median,
      joyP10: joy.p10,
      joyP90: joy.p90,
      sunkMean: sunk.mean,
      shadowMedian: sh.median,
      shadowP90: sh.p90,
      lengthMedian: len.median,
    });
  }

  const tierCount: Record<string, number> = {};
  let total = 0;
  const soldiersByKind: Record<string, number> = {};
  for (const r of runs) {
    for (const [t, c] of Object.entries(r.feedTiers)) {
      tierCount[t] = (tierCount[t] ?? 0) + c;
      total += c;
    }
    for (const [k, c] of Object.entries(r.soldiersByKind)) soldiersByKind[k] = (soldiersByKind[k] ?? 0) + c;
  }
  const feedTierShare: Record<string, number> = {};
  for (const [t, c] of Object.entries(tierCount)) feedTierShare[t] = total === 0 ? 0 : c / total;

  const { m3Goals: _m3, m5Goals: _m5, m89Goals: _m89, ...sim } = cfg;
  return {
    version: 2,
    policy,
    createdAt: new Date().toISOString(),
    options,
    sim,
    summary,
    neverSankRatio: runs.filter((r) => r.firstSinkWave === null).length / Math.max(1, runs.length),
    curves,
    bossDiag: bossDiagnostics(runs),
    feedTierShare,
    chapter: chapterStats(runs),
    soldiersByKind,
    runs,
  };
}

// ── 콘솔 출력 ──

function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function pctOf(x: number): string {
  return `${fmt(x * 100, 1)}%`;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i], i > 0)).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** 한글은 폭 2로 계산 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯⺀-鿿]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, w: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, w - width(s)));
  return right ? fill + s : s + fill;
}

/** --set 요약 한 줄. 없으면 빈 문자열 */
export function overridesLine(r: PolicyReport): string {
  const o = r.options.overrides;
  if (!o || Object.keys(o).length === 0) return '';
  return `(--set ${Object.entries(o)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')})`;
}

/** 정책 이름 + r (balanced·lazy) */
export function policyLabel(r: PolicyReport): string {
  return r.policy === 'balanced' || r.policy === 'lazy' ? `${r.policy}(${r.options.feedRatio})` : r.policy;
}

export function formatReport(r: PolicyReport): string {
  const o = r.options;
  const ov = overridesLine(r);
  const lines = [
    ...(ov ? [ov] : []),
    `■ ${policyLabel(r)}  (시드 ${o.seeds}, 그리드 ${o.grid}, 최대 ${o.days}일)`,
    table(
      // n: 값이 있는 시드 수 (첫 가라앉음이 없던 시드는 빠진다)
      ['지표', '평균', '중앙값', 'p10', 'p90', 'n'],
      METRICS.map((m) => {
        const s = r.summary[m.key];
        return [m.label, fmt(s.mean), fmt(s.median), fmt(s.p10), fmt(s.p90), String(s.n)];
      }),
    ),
    `가라앉음 없이 끝난 시드: ${fmt(r.neverSankRatio * 100, 1)}%`,
    `먹인 단계 분포: ${tierLine(r.feedTierShare)}`,
    '일차별 (하루 끝 기쁨 중앙값 [p10~p90] / 가라앉음 평균 / 그림자 중앙값 [p90] / 하루 길이 중앙값):',
    curveLine(r),
    formatBossDiag(r),
    formatChapter(r),
    formatHeroes(r),
  ];
  return lines.join('\n');
}

function tierLine(share: Record<string, number>): string {
  return (
    Object.entries(share)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([t, s]) => `${t}단계 ${fmt(s * 100, 1)}%`)
      .join(' / ') || '—'
  );
}

/** 챕터 진행 (§5.15-6): 완성률·완성 일차·1-5 도달·끝난 스테이지 */
export function formatChapter(r: PolicyReport): string {
  const c = r.chapter;
  if (!c || c.n === 0) return '챕터: 판 없음';
  const q = (s: Summary, d = 1) => (s.n ? `p10 ${fmt(s.p10, d)} / p50 ${fmt(s.median, d)} / p90 ${fmt(s.p90, d)} (n=${s.n})` : '—');
  return [
    `챕터 완성률 ${pctOf(c.completedRate)} · 미완성 ${pctOf(c.unfinishedRate)}${c.completedRate + c.unfinishedRate < 1 - 1e-9 ? ` · 중단 ${pctOf(1 - c.completedRate - c.unfinishedRate)}` : ''}`,
    `  완성 일차: ${q(c.completeDay)}`,
    `  1-5 도달 일차: ${q(c.turningPointReachedDay)} · 도달 ${pctOf(c.turningPointReachedRate)}  / 1-5 정화 일차: ${q(c.turningPointClearedDay)}`,
    `  끝난 스테이지: ${q(c.stage)}`,
  ].join('\n');
}

/** 영웅별 최종 체인 점수 (전 시드 평균) + 병사 체인·단별 수 */
export function formatHeroes(r: PolicyReport): string {
  const n = Math.max(1, r.runs.length);
  const chains = [...new Set(r.runs.flatMap((x) => [...Object.keys(x.heroPoints.offense), ...Object.keys(x.heroPoints.defense)]))].sort();
  const ids = (role: 'offense' | 'defense') => [...new Set(r.runs.map((x) => x.heroIds[role]))].join('/');
  const line = (role: 'offense' | 'defense') =>
    chains.length ? chains.map((c) => `${c} ${fmt(r.runs.reduce((s, x) => s + (x.heroPoints[role][c] ?? 0), 0) / n, 1)}`).join(' · ') : '없음';
  const sold = Object.entries(r.soldiersByKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `${k}단 ${fmt(c / n, 2)}`)
    .join(' · ');
  return [
    `영웅 최종 점수 (판당 평균) — 낮덱 ${ids('offense')}: ${line('offense')} / 밤덱 ${ids('defense')}: ${line('defense')}`,
    `병사 출전 (판당 평균, 체인:단): ${sold || '없음'}`,
  ].join('\n');
}

function curveLine(r: PolicyReport): string {
  return r.curves
    .map(
      (c) =>
        `  ${String(c.day).padStart(2)}일: 기쁨 ${fmt(c.joyMedian, 0)} [${fmt(c.joyP10, 0)}~${fmt(c.joyP90, 0)}] / 가라앉음 ${fmt(c.sunkMean)} / 그림자 ${fmt(c.shadowMedian, 0)} [${fmt(c.shadowP90, 0)}] / ${fmt(c.lengthMedian, 0)}초`,
    )
    .join('\n');
}

const SLOT_LABEL: Record<string, string> = { morning: '밤 1웨이브', noon: '밤 2웨이브', evening: '밤 3웨이브' };

/** 보스 등장 진단 표 (§5.7) */
export function formatBossDiag(r: PolicyReport): string {
  const d = r.bossDiag;
  if (!d || d.total === 0) return '보스 등장 진단: 보스 없음';
  const pct = (x: number | null) => (x === null ? '—' : `${fmt(x * 100, 0)}%`);
  const slotRows = ['morning', 'noon', 'evening'].flatMap((s) =>
    ['prep', '-'].flatMap((p) => {
      const row = d.bySlot[`${s}|${p}`];
      return row ? [[`${SLOT_LABEL[s]}${p === 'prep' ? ' (준비 시간)' : ''}`, String(row.n), String(row.wins), pct(row.winRate)]] : [];
    }),
  );
  const defRows = Object.keys(d.byDefense)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => [`디펜스 우리 편 ${k}`, String(d.byDefense[k].n), String(d.byDefense[k].wins), pct(d.byDefense[k].winRate)]);
  return [
    `보스 등장 진단 (전 시드 ${d.total}회): 웨이브·준비 여부별 / 등장 시 디펜스 우리 편(영웅+병사) 수별`,
    table(['구분', '등장', '처치', '처치율'], [...slotRows, ...defRows]),
  ].join('\n');
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['sunk', 'earlySunk', 'midSunk', 'layersCleared', 'backflows', 'offensePoints', 'defensePoints', 'battleMergeRatio', 'momentumAvg', 'offenseFalls', 'defenseFalls', 'soldiers', 'soldierShare', 'affinityRatio', 'soldiersCapped'];
  const header = ['정책', ...keys.map((k) => METRICS.find((m) => m.key === k)!.label + ' (중앙값)'), '완성%', '완성일 p50', '1-5 도달 p50'];
  const rows = reports.map((r) => [
    policyLabel(r),
    ...keys.map((k) => fmt(r.summary[k].median) + (r.summary[k].n < r.runs.length ? ` (n=${r.summary[k].n})` : '')),
    fmt(r.chapter.completedRate * 100, 1),
    fmt(r.chapter.completeDay.median, 1),
    fmt(r.chapter.turningPointReachedDay.median, 1),
  ]);
  return table(header, rows);
}

/** --compare: 같은 정책의 수치 변경 전후 */
export function formatCompare(a: PolicyReport, b: PolicyReport): string {
  const rows = METRICS.filter((m) => a.summary[m.key] && b.summary[m.key]).map((m) => {
    const x = a.summary[m.key];
    const y = b.summary[m.key];
    const d = y.median - x.median;
    return [m.label, fmt(x.mean), fmt(y.mean), fmt(x.median), fmt(y.median), (d > 0 ? '+' : '') + fmt(d)];
  });
  rows.push(['챕터 완성률', pctOf(a.chapter.completedRate), pctOf(b.chapter.completedRate), '', '', '']);
  const head =
    `비교: ${policyLabel(a)} (${a.createdAt}) → ${policyLabel(b)} (${b.createdAt})` +
    `\n  A ${overridesLine(a) || '(JSON 그대로)'}\n  B ${overridesLine(b) || '(JSON 그대로)'}`;
  const warn =
    a.policy !== b.policy || a.options.grid !== b.options.grid || a.options.days !== b.options.days
      ? '\n※ 정책·그리드·판 조건이 다릅니다. 조건을 맞춰 비교하세요 (M8.9 이전 리포트와는 비교하지 마세요).'
      : '';
  return `${head}${warn}\n${table(['지표', '평균 A', '평균 B', '중앙값 A', '중앙값 B', 'Δ중앙값'], rows)}`;
}

// ── §8.2 목표 ──

export interface GoalCheck {
  /** 비교 표 열 이름 (짧게). 판정 기준 안내 같은 항목은 없음 */
  id?: string;
  label: string;
  pass: boolean | null;
  detail: string;
}

/** --saveRoundTrip 결과 (정책별 일치 시드 수) */
export interface RoundTripCheck {
  policy: string;
  matched: number;
  total: number;
  /** 어긋난 시드 (앞 몇 개) */
  mismatchSeeds: number[];
}

/** §8.2 M3 부분 목표 중 M8.9에서도 뜻이 있는 것: idle 1일차 가라앉음, 기쁨이 남지 않음, 그리드가 찰 때가 있음 */
export function checkM3Goals(reports: PolicyReport[], goals: SimConfig['m3Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const na = (label: string, why: string) => out.push({ label, pass: null, detail: why });

  const idle = reports.find((r) => r.policy === 'idle');
  const idleLabel = `idle: ${goals.idleSinkByDay}일차에 가라앉음`;
  if (idle) {
    const limit = goals.idleSinkByDay * idle.options.wavesPerNight;
    const ok = idle.runs.every((r) => r.firstSinkWave !== null && r.firstSinkWave <= limit);
    out.push({ label: idleLabel, pass: ok, detail: `첫 가라앉음 웨이브 중앙값 ${fmt(idle.summary.firstSinkWave.median)} (웨이브 ${limit} 이내, 전 시드 ${ok ? '충족' : '미충족'})` });
  } else na(idleLabel, 'idle을 실행하지 않음');

  const bal = reports.find((r) => r.policy === 'balanced');
  if (bal) {
    const deltas = bal.runs.flatMap(dayJoyDeltas).sort((a, b) => a - b);
    const med = quantile(deltas, 0.5);
    const shareOk = deltas.length ? deltas.filter((d) => d <= goals.dayEndJoyMaxDelta).length / deltas.length : NaN;
    out.push({
      label: 'balanced: 하루 끝 남는 기쁨 ≤ 하루 시작 기쁨',
      pass: deltas.length ? med <= goals.dayEndJoyMaxDelta : null,
      detail: deltas.length
        ? `하루 끝−시작 기쁨 중앙값 ${fmt(med)} [p10 ${fmt(quantile(deltas, 0.1))} ~ p90 ${fmt(quantile(deltas, 0.9))}], 충족한 날 ${fmt(shareOk * 100, 1)}%`
        : '하루 단위 기록 없음',
    });
    const withFull = bal.runs.filter((r) => r.gridFullRatio > goals.gridFullRatioMin).length / Math.max(1, bal.runs.length);
    const g = bal.summary.gridFullRatio;
    out.push({
      label: `balanced: 그리드 가득 참 비율 > 0 (가득 차는 순간이 있는 시드 ≥ ${fmt(goals.gridFullRunShareMin * 100, 0)}%)`,
      pass: withFull >= goals.gridFullRunShareMin,
      detail: `가득 참 비율 평균 ${fmt(g.mean, 4)} / 중앙값 ${fmt(g.median, 4)}, 가득 차는 순간이 있는 시드 ${fmt(withFull * 100, 1)}%`,
    });
  } else na('balanced', 'balanced를 실행하지 않음');
  return out;
}

/** §8.2 M5 부분 목표 중 남는 것: 준비 시간 있는 보스 처치율, balanced 역류·초반, 하루 길이 보고 */
export function checkM5Goals(reports: PolicyReport[], goals: SimConfig['m5Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);
  const pct = (x: number | null) => (x === null ? '—' : `${fmt(x * 100, 1)}%`);

  // 낮에 예약되어 준비 시간이 있는 밤 첫 웨이브 보스, 등장 시 디펜스 영웅이 서 있었던 경우의 처치율 (전 정책 합산)
  {
    const prepped = reports.flatMap((r) => r.runs.flatMap((run) => run.bossLog)).filter((b) => b.prep);
    const ready = prepped.filter((b) => b.heroUp && b.win !== null);
    const wins = ready.filter((b) => b.win).length;
    const rate = ready.length ? wins / ready.length : null;
    out.push({
      id: '준비보스',
      label: `준비 시간이 있는 보스, 등장 시 영웅이 서 있음: 처치율 ≥ ${fmt(goals.prepMorningWinRateMin * 100, 0)}% (전 정책 합산, D-021)`,
      pass: rate === null ? null : rate >= goals.prepMorningWinRateMin,
      detail:
        `해당 ${ready.length}회, 처치 ${wins}회 (${pct(rate)}) · 준비 시간 있는 보스 전체 ${prepped.length}회 (정책별 해당/처치: ` +
        reports
          .map((r) => {
            const rs = r.runs.flatMap((run) => run.bossLog).filter((b) => b.prep && b.heroUp && b.win !== null);
            return `${r.policy} ${rs.length}/${rs.filter((b) => b.win).length}`;
          })
          .join(', ') +
        ')',
    });
  }

  const bal = get('balanced');
  if (bal) {
    out.push({
      id: 'B 역류',
      label: `balanced: 역류 0~${goals.balancedBackflowsMax}회 (중앙값)`,
      pass: bal.summary.backflows.median <= goals.balancedBackflowsMax,
      detail: `역류 중앙값 ${fmt(bal.summary.backflows.median)} [p10 ${fmt(bal.summary.backflows.p10)} ~ p90 ${fmt(bal.summary.backflows.p90)}], 보스 처치 중앙값 ${fmt(bal.summary.bossWins.median)}`,
    });
    const len = bal.summary.dayLength;
    const [lo, hi] = goals.dayLengthTargetSeconds;
    out.push({
      label: `하루 길이: 측정값 보고 (목표 ${fmt(lo / 60, 0)}~${fmt(hi / 60, 0)}분은 수치 조정 후 판정)`,
      pass: null,
      detail:
        `balanced 하루 길이 중앙값 ${fmt(len.median, 0)}초 (${fmt(len.median / 60, 1)}분) [p10 ${fmt(len.p10, 0)} ~ p90 ${fmt(len.p90, 0)}]` +
        ` · 오펜스(낮) ${fmt(bal.summary.dayLengthOffense.median, 0)}초 + 디펜스(밤) ${fmt(bal.summary.dayLengthDefense.median, 0)}초`,
    });
  } else out.push({ label: 'balanced', pass: null, detail: '실행하지 않음' });
  return out;
}

/**
 * §8.2 M8.9 진행 목표 (§5.17-7 + [11]-4, 안). 판정 출력만 하고 통과는 (b) 튜닝에서.
 * roundTrip이 주어지면 --saveRoundTrip 일치도 판정한다.
 */
export function checkM89Goals(reports: PolicyReport[], goals: SimConfig['m89Goals'], roundTrip: RoundTripCheck[] | null): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);
  const inRange = (x: number, [lo, hi]: number[]) => x >= lo - 1e-12 && x <= hi + 1e-12;
  const pct0 = (x: number) => fmt(x * 100, 0);
  const na = (label: string) => out.push({ label, pass: null, detail: '실행하지 않음' });

  const bal = get('balanced');
  if (bal) {
    const c = bal.chapter;
    const lb = policyLabel(bal);
    out.push({
      id: 'B 완성률',
      label: `${lb}: 챕터 완성률 ${pct0(goals.balancedCompleteRate[0])}~${pct0(goals.balancedCompleteRate[1])}%`,
      pass: inRange(c.completedRate, goals.balancedCompleteRate),
      detail: `완성 ${pctOf(c.completedRate)} · 미완성 ${pctOf(c.unfinishedRate)}`,
    });
    out.push({
      id: 'B 완성일',
      label: `${lb}: 완성 일차 중앙값 ${goals.balancedCompleteDay[0]}~${goals.balancedCompleteDay[1]}일`,
      pass: c.completeDay.n > 0 ? inRange(c.completeDay.median, goals.balancedCompleteDay) : false,
      detail: c.completeDay.n ? `중앙값 ${fmt(c.completeDay.median, 1)} [p10 ${fmt(c.completeDay.p10, 1)} ~ p90 ${fmt(c.completeDay.p90, 1)}]` : '완성한 판 없음',
    });
    const mid = bal.summary.midSunk;
    out.push({
      id: 'B 중반',
      label: `${lb}: 중반(${MID_DAYS[0]}~${MID_DAYS[1]}일) 가라앉음 중앙값 ≥ ${goals.balancedMidSunkMin} (긴장)`,
      pass: mid.n > 0 ? mid.median >= goals.balancedMidSunkMin : false,
      detail: mid.n ? `중앙값 ${fmt(mid.median)} [p10 ${fmt(mid.p10)} ~ p90 ${fmt(mid.p90)}] (n=${mid.n}, ${MID_DAYS[0]}일 전에 끝난 판 제외)` : `${MID_DAYS[0]}일까지 간 판 없음`,
    });
    const early = bal.summary.earlySunk;
    out.push({
      id: 'B 초반',
      label: `${lb}: 1~2일차 가라앉음 0~${goals.balancedEarlySinkMax} (중앙값, 초반은 쉽게)`,
      pass: early.median <= goals.balancedEarlySinkMax,
      detail: `중앙값 ${fmt(early.median)} [p90 ${fmt(early.p90)}]`,
    });
    const share = bal.summary.soldierShare;
    out.push({
      id: 'B 병사',
      label: `${lb}: 피해 중 병사 비중 ${pct0(goals.soldierDamageShare[0])}~${pct0(goals.soldierDamageShare[1])}% (중앙값)`,
      pass: share.n > 0 ? inRange(share.median, goals.soldierDamageShare) : false,
      detail: `중앙값 ${fmt(share.median * 100, 1)}% [p10 ${fmt(share.p10 * 100, 1)} ~ p90 ${fmt(share.p90 * 100, 1)}]`,
    });
  } else na('balanced');

  for (const name of ['dayOnly', 'nightOnly']) {
    const r = get(name);
    if (!r) {
      na(name);
      continue;
    }
    out.push({
      id: `${name}<30`,
      label: `${name}: 완성률 < ${pct0(goals.oneSidedCompleteMax)}% (한쪽만 키우면 못 깬다)`,
      pass: r.chapter.completedRate < goals.oneSidedCompleteMax,
      detail: `완성 ${pctOf(r.chapter.completedRate)} · 끝난 스테이지 중앙값 1-${fmt(r.chapter.stage.median, 0)}`,
    });
  }

  const lazy = get('lazy');
  if (lazy && bal) {
    const gap = bal.chapter.completedRate - lazy.chapter.completedRate;
    out.push({
      id: 'lazy 격차',
      label: `${policyLabel(lazy)}: 완성률이 ${policyLabel(bal)}보다 ${pct0(goals.lazyGapMin)}%p 이상 낮음 (전투 중 머지가 의미 있다)`,
      pass: gap >= goals.lazyGapMin - 1e-12,
      detail: `lazy ${pctOf(lazy.chapter.completedRate)} vs balanced ${pctOf(bal.chapter.completedRate)} (격차 ${fmt(gap * 100, 1)}%p)`,
    });
  } else na('lazy');

  const noFeed = get('noFeed');
  if (noFeed) {
    out.push({
      id: 'noFeed<30',
      label: `noFeed: 완성률 < ${pct0(goals.noFeedCompleteMax)}% (먹이기 없이 머지 효과만으로는 못 깬다)`,
      pass: noFeed.chapter.completedRate < goals.noFeedCompleteMax,
      detail: `완성 ${pctOf(noFeed.chapter.completedRate)} · 끝난 스테이지 중앙값 1-${fmt(noFeed.chapter.stage.median, 0)}`,
    });
  } else na('noFeed');

  const idle = get('idle');
  if (idle) out.push({ id: 'idle 0%', label: 'idle: 챕터 완성률 0%', pass: idle.chapter.completedRate === 0, detail: `완성 ${pctOf(idle.chapter.completedRate)}` });
  else na('idle');
  const rnd = get('random');
  if (rnd && bal) {
    out.push({
      id: 'random 낮음',
      label: 'random: 완성률이 balanced보다 낮음',
      pass: rnd.chapter.completedRate < bal.chapter.completedRate,
      detail: `random ${pctOf(rnd.chapter.completedRate)} vs balanced ${pctOf(bal.chapter.completedRate)}`,
    });
  } else na('random');
  const hoard = get('hoarder');
  if (hoard && bal) {
    out.push({
      id: 'hoarder<B',
      label: 'hoarder: 완성률이 balanced보다 낮음',
      pass: hoard.chapter.completedRate < bal.chapter.completedRate,
      detail: `hoarder ${pctOf(hoard.chapter.completedRate)} vs balanced ${pctOf(bal.chapter.completedRate)} (참고: 가라앉은 수 중앙값 ${fmt(hoard.summary.sunk.median)} vs ${fmt(bal.summary.sunk.median)})`,
    });
  } else na('hoarder');

  if (roundTrip) {
    const all = roundTrip.every((r) => r.matched === r.total);
    out.push({
      id: 'roundTrip',
      label: '--saveRoundTrip: 끈 실행과 결과 완전 일치',
      pass: all,
      detail: roundTrip
        .map((r) => `${r.policy} ${r.matched}/${r.total}${r.mismatchSeeds.length ? ` (어긋난 시드 ${r.mismatchSeeds.join(',')})` : ''}`)
        .join(' · '),
    });
  } else out.push({ label: '--saveRoundTrip', pass: null, detail: '--saveRoundTrip으로 실행하지 않음' });
  return out;
}

export function formatGoals(checks: GoalCheck[], title = '§8.2 M3 부분 목표'): string {
  const mark = (p: boolean | null) => (p === null ? '[ - ]' : p ? '[OK ]' : '[NG ]');
  return [title, ...checks.flatMap((c) => [`  ${mark(c.pass)} ${c.label}`, `        ${c.detail}`])].join('\n');
}

export interface SweepRow {
  value: OverrideValue;
  reports: PolicyReport[];
  goals: GoalCheck[];
}

/** 값별로 핵심 지표(중앙값)와 목표 충족 여부를 한 표에 */
export function formatSweep(key: string, rows: SweepRow[]): string {
  const goalIds = [...new Set(rows.flatMap((r) => r.goals.flatMap((g) => (g.id ? [g.id] : []))))];
  const header = ['값', '충족', ...goalIds];
  const body = rows.map((row) => {
    const judged = row.goals.filter((g) => g.id && g.pass !== null);
    const ok = judged.filter((g) => g.pass).length;
    const mark = (id: string) => {
      const g = row.goals.find((x) => x.id === id);
      return !g || g.pass === null ? '-' : g.pass ? 'OK' : 'NG';
    };
    return [JSON.stringify(row.value), `${ok}/${judged.length}`, ...goalIds.map(mark)];
  });
  // 정책별 상세 (중앙값): 완성률·완성일·가라앉음(전체·1~2일차·중반)·역류·층·점수·병사 비중
  const detailHeader = ['값', '정책', '완성%', '완성일', '1-5 도달', '가라앉음', '1~2일차', '중반', '역류', '층', '낮덱 점수', '밤덱 점수', '병사 비중', '쓰러짐 낮/밤'];
  const detailBody = rows.flatMap((row) =>
    row.reports.map((r) => {
      const m = (k: string, d = 1) => fmt(r.summary[k]?.median ?? NaN, d);
      return [
        JSON.stringify(row.value),
        policyLabel(r),
        fmt(r.chapter.completedRate * 100, 0),
        fmt(r.chapter.completeDay.median, 1),
        fmt(r.chapter.turningPointReachedDay.median, 1),
        m('sunk'),
        m('earlySunk'),
        m('midSunk'),
        m('backflows'),
        m('layersCleared'),
        m('offensePoints', 0),
        m('defensePoints', 0),
        fmt((r.summary.soldierShare?.median ?? NaN) * 100, 0) + '%',
        `${m('offenseFalls')}/${m('defenseFalls')}`,
      ];
    }),
  );
  return `■ --sweep ${key}\n${table(header, body)}\n\n정책별 상세 (중앙값)\n${table(detailHeader, detailBody)}`;
}

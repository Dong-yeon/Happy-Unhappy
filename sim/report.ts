// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1, §5.19-6).
// M8.10: 시도 상한 안 완성률, 총 시도 수, 같은 스테이지 연속 실패 최대값, 스테이지별 시도·첫 시도 성공률·실패 사유,
//        핵 떨어뜨림·운반 시간·돌아오는 길 실패, 핵 남은 HP 분포. + M8.9 영웅·먹이기·병사 지표.
import { ATTEMPT_RESULTS, type AttemptResult } from '../src/core/day';
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

/** 스테이지 하나 (전 시드) */
export interface StageRow {
  stage: number;
  /** 그 스테이지를 한 번이라도 시도한 판 비율 */
  reachedRate: number;
  /** 시도한 판의 시도 수 평균 */
  attemptsMean: number;
  /** 시도한 판 중 첫 시도 성공 비율 */
  firstTryRate: number | null;
  /** 시도 하나당 결과 비율 (전 시드 합) */
  resultShare: Record<AttemptResult, number>;
}

export interface PolicyReport {
  version: 3;
  policy: string;
  createdAt: string;
  options: {
    seeds: number;
    grid: string;
    /** 시도 상한 */
    maxAttempts: number;
    /** 이 리포트를 만든 먹이기 배분 r (낮덱 몫, balanced·lazy가 쓴다) */
    feedRatio: number;
    /** --set으로 덮어쓴 값 (전체 경로 → 값). 없으면 JSON 그대로 */
    overrides?: Record<string, OverrideValue>;
  };
  sim: Omit<SimConfig, 'm810Goals'>;
  summary: Record<string, Summary>;
  /** 시도 상한 안 완성률 */
  completedRate: number;
  /** 완성한 판의 총 시도 수 */
  completeAttempts: Summary;
  /** 끝난 스테이지 */
  stage: Summary;
  stages: StageRow[];
  /** 결과별 비율 (전 시드 시도 합) */
  resultShare: Record<AttemptResult, number>;
  /** 성공한 밤의 핵 남은 HP 분포 (전 시드 합) */
  coreHp: Summary & { buckets: number[] };
  /** 먹인 단계 분포 (전 시드 합산 비율) */
  feedTierShare: Record<string, number>;
  /** 병사 출전 체인·단별 (전 시드 합) */
  soldiersByKind: Record<string, number>;
  runs: RunResult[];
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
const dayFails = (r: RunResult) => r.results.dayTime + r.results.dayFall + r.results.returnTime;

/** 요약에 넣는 지표 (표 순서) */
export const METRICS: { key: string; label: string; get: (r: RunResult) => number | null }[] = [
  { key: 'attempts', label: '총 시도', get: (r) => r.attempts },
  { key: 'maxFailStreak', label: '연속 실패 최대', get: (r) => r.maxFailStreak },
  { key: 'stage', label: '끝난 스테이지', get: (r) => r.stage },
  { key: 'dayFails', label: '낮 실패', get: dayFails },
  { key: 'dayTime', label: '  가는 길 시간 초과', get: (r) => r.results.dayTime },
  { key: 'dayFall', label: '  가는 길 쓰러짐', get: (r) => r.results.dayFall },
  { key: 'returnTime', label: '  돌아오는 길 실패', get: (r) => r.results.returnTime },
  { key: 'nightFails', label: '밤 실패 (핵 HP 0)', get: (r) => r.results.night },
  { key: 'coreDrops', label: '핵 떨어뜨림', get: (r) => r.coreDrops },
  { key: 'coreReturns', label: '핵 되가져감 (적)', get: (r) => r.coreReturns },
  { key: 'carryTime', label: '운반 시간(초)', get: (r) => median(r.carryTimes) },
  { key: 'coreHpLeft', label: '핵 남은 HP (성공한 밤)', get: (r) => median(r.coreHpLeft) },
  { key: 'attemptLength', label: '시도 길이(초, ×1)', get: (r) => median(r.attemptLengths) },
  { key: 'offenseLength', label: '낮 길이(초)', get: (r) => median(r.offenseLengths) },
  { key: 'defenseLength', label: '밤 길이(초)', get: (r) => median(r.defenseLengths) },
  { key: 'kills', label: '처치 수', get: (r) => r.kills },
  { key: 'sunk', label: '거점 도달 (밤)', get: (r) => r.sunk },
  { key: 'finalJoy', label: '최종 기쁨', get: (r) => r.finalJoy },
  { key: 'gridFullRatio', label: '그리드 가득 참 비율', get: (r) => r.gridFullRatio },
  // §5.17-7
  { key: 'feeds', label: '먹이기 수', get: (r) => r.feeds },
  { key: 'offensePoints', label: '낮덱 점수', get: (r) => sumPts(r.heroPoints.offense) },
  { key: 'defensePoints', label: '밤덱 점수', get: (r) => sumPts(r.heroPoints.defense) },
  { key: 'merges', label: '머지 수', get: (r) => r.merges },
  { key: 'battleMergeRatio', label: '전투 중 머지 비율', get: (r) => (r.merges ? r.battleMerges / r.merges : null) },
  { key: 'momentumAvg', label: '기세 평균 중첩', get: (r) => r.momentumAvg },
  { key: 'offenseFalls', label: '쓰러짐 (낮)', get: (r) => r.offenseFalls },
  { key: 'defenseFalls', label: '쓰러짐 (밤)', get: (r) => r.defenseFalls },
  { key: 'buffHeal', label: '버프 회복 hp', get: (r) => r.buffHeal },
  // [11]-4
  { key: 'soldiers', label: '병사 출전', get: (r) => r.soldiers },
  { key: 'soldiersCapped', label: '상한으로 막힌 병사', get: (r) => r.soldiersCapped },
  { key: 'soldierShare', label: '피해 중 병사 비중', get: (r) => (totalDamage(r) > 0 ? r.damageSoldier / totalDamage(r) : null) },
  { key: 'affinityRatio', label: '때 맞춤 머지 비율', get: (r) => (r.battleMerges ? r.affinityMerges / r.battleMerges : null) },
  { key: 'wildcardsGained', label: '와일드카드 획득', get: (r) => r.wildcardsGained },
  { key: 'lostReturns', label: '지급 소실', get: (r) => r.lostReturns },
  { key: 'releases', label: '놓아주기 수', get: (r) => r.releases },
  { key: 'mistakes', label: '실수(원위치)', get: (r) => r.mistakes },
];

function stageRows(runs: RunResult[]): StageRow[] {
  const len = runs[0]?.attemptsByStage.length ?? 0;
  const rows: StageRow[] = [];
  for (let i = 0; i < len; i++) {
    const tried = runs.filter((r) => r.attemptsByStage[i] > 0);
    const totals = ATTEMPT_RESULTS.map((_, k) => runs.reduce((s, r) => s + r.stageResults[i][k], 0));
    const all = totals.reduce((a, b) => a + b, 0);
    const first = tried.filter((r) => r.firstTry[i] !== null);
    rows.push({
      stage: i + 1,
      reachedRate: runs.length ? tried.length / runs.length : 0,
      attemptsMean: tried.length ? tried.reduce((s, r) => s + r.attemptsByStage[i], 0) / tried.length : NaN,
      firstTryRate: first.length ? first.filter((r) => r.firstTry[i]).length / first.length : null,
      resultShare: Object.fromEntries(ATTEMPT_RESULTS.map((res, k) => [res, all ? totals[k] / all : 0])) as Record<AttemptResult, number>,
    });
  }
  return rows;
}

/** 핵 남은 HP 구간 (0~25, 25~50, 50~75, 75~100 % of core.hp 100) */
const HP_BUCKETS = [25, 50, 75];

export function buildReport(policy: string, runs: RunResult[], options: PolicyReport['options'], cfg: SimConfig): PolicyReport {
  const summary: Record<string, Summary> = {};
  for (const m of METRICS) summary[m.key] = summarize(runs.map(m.get));

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

  const resTotals = ATTEMPT_RESULTS.map((res) => runs.reduce((s, r) => s + r.results[res], 0));
  const resAll = resTotals.reduce((a, b) => a + b, 0);
  const hp = runs.flatMap((r) => r.coreHpLeft);
  const buckets = [0, 0, 0, 0];
  for (const v of hp) buckets[HP_BUCKETS.filter((b) => v > b).length] += 1;
  const done = runs.filter((r) => r.completed);

  const { m810Goals: _goals, ...sim } = cfg;
  return {
    version: 3,
    policy,
    createdAt: new Date().toISOString(),
    options,
    sim,
    summary,
    completedRate: runs.length ? done.length / runs.length : 0,
    completeAttempts: summarize(done.map((r) => r.attempts)),
    stage: summarize(runs.map((r) => r.stage)),
    stages: stageRows(runs),
    resultShare: Object.fromEntries(ATTEMPT_RESULTS.map((res, k) => [res, resAll ? resTotals[k] / resAll : 0])) as Record<AttemptResult, number>,
    coreHp: { ...summarize(hp), buckets },
    feedTierShare,
    soldiersByKind,
    runs,
  };
}

// ── 콘솔 출력 ──

export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function pctOf(x: number | null): string {
  return x === null ? '—' : `${fmt(x * 100, 1)}%`;
}

export function table(header: string[], rows: string[][]): string {
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

const RESULT_LABEL: Record<AttemptResult, string> = {
  dayTime: '가는 길 시간',
  dayFall: '가는 길 쓰러짐',
  returnTime: '돌아오는 길',
  night: '밤 핵 0',
  success: '성공',
};

export function formatReport(r: PolicyReport): string {
  const o = r.options;
  const ov = overridesLine(r);
  const lines = [
    ...(ov ? [ov] : []),
    `■ ${policyLabel(r)}  (시드 ${o.seeds}, 그리드 ${o.grid}, 시도 상한 ${o.maxAttempts})`,
    table(
      ['지표', '평균', '중앙값', 'p10', 'p90', 'n'],
      METRICS.map((m) => {
        const s = r.summary[m.key];
        return [m.label, fmt(s.mean), fmt(s.median), fmt(s.p10), fmt(s.p90), String(s.n)];
      }),
    ),
    `완성률 (시도 ${o.maxAttempts} 안) ${pctOf(r.completedRate)} · 완성한 판 총 시도 p10 ${fmt(r.completeAttempts.p10, 1)} / p50 ${fmt(r.completeAttempts.median, 1)} / p90 ${fmt(r.completeAttempts.p90, 1)} (n=${r.completeAttempts.n})`,
    `시도 결과 비율: ${ATTEMPT_RESULTS.map((k) => `${RESULT_LABEL[k]} ${pctOf(r.resultShare[k])}`).join(' · ')}`,
    `핵 남은 HP (성공한 밤 ${r.coreHp.n}번): p10 ${fmt(r.coreHp.p10, 0)} / p50 ${fmt(r.coreHp.median, 0)} / p90 ${fmt(r.coreHp.p90, 0)} · 구간 0~25 ${r.coreHp.buckets[0]} / 25~50 ${r.coreHp.buckets[1]} / 50~75 ${r.coreHp.buckets[2]} / 75~100 ${r.coreHp.buckets[3]}`,
    `먹인 단계 분포: ${tierLine(r.feedTierShare)}`,
    formatStages(r),
    formatHeroes(r),
  ];
  return lines.join('\n');
}

function tierLine(share: Record<string, number>): string {
  const keys = Object.keys(share).sort((a, b) => Number(a) - Number(b));
  return keys.length ? keys.map((t) => `${t}단계 ${pctOf(share[t])}`).join(' / ') : '—';
}

/** 스테이지별: 도달·시도 수·첫 시도 성공률·실패 사유 비율 */
export function formatStages(r: PolicyReport): string {
  const rows = r.stages.map((s) => [
    `1-${s.stage}`,
    pctOf(s.reachedRate),
    fmt(s.attemptsMean, 2),
    pctOf(s.firstTryRate),
    pctOf(s.resultShare.dayTime),
    pctOf(s.resultShare.dayFall),
    pctOf(s.resultShare.returnTime),
    pctOf(s.resultShare.night),
  ]);
  return `스테이지별 (시도한 판 기준)\n${table(['스테이지', '도달', '시도 평균', '첫 시도 성공', '가는 길 시간', '가는 길 쓰러짐', '돌아오는 길', '밤 실패'], rows)}`;
}

/** 영웅 둘의 최종 점수 (판당 평균, 체인별) + 병사 체인·단별 */
export function formatHeroes(r: PolicyReport): string {
  const n = Math.max(1, r.runs.length);
  const pts = (role: 'offense' | 'defense') => {
    const sum: Record<string, number> = {};
    for (const x of r.runs) for (const [k, v] of Object.entries(x.heroPoints[role])) sum[k] = (sum[k] ?? 0) + v;
    const keys = Object.keys(sum).sort();
    return keys.length ? keys.map((k) => `${k} ${fmt(sum[k] / n, 1)}`).join(' · ') : '없음';
  };
  const id = (role: 'offense' | 'defense') => r.runs[0]?.heroIds[role] ?? '?';
  const kinds = Object.keys(r.soldiersByKind).sort();
  return [
    `영웅 최종 점수 (판당 평균) — 낮덱 ${id('offense')}: ${pts('offense')} / 밤덱 ${id('defense')}: ${pts('defense')}`,
    `병사 출전 (판당 평균, 체인:단): ${kinds.length ? kinds.map((k) => `${k}단 ${fmt(r.soldiersByKind[k] / n, 2)}`).join(' · ') : '없음'}`,
  ].join('\n');
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['attempts', 'maxFailStreak', 'stage', 'dayFails', 'returnTime', 'nightFails', 'coreDrops', 'carryTime', 'coreHpLeft', 'offensePoints', 'defensePoints', 'soldierShare', 'offenseFalls', 'defenseFalls'];
  const header = ['정책', '완성%', '완성 시도 p50', ...keys.map((k) => METRICS.find((m) => m.key === k)!.label.trim())];
  const rows = reports.map((r) => [
    policyLabel(r),
    fmt(r.completedRate * 100, 1),
    fmt(r.completeAttempts.median, 1),
    ...keys.map((k) => fmt(r.summary[k].median) + (r.summary[k].n < r.runs.length ? ` (n=${r.summary[k].n})` : '')),
  ]);
  return `(중앙값)\n${table(header, rows)}`;
}

/** --compare: 같은 정책의 수치 변경 전후 */
export function formatCompare(a: PolicyReport, b: PolicyReport): string {
  const rows = METRICS.filter((m) => a.summary[m.key] && b.summary[m.key]).map((m) => {
    const x = a.summary[m.key];
    const y = b.summary[m.key];
    const d = y.median - x.median;
    return [m.label, fmt(x.mean), fmt(y.mean), fmt(x.median), fmt(y.median), (d > 0 ? '+' : '') + fmt(d)];
  });
  rows.push(['완성률', pctOf(a.completedRate), pctOf(b.completedRate), '', '', '']);
  const head =
    `비교: ${policyLabel(a)} (${a.createdAt}) → ${policyLabel(b)} (${b.createdAt})` +
    `\n  A ${overridesLine(a) || '(JSON 그대로)'}\n  B ${overridesLine(b) || '(JSON 그대로)'}`;
  const warn =
    a.policy !== b.policy || a.options.grid !== b.options.grid || a.options.maxAttempts !== b.options.maxAttempts || a.version !== b.version
      ? '\n※ 정책·그리드·시도 상한·리포트 버전이 다릅니다. 조건을 맞춰 비교하세요 (M8.10 이전 리포트와는 비교하지 마세요).'
      : '';
  return `${head}${warn}\n${table(['지표', '평균 A', '평균 B', '중앙값 A', '중앙값 B', 'Δ중앙값'], rows)}`;
}

// ── §5.19-6 진행 목표 ──

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

const inRange = (v: number, [lo, hi]: number[]) => Number.isFinite(v) && v >= lo && v <= hi;

/** §5.19-6 진행 목표 (판정 출력만 — 통과는 (b) 튜닝) */
export function checkM810Goals(reports: PolicyReport[], goals: SimConfig['m810Goals'], roundTrip: RoundTripCheck[] | null): GoalCheck[] {
  const out: GoalCheck[] = [];
  const by = (name: string) => reports.find((r) => r.policy === name);
  const lim = `시도 ${reports[0]?.options.maxAttempts ?? '?'} 안`;
  const b = by('balanced');
  const bl = b ? policyLabel(b) : 'balanced';
  if (b) {
    const a = b.completeAttempts;
    out.push({
      id: 'B 시도',
      label: `${bl}: 1-10까지 총 시도 수 중앙값 ${goals.balancedAttempts[0]}~${goals.balancedAttempts[1]}`,
      pass: a.n ? inRange(a.median, goals.balancedAttempts) : false,
      detail: `중앙값 ${fmt(a.median, 1)} [p10 ${fmt(a.p10, 1)} ~ p90 ${fmt(a.p90, 1)}] (완성한 판 ${a.n})`,
    });
    const s1 = b.stages[0];
    out.push({
      id: 'B 1-1',
      label: `${bl}: 1-1 첫 시도 성공률 ≥ ${pctOf(goals.firstTry11Min)}`,
      pass: s1?.firstTryRate !== null && s1 !== undefined ? s1.firstTryRate! >= goals.firstTry11Min : false,
      detail: `1-1 ${pctOf(s1?.firstTryRate ?? null)} · 스테이지별 ${b.stages.map((s) => `${s.stage}:${s.firstTryRate === null ? '—' : Math.round(s.firstTryRate * 100)}`).join(' ')}`,
    });
    const s9 = b.stages[8];
    out.push({
      id: 'B 1-9',
      label: `${bl}: 1-9 첫 시도 성공률 ${pctOf(goals.firstTry19[0])}~${pctOf(goals.firstTry19[1])} (내려감)`,
      pass: s9?.firstTryRate !== null && s9 !== undefined ? inRange(s9.firstTryRate!, goals.firstTry19) : false,
      detail: `1-9 ${pctOf(s9?.firstTryRate ?? null)} (도달 ${pctOf(s9?.reachedRate ?? 0)})`,
    });
    const f = b.summary.maxFailStreak;
    out.push({
      id: 'B 연속실패',
      label: `${bl}: 같은 스테이지 연속 실패 최대값 중앙값 ${goals.balancedFailStreak[0]}~${goals.balancedFailStreak[1]}`,
      pass: inRange(f.median, goals.balancedFailStreak),
      detail: `중앙값 ${fmt(f.median, 1)} [p10 ${fmt(f.p10, 1)} ~ p90 ${fmt(f.p90, 1)}]`,
    });
    out.push({
      id: 'B 완성',
      label: `${bl}: ${lim} 완성률 ≥ ${pctOf(goals.balancedCompleteMin)}`,
      pass: b.completedRate >= goals.balancedCompleteMin,
      detail: `완성 ${pctOf(b.completedRate)} · 끝난 스테이지 중앙값 1-${fmt(b.stage.median, 0)}`,
    });
  }
  const rate = (name: string, max: number, label: string, id: string, strict = true) => {
    const r = by(name);
    if (!r) return;
    out.push({
      id,
      label,
      pass: strict ? r.completedRate < max || (max === 0 && r.completedRate === 0) : r.completedRate <= max,
      detail: `완성 ${pctOf(r.completedRate)} · 끝난 스테이지 중앙값 1-${fmt(r.stage.median, 0)} · 총 시도 중앙값 ${fmt(r.summary.attempts.median, 1)}`,
    });
  };
  rate('idle', goals.idleCompleteMax, `idle: ${lim} 완성률 ${pctOf(goals.idleCompleteMax)}`, 'idle', false);
  rate('dayOnly', goals.oneSidedCompleteMax, `dayOnly: ${lim} 완성률 < ${pctOf(goals.oneSidedCompleteMax)} (낮·밤 둘 다 해내야 함)`, 'dayOnly');
  rate('nightOnly', goals.oneSidedCompleteMax, `nightOnly: ${lim} 완성률 < ${pctOf(goals.oneSidedCompleteMax)} (낮·밤 둘 다 해내야 함)`, 'nightOnly');
  rate('noFeed', goals.noFeedCompleteMax, `noFeed: ${lim} 완성률 < ${pctOf(goals.noFeedCompleteMax)} (키워야 넘는다)`, 'noFeed');
  const rnd = by('random');
  if (rnd) {
    out.push({
      id: 'random',
      label: 'random: 완성률 낮음 (balanced보다 낮음)',
      pass: b ? rnd.completedRate < b.completedRate || rnd.completedRate === 0 : null,
      detail: `random ${pctOf(rnd.completedRate)}${b ? ` vs ${bl} ${pctOf(b.completedRate)}` : ''}`,
    });
  }
  if (roundTrip) {
    const ok = roundTrip.every((x) => x.matched === x.total);
    out.push({
      id: 'roundTrip',
      label: '--saveRoundTrip: 끈 실행과 결과 완전 일치',
      pass: ok,
      detail: roundTrip.map((x) => `${x.policy} ${x.matched}/${x.total}${x.mismatchSeeds.length ? ` (어긋남: ${x.mismatchSeeds.join(',')})` : ''}`).join(' · '),
    });
  }
  return out;
}

export function formatGoals(checks: GoalCheck[], title: string): string {
  const mark = (p: boolean | null) => (p === null ? '[ - ]' : p ? '[OK ]' : '[NG ]');
  return [title, ...checks.flatMap((c) => [`  ${mark(c.pass)} ${c.label}`, `        ${c.detail}`])].join('\n');
}

export interface SweepRow {
  value: OverrideValue;
  reports: PolicyReport[];
  goals: GoalCheck[];
}

/** 값별로 목표 충족 여부 + 정책별 핵심 지표(중앙값)를 한 표에 */
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
  const detailHeader = ['값', '정책', '완성%', '완성 시도', '연속 실패', '끝난 스테이지', '낮 실패', '돌아오는 길', '밤 실패', '핵 HP', '낮덱 점수', '밤덱 점수', '병사 비중'];
  const detailBody = rows.flatMap((row) =>
    row.reports.map((r) => {
      const m = (k: string, d = 1) => fmt(r.summary[k]?.median ?? NaN, d);
      return [
        JSON.stringify(row.value),
        policyLabel(r),
        fmt(r.completedRate * 100, 0),
        fmt(r.completeAttempts.median, 1),
        m('maxFailStreak'),
        m('stage', 0),
        m('dayFails'),
        m('returnTime'),
        m('nightFails'),
        m('coreHpLeft', 0),
        m('offensePoints', 0),
        m('defensePoints', 0),
        fmt((r.summary.soldierShare?.median ?? NaN) * 100, 0) + '%',
      ];
    }),
  );
  return `■ --sweep ${key}\n${table(header, body)}\n\n정책별 상세 (중앙값)\n${table(detailHeader, detailBody)}`;
}

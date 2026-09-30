// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1)
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
  version: 1;
  policy: string;
  createdAt: string;
  options: { seeds: number; grid: string; untilWave: number; dayReset: number | null };
  sim: Omit<SimConfig, 'm3Goals'>;
  summary: Record<string, Summary>;
  /** 첫 가라앉음이 없었던 시드 비율 */
  neverSankRatio: number;
  /** 웨이브별 곡선: 기쁨(중앙값·10/90), 가라앉음(평균) */
  curves: { wave: number; joyMedian: number; joyP10: number; joyP90: number; sunkMean: number }[];
  /** 소환 단계 분포 (전 시드 합산 비율) */
  tierShare: Record<string, number>;
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

export function summarize(values: (number | null)[]): Summary {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const mean = xs.length === 0 ? NaN : xs.reduce((s, v) => s + v, 0) / xs.length;
  return { mean, median: quantile(xs, 0.5), p10: quantile(xs, 0.1), p90: quantile(xs, 0.9), n: xs.length };
}

/** 요약에 넣는 지표 (표 순서) */
export const METRICS: { key: string; label: string; get: (r: RunResult) => number | null }[] = [
  { key: 'firstSinkWave', label: '첫 가라앉음 웨이브', get: (r) => r.firstSinkWave },
  { key: 'sunk', label: '가라앉은 수', get: (r) => r.sunk },
  { key: 'kills', label: '처치 수', get: (r) => r.kills },
  { key: 'finalJoy', label: '최종 기쁨', get: (r) => r.finalJoy },
  { key: 'gridFullRatio', label: '그리드 가득 참 비율', get: (r) => r.gridFullRatio },
  { key: 'summons', label: '소환 수', get: (r) => r.summons },
  { key: 'meanSummonTier', label: '소환 평균 단계', get: (r) => r.meanSummonTier },
  { key: 'upRatio', label: '창문(Happy) 비율', get: (r) => r.upRatio },
  { key: 'releases', label: '놓아주기 수', get: (r) => r.releases },
  { key: 'mistakes', label: '실수(원위치)', get: (r) => r.mistakes },
];

export function buildReport(
  policy: string,
  runs: RunResult[],
  options: PolicyReport['options'],
  cfg: SimConfig,
): PolicyReport {
  const summary: Record<string, Summary> = {};
  for (const m of METRICS) summary[m.key] = summarize(runs.map(m.get));

  const maxWave = Math.max(0, ...runs.map((r) => r.reachedWave));
  const curves: PolicyReport['curves'] = [];
  for (let k = 0; k < maxWave; k++) {
    const joy = summarize(runs.map((r) => r.joyByWave[k] ?? null));
    const sunk = summarize(runs.map((r) => r.sunkByWave[k] ?? null));
    curves.push({ wave: k + 1, joyMedian: joy.median, joyP10: joy.p10, joyP90: joy.p90, sunkMean: sunk.mean });
  }

  const tierCount: Record<string, number> = {};
  let total = 0;
  for (const r of runs) {
    for (const [t, c] of Object.entries(r.summonTiers)) {
      tierCount[t] = (tierCount[t] ?? 0) + c;
      total += c;
    }
  }
  const tierShare: Record<string, number> = {};
  for (const [t, c] of Object.entries(tierCount)) tierShare[t] = total === 0 ? 0 : c / total;

  const { m3Goals: _goals, ...sim } = cfg;
  return {
    version: 1,
    policy,
    createdAt: new Date().toISOString(),
    options,
    sim,
    summary,
    neverSankRatio: runs.filter((r) => r.firstSinkWave === null).length / Math.max(1, runs.length),
    curves,
    tierShare,
    runs,
  };
}

// ── 콘솔 출력 ──

function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
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

export function formatReport(r: PolicyReport): string {
  const o = r.options;
  const lines = [
    `■ ${r.policy}  (시드 ${o.seeds}, 그리드 ${o.grid}, 웨이브 ${o.untilWave}까지${o.dayReset ? `, ${o.dayReset}웨이브마다 하루 리셋` : ''})`,
    table(
      ['지표', '평균', '중앙값', 'p10', 'p90'],
      METRICS.map((m) => {
        const s = r.summary[m.key];
        return [m.label, fmt(s.mean), fmt(s.median), fmt(s.p10), fmt(s.p90)];
      }),
    ),
    `가라앉음 없이 끝난 시드: ${fmt(r.neverSankRatio * 100, 1)}%`,
    `소환 단계 분포: ${Object.entries(r.tierShare)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([t, s]) => `${t}단계 ${fmt(s * 100, 1)}%`)
      .join(' / ') || '—'}`,
    '웨이브별 (기쁨 중앙값 [p10~p90] / 가라앉음 평균):',
    curveLine(r),
  ];
  return lines.join('\n');
}

function curveLine(r: PolicyReport): string {
  const pickWaves = new Set([1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, r.curves.length]);
  return r.curves
    .filter((c) => pickWaves.has(c.wave))
    .map((c) => `  w${c.wave}: 기쁨 ${fmt(c.joyMedian, 0)} [${fmt(c.joyP10, 0)}~${fmt(c.joyP90, 0)}] / 가라앉음 ${fmt(c.sunkMean)}`)
    .join('\n');
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['firstSinkWave', 'sunk', 'kills', 'finalJoy', 'gridFullRatio', 'meanSummonTier', 'releases'];
  const header = ['정책', ...keys.map((k) => METRICS.find((m) => m.key === k)!.label + ' (중앙값)'), '무가라앉음%'];
  const rows = reports.map((r) => [
    r.policy,
    ...keys.map((k) => fmt(r.summary[k].median)),
    fmt(r.neverSankRatio * 100, 1),
  ]);
  return table(header, rows);
}

/** --compare: 같은 정책의 수치 변경 전후 */
export function formatCompare(a: PolicyReport, b: PolicyReport): string {
  const rows = METRICS.map((m) => {
    const x = a.summary[m.key];
    const y = b.summary[m.key];
    const d = y.median - x.median;
    return [m.label, fmt(x.mean), fmt(y.mean), fmt(x.median), fmt(y.median), (d > 0 ? '+' : '') + fmt(d)];
  });
  const head = `비교: ${a.policy} (${a.createdAt}) → ${b.policy} (${b.createdAt})`;
  const warn =
    a.policy !== b.policy || a.options.grid !== b.options.grid || a.options.untilWave !== b.options.untilWave
      ? '\n※ 정책·그리드·웨이브 조건이 다릅니다. 조건을 맞춰 비교하세요.'
      : '';
  return `${head}${warn}\n${table(['지표', '평균 A', '평균 B', '중앙값 A', '중앙값 B', 'Δ중앙값'], rows)}`;
}

// ── §8.2 M3 부분 목표 ──

export interface GoalCheck {
  label: string;
  pass: boolean | null;
  detail: string;
}

/**
 * idle: 웨이브 1에서 가라앉음.
 * balanced(창문만): holdUntilWave까지 가라앉음 거의 없음(시드 평균 ≤ earlySinkMeanMax) → 이후 점점 무너짐(후반 가라앉음이 더 많음).
 */
export function checkM3Goals(reports: PolicyReport[], goals: SimConfig['m3Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const idle = reports.find((r) => r.policy === 'idle');
  if (idle) {
    const s = idle.summary.firstSinkWave;
    const all = idle.runs.every((r) => r.firstSinkWave === goals.idleFirstSinkWave);
    out.push({
      label: `idle: 웨이브 ${goals.idleFirstSinkWave}에서 가라앉음`,
      pass: all,
      detail: `첫 가라앉음 웨이브 중앙값 ${fmt(s.median)}, 전 시드 일치 ${all ? '예' : '아니오'}`,
    });
  } else {
    out.push({ label: 'idle', pass: null, detail: '실행하지 않음' });
  }
  const bal = reports.find((r) => r.policy === 'balanced');
  if (bal) {
    const h = goals.balancedHoldUntilWave;
    const early = bal.runs.map((r) => r.sunkByWave.slice(0, h).reduce((s, v) => s + v, 0));
    const late = bal.runs.map((r) => r.sunkByWave.slice(h).reduce((s, v) => s + v, 0));
    const earlyMean = early.reduce((s, v) => s + v, 0) / Math.max(1, early.length);
    const lateMean = late.reduce((s, v) => s + v, 0) / Math.max(1, late.length);
    const first = bal.summary.firstSinkWave;
    out.push({
      label: `balanced: 웨이브 1~${h} 가라앉음 거의 없음 (평균 ≤ ${goals.balancedEarlySinkMeanMax})`,
      pass: earlyMean <= goals.balancedEarlySinkMeanMax,
      detail: `웨이브 1~${h} 가라앉음 평균 ${fmt(earlyMean)}, 첫 가라앉음 웨이브 중앙값 ${fmt(first.median)} [p10 ${fmt(first.p10)} ~ p90 ${fmt(first.p90)}]`,
    });
    const [lo, hi] = goals.balancedFirstSinkWaveRange;
    out.push({
      label: `balanced: 첫 가라앉음이 웨이브 ${h} 전후 (중앙값 ${lo}~${hi})`,
      pass: first.median >= lo && first.median <= hi,
      detail: `첫 가라앉음 웨이브 중앙값 ${fmt(first.median)}`,
    });
    out.push({
      label: `balanced: 웨이브 ${h + 1}~ 점점 무너짐 (후반 가라앉음 > 전반)`,
      pass: bal.options.untilWave > h ? lateMean > earlyMean : null,
      detail: `웨이브 ${h + 1}~${bal.options.untilWave} 가라앉음 평균 ${fmt(lateMean)}`,
    });
  } else {
    out.push({ label: 'balanced', pass: null, detail: '실행하지 않음' });
  }
  return out;
}

export function formatGoals(checks: GoalCheck[]): string {
  return [
    '§8.2 M3 부분 목표',
    ...checks.map((c) => `  [${c.pass === null ? ' - ' : c.pass ? 'OK ' : 'NG '}] ${c.label}\n        ${c.detail}`),
  ].join('\n');
}

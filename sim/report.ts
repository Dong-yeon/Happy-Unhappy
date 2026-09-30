// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1)
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
  version: 1;
  policy: string;
  createdAt: string;
  options: {
    seeds: number;
    grid: string;
    untilWave: number;
    dayReset: number | null;
    dayMode: 'm5' | null;
    wavesPerDay: number;
    /** --set으로 덮어쓴 값 (전체 경로 → 값). 없으면 JSON 그대로 */
    overrides?: Record<string, OverrideValue>;
  };
  sim: Omit<SimConfig, 'm3Goals' | 'm4Goals'>;
  summary: Record<string, Summary>;
  /** 첫 가라앉음이 없었던 시드 비율 */
  neverSankRatio: number;
  /** 웨이브별 곡선: 기쁨(중앙값·10/90), 가라앉음(평균) */
  curves: { wave: number; joyMedian: number; joyP10: number; joyP90: number; sunkMean: number; shadowMedian: number; shadowP90: number }[];
  /** 소환 단계 분포 (전 시드 합산 비율) */
  tierShare: Record<string, number>;
  runs: RunResult[];
}

/** 한 판의 일차별 (하루 끝 기쁨 − 하루 시작 기쁨) 중앙값. dayMode m5가 아니면 null */
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
  { key: 'downRatio', label: '손거울(Unhappy) 비율', get: (r) => r.downRatio },
  { key: 'layersCleared', label: '층 돌파', get: (r) => r.layersCleared },
  { key: 'backflows', label: '역류', get: (r) => r.backflows },
  { key: 'bossWins', label: '역류 보스 처치', get: (r) => r.bossWins },
  { key: 'maxShadow', label: '최대 그림자', get: (r) => r.maxShadow },
  { key: 'stallSeconds', label: 'Unhappy 멈춤(초)', get: (r) => r.stallSeconds },
  { key: 'abyssDeaths', label: '심연 유닛 사망', get: (r) => r.abyssDeaths },
  { key: 'lostReturns', label: '귀환 소실', get: (r) => r.lostReturns },
  { key: 'releases', label: '놓아주기 수', get: (r) => r.releases },
  { key: 'dayJoyDelta', label: '하루 끝−시작 기쁨', get: (r) => dayJoyDeltaMedian(r) },
  { key: 'day1Sunk', label: '1일차 가라앉음', get: (r) => r.day1Sunk },
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
    const sh = summarize(runs.map((r) => r.shadowByWave[k] ?? null));
    curves.push({
      wave: k + 1,
      joyMedian: joy.median,
      joyP10: joy.p10,
      joyP90: joy.p90,
      sunkMean: sunk.mean,
      shadowMedian: sh.median,
      shadowP90: sh.p90,
    });
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

  const { m3Goals: _m3, m4Goals: _m4, ...sim } = cfg;
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

/** --set 요약 한 줄. 없으면 빈 문자열 */
export function overridesLine(r: PolicyReport): string {
  const o = r.options.overrides;
  if (!o || Object.keys(o).length === 0) return '';
  return `(--set ${Object.entries(o)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')})`;
}

export function formatReport(r: PolicyReport): string {
  const o = r.options;
  const ov = overridesLine(r);
  const lines = [
    ...(ov ? [ov] : []),
    `■ ${r.policy}  (시드 ${o.seeds}, 그리드 ${o.grid}, 웨이브 ${o.untilWave}까지${o.dayMode === 'm5' ? ', dayMode m5' : ''}${o.dayReset ? `, ${o.dayReset}웨이브마다 생성 횟수 리셋` : ''})`,
    table(
      // n: 값이 있는 시드 수 (첫 가라앉음이 없던 시드는 빠진다)
      ['지표', '평균', '중앙값', 'p10', 'p90', 'n'],
      METRICS.map((m) => {
        const s = r.summary[m.key];
        return [m.label, fmt(s.mean), fmt(s.median), fmt(s.p10), fmt(s.p90), String(s.n)];
      }),
    ),
    `가라앉음 없이 끝난 시드: ${fmt(r.neverSankRatio * 100, 1)}%`,
    `소환 단계 분포: ${Object.entries(r.tierShare)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([t, s]) => `${t}단계 ${fmt(s * 100, 1)}%`)
      .join(' / ') || '—'}`,
    '웨이브별 (기쁨 중앙값 [p10~p90] / 가라앉음 평균 / 그림자 중앙값 [p90]):',
    curveLine(r),
  ];
  return lines.join('\n');
}

function curveLine(r: PolicyReport): string {
  const pickWaves = new Set([1, 2, 3, 6, 9, 12, 15, 21, 27, 30, 36, 42, r.curves.length]);
  return r.curves
    .filter((c) => pickWaves.has(c.wave))
    .map(
      (c) =>
        `  w${c.wave}: 기쁨 ${fmt(c.joyMedian, 0)} [${fmt(c.joyP10, 0)}~${fmt(c.joyP90, 0)}] / 가라앉음 ${fmt(c.sunkMean)} / 그림자 ${fmt(c.shadowMedian, 0)} [${fmt(c.shadowP90, 0)}]`,
    )
    .join('\n');
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['firstSinkWave', 'sunk', 'layersCleared', 'backflows', 'downRatio', 'finalJoy', 'gridFullRatio', 'meanSummonTier', 'lostReturns'];
  const header = ['정책', ...keys.map((k) => METRICS.find((m) => m.key === k)!.label + ' (중앙값)'), '무가라앉음%'];
  const rows = reports.map((r) => [
    r.policy,
    ...keys.map((k) => fmt(r.summary[k].median) + (r.summary[k].n < r.runs.length ? ` (n=${r.summary[k].n})` : '')),
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
  const head =
    `비교: ${a.policy} (${a.createdAt}) → ${b.policy} (${b.createdAt})` +
    `\n  A ${overridesLine(a) || '(JSON 그대로)'}\n  B ${overridesLine(b) || '(JSON 그대로)'}`;
  const warn =
    a.policy !== b.policy ||
    a.options.grid !== b.options.grid ||
    a.options.untilWave !== b.options.untilWave ||
    (a.options.dayMode ?? null) !== (b.options.dayMode ?? null) ||
    a.options.dayReset !== b.options.dayReset
      ? '\n※ 정책·그리드·웨이브 조건이 다릅니다. 조건을 맞춰 비교하세요.'
      : '';
  return `${head}${warn}\n${table(['지표', '평균 A', '평균 B', '중앙값 A', '중앙값 B', 'Δ중앙값'], rows)}`;
}

// ── §8.2 M3 부분 목표 ──

export interface GoalCheck {
  /** 비교 표 열 이름 (짧게). 판정 기준 안내 같은 항목은 없음 */
  id?: string;
  label: string;
  pass: boolean | null;
  detail: string;
}

/**
 * §8.2 M3 부분 목표 (v0.4.1 표). 기준은 --dayMode m5.
 * 방어만 있는 M3에서는 "붕괴 시점"이 아니라 "경제가 실제 제약인가"를 본다.
 */
export function checkM3Goals(reports: PolicyReport[], goals: SimConfig['m3Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const na = (label: string, why: string) => out.push({ label, pass: null, detail: why });
  const m5 = reports.every((r) => r.options.dayMode === 'm5');
  if (!m5) {
    out.push({ label: '판정 기준', pass: null, detail: 'M3 목표는 --dayMode m5 기준입니다. 이번 실행은 참고용으로만 보세요.' });
  }

  const idle = reports.find((r) => r.policy === 'idle');
  const idleLabel = `idle: ${goals.idleSinkByDay}일차에 가라앉음`;
  if (idle) {
    const limit = goals.idleSinkByDay * idle.options.wavesPerDay;
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
        : '하루 단위 기록 없음 (--dayMode m5 필요)',
    });

    const t1 = bal.tierShare['1'] ?? 0;
    out.push({
      label: `balanced: 1단계만으로 버티지 못함 (1단계 소환 비율 ≤ ${fmt(goals.tier1ShareMax * 100, 0)}%)`,
      pass: t1 <= goals.tier1ShareMax,
      detail: `소환 단계 분포 ${tierLine(bal)}`,
    });

    const withFull = bal.runs.filter((r) => r.gridFullRatio > goals.gridFullRatioMin).length / Math.max(1, bal.runs.length);
    const g = bal.summary.gridFullRatio;
    out.push({
      label: `balanced: 그리드 가득 참 비율 > 0 (가득 차는 순간이 있는 시드 ≥ ${fmt(goals.gridFullRunShareMin * 100, 0)}%)`,
      pass: withFull >= goals.gridFullRunShareMin,
      detail: `가득 참 비율 평균 ${fmt(g.mean, 4)} / 중앙값 ${fmt(g.median, 4)}, 가득 차는 순간이 있는 시드 ${fmt(withFull * 100, 1)}%`,
    });
  } else na('balanced', 'balanced를 실행하지 않음');

  const hoard = reports.find((r) => r.policy === 'hoarder');
  if (hoard && bal) {
    const worse = hoard.summary.sunk.median > bal.summary.sunk.median;
    out.push({
      label: 'hoarder: balanced보다 나쁨',
      pass: worse,
      detail: `가라앉은 수 중앙값 hoarder ${fmt(hoard.summary.sunk.median)} vs balanced ${fmt(bal.summary.sunk.median)}`,
    });
  } else na('hoarder', 'hoarder와 balanced를 함께 실행해야 비교 가능');
  return out;
}

function tierLine(r: PolicyReport): string {
  return (
    Object.entries(r.tierShare)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([t, s]) => `${t}단계 ${fmt(s * 100, 1)}%`)
      .join(' / ') || '—'
  );
}

/**
 * §8.2 M4 부분 목표 (--dayMode m5, 14일 = 42웨이브). 수치 기준은 sim.json m4Goals.
 */
export function checkM4Goals(reports: PolicyReport[], goals: SimConfig['m4Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);
  if (!reports.every((r) => r.options.dayMode === 'm5')) {
    out.push({ label: '판정 기준', pass: null, detail: 'M4 목표는 --dayMode m5 기준입니다. 이번 실행은 참고용으로만 보세요.' });
  }

  const hap = get('alwaysHappy');
  if (hap) {
    const maxLayers = Math.max(...hap.runs.map((r) => r.layersCleared));
    out.push({
      id: 'H 역류≥3',
      label: `alwaysHappy: 역류 반복 (중앙값 ≥ ${goals.alwaysHappyBackflowsMin}회)`,
      pass: hap.summary.backflows.median >= goals.alwaysHappyBackflowsMin,
      detail: `역류 중앙값 ${fmt(hap.summary.backflows.median)} [p10 ${fmt(hap.summary.backflows.p10)} ~ p90 ${fmt(hap.summary.backflows.p90)}]`,
    });
    out.push({ id: 'H 층0', label: 'alwaysHappy: 층 돌파 0', pass: maxLayers === 0, detail: `층 돌파 최대 ${maxLayers}` });
  } else out.push({ label: 'alwaysHappy', pass: null, detail: '실행하지 않음' });

  const unh = get('alwaysUnhappy');
  if (unh) {
    const share = unh.runs.map((r) => (r.day1Worries ? r.day1Sunk / r.day1Worries : 0)).sort((a, b) => a - b);
    const med = quantile(share, 0.5);
    out.push({
      id: 'U 1일차',
      label: `alwaysUnhappy: 1일차부터 가라앉음 다수 (1일차 걱정의 ${fmt(goals.alwaysUnhappyDay1SunkShareMin * 100, 0)}% 이상, 중앙값)`,
      pass: med >= goals.alwaysUnhappyDay1SunkShareMin,
      detail: `1일차 가라앉은 비율 중앙값 ${fmt(med * 100, 1)}%, 전체 가라앉음 중앙값 ${fmt(unh.summary.sunk.median)}`,
    });
    out.push({
      id: 'U 층',
      label: 'alwaysUnhappy: 층 돌파는 일어남',
      pass: unh.summary.layersCleared.median >= 1,
      detail: `층 돌파 중앙값 ${fmt(unh.summary.layersCleared.median)}`,
    });
  } else out.push({ label: 'alwaysUnhappy', pass: null, detail: '실행하지 않음' });

  const bal = get('balanced');
  if (bal) {
    const days = bal.options.untilWave / bal.options.wavesPerDay;
    const needLayers = days * goals.balancedLayersPerDayMin;
    const [lo, hi] = goals.balancedDownRatio;
    const down = bal.summary.downRatio.median;
    out.push({
      id: 'B 역류',
      label: `balanced: 역류 0~${goals.balancedBackflowsMax}회 (중앙값)`,
      pass: bal.summary.backflows.median <= goals.balancedBackflowsMax,
      detail: `역류 중앙값 ${fmt(bal.summary.backflows.median)} [p10 ${fmt(bal.summary.backflows.p10)} ~ p90 ${fmt(bal.summary.backflows.p90)}]`,
    });
    out.push({
      id: 'B 층',
      label: `balanced: 층 돌파 꾸준함 (${fmt(days, 0)}일에 ${fmt(needLayers, 0)}층 이상, 중앙값)`,
      pass: bal.summary.layersCleared.median >= needLayers,
      detail: `층 돌파 중앙값 ${fmt(bal.summary.layersCleared.median)} [p10 ${fmt(bal.summary.layersCleared.p10)} ~ p90 ${fmt(bal.summary.layersCleared.p90)}]`,
    });
    out.push({
      id: 'B 손거울',
      label: `balanced: Unhappy에게 보낸 비율 ${fmt(lo * 100, 0)}~${fmt(hi * 100, 0)}% (중앙값)`,
      pass: down >= lo && down <= hi,
      detail: `손거울 비율 중앙값 ${fmt(down * 100, 1)}%`,
    });
    out.push({
      id: 'B 소실',
      label: `귀환 대기열 소실: balanced에서 거의 없음 (판당 평균 ≤ ${goals.balancedLostReturnsMeanMax})`,
      pass: bal.summary.lostReturns.mean <= goals.balancedLostReturnsMeanMax,
      detail: `소실 평균 ${fmt(bal.summary.lostReturns.mean)} / 최대 ${Math.max(...bal.runs.map((r) => r.lostReturns))}`,
    });
  } else out.push({ label: 'balanced', pass: null, detail: '실행하지 않음' });

  const hoard = get('hoarder');
  if (hoard && bal) {
    out.push({
      id: 'hoarder<B',
      label: 'hoarder: balanced보다 나쁨',
      pass: hoard.summary.sunk.median > bal.summary.sunk.median,
      detail: `가라앉은 수 중앙값 hoarder ${fmt(hoard.summary.sunk.median)} vs balanced ${fmt(bal.summary.sunk.median)}`,
    });
  } else out.push({ label: 'hoarder', pass: null, detail: 'hoarder와 balanced를 함께 실행해야 비교 가능' });
  return out;
}

export function formatGoals(checks: GoalCheck[], title = '§8.2 M3 부분 목표'): string {
  return [
    title,
    ...checks.map((c) => `  [${c.pass === null ? ' - ' : c.pass ? 'OK ' : 'NG '}] ${c.label}\n        ${c.detail}`),
  ].join('\n');
}

// ── --sweep: 값별 비교 표 ──

export interface SweepRow {
  value: OverrideValue;
  reports: PolicyReport[];
  goals: GoalCheck[];
}

/** 값별로 핵심 지표(중앙값)와 §8.2 M4 목표 충족 여부를 한 표에 */
export function formatSweep(key: string, rows: SweepRow[]): string {
  const med = (rs: PolicyReport[], policy: string, k: string, pct = false) => {
    const r = rs.find((x) => x.policy === policy);
    if (!r) return '—';
    const v = r.summary[k].median;
    return pct ? `${fmt(v * 100, 0)}%` : fmt(v);
  };
  const goalIds = [...new Set(rows.flatMap((r) => r.goals.flatMap((g) => (g.id ? [g.id] : []))))];
  const header = ['값', 'bal 역류', 'bal 가라앉음', 'bal 층', 'bal 손거울', 'greedy 역류', 'M4 충족', ...goalIds];
  const body = rows.map((row) => {
    const judged = row.goals.filter((g) => g.id && g.pass !== null);
    const ok = judged.filter((g) => g.pass).length;
    const mark = (id: string) => {
      const g = row.goals.find((x) => x.id === id);
      return !g || g.pass === null ? '-' : g.pass ? 'OK' : 'NG';
    };
    return [
      JSON.stringify(row.value),
      med(row.reports, 'balanced', 'backflows'),
      med(row.reports, 'balanced', 'sunk'),
      med(row.reports, 'balanced', 'layersCleared'),
      med(row.reports, 'balanced', 'downRatio', true),
      med(row.reports, 'alwaysHappy', 'backflows'),
      `${ok}/${judged.length}`,
      ...goalIds.map(mark),
    ];
  });
  return `■ --sweep ${key}\n${table(header, body)}`;
}

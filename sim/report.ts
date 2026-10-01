// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1). M6: 결말 분포·점수 백분위·항목별 기여 (§5.8-4)
import { BREAKDOWN_KEYS, type BreakdownKey } from '../src/core/ending';
import type { EndingId } from '../src/data/types';
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
    /** M5부터 실제 하루 구조 (14일 일생)만 */
    mode: 'life';
    days: number;
    wavesPerDay: number;
    /** --set으로 덮어쓴 값 (전체 경로 → 값). 없으면 JSON 그대로 */
    overrides?: Record<string, OverrideValue>;
  };
  sim: Omit<SimConfig, 'm3Goals' | 'm4Goals' | 'm5Goals' | 'm6Goals'>;
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
  /** 보스 등장 진단 (§5.7): 슬롯·준비 여부별 처치율, 등장 시 방어 유닛 수 분포 */
  bossDiag: BossDiag;
  /** 소환 단계 분포 (전 시드 합산 비율) */
  tierShare: Record<string, number>;
  /** 결말 분포·점수 (M6, §5.8-4) */
  endings: EndingStats;
  runs: RunResult[];
}

export const ENDING_IDS: EndingId[] = ['hidden', 'solid', 'mask', 'quiet', 'rainy'];

export interface EndingStats {
  /** 결말이 난 판 수 (14일을 다 산 판) */
  n: number;
  /** 결말별 비율 (n 기준) */
  dist: Record<EndingId, number>;
  happy: Summary;
  unhappy: Summary;
  /** happy + unhappy */
  total: Summary;
  /** 항목별 평균 기여 (가중치 곱한 값) */
  breakdown: Record<BreakdownKey, number>;
}

export function endingStats(runs: RunResult[]): EndingStats {
  const ends = runs.flatMap((r) => (r.ending ? [r.ending] : []));
  const n = ends.length;
  const dist = Object.fromEntries(ENDING_IDS.map((id) => [id, n ? ends.filter((e) => e.id === id).length / n : 0])) as Record<EndingId, number>;
  const breakdown = Object.fromEntries(
    BREAKDOWN_KEYS.map((k) => [k, n ? ends.reduce((s, e) => s + e.breakdown[k], 0) / n : NaN]),
  ) as Record<BreakdownKey, number>;
  return {
    n,
    dist,
    happy: summarize(ends.map((e) => e.happy)),
    unhappy: summarize(ends.map((e) => e.unhappy)),
    total: summarize(ends.map((e) => e.happy + e.unhappy)),
    breakdown,
  };
}

export interface BossDiagRow {
  n: number;
  wins: number;
  /** 결과가 난 보스 중 처치 비율 */
  winRate: number | null;
}

export interface BossDiag {
  total: number;
  /** key = "morning|prep", "noon|-" 처럼 슬롯|준비여부 */
  bySlot: Record<string, BossDiagRow>;
  /** key = 등장 시 방어 유닛 수 */
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

/** 요약에 넣는 지표 (표 순서) */
export const METRICS: { key: string; label: string; get: (r: RunResult) => number | null }[] = [
  { key: 'firstSinkWave', label: '첫 가라앉음 웨이브', get: (r) => r.firstSinkWave },
  { key: 'firstSinkDay', label: '첫 가라앉음 일차', get: (r) => r.firstSinkDay },
  { key: 'dayLength', label: '하루 길이(초, ×1)', get: (r) => median(r.dayLengths) },
  { key: 'dayLengthDay', label: '낮 길이(초)', get: (r) => median(r.dayLengthsDay ?? []) },
  { key: 'dayLengthNight', label: '밤 길이(초)', get: (r) => median(r.dayLengthsNight ?? []) },
  { key: 'earlySunk', label: '1~2일차 가라앉음', get: (r) => (r.sunkByDay[0] ?? 0) + (r.sunkByDay[1] ?? 0) },
  { key: 'sunk', label: '가라앉은 수', get: (r) => r.sunk },
  { key: 'kills', label: '처치 수', get: (r) => r.kills },
  { key: 'finalJoy', label: '최종 기쁨', get: (r) => r.finalJoy },
  { key: 'gridFullRatio', label: '그리드 가득 참 비율', get: (r) => r.gridFullRatio },
  { key: 'summons', label: '소환 수', get: (r) => r.summons },
  { key: 'meanSummonTier', label: '소환 평균 단계', get: (r) => r.meanSummonTier },
  { key: 'upRatio', label: '창문(Happy) 비율', get: (r) => r.upRatio },
  { key: 'downRatio', label: '손거울(Unhappy) 비율', get: (r) => r.downRatio },
  { key: 'reserved', label: '맡긴 수 (낮 손거울)', get: (r) => r.reserved ?? null },
  { key: 'reservedRatio', label: '맡긴 비율 (소환 중)', get: (r) => (r.summons ? (r.reserved ?? 0) / r.summons : null) },
  { key: 'layersCleared', label: '밤 층 돌파', get: (r) => r.layersCleared },
  { key: 'backflows', label: '역류', get: (r) => r.backflows },
  { key: 'bossWins', label: '역류 보스 처치', get: (r) => r.bossWins },
  { key: 'maxShadow', label: '최대 그림자', get: (r) => r.maxShadow },
  { key: 'stallSeconds', label: '밤 멈춤(초, 잠들기 포함)', get: (r) => r.stallSeconds },
  { key: 'sleeps', label: '잠들기', get: (r) => r.sleeps ?? null },
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
  for (const r of runs) {
    for (const [t, c] of Object.entries(r.summonTiers)) {
      tierCount[t] = (tierCount[t] ?? 0) + c;
      total += c;
    }
  }
  const tierShare: Record<string, number> = {};
  for (const [t, c] of Object.entries(tierCount)) tierShare[t] = total === 0 ? 0 : c / total;

  const { m3Goals: _m3, m4Goals: _m4, m5Goals: _m5, m6Goals: _m6, ...sim } = cfg;
  return {
    version: 1,
    policy,
    createdAt: new Date().toISOString(),
    options,
    sim,
    summary,
    neverSankRatio: runs.filter((r) => r.firstSinkWave === null).length / Math.max(1, runs.length),
    curves,
    bossDiag: bossDiagnostics(runs),
    tierShare,
    endings: endingStats(runs),
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
    `■ ${r.policy}  (시드 ${o.seeds}, 그리드 ${o.grid}, ${o.days}일 일생)`,
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
    '일차별 (하루 끝 기쁨 중앙값 [p10~p90] / 가라앉음 평균 / 그림자 중앙값 [p90] / 하루 길이 중앙값):',
    curveLine(r),
    formatBossDiag(r),
    formatEndings(r),
  ];
  return lines.join('\n');
}

const BREAKDOWN_LABEL: Record<BreakdownKey, string> = {
  upTier: '위 단계(wUpTier)',
  defeat: '처치(wDefeat)',
  joy: '기쁨(wJoy)',
  sunk: '가라앉음 감점(wSunk)',
  downTier: '아래 단계(wDownTier)',
  layer: '층(wLayer)',
  purified: '정화(wPurified)',
};

function pctOf(x: number): string {
  return `${fmt(x * 100, 1)}%`;
}

/** 결말 분포 + 점수 백분위 + 항목별 평균 기여 (§5.8-4) */
export function formatEndings(r: PolicyReport): string {
  const e = r.endings;
  if (!e || e.n === 0) return '결말: 없음 (14일을 다 산 판이 없음)';
  const score = (label: string, s: Summary) => [label, fmt(s.p10, 0), fmt(s.median, 0), fmt(s.p90, 0), fmt(s.mean, 1)];
  const share = (side: BreakdownKey[], total: number) =>
    side.map((k) => `${BREAKDOWN_LABEL[k]} ${fmt(e.breakdown[k], 1)} (${total > 0 ? fmt((e.breakdown[k] / total) * 100, 0) : '—'}%)`).join(' · ');
  const hMean = e.breakdown.upTier + e.breakdown.defeat + e.breakdown.joy;
  const uMean = e.breakdown.downTier + e.breakdown.layer + e.breakdown.purified;
  return [
    `결말 분포 (n=${e.n}): ${ENDING_IDS.map((id) => `${id} ${pctOf(e.dist[id])}`).join(' / ')}`,
    table(['점수', 'p10', 'p50', 'p90', '평균'], [score('Happy', e.happy), score('Unhappy', e.unhappy), score('합', e.total)]),
    // % 는 가산 항목 합 대비 (감점은 음수 %)
    `항목별 평균 기여 — Happy: ${share(['upTier', 'defeat', 'joy', 'sunk'], hMean)}`,
    `                  Unhappy: ${share(['downTier', 'layer', 'purified'], uMean)}`,
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

const SLOT_LABEL: Record<string, string> = { morning: '아침', noon: '낮', evening: '저녁' };

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
    .map((k) => [`방어 유닛 ${k}기`, String(d.byDefense[k].n), String(d.byDefense[k].wins), pct(d.byDefense[k].winRate)]);
  return [
    `보스 등장 진단 (전 시드 ${d.total}회): 슬롯·준비 여부별 / 등장 시 방어 유닛 수별`,
    table(['구분', '등장', '처치', '처치율'], [...slotRows, ...defRows]),
  ].join('\n');
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['firstSinkDay', 'sunk', 'layersCleared', 'backflows', 'bossWins', 'downRatio', 'reservedRatio', 'finalJoy', 'dayLengthDay', 'dayLengthNight', 'meanSummonTier'];
  const header = [
    '정책',
    ...keys.map((k) => METRICS.find((m) => m.key === k)!.label + ' (중앙값)'),
    '무가라앉음%',
    'solid%',
    'hidden%',
    'mask%',
    'H p50',
    'U p50',
  ];
  const rows = reports.map((r) => [
    r.policy,
    ...keys.map((k) => fmt(r.summary[k].median) + (r.summary[k].n < r.runs.length ? ` (n=${r.summary[k].n})` : '')),
    fmt(r.neverSankRatio * 100, 1),
    fmt(r.endings.dist.solid * 100, 1),
    fmt(r.endings.dist.hidden * 100, 1),
    fmt(r.endings.dist.mask * 100, 1),
    fmt(r.endings.happy.median, 0),
    fmt(r.endings.unhappy.median, 0),
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
    a.options.days !== b.options.days ||
    (a.options.mode ?? null) !== (b.options.mode ?? null)
      ? '\n※ 정책·그리드·일생 조건이 다릅니다. 조건을 맞춰 비교하세요 (M5 이전 리포트와는 비교하지 마세요).'
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
 * §8.2 M3 부분 목표 (v0.4.1 표). M5부터는 실제 하루 구조(--until life) 기준.
 * 방어만 있는 M3에서는 "붕괴 시점"이 아니라 "경제가 실제 제약인가"를 본다.
 */
export function checkM3Goals(reports: PolicyReport[], goals: SimConfig['m3Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const na = (label: string, why: string) => out.push({ label, pass: null, detail: why });

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
        : '하루 단위 기록 없음',
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
  if (hoard && bal) out.push(hoarderCheck(hoard, bal));
  else na('hoarder', 'hoarder와 balanced를 함께 실행해야 비교 가능');
  return out;
}

/**
 * hoarder: balanced보다 나쁨 = 결말 점수 합(happy + unhappy) 중앙값이 더 낮음 (v0.6.1 §5.9-5).
 * 가라앉은 수 비교는 버렸다 (난이도를 올리면 balanced가 아래 투자로 가라앉음이 더 많을 수 있다).
 */
function hoarderCheck(hoard: PolicyReport, bal: PolicyReport): GoalCheck {
  return {
    id: 'hoarder<B',
    label: 'hoarder: balanced보다 나쁨 (결말 점수 합 중앙값)',
    pass: hoard.endings.total.median < bal.endings.total.median,
    detail:
      `점수 합 중앙값 hoarder ${fmt(hoard.endings.total.median, 0)} vs balanced ${fmt(bal.endings.total.median, 0)}` +
      ` (참고: 가라앉은 수 중앙값 ${fmt(hoard.summary.sunk.median)} vs ${fmt(bal.summary.sunk.median)})`,
  };
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
 * §8.2 M4 부분 목표 (14일 일생). 수치 기준은 sim.json m4Goals. M5부터는 실제 하루 구조 기준.
 */
export function checkM4Goals(reports: PolicyReport[], goals: SimConfig['m4Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);

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
    const days = bal.options.days;
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
  if (hoard && bal) out.push(hoarderCheck(hoard, bal));
  else out.push({ label: 'hoarder', pass: null, detail: 'hoarder와 balanced를 함께 실행해야 비교 가능' });
  return out;
}

/**
 * §8.2 M5 부분 목표 (--until life, 실제 하루 구조). 수치 기준은 sim.json m5Goals.
 */
export function checkM5Goals(reports: PolicyReport[], goals: SimConfig['m5Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);
  const pct = (x: number | null) => (x === null ? '—' : `${fmt(x * 100, 1)}%`);

  // 준비 시간이 있는 아침 보스 중 등장 시 방어 유닛 ≥ N기인 경우의 처치율, 전 정책 합산 (v0.6.1 §5.9-5)
  {
    const minDef = goals.prepMorningMinDefense;
    const prepped = reports.flatMap((r) => r.runs.flatMap((run) => run.bossLog)).filter((b) => b.slot === 'morning' && b.prep);
    const ready = prepped.filter((b) => b.defenseUnits >= minDef && b.win !== null);
    const wins = ready.filter((b) => b.win).length;
    const rate = ready.length ? wins / ready.length : null;
    out.push({
      id: '준비보스',
      label: `준비 시간이 있는 아침 보스, 등장 시 방어 ≥ ${minDef}기: 처치율 ≥ ${fmt(goals.prepMorningWinRateMin * 100, 0)}% (전 정책 합산, D-021)`,
      pass: rate === null ? null : rate >= goals.prepMorningWinRateMin,
      detail:
        `해당 ${ready.length}회, 처치 ${wins}회 (${pct(rate)}) · 준비된 아침 보스 전체 ${prepped.length}회 (정책별 해당/처치: ` +
        reports
          .map((r) => {
            const rs = r.runs.flatMap((run) => run.bossLog).filter((b) => b.slot === 'morning' && b.prep && b.defenseUnits >= minDef && b.win !== null);
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
    const early = bal.summary.earlySunk;
    out.push({
      id: `B ${goals.earlyDays}일차`,
      label: `balanced: 1~${goals.earlyDays}일차 가라앉음 0~${goals.balancedEarlySinkMax}마리 (중앙값, 초반은 쉽게)`,
      pass: early.median <= goals.balancedEarlySinkMax,
      detail: `1~${goals.earlyDays}일차 가라앉음 중앙값 ${fmt(early.median)} [p90 ${fmt(early.p90)}]`,
    });
    const len = bal.summary.dayLength;
    const [lo, hi] = goals.dayLengthTargetSeconds;
    out.push({
      label: `하루 길이: 측정값 보고 (목표 ${fmt(lo / 60, 0)}~${fmt(hi / 60, 0)}분은 수치 조정 후 판정)`,
      pass: null,
      detail:
        `balanced 하루 길이 중앙값 ${fmt(len.median, 0)}초 (${fmt(len.median / 60, 1)}분) [p10 ${fmt(len.p10, 0)} ~ p90 ${fmt(len.p90, 0)}]` +
        ` · 낮 ${fmt(bal.summary.dayLengthDay?.median, 0)}초 + 밤 ${fmt(bal.summary.dayLengthNight?.median, 0)}초`,
    });
  } else out.push({ label: 'balanced', pass: null, detail: '실행하지 않음' });

  const hap = get('alwaysHappy');
  if (hap) {
    const maxLayers = Math.max(...hap.runs.map((r) => r.layersCleared));
    out.push({
      id: 'H 역류≥3',
      label: `alwaysHappy: 역류 반복 (중앙값 ≥ ${goals.alwaysHappyBackflowsMin}회)`,
      pass: hap.summary.backflows.median >= goals.alwaysHappyBackflowsMin,
      detail: `역류 중앙값 ${fmt(hap.summary.backflows.median)}`,
    });
    out.push({ id: 'H 층0', label: 'alwaysHappy: 층 돌파 0', pass: maxLayers === 0, detail: `층 돌파 최대 ${maxLayers}` });
  } else out.push({ label: 'alwaysHappy', pass: null, detail: '실행하지 않음' });
  return out;
}

/** --saveRoundTrip 결과 (정책별 일치 시드 수) */
export interface RoundTripCheck {
  policy: string;
  matched: number;
  total: number;
  /** 어긋난 시드 (앞 몇 개) */
  mismatchSeeds: number[];
}

/**
 * §8.2 M6 목표 (--until life). M6에서는 판정 출력만 하고 통과를 요구하지 않는다 (통과는 M6.5 완료 조건).
 * roundTrip이 주어지면 --saveRoundTrip 일치(M6 완료 조건)도 판정한다.
 */
export function checkM6Goals(
  reports: PolicyReport[],
  goals: SimConfig['m6Goals'],
  m5: SimConfig['m5Goals'],
  roundTrip: RoundTripCheck[] | null,
): GoalCheck[] {
  const out: GoalCheck[] = [];
  const get = (name: string) => reports.find((r) => r.policy === name);
  const d = (r: PolicyReport) => r.endings.dist;
  const inRange = (x: number, [lo, hi]: number[]) => x >= lo - 1e-12 && x <= hi + 1e-12;
  const distLine = (r: PolicyReport) => ENDING_IDS.map((id) => `${id} ${pctOf(d(r)[id])}`).join(' / ');

  const bal = get('balanced');
  if (bal) {
    const [sl, sh] = goals.balancedSolid;
    const [hl, hh] = goals.balancedHidden;
    out.push({
      id: 'B solid',
      label: `balanced: 단단한 어른 ${fmt(sl * 100, 0)}~${fmt(sh * 100, 0)}%`,
      pass: inRange(d(bal).solid, goals.balancedSolid),
      detail: distLine(bal),
    });
    out.push({
      id: 'B hidden',
      label: `balanced: 히든 ${fmt(hl * 100, 0)}~${fmt(hh * 100, 0)}%`,
      pass: inRange(d(bal).hidden, goals.balancedHidden),
      detail: `hidden ${pctOf(d(bal).hidden)}`,
    });
  } else out.push({ label: 'balanced', pass: null, detail: '실행하지 않음' });

  const hap = get('alwaysHappy');
  if (hap) {
    out.push({
      id: 'H mask',
      label: `alwaysHappy: 웃는 가면 ≥ ${fmt(goals.alwaysHappyMaskMin * 100, 0)}%`,
      pass: d(hap).mask >= goals.alwaysHappyMaskMin,
      detail: distLine(hap),
    });
    out.push({
      id: 'H best0',
      label: 'alwaysHappy: 단단한 어른·히든 0%',
      pass: d(hap).solid + d(hap).hidden === 0,
      detail: `solid ${pctOf(d(hap).solid)} + hidden ${pctOf(d(hap).hidden)}`,
    });
  } else out.push({ label: 'alwaysHappy', pass: null, detail: '실행하지 않음' });

  const unh = get('alwaysUnhappy');
  if (unh) {
    out.push({
      id: 'U best0',
      label: 'alwaysUnhappy: 단단한 어른·히든 0%',
      pass: d(unh).solid + d(unh).hidden === 0,
      detail: distLine(unh),
    });
  } else out.push({ label: 'alwaysUnhappy', pass: null, detail: '실행하지 않음' });

  const rnd = get('random');
  if (rnd) {
    const best = d(rnd).solid + d(rnd).hidden;
    out.push({
      id: 'R best<5',
      label: `random: 단단한 어른 + 히든 < ${fmt(goals.randomBestMax * 100, 0)}%`,
      pass: best < goals.randomBestMax,
      detail: `${pctOf(best)} (${distLine(rnd)})`,
    });
  } else out.push({ label: 'random', pass: null, detail: '실행하지 않음' });

  const hoard = get('hoarder');
  if (hoard && bal) {
    out.push({
      id: 'hoarder<B',
      label: 'hoarder: 결말 점수(happy + unhappy 중앙값)가 balanced보다 낮음',
      pass: hoard.endings.total.median < bal.endings.total.median,
      detail: `hoarder ${fmt(hoard.endings.total.median, 0)} vs balanced ${fmt(bal.endings.total.median, 0)}`,
    });
  } else out.push({ label: 'hoarder', pass: null, detail: 'hoarder와 balanced를 함께 실행해야 비교 가능' });

  if (roundTrip) {
    const all = roundTrip.every((r) => r.matched === r.total);
    out.push({
      id: 'roundTrip',
      label: '--saveRoundTrip: 끈 실행과 결과 완전 일치 (M6 완료 조건)',
      pass: all,
      detail: roundTrip
        .map((r) => `${r.policy} ${r.matched}/${r.total}${r.mismatchSeeds.length ? ` (어긋난 시드 ${r.mismatchSeeds.join(',')})` : ''}`)
        .join(' · '),
    });
  } else out.push({ label: '--saveRoundTrip', pass: null, detail: '--saveRoundTrip으로 실행하지 않음' });

  // 기존 M5 목표 회귀 없음 (1~2일차 가라앉음 0~2, alwaysHappy 역류 ≥ 3)
  if (bal) {
    const early = bal.summary.earlySunk;
    out.push({
      id: 'M5 초반',
      label: `M5 회귀: balanced 1~${m5.earlyDays}일차 가라앉음 0~${m5.balancedEarlySinkMax} (중앙값)`,
      pass: early.median <= m5.balancedEarlySinkMax,
      detail: `중앙값 ${fmt(early.median)} [p90 ${fmt(early.p90)}]`,
    });
  }
  if (hap) {
    out.push({
      id: 'M5 H역류',
      label: `M5 회귀: alwaysHappy 역류 ≥ ${m5.alwaysHappyBackflowsMin} (중앙값)`,
      pass: hap.summary.backflows.median >= m5.alwaysHappyBackflowsMin,
      detail: `역류 중앙값 ${fmt(hap.summary.backflows.median)}`,
    });
  }
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

/** 값별로 핵심 지표(중앙값)와 §8.2 목표(M4·M5) 충족 여부를 한 표에 */
export function formatSweep(key: string, rows: SweepRow[]): string {
  const med = (rs: PolicyReport[], policy: string, k: string, pct = false) => {
    const r = rs.find((x) => x.policy === policy);
    if (!r) return '—';
    const v = r.summary[k].median;
    return pct ? `${fmt(v * 100, 0)}%` : fmt(v);
  };
  const goalIds = [...new Set(rows.flatMap((r) => r.goals.flatMap((g) => (g.id ? [g.id] : []))))];
  const header = ['값', 'bal 역류', 'bal 보스처치', 'bal 가라앉음', 'bal 층', 'bal 손거울', '하루(초)', '충족', ...goalIds];
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
      med(row.reports, 'balanced', 'bossWins'),
      med(row.reports, 'balanced', 'sunk'),
      med(row.reports, 'balanced', 'layersCleared'),
      med(row.reports, 'balanced', 'downRatio', true),
      med(row.reports, 'balanced', 'dayLength'),
      `${ok}/${judged.length}`,
      ...goalIds.map(mark),
    ];
  });
  // 결말 열 (정책별 solid / hidden / mask %)
  const policies = [...new Set(rows.flatMap((r) => r.reports.map((p) => p.policy)))];
  const endHeader = ['값', ...policies.map((p) => `${p} s/h/m%`)];
  const endBody = rows.map((row) => [
    JSON.stringify(row.value),
    ...policies.map((p) => {
      const r = row.reports.find((x) => x.policy === p);
      if (!r) return '—';
      const e = r.endings.dist;
      return `${fmt(e.solid * 100, 0)}/${fmt(e.hidden * 100, 0)}/${fmt(e.mask * 100, 0)}`;
    }),
  ]);
  // 정책별 상세 (§5.12-4): 결말 분포·가라앉음·1~2일차·역류·밤 층 돌파·맡긴 비율·낮/밤 길이·점수 p50 (중앙값)
  const detailHeader = ['값', '정책', 'hid/sol/mask/qui/rainy %', '가라앉음', '1~2일차', '역류', '밤 층', '맡긴%', '낮(초)', '밤(초)', 'H p50', 'U p50'];
  const detailBody = rows.flatMap((row) =>
    row.reports.map((r) => {
      const e = r.endings.dist;
      const m = (k: string, d = 1) => fmt(r.summary[k]?.median ?? NaN, d);
      return [
        JSON.stringify(row.value),
        r.policy,
        [e.hidden, e.solid, e.mask, e.quiet, e.rainy].map((x) => fmt(x * 100, 0)).join('/'),
        m('sunk'),
        m('earlySunk'),
        m('backflows'),
        m('layersCleared'),
        fmt((r.summary.reservedRatio?.median ?? NaN) * 100, 0),
        m('dayLengthDay', 0),
        m('dayLengthNight', 0),
        fmt(r.endings.happy.median, 0),
        fmt(r.endings.unhappy.median, 0),
      ];
    }),
  );
  return (
    `■ --sweep ${key}\n${table(header, body)}\n\n결말 분포 (solid / hidden / mask %)\n${table(endHeader, endBody)}` +
    `\n\n정책별 상세 (중앙값)\n${table(detailHeader, detailBody)}`
  );
}

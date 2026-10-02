// 리포트: 시드 N개 결과 → 요약 통계, 콘솔 표, 비교 (스펙 §8.1, §5.19-6).
// M8.10: 시도 상한 안 완성률, 총 시도 수, 같은 스테이지 연속 실패 최대값, 스테이지별 시도·첫 시도 성공률·실패 사유,
//        핵 떨어뜨림·운반 시간·돌아오는 길 실패, 핵 남은 HP 분포.
// M8.11 (§5.20-10): 팀 교대 수(낮/밤), 스킬 발동 수(영웅별), 5단계 생성·특별 버프, 인연 켜진 비율, 최종 레벨(영웅별), 체인별 생성 비율.
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
    /** 보유 영웅: start(삽살·해태) / all(디버그 6명) */
    roster: string;
    /** 세션 모델 (§5.22-8): "attempts=6,offlineHours=8" / null */
    session?: string | null;
    replayPerfect?: boolean;
    /** --set으로 덮어쓴 값 (전체 경로 → 값). 없으면 JSON 그대로 */
    overrides?: Record<string, OverrideValue>;
  };
  sim: Omit<SimConfig, 'm810Goals' | 'm811Goals' | 'm812Goals'>;
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
  /** 체인별 생성 비율 (전 시드 합) */
  chainShare: Record<string, number>;
  /** 영웅별 스킬 발동 (판당 평균) · 최종 레벨 (중앙값) */
  skillsPerRun: Record<string, number>;
  levelMedian: Record<string, number>;
  /** 인연이 하나 이상 켜진 판 비율, 인연별 켜진 판 비율 */
  bondOnRate: number;
  bondRates: Record<string, number>;
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
  // §5.22-8 성장
  { key: 'sessions', label: '세션 수', get: (r) => r.sessions },
  { key: 'inkTime', label: '잉크 획득 (시간)', get: (r) => r.inkTime },
  { key: 'inkReward', label: '잉크 획득 (보상)', get: (r) => r.inkReward },
  { key: 'inkSpent', label: '잉크 사용 (붓기)', get: (r) => r.inkSpent },
  { key: 'dustEarned', label: '별가루 획득', get: (r) => r.dustEarned },
  { key: 'promotions', label: '진급 횟수', get: (r) => r.promotions },
  { key: 'returnShare', label: '낮 실패 중 돌아오는 길 비율', get: (r) => { const d = r.results.dayTime + r.results.dayFall + r.results.returnTime; return d ? r.results.returnTime / d : null; } },
  { key: 'perfectPages', label: '흠집 없음 장 수 (다시 읽기 뒤)', get: (r) => r.perfectPages },
  { key: 'booksOwned', label: '비법서 보유', get: (r) => r.books.length },
  // §5.20-13 조각이 생기는 길
  { key: 'gridFullRatio', label: '그리드 가득 참 비율 (전투 시간)', get: (r) => r.gridFullRatio },
  { key: 'piecesDiscarded', label: '버려진 조각 수', get: (r) => r.piecesDiscarded },
  { key: 'piecesAuto', label: '저절로 생긴 조각', get: (r) => r.piecesAuto },
  { key: 'piecesDropped', label: '처치 드롭 조각', get: (r) => r.piecesDropped },
  // §5.20-10
  { key: 'teamSwapsDay', label: '팀 교대 (낮)', get: (r) => r.teamSwapsDay },
  { key: 'teamSwapsNight', label: '팀 교대 (밤)', get: (r) => r.teamSwapsNight },
  { key: 'skills', label: '스킬 발동', get: (r) => sumPts(r.skillCasts) },
  { key: 'tier5Made', label: '5단계 생성', get: (r) => r.tier5Made },
  { key: 'specials', label: '특별 버프 발동', get: (r) => r.specials },
  { key: 'skillShare', label: '피해 중 스킬 비중', get: (r) => (totalDamage(r) + r.damageSkill > 0 ? r.damageSkill / (totalDamage(r) + r.damageSkill) : null) },
  { key: 'levelAvg', label: '최종 레벨 평균', get: (r) => { const v = Object.values(r.levels); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; } },
  { key: 'merges', label: '손 머지 수', get: (r) => r.merges },
  // D-070 자동 뭉침
  { key: 'autoMerges', label: '자동 뭉침 수', get: (r) => r.autoMerges ?? 0 },
  { key: 'handMergesPerMin', label: '손 머지/분', get: (r) => (r.playTime > 0 ? r.merges / (r.playTime / 60) : null) },
  // D-073 연쇄
  { key: 'chainAvg', label: '평균 연쇄 수 (손 머지당)', get: (r) => (r.merges > 0 ? 1 + (r.chainSteps ?? 0) / r.merges : null) },
  { key: 'chain2Ratio', label: '2연쇄 이상 비율', get: (r) => (r.merges > 0 ? (r.chains ?? 0) / r.merges : null) },
  // D-072 팀 교대 이어받기
  { key: 'handoverPieces', label: '교대 회수 조각', get: (r) => r.handoverPieces ?? 0 },
  { key: 'battleMergeRatio', label: '전투 중 머지 비율', get: (r) => (r.merges + (r.autoMerges ?? 0) ? r.battleMerges / (r.merges + (r.autoMerges ?? 0)) : null) },
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

  const chainCount: Record<string, number> = {};
  let total = 0;
  const soldiersByKind: Record<string, number> = {};
  const skillSum: Record<string, number> = {};
  const levels: Record<string, number[]> = {};
  const bondCount: Record<string, number> = {};
  for (const r of runs) {
    for (const [t, c] of Object.entries(r.chainSpawns)) {
      chainCount[t] = (chainCount[t] ?? 0) + c;
      total += c;
    }
    for (const [k, c] of Object.entries(r.soldiersByKind)) soldiersByKind[k] = (soldiersByKind[k] ?? 0) + c;
    for (const [k, c] of Object.entries(r.skillCasts)) skillSum[k] = (skillSum[k] ?? 0) + c;
    for (const [k, l] of Object.entries(r.levels)) (levels[k] ??= []).push(l);
    for (const b of new Set(r.bonds)) bondCount[b] = (bondCount[b] ?? 0) + 1;
  }
  const n = Math.max(1, runs.length);
  const chainShare: Record<string, number> = {};
  for (const [t, c] of Object.entries(chainCount)) chainShare[t] = total === 0 ? 0 : c / total;
  const skillsPerRun = Object.fromEntries(Object.entries(skillSum).map(([k, v]) => [k, v / n]));
  const levelMedian = Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, median(v) ?? NaN]));
  const bondRates = Object.fromEntries(Object.entries(bondCount).map(([k, v]) => [k, v / n]));

  const resTotals = ATTEMPT_RESULTS.map((res) => runs.reduce((s, r) => s + r.results[res], 0));
  const resAll = resTotals.reduce((a, b) => a + b, 0);
  const hp = runs.flatMap((r) => r.coreHpLeft);
  const buckets = [0, 0, 0, 0];
  for (const v of hp) buckets[HP_BUCKETS.filter((b) => v > b).length] += 1;
  const done = runs.filter((r) => r.completed);

  const { m810Goals: _g10, m811Goals: _g11, m812Goals: _g12, ...sim } = cfg;
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
    chainShare,
    skillsPerRun,
    levelMedian,
    bondOnRate: runs.filter((r) => r.bonds.length > 0).length / n,
    bondRates,
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
  return r.options.roster === 'all' ? `${r.policy}[all]` : r.policy;
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
    `■ ${policyLabel(r)}  (시드 ${o.seeds}, 그리드 ${o.grid}, 시도 상한 ${o.maxAttempts}, 영웅 ${o.roster}${o.session ? `, 세션 ${o.session}` : ''}${o.replayPerfect ? ', 다시 읽기 10장' : ''})`,
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
    `체인별 생성 비율: ${Object.entries(r.chainShare).map(([k, v]) => `${k} ${pctOf(v)}`).join(' · ') || '—'}`,
    formatStages(r),
    formatHeroes(r),
  ];
  return lines.join('\n');
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

/** 편성·인연·영웅별 레벨·스킬 + 병사 체인·단별 */
export function formatHeroes(r: PolicyReport): string {
  const n = Math.max(1, r.runs.length);
  const f = r.runs[0]?.formation;
  const team = (t: string[][]) => t.map((x) => `[${x.join('·')}]`).join(' ');
  const kinds = Object.keys(r.soldiersByKind).sort();
  return [
    `편성 (첫 시드): 공격대 ${f ? team(f.offense) : '—'} / 수비대 ${f ? team(f.defense) : '—'} · 인연 켜진 판 ${pctOf(r.bondOnRate)} (${Object.entries(r.bondRates).map(([k, v]) => `${k} ${pctOf(v)}`).join(' · ') || '없음'})`,
    `영웅 최종 레벨 (중앙값): ${Object.entries(r.levelMedian).map(([k, v]) => `${k} ${fmt(v, 1)}`).join(' · ')}`,
    `영웅 최종 ★ (중앙값): ${heroMedian(r, (x) => x.stars)}`,
    `비법서 해금 (판 비율): ${bookRates(r)} · 흠집 없음 장 수 중앙값 ${fmt(median(r.runs.map((x) => x.perfectPages)), 1)}${r.options.replayPerfect ? ' (다시 읽기 10장 뒤)' : ''}`,
    `스킬 발동 (판당 평균): ${Object.entries(r.skillsPerRun).map(([k, v]) => `${k} ${fmt(v, 1)}`).join(' · ') || '없음'}`,
    `병사 출전 (판당 평균, 체인:단): ${kinds.length ? kinds.map((k) => `${k}단 ${fmt(r.soldiersByKind[k] / n, 2)}`).join(' · ') : '없음'}`,
  ].join('\n');
}

function heroMedian(r: PolicyReport, pick: (x: RunResult) => Record<string, number>): string {
  const by: Record<string, number[]> = {};
  for (const x of r.runs) for (const [k, v] of Object.entries(pick(x))) (by[k] ??= []).push(v);
  return Object.entries(by).map(([k, v]) => `${k} ${fmt(median(v), 1)}`).join(' · ') || '—';
}

function bookRates(r: PolicyReport): string {
  const n = Math.max(1, r.runs.length);
  const c: Record<string, number> = {};
  for (const x of r.runs) for (const b of x.books) c[b] = (c[b] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k} ${pctOf(v / n)}`).join(' · ') || '없음';
}

/** 정책 간 비교 표 (중앙값 중심) */
export function formatComparison(reports: PolicyReport[]): string {
  const keys = ['attempts', 'maxFailStreak', 'stage', 'dayFails', 'returnTime', 'nightFails', 'coreDrops', 'carryTime', 'coreHpLeft', 'sessions', 'levelAvg', 'promotions', 'inkSpent', 'soldierShare', 'returnShare', 'perfectPages'];
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

/**
 * §5.22-8 M8.12 진행 목표 (판정 출력만, (b) 튜닝 기준): balanced 총 시도·세션·첫 시도·연속 실패·완성률,
 * noInk 총 시도 ≥ balanced × 1.3, dayHeavy·nightHeavy 완성률 < balanced, 피해 중 병사 비중, 낮 실패 중 돌아오는 길 비율
 */
export function checkM812Goals(reports: PolicyReport[], g: SimConfig['m812Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  const by = (name: string) => reports.find((r) => r.policy === name && r.options.roster === 'start');
  const b = by('balanced');
  const inRange = (v: number | null | undefined, [lo, hi]: number[]) => (v === null || v === undefined || Number.isNaN(v) ? null : v >= lo && v <= hi);
  if (b) {
    const att = b.completeAttempts.median;
    out.push({ id: 'B 시도', label: `balanced: 1-10까지 총 시도 중앙값 ${g.balancedAttempts[0]}~${g.balancedAttempts[1]}`, pass: inRange(att, g.balancedAttempts), detail: `중앙값 ${fmt(att, 1)} (완성한 판 ${b.completeAttempts.n})` });
    const ses = median(b.runs.filter((x) => x.completed).map((x) => x.sessions));
    out.push({ id: 'B 세션', label: `balanced: 세션 ${g.balancedSessions[0]}~${g.balancedSessions[1]}개 (완성한 판)`, pass: inRange(ses, g.balancedSessions), detail: `세션 중앙값 ${fmt(ses, 1)}` });
    const ft = (st: number) => b.stages[st - 1]?.firstTryRate ?? null;
    out.push({ id: 'B 1-1', label: `balanced: 1-1 첫 시도 성공률 ≥ ${pctOf(g.firstTry11Min)}`, pass: ft(1) === null ? null : ft(1)! >= g.firstTry11Min, detail: `1-1 ${pctOf(ft(1) ?? NaN)}` });
    out.push({ id: 'B 1-9', label: `balanced: 1-9 첫 시도 성공률 ${pctOf(g.firstTry19[0])}~${pctOf(g.firstTry19[1])}`, pass: inRange(ft(9), g.firstTry19), detail: `1-9 ${pctOf(ft(9) ?? NaN)}` });
    out.push({ id: 'B 연속실패', label: `balanced: 같은 스테이지 연속 실패 최대 중앙값 ${g.balancedFailStreak[0]}~${g.balancedFailStreak[1]}`, pass: inRange(b.summary.maxFailStreak.median, g.balancedFailStreak), detail: `중앙값 ${fmt(b.summary.maxFailStreak.median, 1)}` });
    out.push({ id: 'B 완성', label: `balanced: 시도 50 안 완성률 ≥ ${pctOf(g.balancedCompleteMin)}`, pass: b.completedRate >= g.balancedCompleteMin, detail: `완성 ${pctOf(b.completedRate)}` });
    const sh = b.summary.soldierShare?.median ?? null;
    out.push({ id: '병사 비중', label: `balanced: 피해 중 병사 비중 ${pctOf(g.soldierShare[0])}~${pctOf(g.soldierShare[1])}`, pass: inRange(sh, g.soldierShare), detail: `중앙값 ${pctOf(sh ?? NaN)}` });
    const rs = b.summary.returnShare?.median ?? null;
    out.push({ id: '돌아오는 길', label: `balanced: 낮 실패 중 "돌아오는 길" 비율 ≥ ${pctOf(g.returnShareMin)}`, pass: rs === null ? null : rs >= g.returnShareMin, detail: `중앙값 ${pctOf(rs ?? NaN)}` });
  }
  const ni = by('noInk');
  if (b && ni) {
    const a = b.summary.attempts.median;
    const n = ni.summary.attempts.median;
    out.push({ id: 'noInk', label: `noInk: 총 시도가 balanced보다 ${Math.round((g.noInkAttemptsMult - 1) * 100)}% 이상 많음 (잉크가 의미 있음)`, pass: a > 0 ? n >= a * g.noInkAttemptsMult : null, detail: `noInk ${fmt(n, 1)} vs balanced ${fmt(a, 1)} (완성 ${pctOf(ni.completedRate)} vs ${pctOf(b.completedRate)})` });
  }
  // (b) §5.22-10: 시도 상한 50에서는 다 완성되므로 "완성률 < balanced" 대신 "총 시도 ≥ balanced × heavyAttemptsMult"
  for (const name of ['dayHeavy', 'nightHeavy']) {
    const h = by(name);
    if (!b || !h) continue;
    const a = b.summary.attempts.median;
    const n = h.summary.attempts.median;
    out.push({
      id: name,
      label: `${name}: 총 시도 ≥ balanced × ${g.heavyAttemptsMult} (한쪽만 키우면 오래 걸림)`,
      pass: a > 0 ? n >= a * g.heavyAttemptsMult : null,
      detail: `${name} ${fmt(n, 1)} vs balanced ${fmt(a, 1)} × ${g.heavyAttemptsMult} = ${fmt(a * g.heavyAttemptsMult, 1)} (완성 ${pctOf(h.completedRate)})`,
    });
  }
  return out;
}

/** §5.20-10 M8.11 목표 (판정 출력만, 튜닝은 M8.12 뒤): noMerge < balanced 절반, lazy < balanced, roster all 인연 켬 < 끔 (완성 시도 수) */
export function checkM811Goals(reports: PolicyReport[], goals: SimConfig['m811Goals']): GoalCheck[] {
  const out: GoalCheck[] = [];
  for (const roster of ['start', 'all']) {
    const by = (name: string) => reports.find((r) => r.policy === name && r.options.roster === roster);
    const b = by('balanced');
    const nm = by('noMerge');
    const lz = by('lazy');
    if (b && nm) {
      out.push({
        id: `noMerge ${roster}`,
        label: `[${roster}] noMerge 완성률 < balanced의 ${pctOf(goals.noMergeVsBalanced)} (머지가 중요)`,
        pass: nm.completedRate < b.completedRate * goals.noMergeVsBalanced || (b.completedRate === 0 ? null : false),
        detail: `noMerge ${pctOf(nm.completedRate)} vs balanced ${pctOf(b.completedRate)}`,
      });
    }
    if (b && lz) {
      out.push({
        id: `lazy ${roster}`,
        label: `[${roster}] lazy 완성률 < balanced (전투 중 머지가 의미 있다)`,
        pass: lz.completedRate < b.completedRate,
        detail: `lazy ${pctOf(lz.completedRate)} (완성 시도 p50 ${fmt(lz.completeAttempts.median, 1)}) vs balanced ${pctOf(b.completedRate)} (${fmt(b.completeAttempts.median, 1)})`,
      });
    }
  }
  const on = reports.find((r) => r.policy === 'bondOn' && r.options.roster === 'all');
  const off = reports.find((r) => r.policy === 'bondOff' && r.options.roster === 'all');
  if (on && off) {
    out.push({
      id: 'bond all',
      label: '[all] 인연 켠 편성(bondOn)이 끈 편성(bondOff)보다 완성 시도 수 적음',
      pass: on.completeAttempts.n && off.completeAttempts.n ? on.completeAttempts.median < off.completeAttempts.median : on.completedRate > off.completedRate,
      detail: `bondOn 완성 ${pctOf(on.completedRate)}·시도 p50 ${fmt(on.completeAttempts.median, 1)} (인연 ${Object.keys(on.bondRates).join(',') || '없음'}) vs bondOff ${pctOf(off.completedRate)}·${fmt(off.completeAttempts.median, 1)} (인연 ${Object.keys(off.bondRates).join(',') || '없음'})`,
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

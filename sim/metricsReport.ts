// 사람 플레이 metrics 분석 (스펙 §5.10-6, §5.19). 내보낸 hau_metrics_v4 JSON → 시도·스테이지·먹이기·주관 평가 표.
// 순수 함수만 (CLI는 sim/metrics.ts). --bot: 같은 지표를 봇 리포트(balanced)와 나란히.
import { ATTEMPT_RESULTS } from '../src/core/day';
import type { AttemptMetrics, LifeMetrics, MetricsData } from '../src/metrics/model';
import type { PolicyReport } from './report';

export interface Section {
  title: string;
  header: string[];
  rows: string[][];
  /** 표 아래 한 줄 메모 */
  note?: string;
}

// ── 통계 헬퍼 ──

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

export function fmt(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export function pct(part: number, total: number): string {
  return total === 0 ? '—' : `${fmt((part / total) * 100, 1)}%`;
}

const shortId = (l: LifeMetrics) => `${l.seed}@${l.startedAt.slice(0, 10)}`;
const allAttempts = (data: MetricsData) => data.lives.flatMap((l) => l.attempts);

/** 가장 긴 연속 날짜 수 (YYYY-MM-DD 집합) */
export function longestStreak(dates: string[]): number {
  const days = [...new Set(dates)].map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] - days[i - 1] === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** 시도 길이 표본: 배속을 쓴 시도 제외 */
export const lengthSample = (d: AttemptMetrics) => d.speedUsed === 0;

/** 같은 스테이지 연속 실패 최대값 (판 하나) */
export function lifeFailStreak(l: LifeMetrics): number {
  let best = 0;
  let run = 0;
  let stage = 0;
  for (const a of [...l.attempts].sort((x, y) => x.attempt - y.attempt)) {
    if (a.stage !== stage) {
      stage = a.stage;
      run = 0;
    }
    if (a.result === 'success') run = 0;
    else best = Math.max(best, ++run);
  }
  return best;
}

// ── 섹션 ──

export function analyze(data: MetricsData): Section[] {
  const atts = allAttempts(data);
  const out: Section[] = [];

  out.push({
    title: '개요',
    header: ['판', '끝낸 시도', '세션', '세션 날짜', '최장 연속 날짜', '시도 도중 복원'],
    rows: [
      [
        String(data.lives.length),
        String(atts.length),
        String(data.sessions.length),
        String(new Set(data.sessions.map((s) => s.realDate)).size),
        String(longestStreak(data.sessions.map((s) => s.realDate))),
        String(data.lives.reduce((s, l) => s + l.midAttemptRestores, 0)),
      ],
    ],
  });

  // 스테이지별 결과
  const stages = [...new Set(atts.map((a) => a.stage))].sort((a, b) => a - b);
  out.push({
    title: '스테이지별 시도 결과',
    header: ['스테이지', '시도', ...ATTEMPT_RESULTS],
    rows: stages.map((st) => {
      const xs = atts.filter((a) => a.stage === st);
      return [`1-${st}`, String(xs.length), ...ATTEMPT_RESULTS.map((r) => pct(xs.filter((a) => a.result === r).length, xs.length))];
    }),
  });

  // 시간
  const sample = atts.filter(lengthSample);
  out.push({
    title: '시도 길이 (실제 초, 배속 쓴 시도 제외)',
    header: ['표본', '중앙값', '낮 중앙값', '밤 중앙값', '게임 시간 중앙값'],
    rows: [
      [
        String(sample.length),
        fmt(median(sample.map((d) => d.realSeconds))),
        fmt(median(sample.map((d) => d.dayRealSeconds))),
        fmt(median(sample.filter((d) => d.nightRealSeconds > 0).map((d) => d.nightRealSeconds))),
        fmt(median(atts.map((d) => d.record.realSeconds))),
      ],
    ],
  });

  // 먹이기
  const feeds = atts.flatMap((d) => d.feeds);
  const tiers = [...new Set(feeds.map((f) => f.tier))].sort((a, b) => a - b);
  out.push({
    title: '먹이기',
    header: ['먹이기', '밤덱 비율', ...tiers.map((t) => `${t}단계`)],
    rows: [[String(feeds.length), pct(feeds.filter((f) => f.role === 'defense').length, feeds.length), ...tiers.map((t) => pct(feeds.filter((f) => f.tier === t).length, feeds.length))]],
  });

  // 주관 평가
  const rated = atts.filter((a) => a.rating);
  const count = (k: 'day' | 'retry', v: string) => rated.filter((a) => a.rating?.[k] === v).length;
  out.push({
    title: '주관 평가 (이야기 한 장)',
    header: ['평가한 시도', '좋았다', '그저 그랬다', '별로였다', '다시 하고 싶다', '지친다'],
    rows: [[String(rated.length), String(count('day', 'good')), String(count('day', 'meh')), String(count('day', 'bad')), String(count('retry', 'again')), String(count('retry', 'tired'))]],
  });

  // 판별
  out.push({
    title: '판별',
    header: ['판', '끝낸 시도', '끝', '연속 실패 최대', '갈림길', '납득'],
    rows: data.lives.map((l) => [
      shortId(l),
      String(l.attempts.length),
      l.chapter ? `완성 (시도 ${l.chapter.attempts})` : `진행 중 1-${Math.max(0, ...l.attempts.map((a) => a.stage))}`,
      String(lifeFailStreak(l)),
      l.milestoneChoices.map((c) => c.choiceId).join(',') || '—',
      l.endingAgree === null ? '—' : l.endingAgree ? '응' : '아니',
    ]),
  });
  return out;
}

/** 봇(balanced) 리포트와 같은 지표 비교 */
export function compareWithBot(data: MetricsData, bot: PolicyReport): Section {
  const atts = allAttempts(data);
  const lives = data.lives;
  const done = lives.filter((l) => l.chapter);
  const res = (r: string) => pct(atts.filter((a) => a.result === r).length, atts.length);
  return {
    title: `사람 vs 봇 (${bot.policy}, 시드 ${bot.options.seeds})`,
    header: ['지표', '사람', '봇'],
    rows: [
      ['완성한 판 총 시도 (중앙값)', fmt(median(done.map((l) => l.chapter!.attempts))), fmt(bot.completeAttempts.median)],
      ['연속 실패 최대 (중앙값)', fmt(median(lives.map(lifeFailStreak))), fmt(bot.summary.maxFailStreak.median)],
      ['성공 비율 (시도당)', res('success'), pct(bot.resultShare.success, 1)],
      ['밤 실패 비율', res('night'), pct(bot.resultShare.night, 1)],
      ['게임 시간 시도 길이 (중앙값)', fmt(median(atts.map((d) => d.record.realSeconds))), fmt(bot.summary.attemptLength.median)],
    ],
  };
}

/** 한글은 폭 2로 계산 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯⺀-鿿]/.test(ch) ? 2 : 1;
  return w;
}

export function formatSection(s: Section): string {
  const widths = s.header.map((h, i) => Math.max(width(h), ...s.rows.map((r) => width(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - width(c)))).join('  ');
  const body = [line(s.header), widths.map((w) => '-'.repeat(w)).join('  '), ...s.rows.map(line)].join('\n');
  return `■ ${s.title}\n${body}${s.note ? `\n${s.note}` : ''}`;
}

export function formatAnalysis(sections: Section[]): string {
  return sections.map(formatSection).join('\n\n');
}

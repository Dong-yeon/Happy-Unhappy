// 사람 플레이 metrics 분석 (스펙 §5.10-6). 내보낸 hau_metrics_v2 JSON → §1 가설 H1~H6·주관·결과 표.
// 순수 함수만 (CLI는 sim/metrics.ts). --bot: 같은 지표를 봇 리포트(balanced)와 나란히.
import type { DayMetrics, LifeMetrics, MetricsData } from '../src/metrics/model';
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

const gridKey = (l: LifeMetrics) => `${l.gridSize.cols}x${l.gridSize.rows}`;
const shortId = (l: LifeMetrics) => `${l.seed}@${l.startedAt.slice(0, 10)}`;
const allDays = (data: MetricsData) => data.lives.flatMap((l) => l.days);

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

/** H4 하루 길이 표본: 배속·우회를 쓴 날 제외 */
export const h4Sample = (d: DayMetrics) => d.speedUsed === 0 && !d.bypass;

/** H3: 층 돌파 → 같은 날 다음 낮덱(오펜스) 먹이기까지 시간 (게임 시간 초, v3: 구 Unhappy 소환) */
export function layerToNextDown(days: DayMetrics[]): { gaps: number[]; noNext: number } {
  const gaps: number[] = [];
  let noNext = 0;
  for (const d of days) {
    const downs = d.feeds.filter((s) => s.role === 'offense').map((s) => s.t);
    for (const t of d.dayStats.layerClearTimes) {
      const next = downs.find((x) => x > t);
      if (next === undefined) noNext += 1;
      else gaps.push(next - t);
    }
  }
  return { gaps, noNext };
}

// ── 섹션 ──

export function analyze(data: MetricsData): Section[] {
  const days = allDays(data);
  const out: Section[] = [];

  // 개요
  out.push({
    title: '개요',
    header: ['일생', '끝낸 날', '세션', '세션 날짜', '판 도중 복원', '우회 일생'],
    rows: [
      [
        String(data.lives.length),
        String(days.length),
        String(data.sessions.length),
        String(new Set(data.sessions.map((s) => s.realDate)).size),
        String(data.lives.reduce((s, l) => s + l.midDayRestores, 0)),
        String(data.lives.filter((l) => l.gatingBypassUsed).length),
      ],
    ],
  });

  // H1 — 밤덱 먹이기 비율 (일생·일차·칸 열, v3: 구 Unhappy 소환 비율)
  {
    const rows: string[][] = data.lives.map((l) => {
      const ss = l.days.flatMap((d) => d.feeds);
      const down = ss.filter((s) => s.role === 'defense').length;
      return [`일생 ${shortId(l)} (${gridKey(l)})`, String(ss.length), String(down), pct(down, ss.length)];
    });
    const byDay = new Map<number, { n: number; down: number }>();
    for (const d of days) {
      const e = byDay.get(d.day) ?? { n: 0, down: 0 };
      e.n += d.feeds.length;
      e.down += d.feeds.filter((s) => s.role === 'defense').length;
      byDay.set(d.day, e);
    }
    for (const [day, e] of [...byDay].sort(([a], [b]) => a - b)) rows.push([`${day}일차`, String(e.n), String(e.down), pct(e.down, e.n)]);
    const byCol = new Map<number, { n: number; down: number }>();
    for (const s of days.flatMap((d) => d.feeds)) {
      const e = byCol.get(s.cell.col) ?? { n: 0, down: 0 };
      e.n += 1;
      if (s.role === 'defense') e.down += 1;
      byCol.set(s.cell.col, e);
    }
    for (const [col, e] of [...byCol].sort(([a], [b]) => a - b)) rows.push([`칸 열 ${col}`, String(e.n), String(e.down), pct(e.down, e.n)]);
    out.push({ title: 'H1 밤덱 먹이기 비율 (일생 · 일차 · 칸 열 — 왼쪽/오른쪽 편향)', header: ['구분', '먹이기', '밤덱', '비율'], rows });
  }

  // H2 — 먹인 단계 분포 (낮덱/밤덱 따로)
  {
    const ss = days.flatMap((d) => d.feeds);
    const tiers = [...new Set(ss.map((s) => s.tier))].sort((a, b) => a - b);
    const rows = (['offense', 'defense'] as const).map((role) => {
      const xs = ss.filter((s) => s.role === role);
      return [role === 'offense' ? '낮덱 (오펜스)' : '밤덱 (디펜스)', String(xs.length), ...tiers.map((t) => pct(xs.filter((s) => s.tier === t).length, xs.length))];
    });
    out.push({ title: 'H2 먹인 단계 분포', header: ['덱', '먹이기', ...tiers.map((t) => `${t}단계`)], rows });
  }

  // H3 — 층 돌파 → 다음 Unhappy 소환
  {
    const { gaps, noNext } = layerToNextDown(days);
    out.push({
      title: 'H3 층 돌파 → 다음 낮덱 먹이기까지 (게임 시간)',
      header: ['층 돌파', '다음 먹이기 있음', '중앙값(초)', 'p90(초)', '그날 다음 먹이기 없음'],
      rows: [[String(gaps.length + noNext), String(gaps.length), fmt(median(gaps)), fmt(quantile(gaps, 0.9)), String(noNext)]],
    });
  }

  // H4 — 하루 길이, 세션
  {
    const sample = days.filter(h4Sample);
    const excluded = days.length - sample.length;
    const dates = data.sessions.map((s) => s.realDate);
    const perDate = new Map<string, { sessions: number; fg: number; days: number }>();
    for (const s of data.sessions) {
      const e = perDate.get(s.realDate) ?? { sessions: 0, fg: 0, days: 0 };
      e.sessions += 1;
      e.fg += s.foregroundSeconds;
      perDate.set(s.realDate, e);
    }
    for (const d of days) {
      const e = perDate.get(d.realDate) ?? { sessions: 0, fg: 0, days: 0 };
      e.days += 1;
      perDate.set(d.realDate, e);
    }
    const rows: string[][] = [
      ['하루 길이 중앙값 (실제 초, 배속·우회 제외)', fmt(median(sample.map((d) => d.realSeconds)), 0), `n=${sample.length} (제외 ${excluded})`],
      ['하루 길이 중앙값 (게임 시간 ×1)', fmt(median(sample.map((d) => d.dayStats.realSeconds)), 0), ''],
      ['연속 접속 일수 (최장)', String(longestStreak(dates)), ''],
      ['하루에 연 날 수 (중앙값 / 최대)', `${fmt(median([...perDate.values()].map((e) => e.days)))} / ${Math.max(0, ...[...perDate.values()].map((e) => e.days))}`, ''],
    ];
    for (const [date, e] of [...perDate].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push([`  ${date}`, `세션 ${e.sessions} · 끝낸 날 ${e.days}`, `앱 ${fmt(e.fg / 60, 1)}분`]);
    }
    out.push({ title: 'H4 하루 길이 · 세션', header: ['지표', '값', '비고'], rows });
  }

  // H5 — 체인별 3단계 도달·영웅 첫 소환 일차
  {
    const chains = new Set<string>();
    const rows: string[][] = [];
    for (const l of data.lives) {
      const firstHero: Record<string, number> = {};
      for (const d of l.days) for (const s of d.feeds) if (s.tier >= 3 && firstHero[s.chain] === undefined) firstHero[s.chain] = d.day;
      for (const c of [...Object.keys(firstHero), ...Object.keys(l.stats?.tier3ByChain ?? {})]) chains.add(c);
      for (const c of [...chains].sort()) {
        rows.push([
          `일생 ${shortId(l)}`,
          c,
          l.stats ? String(l.stats.tier3ByChain[c] ?? 0) : '(진행 중)',
          String(firstHero[c] ?? '—'),
        ]);
      }
      chains.clear();
    }
    out.push({
      title: 'H5 체인별 3단계 도달 · 3단계 첫 먹이기 일차',
      header: ['판', '체인', '3단계 도달(머지)', '3단계 첫 먹이기'],
      rows,
      note: '3단계 도달 수는 chapterComplete 때 판 stats로 확정 (진행 중 일생은 영웅 첫 소환만 소환 기록에서 계산)',
    });
  }

  // H6 — 그리드 프리셋별
  {
    const groups = new Map<string, DayMetrics[]>();
    for (const l of data.lives) groups.set(gridKey(l), [...(groups.get(gridKey(l)) ?? []), ...l.days]);
    const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, ds]) => {
      const game = ds.reduce((s, d) => s + d.dayStats.realSeconds, 0);
      const full = ds.reduce((s, d) => s + d.dayStats.gridFullSeconds, 0);
      const rel = ds.reduce((s, d) => s + d.dayStats.releases, 0);
      const relTiers: number[] = [];
      for (const d of ds) d.dayStats.releaseTiers.forEach((n, t) => (relTiers[t] = (relTiers[t] ?? 0) + n));
      const sum = (f: (d: DayMetrics) => number) => ds.reduce((s, d) => s + f(d), 0);
      return [
        g,
        String(ds.length),
        game > 0 ? `${fmt((full / game) * 100, 1)}%` : '—',
        `${rel} (${relTiers.map((n, t) => `${t === 0 ? 'W' : t}:${n ?? 0}`).join(' ')})`,
        String(sum((d) => d.dayStats.lostReturns)),
        `${sum((d) => d.dropFails.invalid)}/${sum((d) => d.dropFails.laneFull)}/${sum((d) => d.dropFails.wildcard)}`,
        fmt(ds.length ? sum((d) => d.dragDistance) / ds.length : null, 0),
      ];
    });
    out.push({
      title: 'H6 그리드 (프리셋별)',
      header: ['프리셋', '날', '가득 참 비율', '놓아주기 (단계별, W=와일드카드)', '귀환 소실', '드롭 실패 영역밖/정원/와일드', '드래그 px/일'],
      rows,
    });
  }

  // 주관
  {
    const r = { good: 0, meh: 0, bad: 0, none: 0, tense: 0, annoyed: 0, bfNone: 0 };
    for (const d of days) {
      if (d.rating?.day) r[d.rating.day] += 1;
      else r.none += 1;
      if (d.dayStats.backflow) {
        if (d.rating?.backflow) r[d.rating.backflow] += 1;
        else r.bfNone += 1;
      }
    }
    const agree = data.lives.filter((l) => l.chapter);
    out.push({
      title: '주관 평가',
      header: ['질문', '응답'],
      rows: [
        ['오늘은? 좋았다/그저/별로 (무응답)', `${r.good}/${r.meh}/${r.bad} (${r.none})`],
        ['역류는? 긴장/짜증 (무응답, 역류 있던 날만)', `${r.tense}/${r.annoyed} (${r.bfNone})`],
        [
          '이 챕터의 끝, 납득돼? 응/아니 (무응답)',
          `${agree.filter((l) => l.endingAgree === true).length}/${agree.filter((l) => l.endingAgree === false).length} (${agree.filter((l) => l.endingAgree === null).length})`,
        ],
      ],
    });
  }

  // 결과
  out.push({
    title: '결과',
    header: ['판', '그리드', '끝낸 날', '챕터', '스테이지', '가라앉음', '갈림길'],
    rows: data.lives.map((l) => [
      shortId(l),
      gridKey(l),
      String(l.days.length),
      l.chapter ? (l.chapter.completed ? `완성 (${l.chapter.day}일)` : `미완성 (${l.chapter.day}일)`) : '(진행 중)',
      l.chapter ? `1-${l.chapter.stage}` : '—',
      String(l.stats?.sunkCount ?? l.days.reduce((s, d) => s + d.dayStats.sunk, 0)),
      l.milestoneChoices.map((c) => `${c.day}일 ${c.choiceId}`).join(', ') || '—',
    ]),
  });
  return out;
}

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  return s[Math.floor(pos)] + (s[Math.ceil(pos)] - s[Math.floor(pos)]) * (pos - Math.floor(pos));
}

/** --bot: 같은 지표를 봇 리포트(balanced)와 나란히 (봇에 없는 지표는 —) */
export function compareWithBot(data: MetricsData, bot: PolicyReport): Section {
  const days = allDays(data);
  const ss = days.flatMap((d) => d.feeds);
  const down = ss.filter((s) => s.role === 'defense').length;
  const tierShare = (t: number) => pct(ss.filter((s) => s.tier === t).length, ss.length);
  const game = days.reduce((s, d) => s + d.dayStats.realSeconds, 0);
  const full = days.reduce((s, d) => s + d.dayStats.gridFullSeconds, 0);
  const perLife = (f: (l: LifeMetrics) => number) => median(data.lives.map(f));
  const bs = bot.summary;
  const botPct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${fmt(x * 100, 1)}%`);
  const ended = data.lives.filter((l) => l.chapter);
  const rows: string[][] = [
    [
      'H1 밤덱 먹이기 비율 (봇: 점수 비율)',
      pct(down, ss.length),
      botPct((bs.defensePoints?.median ?? NaN) / ((bs.defensePoints?.median ?? NaN) + (bs.offensePoints?.median ?? NaN))),
    ],
    ...[1, 2, 3].map((t) => [`H2 ${t}단계 먹이기 비율`, tierShare(t), botPct(bot.feedTierShare?.[String(t)])]),
    ['H4 하루 길이 중앙값 (게임 초 ×1)', fmt(median(days.filter(h4Sample).map((d) => d.dayStats.realSeconds)), 0), fmt(bs.dayLength?.median, 0)],
    ['H6 그리드 가득 참 비율', game > 0 ? `${fmt((full / game) * 100, 1)}%` : '—', botPct(bs.gridFullRatio?.mean)],
    ['H6 놓아주기 (일생당 중앙값)', fmt(perLife((l) => l.days.reduce((s, d) => s + d.dayStats.releases, 0))), fmt(bs.releases?.median)],
    ['H6 지급 소실 (판당 중앙값)', fmt(perLife((l) => l.days.reduce((s, d) => s + d.dayStats.lostReturns, 0))), fmt(bs.lostReturns?.median)],
    ['층 돌파 (일생당 중앙값)', fmt(perLife((l) => l.days.reduce((s, d) => s + d.dayStats.layersCleared, 0))), fmt(bs.layersCleared?.median)],
    ['역류 (일생당 중앙값)', fmt(perLife((l) => l.days.filter((d) => d.dayStats.backflow).length)), fmt(bs.backflows?.median)],
    ['가라앉음 (일생당 중앙값)', fmt(perLife((l) => l.days.reduce((s, d) => s + d.dayStats.sunk, 0))), fmt(bs.sunk?.median)],
    ['챕터 완성률', ended.length ? pct(ended.filter((l) => l.chapter!.completed).length, ended.length) : '—', botPct(bot.chapter?.completedRate)],
  ];
  const daysPerLife = median(data.lives.map((l) => l.days.length));
  return {
    title: `봇 비교 (${bot.policy}, 시드 ${bot.options.seeds}, ${bot.options.days}일)`,
    header: ['지표', '사람', '봇'],
    rows,
    note: `사람 판은 끝낸 날 수 중앙값 ${fmt(daysPerLife)}일 기준 (봇보다 짧으면 판당 합계는 봇보다 작게 나온다)`,
  };
}

// ── 출력 ──

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯⺀-鿿]/.test(ch) ? 2 : 1;
  return w;
}

export function formatSection(s: Section): string {
  const widths = s.header.map((h, i) => Math.max(width(h), ...s.rows.map((r) => width(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - width(c)))).join('  ').trimEnd();
  const body = s.rows.length ? s.rows.map(line) : ['(데이터 없음)'];
  return [`■ ${s.title}`, line(s.header), widths.map((w) => '-'.repeat(w)).join('  '), ...body, ...(s.note ? [`  ※ ${s.note}`] : [])].join('\n');
}

export function formatAnalysis(sections: Section[]): string {
  return sections.map(formatSection).join('\n\n');
}

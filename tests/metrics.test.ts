// metrics v4: 저장 형식·상한·시도 도중 복원 감지·수집기·분석 스크립트 (스펙 §5.10-3·5·6, §5.19)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { emptyAttemptStats, type AttemptResult } from '../src/core/day';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import {
  MAX_LIVES,
  MAX_SESSIONS,
  byteLength,
  detectMidAttemptRestore,
  emptyMetrics,
  enforceLimits,
  newLife,
  parseMetrics,
  summarizeMetrics,
  type AttemptMetrics,
  type MetricsData,
} from '../src/metrics/model';
import { MetricsRecorder } from '../src/metrics/recorder';
import { METRICS_KEY } from '../src/platform/storage';
import { gameGeometry } from '../src/scenes/layout';
import { analyze, compareWithBot, formatAnalysis, lifeFailStreak, longestStreak } from '../sim/metricsReport';
import type { PolicyReport } from '../sim/report';

const data = structuredClone(rawGameData) as unknown as GameData;
const SIZE = { cols: 5, rows: 4 };
const NOW = '2026-10-01T00:00:00.000Z';
const GEO = gameGeometry(data.balance.merge.soldierCap + 1);

function attemptMetrics(attempt: number, stage: number, result: AttemptResult, feeds = 0): AttemptMetrics {
  const record = { ...emptyAttemptStats(stage, attempt, 50, data.balance.grid.maxTier), result, realSeconds: 90 };
  return {
    attempt,
    stage,
    result,
    realDate: '2026-10-01',
    record,
    feeds: Array.from({ length: feeds }, (_, i) => ({ t: i, attempt, stage, role: 'offense' as const, hero: 'sapsal', chain: 'companion_animal', tier: 1, points: 1, cell: { col: 0, row: 0 }, heldFor: 0 })),
    dropFails: { invalid: 0, laneFull: 0, wildcard: 0 },
    dragDistance: 0,
    realSeconds: 60,
    dayRealSeconds: 40,
    nightRealSeconds: 20,
    speedUsed: 0,
    rating: null,
  };
}

describe('상한 (500 / 20 / 크기)', () => {
  it('세션 500·판 20을 넘으면 오래된 것부터 버린다', () => {
    const m = emptyMetrics(NOW);
    for (let i = 0; i < MAX_SESSIONS + 3; i++) m.sessions.push({ realDate: '2026-10-01', startedAt: String(i), foregroundSeconds: 0, attemptsCompleted: 0 });
    for (let i = 0; i < MAX_LIVES + 2; i++) m.lives.push(newLife(i, SIZE, NOW));
    const w = enforceLimits(m);
    expect(m.sessions).toHaveLength(MAX_SESSIONS);
    expect(m.sessions[0].startedAt).toBe('3');
    expect(m.lives).toHaveLength(MAX_LIVES);
    expect(m.lives[0].seed).toBe(2);
    expect(w).toHaveLength(2);
  });

  it('직렬화 크기가 상한을 넘으면 가장 오래된 판의 feeds부터 비운다', () => {
    const m = emptyMetrics(NOW);
    const a = newLife(1, SIZE, NOW);
    const b = newLife(2, SIZE, NOW);
    a.attempts.push(attemptMetrics(1, 1, 'success', 50));
    b.attempts.push(attemptMetrics(1, 1, 'success', 50));
    m.lives.push(a, b);
    const limit = byteLength(JSON.stringify(m)) - 100;
    enforceLimits(m, limit);
    expect(a.attempts[0].feeds).toEqual([]);
    expect(b.attempts[0].feeds).toHaveLength(50);
  });

  it('byteLength: UTF-8 (한글 3바이트)', () => {
    expect(byteLength('ab')).toBe(2);
    expect(byteLength('가')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});

describe('parseMetrics', () => {
  it('정상 / 없음 / JSON 파싱 실패 / version 불일치(v3) / 구조 불일치', () => {
    expect(parseMetrics(JSON.stringify(emptyMetrics(NOW))).ok).toBe(true);
    expect(parseMetrics(null)).toEqual({ ok: false, reason: '없음' });
    expect(parseMetrics('{oops').ok).toBe(false);
    expect(parseMetrics(JSON.stringify({ ...emptyMetrics(NOW), version: 3 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/version/) });
    expect(parseMetrics(JSON.stringify({ ...emptyMetrics(NOW), lives: [{ lifeId: 'x', days: [] }] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/lives\[0\]/) });
  });
});

describe('시도 도중 복원 감지', () => {
  it('inProgress가 같은 판이고, 저장된 시도 수 < 진행 중이던 시도이며, 장면 카드면 +1. 어느 경우든 inProgress를 지운다', () => {
    const m = emptyMetrics(NOW);
    const life = newLife(5, SIZE, NOW);
    m.inProgress = { lifeId: life.lifeId, attempt: 3 };
    expect(detectMidAttemptRestore(m, life, 2, 'dayStart')).toBe(true);
    expect(life.midAttemptRestores).toBe(1);
    expect(m.inProgress).toBeNull();
    for (const [lifeId, saved, phase] of [
      [life.lifeId, 3, 'dayStart'],
      ['other', 2, 'dayStart'],
      [life.lifeId, 2, 'diary'],
    ] as const) {
      m.inProgress = { lifeId, attempt: 3 };
      expect(detectMidAttemptRestore(m, life, saved, phase)).toBe(false);
      expect(m.inProgress).toBeNull();
    }
    expect(life.midAttemptRestores).toBe(1);
  });
});

// ── 수집기 (브라우저 저장소는 메모리 대역으로) ──

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe('MetricsRecorder', () => {
  let store: MemoryStorage;
  const g = globalThis as unknown as { window?: unknown };
  beforeEach(() => {
    store = new MemoryStorage();
    g.window = { localStorage: store, location: { search: '' } };
  });
  afterEach(() => {
    delete g.window;
  });

  function fresh(seed = 9): GameState {
    return new GameState(data, SIZE, mulberry32(seed), GEO, seed);
  }
  const stored = (): MetricsData => JSON.parse(store.getItem(METRICS_KEY)!);

  it('시도 끝: AttemptMetrics 확정 (core 기록·그 시도 먹이기·입력 카운터), inProgress 지움', () => {
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    rec.beginAttempt();
    expect(stored().inProgress).toEqual({ lifeId: rec.life.lifeId, attempt: 1 });
    rec.drop('invalid', 30);
    rec.drop('laneFull', 10);
    rec.drop(null, 5);
    rec.frame(0.5, 1);
    rec.frame(0.25, 3);
    s.feed(s.debugGrant('companion_animal', 3)!, 'defense');
    s.debugFail();
    rec.endAttempt(s.lastAttempt!);
    const m = stored();
    expect(m.inProgress).toBeNull();
    const d = m.lives[0].attempts[0];
    expect(d).toMatchObject({
      attempt: 1,
      stage: 1,
      result: 'dayTime',
      dropFails: { invalid: 1, laneFull: 1, wildcard: 0 },
      dragDistance: 45,
      realSeconds: 0.75,
      speedUsed: 0.25,
      rating: null,
    });
    expect(d.feeds).toHaveLength(1);
    expect(d.record).toEqual(JSON.parse(JSON.stringify(s.lastAttempt)));
    expect(m.sessions[0].attemptsCompleted).toBe(1);
  });

  it('시도 도중 종료 → 같은 판 장면 카드로 복원하면 midAttemptRestores += 1', () => {
    const s = fresh();
    const save = serializeGame(s);
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    rec.beginAttempt();
    const restored = GameState.fromSave(data, save, mulberry32(save.seed), GEO, SIZE);
    const rec2 = new MetricsRecorder(restored, SIZE);
    expect(rec2.life.lifeId).toBe(rec.life.lifeId);
    expect(rec2.life.midAttemptRestores).toBe(1);
    expect(stored().inProgress).toBeNull();
  });

  it('평가·챕터 끝 납득·chapterComplete 기록', () => {
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    rec.beginAttempt();
    s.debugToNight();
    s.debugEndNight();
    rec.endAttempt(s.lastAttempt!);
    rec.rate(1, 'day', 'good');
    rec.rate(1, 'retry', 'again');
    expect(rec.rating(1)).toEqual({ day: 'good', retry: 'again' });
    s.debugCompleteChapter();
    rec.chapterEnd();
    rec.setEndingAgree(false);
    const life = stored().lives[0];
    expect(life.chapter).toEqual({ completed: true, attempts: 1, stage: 1 });
    expect(life.endingAgree).toBe(false);
    const rec3 = new MetricsRecorder(fresh(10), SIZE);
    expect(stored().lives).toHaveLength(2);
    expect(rec3.life.seed).toBe(10);
  });

  it('저장값이 깨졌으면 키를 지우고 새로 시작, localStorage 예외도 게임에 영향 없음', () => {
    store.setItem(METRICS_KEY, '{broken');
    const rec = new MetricsRecorder(fresh(), SIZE);
    expect(rec.data.lives).toHaveLength(1);
    expect(stored().version).toBe(4);
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const s = fresh();
    const r2 = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    expect(() => r2.beginAttempt()).not.toThrow();
    expect(s.phase).toBe('day');
  });
});

describe('요약·분석', () => {
  const life = newLife(1, SIZE, NOW);
  life.attempts.push(
    attemptMetrics(1, 1, 'success', 2),
    attemptMetrics(2, 2, 'night'),
    attemptMetrics(3, 2, 'dayFall'),
    { ...attemptMetrics(4, 2, 'success'), speedUsed: 5, realSeconds: 999 },
  );
  const data4: MetricsData = { ...emptyMetrics(NOW), lives: [life], sessions: [{ realDate: '2026-10-01', startedAt: NOW, foregroundSeconds: 10, attemptsCompleted: 4 }] };

  it('배속 사용 시도는 길이 중앙값에서 제외, 결과별 수', () => {
    const s = summarizeMetrics([life], data4.sessions);
    expect(s.attemptLengthMedian).toBe(60);
    expect(s.results).toEqual({ success: 2, night: 1, dayFall: 1 });
  });

  it('연속 실패 최대·연속 날짜', () => {
    expect(lifeFailStreak(life)).toBe(2);
    expect(longestStreak(['2026-10-01', '2026-10-02', '2026-10-04'])).toBe(2);
  });

  it('분석 표: 개요 → 스테이지별 → 길이 → 먹이기 → 주관 → 판별, --bot 비교', () => {
    const sections = analyze(data4);
    expect(sections.map((x) => x.title.split(' ')[0])).toEqual(['개요', '스테이지별', '시도', '먹이기', '주관', '판별']);
    const st = sections[1];
    expect(st.rows.map((r) => r[0])).toEqual(['1-1', '1-2']);
    const bot = {
      policy: 'balanced',
      options: { seeds: 10 },
      completeAttempts: { median: 15 },
      summary: { maxFailStreak: { median: 3 }, attemptLength: { median: 100 } },
      resultShare: { success: 0.5, night: 0.2 },
    } as unknown as PolicyReport;
    const cmp = compareWithBot(data4, bot);
    expect(cmp.rows[0][2]).toBe('15');
    expect(formatAnalysis([...sections, cmp])).toContain('사람 vs 봇');
  });
});

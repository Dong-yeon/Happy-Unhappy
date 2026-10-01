// M7: metrics 저장 형식·상한·복원 감지·수집기·분석 스크립트 (스펙 §5.10-3·5·6, §5.10-8)
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { serializeGame } from '../src/core/save';
import {
  MAX_BYTES,
  MAX_LIVES,
  MAX_SESSIONS,
  byteLength,
  detectMidDayRestore,
  emptyMetrics,
  enforceLimits,
  newLife,
  parseMetrics,
  summarizeMetrics,
  type DayMetrics,
  type MetricsData,
} from '../src/metrics/model';
import { MetricsRecorder } from '../src/metrics/recorder';
import { METRICS_KEY } from '../src/platform/storage';
import { gameGeometry } from '../src/scenes/layout';
import { analyze, compareWithBot, formatAnalysis, layerToNextDown, longestStreak, type Section } from '../sim/metricsReport';
import type { PolicyReport } from '../sim/report';

const data = structuredClone(rawGameData) as unknown as GameData;
const SIZE = { cols: 5, rows: 4 };
const NOW = '2026-10-01T00:00:00.000Z';

function dayMetrics(day: number, summons = 0): DayMetrics {
  return {
    day,
    date: '2026-10-01',
    realDate: '2026-10-01',
    eventId: 'plain',
    dayStats: { ...emptyDay() },
    summons: Array.from({ length: summons }, (_, i) => ({ t: i, day, side: 'happy' as const, chain: 'companion_animal', tier: 1, cell: { col: 0, row: 0 }, heldFor: 0, reserved: false })),
    dropFails: { invalid: 0, laneFull: 0, wildcard: 0 },
    dragDistance: 0,
    realSeconds: 60,
    dayRealSeconds: 40,
    nightRealSeconds: 20,
    reserved: 0,
    speedUsed: 0,
    bypass: false,
    rating: null,
  };
}
function emptyDay() {
  const g = new GameState(data, SIZE, mulberry32(1), gameGeometry(data.balance.lane.laneCap));
  return structuredClone(g.dayStats);
}

describe('상한 (500 / 20 / 1.5MB)', () => {
  it('세션 500·일생 20을 넘으면 오래된 것부터 버린다', () => {
    const m = emptyMetrics(NOW);
    for (let i = 0; i < MAX_SESSIONS + 7; i++) m.sessions.push({ date: 'd', realDate: 'd', startedAt: String(i), foregroundSeconds: 0, daysCompleted: 0 });
    for (let i = 0; i < MAX_LIVES + 3; i++) m.lives.push(newLife(i, SIZE, String(i)));
    const w = enforceLimits(m);
    expect(m.sessions).toHaveLength(MAX_SESSIONS);
    expect(m.sessions[0].startedAt).toBe('7');
    expect(m.lives).toHaveLength(MAX_LIVES);
    expect(m.lives[0].seed).toBe(3);
    expect(w).toHaveLength(2);
  });

  it('직렬화 크기가 상한을 넘으면 가장 오래된 life의 summons부터 비운다', () => {
    expect(MAX_BYTES).toBe(1.5 * 1024 * 1024);
    const m = emptyMetrics(NOW);
    for (let l = 0; l < 3; l++) {
      const life = newLife(l, SIZE, `life${l}`);
      for (let d = 1; d <= 2; d++) life.days.push(dayMetrics(d, 200));
      m.lives.push(life);
    }
    const full = byteLength(JSON.stringify(m));
    // 일생 하나 반 정도를 비워야 들어가는 상한
    const limit = Math.floor(full * 0.55);
    enforceLimits(m, limit);
    expect(byteLength(JSON.stringify(m))).toBeLessThanOrEqual(limit);
    expect(m.lives[0].days.every((d) => d.summons.length === 0)).toBe(true);
    expect(m.lives[2].days.every((d) => d.summons.length === 200)).toBe(true); // 최신 일생은 그대로
    expect(m.lives[0].days).toHaveLength(2); // 날 기록 자체는 남긴다
  });

  it('실제 1.5MB 상한으로도 동작', () => {
    const m = emptyMetrics(NOW);
    for (let l = 0; l < 8; l++) {
      const life = newLife(l, SIZE, `life${l}`);
      for (let d = 1; d <= 14; d++) life.days.push(dayMetrics(d, 160));
      m.lives.push(life);
    }
    expect(byteLength(JSON.stringify(m))).toBeGreaterThan(MAX_BYTES);
    enforceLimits(m);
    expect(byteLength(JSON.stringify(m))).toBeLessThanOrEqual(MAX_BYTES);
    expect(m.lives[m.lives.length - 1].days[13].summons).toHaveLength(160);
  });

  it('byteLength: UTF-8 (한글 3바이트)', () => {
    expect(byteLength('ab')).toBe(2);
    expect(byteLength('가')).toBe(3);
    expect(byteLength('😀')).toBe(4);
  });
});

describe('parseMetrics', () => {
  it('정상 / 없음 / JSON 파싱 실패 / version 불일치 / 구조 불일치', () => {
    const ok = parseMetrics(JSON.stringify(emptyMetrics(NOW)));
    expect(ok.ok).toBe(true);
    expect(parseMetrics(null)).toEqual({ ok: false, reason: '없음' });
    expect(parseMetrics('{oops').ok).toBe(false);
    expect(parseMetrics(JSON.stringify({ ...emptyMetrics(NOW), version: 1 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/version/) });
    expect(parseMetrics(JSON.stringify({ ...emptyMetrics(NOW), lives: [{ lifeId: 'x' }] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/lives\[0\]/) });
  });
});

describe('판 도중 복원 감지', () => {
  it('inProgress가 같은 lifeId·day이고 복원된 저장이 dayStart면 +1, 어느 경우든 inProgress를 지운다', () => {
    const m = emptyMetrics(NOW);
    const life = newLife(5, SIZE, NOW);
    m.inProgress = { lifeId: life.lifeId, day: 3 };
    expect(detectMidDayRestore(m, life, 3, 'dayStart')).toBe(true);
    expect(life.midDayRestores).toBe(1);
    expect(m.inProgress).toBeNull();
    for (const [lifeId, day, phase] of [
      [life.lifeId, 4, 'dayStart'],
      ['other', 3, 'dayStart'],
      [life.lifeId, 3, 'diary'],
    ] as const) {
      m.inProgress = { lifeId, day: 3 };
      expect(detectMidDayRestore(m, life, day, phase)).toBe(false);
      expect(m.inProgress).toBeNull();
    }
    expect(life.midDayRestores).toBe(1);
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
    return new GameState(data, SIZE, mulberry32(seed), gameGeometry(data.balance.lane.laneCap), seed);
  }
  const stored = (): MetricsData => JSON.parse(store.getItem(METRICS_KEY)!);

  it('하루 끝: DayMetrics 확정 (core dayStats·그날 소환·입력 카운터), inProgress 지움, 우회일 표시', () => {
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    s.debugForceEvent('plain');
    s.confirmDay();
    rec.beginDay(true);
    expect(stored().inProgress).toEqual({ lifeId: rec.life.lifeId, day: 1 });
    rec.drop('invalid', 30);
    rec.drop('laneFull', 10);
    rec.drop(null, 5);
    rec.frame(0.5, 1);
    rec.frame(0.25, 3);
    s.summon(s.debugGrant('companion_animal', 3)!, 'happy');
    s.debugEndDay();
    rec.endDay();
    const m = stored();
    expect(m.inProgress).toBeNull();
    const life = m.lives[0];
    expect(life.gatingBypassUsed).toBe(true);
    const d = life.days[0];
    expect(d).toMatchObject({
      day: 1,
      eventId: 'plain',
      bypass: true,
      dropFails: { invalid: 1, laneFull: 1, wildcard: 0 },
      dragDistance: 45,
      realSeconds: 0.75,
      speedUsed: 0.25,
      rating: null,
    });
    expect(d.summons).toHaveLength(1);
    expect(d.dayStats).toEqual(s.lastDayStats);
    expect(m.sessions[0].daysCompleted).toBe(1);
  });

  it('waves가 아닐 때·하루 시작 전에는 입력·실제 시간을 세지 않는다', () => {
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    rec.frame(1, 1);
    rec.drop('invalid', 99);
    s.debugForceEvent('plain');
    s.confirmDay();
    rec.beginDay(false);
    s.debugEndDay();
    rec.endDay();
    expect(stored().lives[0].days[0]).toMatchObject({ realSeconds: 0, dragDistance: 0, dropFails: { invalid: 0 }, bypass: false });
    expect(stored().lives[0].gatingBypassUsed).toBe(false);
    expect(stored().sessions[0].foregroundSeconds).toBe(1);
  });

  it('판 도중 종료 → 같은 일생·같은 날 dayStart로 복원하면 midDayRestores += 1 (중단된 날 카운터는 버림)', () => {
    const s = fresh();
    const save = serializeGame(s); // dayStart 1일차
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    rec.beginDay(false);
    rec.drop('invalid', 10);
    // 새로고침: 저장(그날 dayStart)에서 복원 → 새 수집기
    const restored = GameState.fromSave(data, save, mulberry32(save.seed), gameGeometry(data.balance.lane.laneCap), SIZE);
    const rec2 = new MetricsRecorder(restored, SIZE);
    expect(rec2.life.lifeId).toBe(rec.life.lifeId);
    expect(rec2.life.midDayRestores).toBe(1);
    expect(stored().inProgress).toBeNull();
    restored.confirmDay();
    rec2.beginDay(false);
    restored.debugEndDay();
    rec2.endDay();
    expect(stored().lives[0].days[0].dropFails.invalid).toBe(0);
  });

  it('평가·챕터 끝 납득·chapterComplete 기록, 저장(게임) 초기화와 무관하게 유지', () => {
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    rec.beginDay(false);
    s.debugEndDay();
    rec.endDay();
    rec.rate(1, 'day', 'good');
    rec.rate(1, 'backflow', 'tense');
    expect(rec.rating(1)).toEqual({ day: 'good', backflow: 'tense' });
    s.debugCompleteChapter(true);
    rec.chapterEnd();
    rec.setEndingAgree(false);
    const life = stored().lives[0];
    expect(life.chapter).toEqual({ completed: true, day: s.day, stage: s.stage });
    expect(life.stats).toEqual(s.stats);
    expect(life.endedAt).not.toBeNull();
    expect(life.endingAgree).toBe(false);
    // 새 일생(다른 시드) → 새 LifeMetrics, 이전 일생 유지
    const rec3 = new MetricsRecorder(fresh(10), SIZE);
    expect(stored().lives).toHaveLength(2);
    expect(rec3.life.seed).toBe(10);
  });

  it('저장값이 깨졌으면 키를 지우고 새로 시작 (게임은 계속)', () => {
    store.setItem(METRICS_KEY, '{broken');
    const rec = new MetricsRecorder(fresh(), SIZE);
    expect(rec.data.lives).toHaveLength(1);
    expect(stored().version).toBe(2);
  });

  it('localStorage 예외가 나도 게임 진행에 영향 없음', () => {
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const s = fresh();
    const rec = new MetricsRecorder(s, SIZE);
    s.confirmDay();
    expect(() => rec.beginDay(false)).not.toThrow();
    expect(s.phase).toBe('day');
  });
});

describe('요약', () => {
  it('배속 사용일은 하루 길이 중앙값에서 제외', () => {
    const life = newLife(1, SIZE, NOW);
    life.days.push({ ...dayMetrics(1), realSeconds: 100 }, { ...dayMetrics(2), realSeconds: 300, speedUsed: 5 }, { ...dayMetrics(3), realSeconds: 120 });
    expect(summarizeMetrics([life], []).dayLengthMedian).toBe(110);
  });
});

// ── 분석 스크립트: 고정 fixture → 기대 표 ──

describe('분석 스크립트 (fixture)', () => {
  const fx = parseMetrics(readFileSync('tests/fixtures/metrics_fixture.json', 'utf8'));
  if (!fx.ok) throw new Error(fx.reason);
  const sections = analyze(fx.data);
  const sec = (prefix: string): Section => sections.find((s) => s.title.startsWith(prefix))!;
  const row = (s: Section, first: string) => s.rows.find((r) => r[0] === first);

  it('표 순서: 개요 → H1~H6 → 주관 → 결과', () => {
    expect(sections.map((s) => s.title.split(' ')[0])).toEqual(['개요', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', '주관', '결과']);
  });

  it('H1: 일생·일차·칸 열별 Unhappy 비율', () => {
    const s = sec('H1');
    expect(row(s, '일생 111@2026-10-01 (5x4)')).toEqual(['일생 111@2026-10-01 (5x4)', '5', '2', '40%']);
    expect(row(s, '1일차')).toEqual(['1일차', '4', '3', '75%']);
    expect(row(s, '2일차')).toEqual(['2일차', '2', '0', '0%']);
    expect(row(s, '칸 열 0')).toEqual(['칸 열 0', '2', '1', '50%']);
    expect(row(s, '칸 열 4')).toEqual(['칸 열 4', '2', '2', '100%']);
  });

  it('H2: 위·아래 따로 단계 분포', () => {
    const s = sec('H2');
    expect(s.header).toEqual(['쪽', '소환', '1단계', '2단계', '3단계']);
    expect(s.rows).toEqual([
      ['위 (창문)', '3', '33.3%', '33.3%', '33.3%'],
      ['아래 (손거울)', '3', '33.3%', '33.3%', '33.3%'],
    ]);
  });

  it('H3: 층 돌파 → 같은 날 다음 Unhappy 소환 (5초, 없음 1)', () => {
    expect(sec('H3').rows).toEqual([['2', '1', '5', '5', '1']]);
    expect(layerToNextDown(fx.data.lives[0].days)).toEqual({ gaps: [5], noNext: 1 });
  });

  it('H4: 하루 길이(배속·우회 제외), 연속 접속, 하루에 연 날 수', () => {
    const s = sec('H4');
    expect(s.rows[0]).toEqual(['하루 길이 중앙값 (실제 초, 배속·우회 제외)', '160', 'n=2 (제외 1)']);
    expect(row(s, '연속 접속 일수 (최장)')?.[1]).toBe('2');
    expect(row(s, '하루에 연 날 수 (중앙값 / 최대)')?.[1]).toBe('1 / 2');
    expect(row(s, '  2026-10-02')?.[1]).toBe('세션 1 · 끝낸 날 2');
    expect(longestStreak(['2026-02-28', '2026-03-01', '2026-03-02', '2026-03-05'])).toBe(3);
  });

  it('H5: 끝난 일생은 stats, 영웅 첫 소환 일차', () => {
    expect(sec('H5').rows).toEqual([
      ['일생 111@2026-10-01', 'comfort_object', '0', '2'],
      ['일생 111@2026-10-01', 'companion_animal', '1', '1'],
    ]);
  });

  it('H6: 그리드 프리셋별', () => {
    expect(sec('H6').rows).toEqual([
      ['4x4', '1', '50%', '2 (W:0 1:2 2:0 3:0)', '1', '1/0/0', '50'],
      ['5x4', '2', '20%', '1 (W:0 1:1 2:0 3:0)', '0', '2/1/1', '200'],
    ]);
  });

  it('주관·결과', () => {
    expect(sec('주관').rows.map((r) => r[1])).toEqual(['1/1/0 (1)', '1/0 (1)', '1/0 (0)']);
    expect(sec('결과').rows).toEqual([
      ['111@2026-10-01', '5x4', '2', '완성 (2일)', '1-10', '2', '2일 unhappy'],
      ['222@2026-10-02', '4x4', '1', '(진행 중)', '—', '3', '—'],
    ]);
  });

  it('--bot: 봇 리포트와 나란히 (봇에 없는 지표는 —)', () => {
    const bot = {
      policy: 'balanced',
      options: { seeds: 2, days: 14 },
      summary: {
        downRatio: { median: 0.5 },
        dayLength: { median: 110 },
        gridFullRatio: { mean: 0 },
        releases: { median: 0 },
        lostReturns: { median: 0 },
        layersCleared: { median: 23 },
        backflows: { median: 1 },
        sunk: { median: 47 },
      },
      tierShare: { '1': 0.25, '2': 0.25, '3': 0.5 },
      chapter: { completedRate: 0.4 },
    } as unknown as PolicyReport;
    const s = compareWithBot(fx.data, bot);
    expect(s.header).toEqual(['지표', '사람', '봇']);
    expect(s.rows.find((r) => r[0] === 'H1 Unhappy 비율')).toEqual(['H1 Unhappy 비율', '50%', '50%']);
    expect(s.rows.find((r) => r[0] === '챕터 완성률')).toEqual(['챕터 완성률', '100%', '40%']);
    expect(s.rows.find((r) => r[0] === 'H6 그리드 가득 참 비율')?.[1]).toBe('28.6%');
  });

  it('formatAnalysis가 모든 표를 출력', () => {
    const out = formatAnalysis(sections);
    for (const t of ['■ 개요', '■ H1', '■ H6 그리드 (프리셋별)', '■ 결과']) expect(out).toContain(t);
  });
});

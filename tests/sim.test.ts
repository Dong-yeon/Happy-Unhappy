// 시뮬레이터 하네스 (스펙 §8.1): 재현성, 정책 기본 동작, 통계, M5 실제 하루 구조
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { bossDiagnostics, buildReport, checkM3Goals, checkM5Goals, checkM88Goals, chapterStats, quantile, summarize } from '../sim/report';
import { runOne, type RunOptions, type RunResult } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
const DAYS = data.balance.chapter.maxDays;
const opt = (seed: number): RunOptions => ({ seed, grid: { cols: 5, rows: 4 } });
const options = { seeds: 1, grid: '5x4', mode: 'life' as const, days: DAYS, wavesPerDay: data.balance.wave.wavesPerDay };

/** 정책별 한 판은 비싸지 않지만 여러 번 쓰므로 캐시 */
const cache = new Map<string, RunResult>();
function run(policy: string, seed: number): RunResult {
  const k = `${policy}:${seed}`;
  if (!cache.has(k)) cache.set(k, runOne(data, cfg, POLICIES[policy], opt(seed)));
  return cache.get(k)!;
}

describe('재현성', () => {
  it.each(Object.keys(POLICIES))('%s: 같은 시드·같은 정책 → 같은 결과', (name) => {
    expect(runOne(data, cfg, POLICIES[name], opt(7))).toEqual(runOne(data, cfg, POLICIES[name], opt(7)));
  });

  it('시드가 다르면 결과가 달라질 수 있다 (random)', () => {
    expect(run('random', 1)).not.toEqual(run('random', 2));
  });
});

describe('실제 하루 구조 (--until life)', () => {
  it('한 판 = 1챕터: 완성하면 그날 끝, 못 하면 maxDays일 (일차별 기록 길이 = 끝난 날 수)', () => {
    const done = run('balanced', 1);
    expect(done.completed).toBe(true);
    expect(done.stage).toBe(data.balance.chapter.length);
    expect(done.days).toBe(done.endDay);
    expect(done.days).toBeLessThan(DAYS + 1);
    const idle = run('idle', 1);
    expect(idle.completed).toBe(false);
    expect(idle.days).toBe(DAYS);
    for (const r of [done, idle]) {
      for (const k of ['sunkByDay', 'joyByDay', 'shadowByDay', 'dayLengths', 'dayStartJoy', 'dayEndJoy'] as const) {
        expect(r[k]).toHaveLength(r.days);
      }
      expect(Math.min(...r.dayLengths)).toBeGreaterThan(20);
    }
  });

  it('1-5를 정화한 다음 날 갈림길에서 정책이 고른다 (balanced = 달이 맡음), 1-5에 못 가면 갈림길 없음', () => {
    const b = run('balanced', 1);
    expect(b.turningPointClearedDay).not.toBeNull();
    expect(b.flags).toEqual(['face']);
    expect(run('alwaysHappy', 1).flags).toEqual([]);
    expect(run('idle', 1).flags).toEqual([]);
    // 자라기 = 1-5 다음 날 + 챕터 완성
    expect(b.growths.map((g) => g.day)).toEqual([b.turningPointClearedDay! + 1, b.endDay]);
  });

  it('보스 진단 기록이 역류 수와 같고, 결과(win)가 채워진다', () => {
    const r = run('idle', 1);
    expect(r.backflows).toBeGreaterThan(0);
    expect(r.bossLog).toHaveLength(r.backflows);
    expect(r.bossLog.every((b) => b.win !== null)).toBe(true);
    expect(r.bossWins + r.bossLosses).toBe(r.backflows);
  });
});

describe('정책 기본 동작', () => {
  it('idle: 행동 없음, 1일차에 가라앉음, 걱정 전부 가라앉음', () => {
    const r = run('idle', 1);
    expect(r.firstSinkDay).toBe(1);
    expect(r.summons + r.spawns + r.merges + r.releases + r.mistakes).toBe(0);
    expect(r.kills).toBe(0);
    expect(r.day1Sunk).toBe(r.day1Worries);
  });

  it('balanced는 idle보다 덜 가라앉고 위·아래 모두 보낸다', () => {
    // 시드에 따라 역류가 계속 예약돼 손거울을 한 번도 안 쓰는 판도 있다 (M5 리포트 참고) → 손거울을 쓰는 시드로
    const idle = run('idle', 1);
    const bal = run('balanced', 1);
    expect(bal.sunk).toBeLessThan(idle.sunk);
    expect(bal.upRatio).toBeGreaterThan(0);
    expect(bal.downRatio).toBeGreaterThan(0);
    expect(bal.upRatio! + bal.downRatio!).toBeCloseTo(1, 10);
  });

  it('hoarder는 최고 단계 조각(영웅)과 행복한 추억 전설만 보낸다', () => {
    for (let s = 1; s <= 4; s++) {
      for (const t of Object.keys(run('hoarder', s).summonTiers)) expect(Number(t)).toBeGreaterThanOrEqual(data.balance.grid.maxTier);
    }
  });

  it('alwaysUnhappy는 손거울로만 (낮 = 맡기기), alwaysHappy는 창문으로만·밤에는 잠들기 (§5.11-8)', () => {
    const u = run('alwaysUnhappy', 1);
    expect(u.downRatio).toBe(1);
    expect(u.reserved).toBeGreaterThan(0);
    const h = run('alwaysHappy', 1);
    expect(h.downRatio).toBe(0);
    expect(h.reserved).toBe(0);
    expect(h.layersCleared).toBe(0);
    expect(h.sleeps).toBe(h.days); // 매일 밤 잠들기
  });

  it('mistakeRate 0이면 실수 없음, 1이면 드래그 행동이 모두 원위치', () => {
    const none = runOne(data, { ...cfg, mistakeRate: 0 }, POLICIES.balanced, opt(1));
    expect(none.mistakes).toBe(0);
    const all = runOne(data, { ...cfg, mistakeRate: 1 }, POLICIES.balanced, opt(1));
    expect(all.summons + all.merges + all.releases).toBe(0);
    expect(all.spawns).toBeGreaterThan(0); // 버튼 탭(생성)은 실수 대상 아님
  });

  it('balanced: 역류가 예약되면 창문 보강을 먼저 한다 (평소라면 손거울로 갈 조각도)', () => {
    const g = new GameState(data, { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(data.balance.lane.laneCap));
    g.debugForceEvent('plain');
    g.confirmDay();
    g.wave.paused = true;
    for (let k = 0; k < cfg.balanced.minUnits; k++) g.summon(g.debugGrant('companion_animal', 1)!, 'happy');
    const cell = g.debugGrant('comfort_object', 2)!;
    const ctx = { state: g, rng: mulberry32(9), cfg };
    expect(POLICIES.balanced.decide(ctx)).toEqual({ type: 'summon', cell, side: 'unhappy' });
    g.debugScheduleBackflow();
    expect(POLICIES.balanced.decide(ctx)).toEqual({ type: 'summon', cell, side: 'happy' });
  });
});

describe('통계·리포트', () => {
  it('선형 보간 백분위', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(quantile(xs, 0.5)).toBe(6);
    expect(quantile(xs, 0.1)).toBe(2);
    expect(quantile(xs, 0.9)).toBe(10);
    expect(quantile([5], 0.9)).toBe(5);
  });

  it('summarize는 null을 제외한다', () => {
    expect(summarize([null, 2, 4, null])).toMatchObject({ mean: 3, median: 3, n: 2 });
  });

  it('리포트: 곡선 길이 = 일차 수, 소환 단계 비율 합 = 1, 하루 길이 곡선', () => {
    const runs = [1, 2].map((s) => run('balanced', s));
    const rep = buildReport('balanced', runs, { ...options, seeds: 2 }, cfg);
    expect(rep.curves).toHaveLength(Math.max(...runs.map((r) => r.days)));
    expect(rep.curves.every((c) => c.lengthMedian > 0)).toBe(true);
    const share = Object.values(rep.tierShare).reduce((s, v) => s + v, 0);
    expect(share).toBeCloseTo(1, 10);
  });

  it('보스 진단: 슬롯|준비 여부별, 방어 유닛 수별 처치율', () => {
    const fake = {
      bossLog: [
        { slot: 'morning', prep: true, defenseUnits: 0, win: false },
        { slot: 'morning', prep: true, defenseUnits: 2, win: true },
        { slot: 'noon', prep: false, defenseUnits: 2, win: true },
        { slot: 'evening', prep: false, defenseUnits: 0, win: null },
      ],
    } as unknown as RunResult;
    const d = bossDiagnostics([fake]);
    expect(d.total).toBe(4);
    expect(d.bySlot['morning|prep']).toEqual({ n: 2, wins: 1, winRate: 0.5 });
    expect(d.bySlot['noon|-']).toEqual({ n: 1, wins: 1, winRate: 1 });
    expect(d.bySlot['evening|-']).toEqual({ n: 1, wins: 0, winRate: null }); // 결과 전
    expect(d.byDefense['2']).toEqual({ n: 2, wins: 2, winRate: 1 });
    expect(d.byDefense['0']).toEqual({ n: 2, wins: 0, winRate: 0 });
  });

  it('M3·M5 목표 판정이 돌아간다 (idle 1일차 가라앉음 OK, 하루 길이는 보고만)', () => {
    const idle = buildReport('idle', [run('idle', 1)], options, cfg);
    const bal = buildReport('balanced', [run('balanced', 1)], options, cfg);
    const m3 = checkM3Goals([idle, bal], cfg.m3Goals);
    expect(m3.find((c) => c.label.startsWith('idle'))?.pass).toBe(true);
    const m5 = checkM5Goals([bal], cfg.m5Goals);
    expect(m5.find((c) => c.label.startsWith('하루 길이'))?.pass).toBeNull();
    expect(m5.find((c) => c.id === 'B 역류')).toBeDefined();
  });
});

describe('M8.8: 챕터 진행 리포트 (§5.15-6)', () => {
  it('완성률·완성 일차·1-5 도달 일차', () => {
    const runs = [run('balanced', 1), run('alwaysHappy', 1), run('idle', 1)];
    const c = chapterStats(runs);
    expect(c.n).toBe(3);
    expect(c.completedRate).toBeCloseTo(1 / 3);
    expect(c.unfinishedRate).toBeCloseTo(2 / 3);
    expect(c.completeDay.n).toBe(1);
    expect(c.completeDay.median).toBe(runs[0].endDay);
    expect(c.turningPointReachedDay.n).toBe(runs.filter((r) => r.turningPointReachedDay !== null).length);
    // 1-5 도달 ≤ 1-5 정화
    expect(runs[0].turningPointReachedDay!).toBeLessThanOrEqual(runs[0].turningPointClearedDay!);
  });

  it('alwaysHappy는 층을 넘지 않아 미완성, 정화된 추억 0', () => {
    const r = run('alwaysHappy', 1);
    expect(r.bossWins).toBeGreaterThan(0);
    expect(r.layersCleared).toBe(0);
    expect(r.completed).toBe(false);
    expect(r.growths).toHaveLength(1); // maxDays 미완성 자라기 1회
    expect(r.growths[0].purified).toBe(0);
  });

  it('checkM88Goals: 판정 출력 (roundTrip 없으면 미판정, 있으면 일치 여부), hoarder는 완성률 비교', () => {
    const reports = ['balanced', 'alwaysHappy', 'alwaysUnhappy', 'random', 'idle', 'hoarder'].map((p) => buildReport(p, [run(p, 1)], options, cfg));
    const none = checkM88Goals(reports, cfg.m88Goals, null);
    expect(none.find((c) => c.label.startsWith('--saveRoundTrip'))?.pass).toBeNull();
    for (const id of ['B 완성률', 'B 완성일', 'B 중반', 'B 초반', 'B 역류', 'alwaysHappy 0%', 'alwaysUnhappy 0%', 'random 0%', 'idle 0%', 'hoarder<B']) {
      expect(none.find((c) => c.id === id), id).toBeDefined();
    }
    expect(none.find((c) => c.id === 'idle 0%')?.pass).toBe(true);
    expect(none.find((c) => c.id === 'hoarder<B')?.label).toContain('완성률');
    const ok = checkM88Goals(reports, cfg.m88Goals, [{ policy: 'balanced', matched: 1, total: 1, mismatchSeeds: [] }]);
    expect(ok.find((c) => c.id === 'roundTrip')?.pass).toBe(true);
    const ng = checkM88Goals(reports, cfg.m88Goals, [{ policy: 'balanced', matched: 0, total: 1, mismatchSeeds: [1] }]);
    expect(ng.find((c) => c.id === 'roundTrip')?.pass).toBe(false);
  });
});

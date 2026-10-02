// 시뮬레이터 하네스 (스펙 §8.1, §5.17-7, [11]-4): 재현성, 정책 기본 동작, 통계, 진행 목표
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';
import { applyOverrides, parseSet } from '../sim/overrides';
import { POLICIES } from '../sim/policies';
import { feedRole } from '../sim/policies/helpers';
import { bossDiagnostics, buildReport, checkM3Goals, checkM5Goals, checkM89Goals, chapterStats, quantile, summarize } from '../sim/report';
import { runOne, type RunOptions, type RunResult } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
const DAYS = data.balance.chapter.maxDays;
const opt = (seed: number): RunOptions => ({ seed, grid: { cols: 5, rows: 4 } });
const options = { seeds: 1, grid: '5x4', mode: 'life' as const, days: DAYS, wavesPerNight: data.balance.wave.wavesPerNight, feedRatio: cfg.feedRatio };

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

describe('실제 하루 구조', () => {
  it('한 판 = 1챕터: 완성하면 그날 끝, 못 하면 maxDays일 (일차별 기록 길이 = 끝난 날 수)', () => {
    const done = run('balanced', 1);
    expect(done.completed).toBe(true);
    expect(done.stage).toBe(data.balance.chapter.length);
    expect(done.days).toBe(done.endDay);
    // 층 HP를 아주 높이면 못 깬다 → maxDays일 미완성
    const hard = runOne(applyOverrides(data, [parseSet('abyss.layerHpBase=1000000')]), cfg, POLICIES.idle, opt(1));
    expect(hard.completed).toBe(false);
    expect(hard.days).toBe(DAYS);
    for (const r of [done, hard]) {
      for (const k of ['sunkByDay', 'joyByDay', 'shadowByDay', 'dayLengths', 'dayStartJoy', 'dayEndJoy'] as const) {
        expect(r[k]).toHaveLength(r.days);
      }
      expect(Math.min(...r.dayLengths)).toBeGreaterThan(20);
    }
  });

  it('하루 길이 = 오펜스(낮) + 디펜스(밤), 오펜스는 offense.seconds 이하', () => {
    const r = run('balanced', 1);
    for (let i = 0; i < r.days; i++) {
      expect(r.dayLengthsOffense[i]).toBeLessThanOrEqual(data.balance.offense.seconds + 1e-6);
      expect(r.dayLengths[i]).toBeCloseTo(r.dayLengthsOffense[i] + r.dayLengthsDefense[i], 6);
    }
  });

  it('1-5를 정화한 다음 날 갈림길에서 정책이 고른다 (balanced = 달이 맡음), 1-5에 못 가면 갈림길 없음', () => {
    const b = run('balanced', 1);
    expect(b.turningPointClearedDay).not.toBeNull();
    expect(b.flags).toEqual(['face']);
    const i = run('idle', 1);
    expect(i.flags).toEqual(i.turningPointClearedDay !== null && i.endDay > i.turningPointClearedDay ? ['avoid'] : []); // 기본 = 첫 선택지
  });

  it('보스 진단 기록이 역류 수와 같고, 결과(win)가 채워진다', () => {
    const r = run('idle', 1);
    expect(r.backflows).toBeGreaterThan(0);
    expect(r.bossLog).toHaveLength(r.backflows);
    expect(r.bossLog.every((b) => b.win !== null)).toBe(true);
    expect(r.bossWins + r.bossLosses).toBe(r.backflows);
  });
});

describe('정책 기본 동작 (§5.17-7)', () => {
  it('idle: 행동 없음 → 영웅만 싸운다', () => {
    const r = run('idle', 1);
    expect(r.feeds + r.spawns + r.merges + r.releases + r.mistakes).toBe(0);
    expect(r.soldiers).toBe(0);
  });

  it('balanced: 머지·먹이기, 전투 중 머지로 병사·버프, 양쪽 영웅 모두 점수', () => {
    const b = run('balanced', 1);
    expect(b.merges).toBeGreaterThan(0);
    expect(b.battleMerges).toBe(b.merges); // 전투 밖 행동 없음
    expect(b.soldiers).toBeGreaterThan(0);
    const sum = (p: Record<string, number>) => Object.values(p).reduce((a, x) => a + x, 0);
    expect(sum(b.heroPoints.offense)).toBeGreaterThan(0);
    expect(sum(b.heroPoints.defense)).toBeGreaterThan(0);
  });

  it('dayOnly·nightOnly: 한쪽 덱에만 먹인다', () => {
    const sum = (p: Record<string, number>) => Object.values(p).reduce((a, x) => a + x, 0);
    const d = run('dayOnly', 1);
    const n = run('nightOnly', 1);
    expect(sum(d.heroPoints.defense)).toBe(0);
    expect(sum(d.heroPoints.offense)).toBeGreaterThan(0);
    expect(sum(n.heroPoints.offense)).toBe(0);
    expect(sum(n.heroPoints.defense)).toBeGreaterThan(0);
  });

  it('lazy: 전투 중에는 머지하지 않는다 (병사·버프 없음), 전투 밖에서 몰아서 머지', () => {
    const l = run('lazy', 1);
    expect(l.merges).toBeGreaterThan(0);
    expect(l.battleMerges).toBe(0);
    expect(l.soldiers).toBe(0);
  });

  it('hoarder·noFeed: 먹이지 않는다 (점수 0), 머지는 한다', () => {
    for (const p of ['hoarder', 'noFeed']) {
      const r = run(p, 1);
      expect(r.feeds).toBe(0);
      expect(r.merges).toBeGreaterThan(0);
    }
  });

  it('feedRole: 배분 r에 맞춰 덱을 고른다 (r = 1 낮만 / 0 밤만 / 0.5 번갈아)', () => {
    const g = new GameState(data, { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(data.balance.merge.soldierCap + 1));
    expect(feedRole(g, 1)).toBe('offense');
    expect(feedRole(g, 0)).toBe('defense');
    expect(feedRole(g, 0.5)).toBe('offense');
    g.heroes.offense.points.companion_animal = 7;
    expect(feedRole(g, 0.5)).toBe('defense');
    g.heroes.defense.points.companion_animal = 7;
    expect(feedRole(g, 0.5)).toBe('defense'); // 7/14 = 0.5 → r보다 낮지 않음
    expect(feedRole(g, 0.75)).toBe('offense');
  });

  it('mistakeRate 0이면 실수 없음, 1이면 드래그 행동이 모두 원위치', () => {
    const none = runOne(data, { ...cfg, mistakeRate: 0 }, POLICIES.balanced, opt(1));
    expect(none.mistakes).toBe(0);
    const all = runOne(data, { ...cfg, mistakeRate: 1 }, POLICIES.balanced, opt(1));
    expect(all.feeds + all.merges + all.releases).toBe(0);
    expect(all.spawns).toBeGreaterThan(0); // 버튼 탭(생성)은 실수 대상 아님
  });

  it('--set merge.soldiers=false: 병사 없음 (버프는 그대로) / start.swapHeroes=true: 배정이 바뀐다', () => {
    const off = runOne(applyOverrides(data, [parseSet('merge.soldiers=false')]), cfg, POLICIES.balanced, opt(1));
    expect(off.soldiers).toBe(0);
    expect(off.soldiersCapped).toBe(0);
    expect(off.battleMerges).toBeGreaterThan(0);
    const sw = runOne(applyOverrides(data, [parseSet('start.swapHeroes=true')]), cfg, POLICIES.balanced, opt(1));
    expect(sw.heroIds).toEqual({ offense: data.heroes.defense, defense: data.heroes.offense });
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

  it('리포트: 곡선 길이 = 일차 수, 먹인 단계 비율 합 = 1, 병사 체인:단 합 = 병사 수, 피해 비중 0~1', () => {
    const runs = [1, 2].map((s) => run('balanced', s));
    const rep = buildReport('balanced', runs, { ...options, seeds: 2 }, cfg);
    expect(rep.curves).toHaveLength(Math.max(...runs.map((r) => r.days)));
    expect(rep.curves.every((c) => c.lengthMedian > 0)).toBe(true);
    const share = Object.values(rep.feedTierShare).reduce((s, v) => s + v, 0);
    expect(share).toBeCloseTo(1, 10);
    expect(Object.values(rep.soldiersByKind).reduce((s, v) => s + v, 0)).toBe(runs.reduce((s, r) => s + r.soldiers, 0));
    const ss = rep.summary.soldierShare;
    expect(ss.p10).toBeGreaterThanOrEqual(0);
    expect(ss.p90).toBeLessThanOrEqual(1);
  });

  it('보스 진단: 웨이브|준비 여부별, 디펜스 우리 편 수별 처치율', () => {
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

  it('M3·M5 목표 판정이 돌아간다 (하루 길이는 보고만)', () => {
    const idle = buildReport('idle', [run('idle', 1)], options, cfg);
    const bal = buildReport('balanced', [run('balanced', 1)], options, cfg);
    const m3 = checkM3Goals([idle, bal], cfg.m3Goals);
    expect(typeof m3.find((c) => c.label.startsWith('idle'))?.pass).toBe('boolean');
    const m5 = checkM5Goals([bal], cfg.m5Goals);
    expect(m5.find((c) => c.label.startsWith('하루 길이'))?.pass).toBeNull();
    expect(m5.find((c) => c.id === 'B 역류')).toBeDefined();
  });
});

describe('M8.9: 챕터 진행 리포트·진행 목표 (§5.17-7, [11]-4)', () => {
  it('완성률·완성 일차·1-5 도달 일차', () => {
    const hard = runOne(applyOverrides(data, [parseSet('abyss.layerHpBase=1000000')]), cfg, POLICIES.idle, opt(1));
    const runs = [run('balanced', 1), hard];
    const c = chapterStats(runs);
    expect(c.n).toBe(2);
    expect(c.completedRate).toBeCloseTo(1 / 2);
    expect(c.unfinishedRate).toBeCloseTo(1 / 2);
    expect(c.completeDay.median).toBe(runs[0].endDay);
    expect(runs[0].turningPointReachedDay!).toBeLessThanOrEqual(runs[0].turningPointClearedDay!);
  });

  it('checkM89Goals: 항목이 모두 나오고, roundTrip 없으면 미판정 / 있으면 일치 여부', () => {
    const reports = ['balanced', 'lazy', 'dayOnly', 'nightOnly', 'noFeed', 'random', 'idle', 'hoarder'].map((p) => buildReport(p, [run(p, 1)], options, cfg));
    const none = checkM89Goals(reports, cfg.m89Goals, null);
    expect(none.find((c) => c.label.startsWith('--saveRoundTrip'))?.pass).toBeNull();
    for (const id of ['B 완성률', 'B 완성일', 'B 중반', 'B 초반', 'B 병사', 'dayOnly<30', 'nightOnly<30', 'lazy 격차', 'noFeed<30', 'idle 0%', 'random 낮음', 'hoarder<B']) {
      expect(none.find((c) => c.id === id), id).toBeDefined();
    }
    expect(typeof none.find((c) => c.id === 'idle 0%')?.pass).toBe('boolean');
    const ok = checkM89Goals(reports, cfg.m89Goals, [{ policy: 'balanced', matched: 1, total: 1, mismatchSeeds: [] }]);
    expect(ok.find((c) => c.id === 'roundTrip')?.pass).toBe(true);
    const ng = checkM89Goals(reports, cfg.m89Goals, [{ policy: 'balanced', matched: 0, total: 1, mismatchSeeds: [1] }]);
    expect(ng.find((c) => c.id === 'roundTrip')?.pass).toBe(false);
  });
});

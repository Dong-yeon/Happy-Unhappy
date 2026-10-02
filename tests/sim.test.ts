// 시뮬레이터 하네스 (스펙 §8.1, §5.19-6, [11]-4): 재현성, 시도 상한, 정책 기본 동작, 통계, 진행 목표
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import type { AttemptStats } from '../src/core/day';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';
import { applyOverrides, parseSet } from '../sim/overrides';
import { POLICIES } from '../sim/policies';
import { feedRole } from '../sim/policies/helpers';
import { buildReport, checkM810Goals, formatReport, quantile, summarize } from '../sim/report';
import { maxFailStreak, runOne, type RunOptions, type RunResult } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
/** 테스트는 시도 상한을 줄여 빨리 */
const MAX = 12;
const opt = (seed: number, maxAttempts = MAX): RunOptions => ({ seed, grid: { cols: 5, rows: 4 }, maxAttempts });
const options = { seeds: 1, grid: '5x4', maxAttempts: MAX, feedRatio: cfg.feedRatio };

/** 정책별 한 판은 비싸지 않지만 여러 번 쓰므로 캐시 */
const cache = new Map<string, RunResult>();
function run(policy: string, seed: number): RunResult {
  const k = `${policy}:${seed}`;
  if (!cache.has(k)) cache.set(k, runOne(data, cfg, POLICIES[policy], opt(seed)));
  return cache.get(k)!;
}

describe('재현성', () => {
  it.each(Object.keys(POLICIES))('%s: 같은 시드·같은 정책 → 같은 결과', (name) => {
    expect(runOne(data, cfg, POLICIES[name], opt(7, 6))).toEqual(runOne(data, cfg, POLICIES[name], opt(7, 6)));
  });

  it('시드가 다르면 결과가 달라질 수 있다 (random)', () => {
    expect(run('random', 1)).not.toEqual(run('random', 2));
  });
});

describe('한 판 = 1챕터, 시도 상한 (§5.19-6)', () => {
  it('시도 상한에 닿으면 멈춘다 (미완성), 스테이지별 시도 수 합 = 총 시도', () => {
    const r = run('idle', 1);
    expect(r.completed).toBe(false);
    expect(r.attempts).toBe(MAX);
    expect(r.attemptsByStage.reduce((a, b) => a + b, 0)).toBe(MAX);
    const res = Object.values(r.results).reduce((a, b) => a + b, 0);
    expect(res).toBe(MAX);
  });

  it('balanced는 진행한다: 첫 시도 성공 기록·핵 남은 HP·운반 시간', () => {
    const r = run('balanced', 1);
    expect(r.stage).toBeGreaterThan(1);
    expect(r.firstTry[0]).not.toBeNull();
    expect(r.coreHpLeft.length).toBeGreaterThan(0);
    for (const hp of r.coreHpLeft) expect(hp).toBeGreaterThan(0);
    expect(r.carryTimes.length).toBeGreaterThan(0);
  });

  it('maxFailStreak: 같은 스테이지 연속 실패 최대 (성공하면 끊김, 끝까지 못 넘은 것도 센다)', () => {
    const a = (stage: number, result: AttemptStats['result']) => ({ stage, result }) as AttemptStats;
    expect(maxFailStreak([a(1, 'success'), a(2, 'night'), a(2, 'dayFall'), a(2, 'success'), a(3, 'night')])).toBe(2);
    expect(maxFailStreak([a(1, 'night'), a(1, 'night'), a(1, 'night')])).toBe(3);
    expect(maxFailStreak([])).toBe(0);
  });

  it('갈림길(1-5 성공 다음)에서 정책이 고른다 (balanced = 달이 맡음)', () => {
    const r = runOne(data, cfg, POLICIES.balanced, opt(1, 50));
    if (r.stage >= 6) expect(r.flags).toEqual(['face']);
    else expect(r.flags).toEqual([]);
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
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });

  it('summarize는 null을 제외한다', () => {
    expect(summarize([1, null, 3])).toMatchObject({ mean: 2, median: 2, n: 2 });
  });

  it('리포트: 스테이지 표·결과 비율 합 = 1·핵 HP 구간 합 = 성공한 밤 수·병사 체인:단 합 = 병사 수', () => {
    const runs = [run('balanced', 1), run('balanced', 2)];
    const rep = buildReport('balanced', runs, options, cfg);
    expect(rep.stages).toHaveLength(data.balance.chapter.length);
    expect(Object.values(rep.resultShare).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(rep.coreHp.buckets.reduce((a, b) => a + b, 0)).toBe(runs.reduce((s, r) => s + r.coreHpLeft.length, 0));
    expect(Object.values(rep.soldiersByKind).reduce((a, b) => a + b, 0)).toBe(runs.reduce((s, r) => s + r.soldiers, 0));
    expect(rep.stages[0].reachedRate).toBe(1);
    expect(formatReport(rep)).toContain('스테이지별');
  });

  it('checkM810Goals: 항목이 모두 나오고, roundTrip 없으면 그 항목 없음 / 있으면 일치 여부', () => {
    const names = ['idle', 'random', 'balanced', 'dayOnly', 'nightOnly', 'noFeed'];
    const reports = names.map((n) => buildReport(n, [run(n, 1)], options, cfg));
    const goals = checkM810Goals(reports, cfg.m810Goals, null);
    const ids = goals.map((g) => g.id);
    expect(ids).toEqual(['B 시도', 'B 1-1', 'B 1-9', 'B 연속실패', 'B 완성', 'idle', 'dayOnly', 'nightOnly', 'noFeed', 'random']);
    expect(goals.find((g) => g.id === 'idle')!.pass).toBe(true);
    const withRt = checkM810Goals(reports, cfg.m810Goals, [{ policy: 'balanced', matched: 1, total: 1, mismatchSeeds: [] }]);
    expect(withRt.find((g) => g.id === 'roundTrip')!.pass).toBe(true);
  });
});

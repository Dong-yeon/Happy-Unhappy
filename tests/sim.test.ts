// M3.5 시뮬레이터 하네스 (스펙 §8.1): 재현성, 정책 기본 동작, 통계
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { POLICIES } from '../sim/policies';
import { buildReport, checkM3Goals, quantile, summarize } from '../sim/report';
import { runOne, type RunOptions } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
const opt = (seed: number, extra: Partial<RunOptions> = {}): RunOptions => ({
  seed,
  grid: { cols: 5, rows: 4 },
  untilWave: 6,
  dayReset: null,
  ...extra,
});

describe('재현성', () => {
  it.each(Object.keys(POLICIES))('%s: 같은 시드·같은 정책 → 같은 결과', (name) => {
    expect(runOne(data, cfg, POLICIES[name], opt(7))).toEqual(runOne(data, cfg, POLICIES[name], opt(7)));
  });

  it('시드가 다르면 결과가 달라질 수 있다 (random)', () => {
    const a = runOne(data, cfg, POLICIES.random, opt(1));
    const b = runOne(data, cfg, POLICIES.random, opt(2));
    expect(a).not.toEqual(b);
  });
});

describe('정책 기본 동작', () => {
  it('idle: 행동 없음, 웨이브 1에서 가라앉음, 걱정 전부 가라앉음', () => {
    const r = runOne(data, cfg, POLICIES.idle, opt(1));
    expect(r.firstSinkWave).toBe(1);
    expect(r.summons + r.spawns + r.merges + r.releases + r.mistakes).toBe(0);
    expect(r.kills).toBe(0);
    expect(r.reachedWave).toBe(6);
    expect(r.sunkByWave).toHaveLength(6);
  });

  it('balanced는 idle보다 덜 가라앉는다', () => {
    const idle = runOne(data, cfg, POLICIES.idle, opt(3));
    const bal = runOne(data, cfg, POLICIES.balanced, opt(3));
    expect(bal.sunk).toBeLessThan(idle.sunk);
    expect(bal.summons).toBeGreaterThan(0);
    expect(bal.upRatio).toBe(1); // M3.5: 창문만
  });

  it('hoarder는 최고 단계 조각만 보낸다', () => {
    for (let s = 1; s <= 10; s++) {
      const r = runOne(data, cfg, POLICIES.hoarder, opt(s));
      for (const t of Object.keys(r.summonTiers)) expect(Number(t)).toBe(data.balance.grid.maxTier);
    }
  });

  it('mistakeRate 0이면 실수 없음, 1이면 드래그 행동이 모두 원위치', () => {
    const none = runOne(data, { ...cfg, mistakeRate: 0 }, POLICIES.balanced, opt(1));
    expect(none.mistakes).toBe(0);
    const all = runOne(data, { ...cfg, mistakeRate: 1 }, POLICIES.balanced, opt(1));
    expect(all.summons + all.merges + all.releases).toBe(0);
    expect(all.spawns).toBeGreaterThan(0); // 버튼 탭(생성)은 실수 대상 아님
  });

  it('--dayReset: N웨이브마다 생성 비용이 기본값으로 돌아와 더 많이 생성한다', () => {
    const plain = runOne(data, cfg, POLICIES.alwaysHappy, opt(1, { untilWave: 9 }));
    const reset = runOne(data, cfg, POLICIES.alwaysHappy, opt(1, { untilWave: 9, dayReset: 3 }));
    expect(reset.spawns).toBeGreaterThan(plain.spawns);
  });
});

describe('통계', () => {
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

  it('리포트: 곡선 길이 = 도달 웨이브, 소환 단계 비율 합 = 1, M3 목표 판정', () => {
    const runs = [1, 2, 3].map((s) => runOne(data, cfg, POLICIES.balanced, opt(s)));
    const rep = buildReport('balanced', runs, { seeds: 3, grid: '5x4', untilWave: 6, dayReset: null }, cfg);
    expect(rep.curves).toHaveLength(6);
    const share = Object.values(rep.tierShare).reduce((s, v) => s + v, 0);
    expect(share).toBeCloseTo(1, 10);
    const idle = buildReport('idle', [runOne(data, cfg, POLICIES.idle, opt(1))], rep.options, cfg);
    const checks = checkM3Goals([idle, rep], cfg.m3Goals);
    expect(checks[0].pass).toBe(true); // idle은 웨이브 1에서 가라앉음
  });
});

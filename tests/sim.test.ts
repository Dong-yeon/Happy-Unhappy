// 시뮬레이터 하네스 (스펙 §8.1): 재현성, 정책 기본 동작, 통계, M5 실제 하루 구조
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { bossDiagnostics, buildReport, checkM3Goals, checkM5Goals, checkM6Goals, endingStats, quantile, summarize } from '../sim/report';
import { runOne, type RunOptions, type RunResult } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
const DAYS = data.balance.days.lifeLengthDays;
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
  it('14일을 다 산다: 일차별 기록 길이 = 14, 하루 길이 > 0', () => {
    const r = run('balanced', 1);
    expect(r.days).toBe(DAYS);
    for (const k of ['sunkByDay', 'joyByDay', 'shadowByDay', 'dayLengths', 'dayStartJoy', 'dayEndJoy'] as const) {
      expect(r[k]).toHaveLength(DAYS);
    }
    expect(Math.min(...r.dayLengths)).toBeGreaterThan(20);
  });

  it('7일째 이정표에서 정책이 고른다 (balanced = 마주함, alwaysHappy = 웃어넘김)', () => {
    expect(run('balanced', 1).flags).toEqual(['face']);
    expect(run('alwaysHappy', 1).flags).toEqual(['avoid']);
    expect(run('idle', 1).flags).toHaveLength(1); // 기본 = 첫 선택지
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
    expect(rep.curves).toHaveLength(DAYS);
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

describe('M6: 결말 리포트 (§5.8-4)', () => {
  it('판마다 결말이 있고, 분포 합 = 1, 항목별 평균 기여의 합 = 점수 평균', () => {
    // 0 하한이 걸리지 않는 판들로 (random은 가라앉음 감점으로 happy가 0에 막힌다)
    const runs = [run('balanced', 1), run('alwaysHappy', 1), run('random', 1)];
    for (const r of runs) expect(r.ending).not.toBeNull();
    expect(run('random', 1).ending?.happy).toBe(0);
    expect(Object.values(endingStats(runs).dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // 성장치 = 준 전설 × growthPerLegend + 기억 × memoryBonus (§5.14-2)
    for (const r of runs) {
      const gr = data.balance.growth;
      const b = r.ending!.breakdown;
      expect(r.ending!.happy).toBe(b.happyLegends * gr.growthPerLegend + b.memories * gr.memoryBonus);
      expect(r.ending!.unhappy).toBe(b.purifiedLegends * gr.growthPerLegend + b.memories * gr.memoryBonus);
      expect(r.growths.length).toBe(data.days.growthDays.length + 1);
    }
  });

  it('alwaysHappy는 보스 승리분이 unhappy 점수에 들어가지 않는다 (D-023)', () => {
    const r = run('alwaysHappy', 1);
    expect(r.bossWins).toBeGreaterThan(0);
    expect(r.layersCleared).toBe(0);
    expect(r.ending!.unhappy).toBe(0);
  });

  it('checkM6Goals: 판정 출력 (roundTrip 없으면 미판정, 있으면 일치 여부)', () => {
    const reports = ['balanced', 'alwaysHappy', 'alwaysUnhappy', 'random', 'hoarder'].map((p) => buildReport(p, [run(p, 1)], options, cfg));
    const none = checkM6Goals(reports, cfg.m6Goals, cfg.m5Goals, null);
    expect(none.find((c) => c.label.startsWith('--saveRoundTrip'))?.pass).toBeNull();
    for (const id of ['B solid', 'B hidden', 'H mask', 'H best0', 'U best0', 'R best<5', 'hoarder<B', 'M5 초반', 'M5 H역류']) {
      expect(none.find((c) => c.id === id), id).toBeDefined();
    }
    const ok = checkM6Goals(reports, cfg.m6Goals, cfg.m5Goals, [{ policy: 'balanced', matched: 1, total: 1, mismatchSeeds: [] }]);
    expect(ok.find((c) => c.id === 'roundTrip')?.pass).toBe(true);
    const ng = checkM6Goals(reports, cfg.m6Goals, cfg.m5Goals, [{ policy: 'balanced', matched: 0, total: 1, mismatchSeeds: [1] }]);
    expect(ng.find((c) => c.id === 'roundTrip')?.pass).toBe(false);
  });
});

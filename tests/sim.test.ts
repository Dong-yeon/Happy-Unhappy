// 시뮬레이터 하네스 (스펙 §8.1, §5.19-6, §5.20-10·13): 재현성, 시도 상한, 정책 기본 동작, 통계, 진행 목표
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import type { AttemptStats } from '../src/core/day';
import { applyOverrides, parseSet } from '../sim/overrides';
import { EXTRA_POLICIES, POLICIES } from '../sim/policies';
import { buildReport, checkM810Goals, checkM811Goals, formatReport, quantile, summarize } from '../sim/report';
import { GameState } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';
import { maxFailStreak, runOne, simGeometry, type Roster, type RunOptions, type RunResult } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const cfg = simJson as SimConfig;
/** 테스트는 시도 상한을 줄여 빨리 */
const MAX = 12;
const ALL = { ...POLICIES, ...EXTRA_POLICIES };
const opt = (seed: number, maxAttempts = MAX, roster: Roster = 'start'): RunOptions => ({ seed, grid: { cols: 5, rows: 4 }, maxAttempts, roster });
const options = (roster: Roster = 'start') => ({ seeds: 1, grid: '5x4', maxAttempts: MAX, roster });

/** 정책별 한 판은 비싸지 않지만 여러 번 쓰므로 캐시 */
const cache = new Map<string, RunResult>();
function run(policy: string, seed: number, roster: Roster = 'start'): RunResult {
  const k = `${policy}:${seed}:${roster}`;
  if (!cache.has(k)) cache.set(k, runOne(data, cfg, ALL[policy], opt(seed, MAX, roster)));
  return cache.get(k)!;
}

describe('재현성', () => {
  it.each(Object.keys(POLICIES))('%s: 같은 시드·같은 정책 → 같은 결과', (name) => {
    expect(runOne(data, cfg, POLICIES[name], opt(7, 4))).toEqual(runOne(data, cfg, POLICIES[name], opt(7, 4)));
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

  it('balanced는 진행한다: 첫 시도 기록·운반 시간', () => {
    const r = run('balanced', 1);
    expect(r.stage).toBeGreaterThan(1);
    expect(r.firstTry[0]).not.toBeNull();
    expect(r.carryTimes.length).toBeGreaterThan(0);
    for (const hp of r.coreHpLeft) expect(hp).toBeGreaterThan(0);
  });

  it('maxFailStreak: 같은 스테이지 연속 실패 최대 (성공하면 끊김, 끝까지 못 넘은 것도 센다)', () => {
    const a = (stage: number, result: AttemptStats['result']) => ({ stage, result }) as AttemptStats;
    expect(maxFailStreak([a(1, 'success'), a(2, 'night'), a(2, 'dayFall'), a(2, 'success'), a(3, 'night')])).toBe(2);
    expect(maxFailStreak([a(1, 'night'), a(1, 'night'), a(1, 'night')])).toBe(3);
    expect(maxFailStreak([])).toBe(0);
  });
});

describe('정책 기본 동작 (§5.20-10·13: 조각은 저절로 + 처치 드롭, 손은 머지·놓아주기뿐)', () => {
  it('idle: 손 행동 없음 → 1단계만 저절로 뭉치고(D-070) 나머지는 쌓이다 가득 차면 버려진다', () => {
    const r = run('idle', 1);
    expect(r.merges + r.releases + r.mistakes).toBe(0);
    expect(r.autoMerges).toBeGreaterThan(0);
    expect(r.battleMerges).toBe(r.autoMerges);
    expect(r.piecesAuto).toBeGreaterThan(0);
    expect(r.piecesDiscarded).toBeGreaterThan(0);
    expect(r.gridFullRatio).toBeGreaterThan(0);
  });

  it('balanced: 전투 중 머지로 병사·버프·스킬, 처치 드롭 조각도 들어온다', () => {
    const b = run('balanced', 1);
    expect(b.merges).toBeGreaterThan(0);
    expect(b.battleMerges).toBe(b.merges + b.autoMerges); // 전투 밖 행동 없음 (자동 뭉침도 전투 중에만)
    expect(b.soldiers).toBeGreaterThan(0);
    expect(Object.values(b.skillCasts).reduce((a, x) => a + x, 0)).toBeGreaterThan(0);
    expect(b.piecesDropped).toBeGreaterThan(0);
    expect(b.gridFullRatio).toBeLessThan(run('idle', 1).gridFullRatio);
  });

  it('roster start: 체인 생성은 삽살·해태 체인만 (지금 팀 체인, §5.20-4)', () => {
    const b = run('balanced', 1);
    expect(Object.keys(b.chainSpawns).sort()).toEqual(['bell', 'bone']);
    expect(b.formation).toEqual({ offense: [['sapsal']], defense: [['haetae']] });
  });

  it('roster all: 6명 보유, 편성대로 인연·레벨 기록', () => {
    const r = run('balanced', 1, 'all');
    expect(Object.keys(r.levels)).toHaveLength(6);
    const on = run('bondOn', 1, 'all');
    const off = run('bondOff', 1, 'all');
    expect(on.bonds.length).toBeGreaterThan(0);
    expect(off.bonds).toEqual([]);
  });

  it('dayHeavyTeam·nightHeavyTeam (M8.11 편성 몰기): 한쪽에 몰고 반대쪽은 1명', () => {
    const d = run('dayHeavyTeam', 1, 'all');
    expect(d.formation.defense.flat()).toHaveLength(1);
    expect(d.formation.offense.flat().length).toBeGreaterThan(1);
    const n = run('nightHeavyTeam', 1, 'all');
    expect(n.formation.offense.flat()).toHaveLength(1);
  });

  it('lazy: 전투 중에는 머지하지 않는다 (병사·버프 없음), 전투 밖에서 몰아서 머지', () => {
    const l = run('lazy', 1);
    expect(l.merges).toBeGreaterThan(0);
    expect(l.battleMerges).toBe(l.autoMerges); // 전투 중 머지는 자동 뭉침뿐
  });

  it('noMerge: 머지 안 함 (가득이면 놓아주기만)', () => {
    const r = run('noMerge', 1);
    expect(r.merges).toBe(0);
    expect(r.releases).toBeGreaterThan(0);
  });

  it('mistakeRate 0이면 실수 없음, 1이면 드래그 행동이 모두 원위치', () => {
    const none = runOne(data, { ...cfg, mistakeRate: 0 }, POLICIES.balanced, opt(1, 3));
    expect(none.mistakes).toBe(0);
    const all = runOne(data, { ...cfg, mistakeRate: 1 }, POLICIES.balanced, opt(1, 3));
    expect(all.merges + all.releases).toBe(0);
    expect(all.mistakes).toBeGreaterThan(0);
  });

  it('--set merge.soldiers=false: 병사 없음 (버프는 그대로) / start.swapHeroes=true: core 기본 편성이 바뀐다', () => {
    const off = runOne(applyOverrides(data, [parseSet('merge.soldiers=false')]), cfg, POLICIES.balanced, opt(1, 3));
    expect(off.soldiers).toBe(0);
    expect(off.soldiersCapped).toBe(0);
    expect(off.battleMerges).toBeGreaterThan(0);
    // swapHeroes는 core 기본 편성만 바꾼다 (시뮬은 판 시작에 정책 편성을 확정)
    const sw = new GameState(applyOverrides(data, [parseSet('start.swapHeroes=true')]), { cols: 5, rows: 4 }, mulberry32(1), simGeometry(data));
    expect(sw.formation).toEqual({ offense: [[data.heroes.defense]], defense: [[data.heroes.offense]] });
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

  it('리포트: 스테이지 표·결과 비율 합 = 1·핵 HP 구간 합·병사 합·체인 생성 비율 합 = 1·가득 참·버린 조각', () => {
    const runs = [run('balanced', 1), run('balanced', 2)];
    const rep = buildReport('balanced', runs, options(), cfg);
    expect(rep.stages).toHaveLength(data.balance.chapter.length);
    expect(Object.values(rep.resultShare).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(rep.coreHp.buckets.reduce((a, b) => a + b, 0)).toBe(runs.reduce((s, r) => s + r.coreHpLeft.length, 0));
    expect(Object.values(rep.soldiersByKind).reduce((a, b) => a + b, 0)).toBe(runs.reduce((s, r) => s + r.soldiers, 0));
    expect(Object.values(rep.chainShare).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(rep.stages[0].reachedRate).toBe(1);
    const text = formatReport(rep);
    for (const s of ['스테이지별', '그리드 가득 참 비율', '버려진 조각 수', '팀 교대 (낮)', '스킬 발동', '5단계 생성', '특별 버프 발동', '체인별 생성 비율', '영웅 최종 레벨', '인연 켜진 판']) {
      expect(text).toContain(s);
    }
  });

  it('checkM810Goals: 있는 정책만 판정, roundTrip 있으면 일치 여부', () => {
    const names = ['idle', 'random', 'balanced'];
    const reports = names.map((n) => buildReport(n, [run(n, 1)], options(), cfg));
    const goals = checkM810Goals(reports, cfg.m810Goals, null);
    expect(goals.map((g) => g.id)).toEqual(['B 시도', 'B 1-1', 'B 1-9', 'B 연속실패', 'B 완성', 'idle', 'random']);
    const withRt = checkM810Goals(reports, cfg.m810Goals, [{ policy: 'balanced', matched: 1, total: 1, mismatchSeeds: [] }]);
    expect(withRt.find((g) => g.id === 'roundTrip')!.pass).toBe(true);
  });

  it('checkM811Goals: noMerge·lazy (roster별), 인연 켬/끔 (roster all)', () => {
    const start = ['balanced', 'noMerge', 'lazy'].map((n) => buildReport(n, [run(n, 1)], options(), cfg));
    const all = ['bondOn', 'bondOff'].map((n) => buildReport(n, [run(n, 1, 'all')], options('all'), cfg));
    const goals = checkM811Goals([...start, ...all], cfg.m811Goals);
    expect(goals.map((g) => g.id)).toEqual(['noMerge start', 'lazy start', 'bond all']);
    for (const g of goals) expect(g.detail.length).toBeGreaterThan(0);
  });
});

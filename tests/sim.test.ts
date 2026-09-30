// M3.5 시뮬레이터 하네스 (스펙 §8.1): 재현성, 정책 기본 동작, 통계
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { POLICIES } from '../sim/policies';
import { buildReport, checkM3Goals, quantile, summarize } from '../sim/report';
import { m5LastWave, runOne, type RunOptions } from '../sim/runner';
import { waveHp } from '../src/core/wave';
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
    // M4: 위/아래 배분 (합 = 1)
    expect(bal.upRatio! + bal.downRatio!).toBeCloseTo(1, 10);
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
    const rep = buildReport('balanced', runs, { seeds: 3, grid: '5x4', untilWave: 6, dayReset: null, dayMode: null, wavesPerDay: 3 }, cfg);
    expect(rep.curves).toHaveLength(6);
    const share = Object.values(rep.tierShare).reduce((s, v) => s + v, 0);
    expect(share).toBeCloseTo(1, 10);
    const idle = buildReport('idle', [runOne(data, cfg, POLICIES.idle, opt(1))], rep.options, cfg);
    const checks = checkM3Goals([idle, rep], cfg.m3Goals);
    expect(checks[0]).toMatchObject({ label: '판정 기준', pass: null }); // dayMode m5가 아니면 참고용 안내
    expect(checks.find((c) => c.label.startsWith('idle'))?.pass).toBe(true); // idle은 1일차에 가라앉음
  });
});

describe('--dayMode m5 (§8.1 v0.4.1)', () => {
  const WPD = data.balance.wave.wavesPerDay;
  const DAYS = data.balance.days.lifeLengthDays;
  const m5 = (seed: number, policy = 'balanced') =>
    runOne(data, cfg, POLICIES[policy], opt(seed, { dayMode: 'm5', untilWave: 999 }));

  it('④ lifeLengthDays × wavesPerDay웨이브에서 끝남 (untilWave 무시)', () => {
    expect(m5LastWave(data)).toBe(DAYS * WPD);
    const r = m5(1);
    expect(r.reachedWave).toBe(DAYS * WPD);
    expect(r.dayStartJoy).toHaveLength(DAYS);
    expect(r.dayEndJoy).toHaveLength(DAYS);
  });

  it('② 하루 끝마다 방어 유닛 해산', () => {
    const r = m5(2);
    expect(r.summons).toBeGreaterThan(0);
    expect(r.disbanded).toBeGreaterThan(0);
    expect(r.disbanded).toBeLessThanOrEqual(r.summons);
  });

  it('① 하루 시작마다 생성 횟수 리셋 → 같은 봇이 더 많이 생성', () => {
    const plain = runOne(data, cfg, POLICIES.alwaysHappy, opt(1, { untilWave: DAYS * WPD }));
    const day = runOne(data, cfg, POLICIES.alwaysHappy, opt(1, { dayMode: 'm5' }));
    expect(day.spawns).toBeGreaterThan(plain.spawns);
  });

  it('③ 걱정 HP는 일차 기준 (같은 날의 웨이브는 같은 HP)', () => {
    const cfgW = { ...data.balance.wave, hpBase: data.monsters.worry.hpBase };
    // 4웨이브 = 2일차 첫 웨이브 → 레벨 2, 웨이브 3 = 1일차 저녁 → 레벨 1
    expect(waveHp(cfgW, Math.ceil(3 / WPD))).toBe(waveHp(cfgW, 1));
    expect(waveHp(cfgW, Math.ceil(4 / WPD))).toBe(waveHp(cfgW, 2));
  });

  it('idle은 1일차에 가라앉고, 결과는 시드로 재현된다', () => {
    const a = m5(5, 'idle');
    expect(a.firstSinkWave).not.toBeNull();
    expect(a.firstSinkWave!).toBeLessThanOrEqual(WPD);
    expect(a.day1Sunk).toBe(a.day1Worries);
    expect(m5(5)).toEqual(m5(5));
  });
});

describe('M4 정책', () => {
  const m5 = (seed: number, policy: string) => runOne(data, cfg, POLICIES[policy], opt(seed, { dayMode: 'm5' }));

  it('alwaysUnhappy는 손거울로만 보내고 층을 돌파한다', () => {
    const r = m5(1, 'alwaysUnhappy');
    expect(r.summons).toBeGreaterThan(0);
    expect(r.downRatio).toBe(1);
    expect(r.layersCleared).toBeGreaterThan(0);
  });

  it('alwaysHappy는 손거울을 쓰지 않아 층 돌파가 없다', () => {
    const r = m5(1, 'alwaysHappy');
    expect(r.downRatio).toBe(0);
    expect(r.layersCleared).toBe(0);
  });

  it('balanced는 위·아래 모두 보낸다 (손거울은 abyssMinTier 이상만)', () => {
    const r = m5(2, 'balanced');
    expect(r.upRatio).toBeGreaterThan(0);
    expect(r.downRatio).toBeGreaterThan(0);
  });

  it('리포트 곡선에 그림자가 들어간다', () => {
    const r = m5(3, 'idle');
    expect(r.shadowByWave).toHaveLength(r.reachedWave);
    expect(r.maxShadow).toBe(data.balance.shadow.shadowMax); // 방치하면 역류까지 간다
    expect(r.backflows).toBeGreaterThan(0);
  });
});

describe('M4 조정 (A안 이후)', () => {
  it('--dayMode m5: 보스는 끼어드는 자리(다음 일반 웨이브)의 일차 HP', async () => {
    const { GameState } = await import('../src/core/game');
    const orig = GameState.prototype.tick;
    const bossHps: { n: number; hp: number }[] = [];
    GameState.prototype.tick = function (dt: number) {
      const ev = orig.call(this, dt);
      for (const e of ev) {
        if (e.type === 'spawnWorry' && e.boss) bossHps.push({ n: this.wave.n, hp: this.defense.worries.at(-1)!.maxHp });
      }
      return ev;
    };
    try {
      const d = structuredClone(data);
      d.monsters.backflowBoss.hpGrowthPerDay = 1.1;
      runOne(d, cfg, POLICIES.idle, opt(1, { dayMode: 'm5' }));
    } finally {
      GameState.prototype.tick = orig;
    }
    const wpd = data.balance.wave.wavesPerDay;
    expect(bossHps.length).toBeGreaterThan(0);
    for (const b of bossHps) {
      const day = Math.ceil((b.n + 1) / wpd);
      expect(b.hp).toBeCloseTo(data.monsters.backflowBoss.hp * Math.pow(1.1, day - 1), 6);
    }
  });

  it('balanced: 역류가 예약되면 창문 보강을 먼저 한다 (평소라면 손거울로 갈 조각도)', async () => {
    const { GameState } = await import('../src/core/game');
    const { mulberry32 } = await import('../src/core/rng');
    const { gameGeometry } = await import('../src/scenes/layout');
    const g = new GameState(data, { cols: 5, rows: 4 }, mulberry32(1), gameGeometry(data.balance.lane.laneCap));
    g.wave.paused = true;
    for (let k = 0; k < cfg.balanced.minUnits; k++) g.summon(g.debugGrant('companion_animal', 1)!, 'happy');
    const cell = g.debugGrant('comfort_object', 2)!;
    const ctx = { state: g, rng: mulberry32(9), cfg };
    // 안전 + 2단계 → 평소에는 손거울
    expect(POLICIES.balanced.decide(ctx)).toEqual({ type: 'summon', cell, side: 'unhappy' });
    g.debugScheduleBackflow();
    expect(POLICIES.balanced.decide(ctx)).toEqual({ type: 'summon', cell, side: 'happy' });
  });
});

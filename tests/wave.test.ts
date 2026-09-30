import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../src/core/lane';
import { DayWaves, waveCount, waveHp, type WaveConfig } from '../src/core/wave';

const CFG: WaveConfig = {
  wavesPerDay: 3,
  countBase: 6,
  countStep: 1,
  spawnInterval: 1.5,
  waveGap: 3,
  dayStartDelay: 3,
  bossPrepSeconds: 10,
  hpBase: 18,
  hpGrowthPerDay: 1.08,
};

/** 틱을 돌리며 등장 틱 번호를 모은다. fieldEmpty는 콜백으로 */
function simulate(w: DayWaves, seconds: number, fieldEmpty: (tick: number) => boolean = () => true) {
  const spawnsAt: number[] = [];
  const n = Math.round(seconds / FIXED_DT);
  for (let t = 1; t <= n; t++) {
    const s = w.step(FIXED_DT, fieldEmpty(t));
    for (let i = 0; i < s; i++) spawnsAt.push(t);
  }
  return spawnsAt;
}

describe('일차 기준 공식 (§5.7)', () => {
  it('걱정 수 = round((countBase + countStep × (d-1)) × worryMultiplier), 최소 1', () => {
    expect(waveCount(CFG, 1)).toBe(6);
    expect(waveCount(CFG, 4)).toBe(9);
    expect(waveCount(CFG, 1, 1.4)).toBe(Math.round(6 * 1.4)); // 8
    expect(waveCount(CFG, 1, 0.8)).toBe(Math.round(6 * 0.8)); // 5
    expect(waveCount({ ...CFG, countBase: 0, countStep: 0 }, 1)).toBe(1);
  });

  it('HP = hpBase × hpGrowthPerDay^(d-1) × worryMultiplier', () => {
    expect(waveHp(CFG, 1)).toBe(18);
    expect(waveHp(CFG, 3, 1.4)).toBeCloseTo(18 * 1.08 * 1.08 * 1.4, 10);
  });

  it('DayWaves.count·hp는 그날 일차·배율 기준 (웨이브 칸과 무관)', () => {
    const w = new DayWaves(CFG);
    w.startDay(5, 1.4, false);
    expect(w.count).toBe(waveCount(CFG, 5, 1.4));
    expect(w.hp).toBeCloseTo(waveHp(CFG, 5, 1.4), 10);
  });
});

describe('하루 3웨이브 흐름', () => {
  it('dayStartDelay 뒤 아침 → waveGap → 낮 → waveGap → 저녁 → done (항상 wavesPerDay웨이브)', () => {
    const w = new DayWaves(CFG);
    expect(w.phase).toBe('idle');
    expect(simulate(w, 5)).toEqual([]); // 하루 시작 전에는 아무것도 안 나옴
    w.startDay(1, 1, false);
    const spawnsAt = simulate(w, 120);
    expect(spawnsAt).toHaveLength(18); // 6 × 3
    expect(spawnsAt[0]).toBe(180); // 3초
    expect(w.phase).toBe('done');
    expect(w.slot).toBe(2);
  });

  it('남은 걱정이 있으면 다음 웨이브로 넘어가지 않는다', () => {
    const w = new DayWaves(CFG);
    w.startDay(1, 1, false);
    simulate(w, 60, () => false);
    expect(w.slot).toBe(0);
    expect(w.phase).toBe('clearing');
  });

  it('nextSlot: 대기·간격이면 지금 칸, 진행 중이면 다음 칸, 저녁 진행 중이면 null', () => {
    const w = new DayWaves(CFG);
    w.startDay(1, 1, false);
    expect(w.nextSlot()).toBe(0); // delay
    simulate(w, 3.01, () => false); // 아침 시작
    expect(w.nextSlot()).toBe(1);
    w.slot = 2;
    expect(w.nextSlot()).toBeNull();
  });

  it('보스로 교체된 칸은 1마리', () => {
    const w = new DayWaves(CFG);
    w.startDay(1, 1, false);
    w.markBoss(1);
    const spawnsAt = simulate(w, 120);
    expect(spawnsAt).toHaveLength(6 + 1 + 6);
  });

  it('전날 넘어온 역류: 아침이 보스, 대기 = bossPrepSeconds (inBossPrep)', () => {
    const w = new DayWaves(CFG);
    w.startDay(2, 1, true);
    expect(w.inBossPrep).toBe(true);
    expect(w.bossSlots.has(0)).toBe(true);
    const spawnsAt = simulate(w, 11, () => false); // 보스가 아직 필드에 있음
    expect(spawnsAt).toEqual([600]); // 10초에 1마리
    expect(w.isBoss).toBe(true);
    expect(w.inBossPrep).toBe(false);
  });

  it('일시정지 중에는 등장·간격이 멈춘다, startNext는 대기를 건너뛴다', () => {
    const w = new DayWaves(CFG);
    w.startDay(1, 1, false);
    w.paused = true;
    expect(simulate(w, 10)).toEqual([]);
    w.paused = false;
    w.startNext();
    expect(w.step(FIXED_DT, true)).toBe(1);
  });
});

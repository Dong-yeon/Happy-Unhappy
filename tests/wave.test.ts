import { describe, expect, it } from 'vitest';
import { FIXED_DT } from '../src/core/lane';
import { M3_FIRST_WAVE_DELAY, WaveRunner, waveCount, waveHp, type WaveConfig } from '../src/core/wave';

const CFG: WaveConfig = { countBase: 6, countStep: 1, spawnInterval: 1.5, waveGap: 3, hpBase: 18, hpGrowthPerDay: 1.08 };

/** 틱을 돌리며 틱 번호별 등장 수를 모은다. fieldEmpty는 콜백으로 */
function simulate(w: WaveRunner, seconds: number, fieldEmpty: (tick: number) => boolean = () => true) {
  const spawnsAt: number[] = [];
  const n = Math.round(seconds / FIXED_DT);
  for (let t = 1; t <= n; t++) {
    const s = w.step(FIXED_DT, fieldEmpty(t));
    for (let i = 0; i < s; i++) spawnsAt.push(t);
  }
  return spawnsAt;
}

describe('웨이브 공식', () => {
  it('마리 수 = countBase + countStep × (n-1)', () => {
    expect(waveCount(CFG, 1)).toBe(6);
    expect(waveCount(CFG, 4)).toBe(9);
  });

  it('HP = hpBase × hpGrowthPerDay^(n-1)', () => {
    expect(waveHp(CFG, 1)).toBe(18);
    expect(waveHp(CFG, 3)).toBeCloseTo(18 * 1.08 * 1.08, 10);
  });
});

describe('WaveRunner', () => {
  it(`게임 시작 ${M3_FIRST_WAVE_DELAY}초 후 첫 웨이브, spawnInterval 간격으로 countBase마리`, () => {
    const w = new WaveRunner(CFG);
    const spawnsAt = simulate(w, 2 + 1.5 * 5 + 0.1, () => false);
    expect(spawnsAt).toHaveLength(6);
    expect(spawnsAt[0]).toBe(120); // 2초 = 120틱
    const gaps = spawnsAt.slice(1).map((t, i) => t - spawnsAt[i]);
    expect(gaps.every((g) => g === 90)).toBe(true); // 1.5초 = 90틱
    expect(w.n).toBe(1);
    expect(w.phase).toBe('clearing');
  });

  it('남은 걱정이 있으면 다음 웨이브로 넘어가지 않는다', () => {
    const w = new WaveRunner(CFG);
    simulate(w, 30, () => false);
    expect(w.n).toBe(1);
    expect(w.phase).toBe('clearing');
  });

  it('웨이브 종료(필드 비움) → waveGap 후 다음 웨이브 (마리 수 +countStep)', () => {
    const w = new WaveRunner(CFG);
    // 첫 웨이브 마지막 등장: 120 + 90×5 = 570틱. 600틱에 필드가 비었다고 치자
    const spawnsAt = simulate(w, 20, (t) => t >= 600);
    const wave2 = spawnsAt.slice(6);
    expect(w.n).toBe(2);
    // 600틱에 gap 시작 → waveGap 3초(180틱) 뒤 780틱에 첫 등장
    expect(wave2[0]).toBe(600 + 180);
    expect(waveCount(CFG, 2)).toBe(7);
  });

  it('일시정지 중에는 등장·간격이 멈춘다', () => {
    const w = new WaveRunner(CFG);
    w.paused = true;
    expect(simulate(w, 10)).toEqual([]);
    expect(w.n).toBe(0);
    w.paused = false;
    expect(simulate(w, 2.01)[0]).toBe(120);
  });

  it('다음 웨이브 즉시 시작: 번호 +1, 첫 걱정은 다음 틱에', () => {
    const w = new WaveRunner(CFG);
    w.startNext();
    expect(w.n).toBe(1);
    expect(w.step(FIXED_DT, true)).toBe(1);
    w.startNext();
    expect(w.n).toBe(2);
    expect(w.count).toBe(7);
    expect(w.step(FIXED_DT, false)).toBe(1);
  });
});

describe('hpLevel (시뮬 --dayMode m5 대비)', () => {
  it('기본은 웨이브 번호, 바꿔 끼우면 그 레벨로 HP 계산 (마리 수는 그대로)', () => {
    const w = new WaveRunner(CFG);
    w.startNext();
    w.startNext();
    w.startNext(); // n = 3
    expect(w.hp).toBeCloseTo(waveHp(CFG, 3), 10);
    w.hpLevel = (n) => Math.ceil(n / 3);
    expect(w.hp).toBe(waveHp(CFG, 1));
    expect(w.count).toBe(waveCount(CFG, 3));
  });
});

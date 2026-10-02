// 밤 웨이브 (§5.19-3·3-5): stages.json night 그대로, 종류별로 번갈아, bossWave는 마지막
import { describe, expect, it } from 'vitest';
import { NightWaves, interleave } from '../src/core/wave';

const CFG = { spawnInterval: 1, waveGap: 2, nightStartDelay: 3 };
const DT = 1 / 60;

/** 끝날 때까지 돌리며 등장 기록 (fieldEmpty는 늘 true = 나오자마자 처치) */
function runAll(w: NightWaves, maxSeconds = 120): { t: number; type: string; boss: boolean; slot: number }[] {
  const out: { t: number; type: string; boss: boolean; slot: number }[] = [];
  for (let k = 0; k < maxSeconds * 60 && w.phase !== 'done'; k++) {
    for (const s of w.step(DT, true)) out.push({ t: (k + 1) * DT, ...s, slot: w.slot });
  }
  return out;
}

describe('interleave', () => {
  it('종류별로 하나씩 번갈아, 남은 것은 뒤에', () => {
    expect(interleave([{ type: 'a', count: 3 }, { type: 'b', count: 1 }])).toEqual(['a', 'b', 'a', 'a']);
    expect(interleave([])).toEqual([]);
  });
});

describe('NightWaves', () => {
  it('start → delay(nightStartDelay) → 웨이브마다 spawnInterval 간격 → waveGap → … → done', () => {
    const w = new NightWaves(CFG);
    w.start([[{ type: 'shadow', count: 2 }], [{ type: 'wildcat', count: 1 }]]);
    expect(w.waveCount).toBe(2);
    const spawns = runAll(w);
    expect(spawns.map((s) => s.type)).toEqual(['shadow', 'shadow', 'wildcat']);
    expect(spawns[0].t).toBeCloseTo(3, 1);
    expect(spawns[1].t - spawns[0].t).toBeCloseTo(1, 1);
    expect(w.phase).toBe('done');
  });

  it('bossWave는 일반 웨이브 다음 마지막 웨이브, 그 적은 boss = true', () => {
    const w = new NightWaves(CFG);
    w.start([[{ type: 'shadow', count: 1 }]], [{ type: 'mitten', count: 2 }]);
    expect(w.waveCount).toBe(2);
    const spawns = runAll(w);
    expect(spawns.map((s) => [s.type, s.boss])).toEqual([
      ['shadow', false],
      ['mitten', true],
      ['mitten', true],
    ]);
  });

  it('필드에 적이 남아 있으면 다음 웨이브로 넘어가지 않는다', () => {
    const w = new NightWaves(CFG);
    w.start([[{ type: 'shadow', count: 1 }], [{ type: 'shadow', count: 1 }]]);
    for (let k = 0; k < 3 * 60 + 2; k++) w.step(DT, false);
    expect(w.phase).toBe('clearing');
    for (let k = 0; k < 600; k++) w.step(DT, false);
    expect(w.slot).toBe(0);
    w.step(DT, true);
    expect(w.phase).toBe('gap');
  });

  it('웨이브가 없으면 바로 done (1-10 = 밤 없음), stop → idle', () => {
    const w = new NightWaves(CFG);
    w.start([]);
    expect(w.phase).toBe('done');
    w.stop();
    expect(w.phase).toBe('idle');
    expect(w.step(DT, true)).toEqual([]);
  });

  it('같은 구성 → 같은 순서 (낮 결과와 무관, D-055)', () => {
    const night = [[{ type: 'shadow', count: 3 }, { type: 'wildcat', count: 2 }]];
    const a = new NightWaves(CFG);
    const b = new NightWaves(CFG);
    a.start(night);
    b.start(night);
    expect(runAll(a)).toEqual(runAll(b));
  });
});

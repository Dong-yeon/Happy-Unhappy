// rng 상태 저장·복원 (스펙 §5.8-2 "난수", §5.8-5)
import { describe, expect, it } from 'vitest';
import { mulberry32, randomSeed } from '../src/core/rng';

describe('SeededRng', () => {
  it('getState → setState 후 같은 수열', () => {
    const a = mulberry32(12345);
    for (let i = 0; i < 17; i++) a();
    const st = a.getState();
    const first = Array.from({ length: 10 }, () => a());
    a.setState(st);
    expect(Array.from({ length: 10 }, () => a())).toEqual(first);
    // 다른 인스턴스에 상태를 옮겨도 같은 수열
    const b = mulberry32(999);
    b.setState(st);
    expect(Array.from({ length: 10 }, () => b())).toEqual(first);
  });

  it('상태는 32비트 부호 없는 정수 (JSON에 그대로 저장 가능)', () => {
    const r = mulberry32(-1);
    r();
    const st = r.getState();
    expect(Number.isInteger(st) && st >= 0 && st < 2 ** 32).toBe(true);
  });

  it('기존 Rng 호출 방식 그대로 [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it('randomSeed: 32비트 부호 없는 정수', () => {
    expect(randomSeed(() => 0)).toBe(0);
    expect(randomSeed(() => 0.999999999)).toBeLessThan(2 ** 32);
    expect(Number.isInteger(randomSeed(Math.random))).toBe(true);
  });
});

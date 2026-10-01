// sim --set / --sweep: JSON 수치를 파일 수정 없이 덮어쓰기
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { applyOverrides, overridesRecord, parseSet, parseSweep, parseValue, resolvePath } from '../sim/overrides';
import { POLICIES } from '../sim/policies';
import { runOne } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;

describe('키 경로', () => {
  it('파일 이름이 없으면 balance.json, 있으면 그 파일', () => {
    expect(resolvePath('shadow.shadowAfterBossWin')).toEqual(['balance', 'shadow', 'shadowAfterBossWin']);
    expect(resolvePath('monsters.backflowBoss.hp')).toEqual(['monsters', 'backflowBoss', 'hp']);
    expect(resolvePath('chains.0.hero.atk')).toEqual(['chains', '0', 'hero', 'atk']);
    expect(resolvePath('balance.happy.atk')).toEqual(['balance', 'happy', 'atk']);
  });

  it('값: 숫자·불리언·배열은 JSON, 나머지는 문자열', () => {
    expect(parseValue('0.15')).toBe(0.15);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('[20,40,60]')).toEqual([20, 40, 60]);
    expect(parseValue('강아지')).toBe('강아지');
    expect(() => parseValue(' ')).toThrow();
  });

  it('parseSet / parseSweep', () => {
    expect(parseSet('shadow.shadowAfterBossWin=50')).toMatchObject({ value: 50, path: ['balance', 'shadow', 'shadowAfterBossWin'] });
    expect(() => parseSet('noequals')).toThrow(/key=value/);
    const sw = parseSweep('night.stallShadowPerSec=0.1, 0.2,0.3');
    expect(sw.values.map((v) => v.value)).toEqual([0.1, 0.2, 0.3]);
    expect(() => parseSweep('happy.atk=')).toThrow();
  });
});

describe('applyOverrides', () => {
  it('사본만 바꾸고 원본은 그대로', () => {
    const before = structuredClone(data);
    const out = applyOverrides(data, [parseSet('shadow.shadowAfterBossWin=50'), parseSet('monsters.backflowBoss.hp=300')]);
    expect(out.balance.shadow.shadowAfterBossWin).toBe(50);
    expect(out.monsters.backflowBoss.hp).toBe(300);
    expect(data).toEqual(before);
  });

  it('배열 원소·배열 값도 바꿀 수 있다', () => {
    const out = applyOverrides(data, [parseSet('chains.1.hero.atk=16'), parseSet('shadow.weatherThresholds=[20,40,60]')]);
    expect(out.chains[1].hero.atk).toBe(16);
    expect(out.balance.shadow.weatherThresholds).toEqual([20, 40, 60]);
  });

  it('없는 키는 만들지 않는다 (오타 방지)', () => {
    expect(() => applyOverrides(data, [parseSet('shadow.shadowAfterBossWinn=50')])).toThrow(/없음/);
    expect(() => applyOverrides(data, [parseSet('nothere.x=1')])).toThrow(/없음/);
  });

  it('타입이 다르면 거부', () => {
    expect(() => applyOverrides(data, [parseSet('happy.atk=abc')])).toThrow(/타입/);
  });

  it('적용 후 데이터 검증을 다시 한다', () => {
    expect(() => applyOverrides(data, [parseSet('shadow.shadowAfterBossWin=500')])).toThrow(/검증 실패[\s\S]*shadowAfterBossWin/);
    expect(() => applyOverrides(data, [parseSet('shadow.weatherThresholds=[60,40,20]')])).toThrow(/오름차순/);
  });

  it('리포트 기록은 전체 경로', () => {
    expect(overridesRecord([parseSet('happy.atk=6')])).toEqual({ 'balance.happy.atk': 6 });
  });

  it('덮어쓴 값이 시뮬레이션에 실제로 반영된다', () => {
    const cfg = simJson as SimConfig;
    const opt = { seed: 1, grid: { cols: 5, rows: 4 } };
    const plain = runOne(data, cfg, POLICIES.idle, opt);
    const calm = runOne(applyOverrides(data, [parseSet('night.stallShadowPerSec=0'), parseSet('shadow.sinkShadow=0')]), cfg, POLICIES.idle, opt);
    expect(plain.backflows).toBeGreaterThan(0);
    expect(calm.backflows).toBe(0); // 그림자 증가원을 끄면 역류 없음
  });
});

import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import { validateGameData, type Issue } from '../src/data/validate';

type Raw = typeof rawGameData;

/** 원본을 복제해 한 군데만 망가뜨린 뒤 검증 */
function issuesAfter(mutate: (d: Raw) => void): Issue[] {
  const d = structuredClone(rawGameData);
  mutate(d);
  const r = validateGameData(d);
  return r.ok ? [] : r.issues;
}

function expectIssue(issues: Issue[], path: string, reason?: RegExp): void {
  const hit = issues.find((i) => i.path === path && (!reason || reason.test(i.reason)));
  expect(hit, `기대한 오류 없음: ${path}\n실제: ${JSON.stringify(issues, null, 1)}`).toBeDefined();
}

describe('validateGameData', () => {
  it('현재 src/data/*.json은 통과', () => {
    const r = validateGameData(structuredClone(rawGameData));
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('알 수 없는 키 (키 이름 불일치)', () => {
    const issues = issuesAfter((d) => {
      (d.monsters.backflowBoss as Record<string, unknown>).bossJoyReward = 40;
    });
    expectIssue(issues, 'monsters.backflowBoss.bossJoyReward', /알 수 없는 키/);
  });

  it('v0.3에서 삭제된 balance.lane.defenseLineY는 알 수 없는 키', () => {
    const issues = issuesAfter((d) => {
      (d.balance.lane as Record<string, unknown>).defenseLineY = 206;
    });
    expectIssue(issues, 'balance.lane.defenseLineY', /알 수 없는 키/);
  });

  it('필수 키 없음', () => {
    const issues = issuesAfter((d) => {
      delete (d.balance.lane as Partial<Raw['balance']['lane']>).abyssAdvanceSpeed;
    });
    expectIssue(issues, 'balance.lane.abyssAdvanceSpeed', /필수 키/);
  });

  it('타입 오류', () => {
    const issues = issuesAfter((d) => {
      (d.balance.grid as Record<string, unknown>).spawnCostBase = '10';
    });
    expectIssue(issues, 'balance.grid.spawnCostBase', /숫자/);
  });

  it('기본 그리드가 프리셋에 없음', () => {
    const issues = issuesAfter((d) => {
      d.balance.grid.gridCols = 3;
    });
    expectIssue(issues, 'balance.grid', /gridPresets에 없음/);
  });

  it('tierNames 개수 ≠ maxTier', () => {
    const issues = issuesAfter((d) => {
      d.chains[0].tierNames.pop();
    });
    expectIssue(issues, 'chains[0].tierNames', /maxTier/);
  });

  it('공용 정령 단계 누락', () => {
    const issues = issuesAfter((d) => {
      d.units.commonSpirit.pop();
    });
    expectIssue(issues, 'units.commonSpirit', /2단계/);
  });

  it('체인 id 중복', () => {
    const issues = issuesAfter((d) => {
      d.chains[1].archetypeId = d.chains[0].archetypeId;
    });
    expectIssue(issues, 'chains', /중복/);
  });

  it('days.fixed가 없는 이벤트를 참조', () => {
    const issues = issuesAfter((d) => {
      (d.days.fixed as Record<string, string>)['3'] = 'no_such_event';
    });
    expectIssue(issues, 'days.fixed.3', /없는 이벤트/);
  });

  it('days.fixed에 일상 이벤트는 불가', () => {
    const issues = issuesAfter((d) => {
      (d.days.fixed as Record<string, string>)['3'] = 'rainy_day';
    });
    expectIssue(issues, 'days.fixed.3', /일상 이벤트/);
  });

  it('days.fixed 일차가 일생 길이를 넘음', () => {
    const issues = issuesAfter((d) => {
      (d.days.fixed as Record<string, string>)['15'] = 'birthday';
    });
    expectIssue(issues, 'days.fixed.15', /lifeLengthDays/);
  });

  it('freePieces.chain이 chains.json에 없음', () => {
    const issues = issuesAfter((d) => {
      d.events.seasonal[0].effects.freePieces[0].chain = 'no_chain';
    });
    expectIssue(issues, 'events.seasonal[0].effects.freePieces[0].chain', /없는 체인/);
  });

  it('freePieces.tier가 maxTier 초과', () => {
    const issues = issuesAfter((d) => {
      d.events.seasonal[0].effects.freePieces[0].tier = 4;
    });
    expectIssue(issues, 'events.seasonal[0].effects.freePieces[0].tier', /이하/);
  });

  it('chainWeight 키가 chains.json에 없음', () => {
    const issues = issuesAfter((d) => {
      (d.events.daily[2].effects as Record<string, unknown>).chainWeight = { no_chain: 2 };
    });
    expectIssue(issues, 'events.daily[2].effects.chainWeight.no_chain', /없는 체인/);
  });

  it('faceLayerHpReduce는 0~1 비율', () => {
    const issues = issuesAfter((d) => {
      (d.events.milestones[0].choices[1] as Record<string, unknown>).faceLayerHpReduce = 30;
    });
    expectIssue(issues, 'events.milestones[0].choices[1].faceLayerHpReduce', /1 이하/);
  });

  it('이벤트 id 중복 (종류가 달라도)', () => {
    const issues = issuesAfter((d) => {
      d.events.daily[0].id = 'birthday';
    });
    expectIssue(issues, 'events', /중복/);
  });

  it('world 불일치', () => {
    const issues = issuesAfter((d) => {
      d.chains[0].world = 'fantasy';
    });
    expectIssue(issues, 'chains[0].world', /days\.world/);
  });

  it('결말 5종 중 누락', () => {
    const issues = issuesAfter((d) => {
      delete (d.endings.endings as Partial<Raw['endings']['endings']>).hidden;
    });
    expectIssue(issues, 'endings.endings.hidden', /필수 키/);
  });

  it('balance.version ≠ 2', () => {
    const issues = issuesAfter((d) => {
      (d.balance as Record<string, unknown>).version = 1;
    });
    expectIssue(issues, 'balance.version');
  });
});

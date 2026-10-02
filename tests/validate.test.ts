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

  it('M4: abyss.counterRange 필수, weatherThresholds는 오름차순 세 값', () => {
    expectIssue(
      issuesAfter((d) => {
        delete (d.balance.abyss as Partial<Raw['balance']['abyss']>).counterRange;
      }),
      'balance.abyss.counterRange',
      /필수 키/,
    );
    expectIssue(
      issuesAfter((d) => {
        (d.balance.shadow as Record<string, unknown>).weatherThresholds = [50, 25, 75];
      }),
      'balance.shadow.weatherThresholds',
      /오름차순/,
    );
    expectIssue(
      issuesAfter((d) => {
        (d.balance.shadow as Record<string, unknown>).weatherThresholds = [25, 50];
      }),
      'balance.shadow.weatherThresholds',
      /세 값/,
    );
  });

  it('monsters.backflowBoss.hpGrowthPerDay 필수, 0보다 커야 함', () => {
    expectIssue(
      issuesAfter((d) => {
        delete (d.monsters.backflowBoss as Partial<Raw['monsters']['backflowBoss']>).hpGrowthPerDay;
      }),
      'monsters.backflowBoss.hpGrowthPerDay',
      /필수 키/,
    );
    expectIssue(
      issuesAfter((d) => {
        d.monsters.backflowBoss.hpGrowthPerDay = 0;
      }),
      'monsters.backflowBoss.hpGrowthPerDay',
      /이상/,
    );
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

  it('heroes.json: offense = defense면 오류 (양쪽 최소 1명), 없는 영웅 id 오류 (§5.17-1, [11]-3)', () => {
    expectIssue(issuesAfter((d) => (d.heroes.defense = d.heroes.offense)), 'heroes.defense', /다른 영웅/);
    expectIssue(issuesAfter((d) => (d.heroes.offense = 'nobody')), 'heroes.offense', /없는 영웅/);
    expectIssue(issuesAfter((d) => d.heroes.heroes.pop()), 'heroes.heroes', /2개 이상/);
  });

  it('spawnWeight 합이 0이면 오류', () => {
    const issues = issuesAfter((d) => {
      for (const c of d.chains) c.spawnWeight = 0;
    });
    expectIssue(issues, 'chains', /spawnWeight 합/);
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

  it('days.fixed 일차가 chapter.maxDays를 넘음', () => {
    const issues = issuesAfter((d) => {
      (d.days.fixed as Record<string, string>)['21'] = 'first_tooth';
    });
    expectIssue(issues, 'days.fixed.21', /maxDays/);
  });

  it('freePieces.chain이 chains.json에 없음', () => {
    const issues = issuesAfter((d) => {
(d.events.seasonal as unknown[]).push({ id: 'gift', world: d.chapter.world, archetypeId: 'gift', title: '선물', text: '', effects: { freePieces: [{ chain: 'companion_animal', tier: 2 }] }, diaryLine: '선물.' });
      (d.events.seasonal as unknown as { effects: { freePieces: { chain: string }[] } }[])[0].effects.freePieces[0].chain = 'no_chain';
    });
    expectIssue(issues, 'events.seasonal[0].effects.freePieces[0].chain', /없는 체인/);
  });

  it('freePieces.tier가 maxTier 초과', () => {
    const issues = issuesAfter((d) => {
(d.events.seasonal as unknown[]).push({ id: 'gift', world: d.chapter.world, archetypeId: 'gift', title: '선물', text: '', effects: { freePieces: [{ chain: 'companion_animal', tier: 2 }] }, diaryLine: '선물.' });
      (d.events.seasonal as unknown as { effects: { freePieces: { tier: number }[] } }[])[0].effects.freePieces[0].tier = 4;
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
      d.events.daily[0].id = 'first_tooth';
    });
    expectIssue(issues, 'events', /중복/);
  });

  it('world 불일치', () => {
    const issues = issuesAfter((d) => {
      d.chains[0].world = 'fantasy';
    });
    expectIssue(issues, 'chains[0].world', /chapter\.world/);
    expectIssue(issuesAfter((d) => (d.events.daily[0].world = 'modern')), 'events.daily[0].world', /chapter\.world/);
  });

  it('M8.8: balance.chapter (turningPoint < length), days.lifeLengthDays·growthDays·world·age 는 알 수 없는 키', () => {
    expectIssue(issuesAfter((d) => (d.balance.chapter.turningPoint = 10)), 'balance.chapter.turningPoint', /length보다 작아야/);
    expectIssue(issuesAfter((d) => delete (d.balance as Record<string, unknown>).chapter), 'balance.chapter', /필수 키/);
    expectIssue(issuesAfter((d) => (d.balance.chapter.maxDays = 0)), 'balance.chapter.maxDays', /이상/);
    expectIssue(issuesAfter((d) => ((d.balance.days as Record<string, unknown>).lifeLengthDays = 14)), 'balance.days.lifeLengthDays', /알 수 없는 키/);
    for (const k of ['growthDays', 'world', 'age']) {
      expectIssue(issuesAfter((d) => ((d.days as Record<string, unknown>)[k] = 1)), `days.${k}`, /알 수 없는 키/);
    }
  });

  it('M8.8: chapter.json (갈림길 id = 이정표, 장면 이름 length개)·chapter_complete.json (learnedRecipes)', () => {
    expectIssue(issuesAfter((d) => (d.chapter.crossroad = 'scraped_knee')), 'chapter.crossroad', /없는 갈림길/);
    expectIssue(issuesAfter((d) => d.chapter.sceneNames.pop()), 'chapter.sceneNames', /length/);
    expectIssue(issuesAfter((d) => d.chapter.dayScenes.push('하나 더')), 'chapter.dayScenes', /length/);
    expectIssue(issuesAfter((d) => ((d.chapterComplete.learnedRecipes[0] as Record<string, unknown>).side = 'noon')), 'chapterComplete.learnedRecipes[0].side', /day 또는 night/);
    expectIssue(issuesAfter((d) => ((d.chapterComplete as Record<string, unknown>).companions = [])), 'chapterComplete.companions', /알 수 없는 키/);
  });

  it('M8.8: endings.json 삭제 (rawGameData에 없음), 조합법 카드는 조합표에 없다 (표시만, D-043)', () => {
    expect('endings' in rawGameData).toBe(false);
    const recipeIds = rawGameData.recipes.recipes.map((r) => r.id);
    for (const r of rawGameData.chapterComplete.learnedRecipes) expect(recipeIds).not.toContain(r.id);
  });

  it('M8.9: 삭제된 키가 남아 있으면 오류 (growth·night·hero.shineMult·laneCap·returnQueueCap·wavesPerDay·chains.hero, §5.17-5)', () => {
    const b = (d: Raw) => d.balance as unknown as Record<string, Record<string, unknown>>;
    expectIssue(issuesAfter((d) => (b(d).growth = { ageWorryMult: 1.15 } as never)), 'balance.growth', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).night = { nightSeconds: 60 } as never)), 'balance.night', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).hero.shineMult = 1.2)), 'balance.hero.shineMult', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).lane.laneCap = 5)), 'balance.lane.laneCap', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).grid.returnQueueCap = 6)), 'balance.grid.returnQueueCap', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).wave.wavesPerDay = 3)), 'balance.wave.wavesPerDay', /알 수 없는 키/);
    expectIssue(
      issuesAfter((d) => ((d.chains[0] as unknown as Record<string, unknown>).hero = { hp: 1, atk: 1, atkInterval: 1, range: 1 })),
      'chains[0].hero',
      /알 수 없는 키/,
    );
    expectIssue(issuesAfter((d) => delete (d.balance as Record<string, unknown>).offense), 'balance.offense', /필수 키/);
  });

  it('M8.9: 먹이기 tierScore는 maxTier개, 병사 단은 maxTier − 1개, side·buff 값 ([11])', () => {
    expectIssue(issuesAfter((d) => d.balance.feed.tierScore.pop()), 'balance.feed.tierScore', /maxTier/);
    expectIssue(issuesAfter((d) => d.chains[0].soldier.levels.pop()), 'chains[0].soldier.levels', /maxTier − 1/);
    expectIssue(issuesAfter((d) => ((d.chains[0] as unknown as Record<string, unknown>).side = 'noon')), 'chains[0].side', /sun 또는 moon/);
    expectIssue(issuesAfter((d) => ((d.chains[1] as unknown as Record<string, unknown>).buff = 'shield')), 'chains[1].buff', /heal 또는 momentum/);
    expectIssue(issuesAfter((d) => ((d.balance.merge as unknown as Record<string, unknown>).soldiers = 'yes')), 'balance.merge.soldiers', /.+/);
  });

  it('M8.7→: recipes kind (조합 제작은 꺼도 검증은 유지, §5.17-6)', () => {
    expectIssue(issuesAfter((d) => ((d.recipes.recipes[0] as Record<string, unknown>).kind = 'sad')), 'recipes.recipes[0].kind', /.+/);
  });

  it('M6.5: days.quietDays 필수, balance.days.morningJoyFloor는 0 이상 정수', () => {
    const issues = issuesAfter((d) => {
      delete (d.days as Record<string, unknown>).quietDays;
      d.balance.days.morningJoyFloor = 2.5;
    });
    expectIssue(issues, 'days.quietDays', /필수 키/);
    expectIssue(issues, 'balance.days.morningJoyFloor', /정수/);
    expectIssue(
      issuesAfter((d) => (d.balance.days.morningJoyFloor = -1)),
      'balance.days.morningJoyFloor',
      /0 이상/,
    );
  });

  it('M8.5: lane.defenseInterceptRange·defenseMoveSpeed·defenseContact 필수, 0 이상', () => {
    const issues = issuesAfter((d) => {
      delete (d.balance.lane as Record<string, unknown>).defenseMoveSpeed;
      d.balance.lane.defenseInterceptRange = -1;
    });
    expectIssue(issues, 'balance.lane.defenseMoveSpeed', /필수 키/);
    expectIssue(issues, 'balance.lane.defenseInterceptRange', /0 이상/);
  });

  it('balance.version ≠ 2', () => {
    const issues = issuesAfter((d) => {
      (d.balance as Record<string, unknown>).version = 1;
    });
    expectIssue(issues, 'balance.version');
  });
});

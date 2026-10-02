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
      (d.monsters.base as Record<string, unknown>).bossJoyReward = 40;
    });
    expectIssue(issues, 'monsters.base.bossJoyReward', /알 수 없는 키/);
  });

  it('v0.3에서 삭제된 balance.lane.defenseLineY는 알 수 없는 키', () => {
    const issues = issuesAfter((d) => {
      (d.balance.lane as Record<string, unknown>).defenseLineY = 206;
    });
    expectIssue(issues, 'balance.lane.defenseLineY', /알 수 없는 키/);
  });

  it('M8.10: guardian.counterRange 필수, core.hp ≥ 1, carry 배수 > 0', () => {
    expectIssue(
      issuesAfter((d) => {
        delete (d.balance.guardian as Partial<Raw['balance']['guardian']>).counterRange;
      }),
      'balance.guardian.counterRange',
      /필수 키/,
    );
    expectIssue(issuesAfter((d) => (d.balance.core.hp = 0)), 'balance.core.hp', /이상/);
    expectIssue(issuesAfter((d) => (d.balance.carry.speedMult = 0)), 'balance.carry.speedMult', /이상/);
  });

  it('M8.10: monsters.json 종류별 배수, 적 id 중복 금지', () => {
    expectIssue(issuesAfter((d) => delete (d.monsters.enemies[1] as Partial<Raw['monsters']['enemies'][number]>).hpMult), 'monsters.enemies[1].hpMult', /필수 키/);
    expectIssue(issuesAfter((d) => (d.monsters.enemies[1].id = 'shadow')), 'monsters.enemies', /중복/);
    for (const id of ['shadow', 'wildcat', 'mitten', 'boss']) expect(rawGameData.monsters.enemies.map((e) => e.id)).toContain(id);
    const m = (id: string) => rawGameData.monsters.enemies.find((e) => e.id === id)!;
    expect([m('wildcat').speedMult, m('wildcat').hpMult]).toEqual([1.6, 0.6]);
    expect([m('mitten').hpMult, m('mitten').speedMult]).toEqual([2.5, 0.7]);
  });

  it('M8.10: stages.json — chapter.length개, 순서, 필수 문구, 적 id 참조, 1-length는 밤 없음 (§5.19-4)', () => {
    expect(rawGameData.stages.stages).toHaveLength(rawGameData.balance.chapter.length);
    for (const st of rawGameData.stages.stages) {
      for (const k of ['title', 'intro', 'coreName', 'page', 'retryIntro'] as const) expect(st[k].length).toBeGreaterThan(0);
    }
    expect(rawGameData.stages.stages[0].intro).toContain('해 지기 전에 돌아오마');
    expect(rawGameData.stages.stages[9].page).toContain('누이는 해가, 오라비는 달이 되었다');
    expectIssue(issuesAfter((d) => d.stages.stages.pop()), 'stages.stages', /length/);
    expectIssue(issuesAfter((d) => (d.stages.stages[1].stage = 5)), 'stages.stages[1].stage', /순서/);
    expectIssue(issuesAfter((d) => ((d.stages.stages[2] as Record<string, unknown>).page = '')), 'stages.stages[2].page', /비어 있지 않은/);
    expectIssue(issuesAfter((d) => delete (d.stages.stages[2] as Record<string, unknown>).retryIntro), 'stages.stages[2].retryIntro', /필수 키/);
    expectIssue(issuesAfter((d) => (d.stages.stages[0].day.enemies[0].type = 'dragon')), 'stages.stages[0].day.enemies[0].type', /없는 적/);
    expectIssue(issuesAfter((d) => (d.stages.stages[0].night.waves = [])), 'stages.stages[0].night.waves', /하나 이상/);
    expectIssue(issuesAfter((d) => (d.stages.stages[9].night.waves = [[{ type: 'shadow', count: 1 }]])), 'stages.stages[9].night', /밤이 없어야/);
  });

  it('필수 키 없음', () => {
    const issues = issuesAfter((d) => {
      delete (d.balance.lane as Partial<Raw['balance']['lane']>).abyssAdvanceSpeed;
    });
    expectIssue(issues, 'balance.lane.abyssAdvanceSpeed', /필수 키/);
  });

  it('타입 오류', () => {
    const issues = issuesAfter((d) => {
      (d.balance.grid as Record<string, unknown>).maxTier = '5';
    });
    expectIssue(issues, 'balance.grid.maxTier', /숫자/);
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
    expectIssue(issuesAfter((d) => d.heroes.heroes.splice(1)), 'heroes.heroes', /2개 이상/);
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
      (d.events.seasonal as unknown as { effects: { freePieces: { tier: number }[] } }[])[0].effects.freePieces[0].tier = 6;
    });
    expectIssue(issues, 'events.seasonal[0].effects.freePieces[0].tier', /이하/);
  });

  it('chainWeight 키가 chains.json에 없음', () => {
    const issues = issuesAfter((d) => {
      (d.events.daily[2].effects as Record<string, unknown>).chainWeight = { no_chain: 2 };
    });
    expectIssue(issues, 'events.daily[2].effects.chainWeight.no_chain', /없는 체인/);
  });

  it('이벤트 id 중복 (종류가 달라도)', () => {
    const issues = issuesAfter((d) => {
      d.events.daily[0].id = d.events.daily[1].id;
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
    for (const k of ['growthDays', 'world', 'age']) {
      expectIssue(issuesAfter((d) => ((d.days as Record<string, unknown>)[k] = 1)), `days.${k}`, /알 수 없는 키/);
    }
  });

  it('M8.8: chapter.json (갈림길은 D-063에서 삭제 → crossroad는 알 수 없는 키)·chapter_complete.json (learnedRecipes)', () => {
    expectIssue(issuesAfter((d) => ((d.chapter as Record<string, unknown>).crossroad = 'scraped_knee')), 'chapter.crossroad', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => ((d.chapter as Record<string, unknown>).sceneNames = ['a'])), 'chapter.sceneNames', /알 수 없는 키/);
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

  it('M8.10: 일차·gating·그림자 키가 남아 있으면 오류 (maxDays·dailyLimit·storeCap·shadow·diary·stallShadowPerSec, D-054·D-055)', () => {
    const b = (d: Raw) => d.balance as unknown as Record<string, Record<string, unknown>>;
    expectIssue(issuesAfter((d) => (b(d).chapter.maxDays = 20)), 'balance.chapter.maxDays', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).shadow = { shadowMax: 100 } as never)), 'balance.shadow', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).diary = { diarySinkThreshold: 3 } as never)), 'balance.diary', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).offense.stallShadowPerSec = 0.3)), 'balance.offense.stallShadowPerSec', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).start.shadow = 0)), 'balance.start.shadow', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).abyss = { layerHpBase: 120 } as never)), 'balance.abyss', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).wave.wavesPerNight = 3)), 'balance.wave.wavesPerNight', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => ((d.chapterComplete as Record<string, unknown>).notDoneText = '아직')), 'chapterComplete.notDoneText', /알 수 없는 키/);
  });

  it('M8.10: heroes reward (보상 영웅은 시작 배정 불가), chapter.id 필수 (D-057)', () => {
    expectIssue(issuesAfter((d) => (d.heroes.offense = 'nui')), 'heroes.offense', /보상 영웅/);
    expectIssue(issuesAfter((d) => delete (d.chapter as Record<string, unknown>).id), 'chapter.id', /필수 키/);
    expect(rawGameData.heroes.heroes.filter((h) => 'reward' in h).map((h) => h.id)).toEqual(['nui', 'orabi', 'test_a', 'test_b']);
  });

  it('M8.9: 먹이기 tierScore는 maxTier개, 병사 단은 maxTier − 1개, side·buff 값 ([11])', () => {
    expectIssue(issuesAfter((d) => d.chains[0].soldier.levels.pop()), 'chains[0].soldier.levels', /maxTier − 1/);
    expectIssue(issuesAfter((d) => ((d.chains[0] as unknown as Record<string, unknown>).side = 'noon')), 'chains[0].side', /sun 또는 moon/);
    expectIssue(issuesAfter((d) => ((d.chains[1] as unknown as Record<string, unknown>).buff = 'shield')), 'chains[1].buff', /heal 또는 momentum/);
    expectIssue(issuesAfter((d) => ((d.balance.merge as unknown as Record<string, unknown>).soldiers = 'yes')), 'balance.merge.soldiers', /.+/);
  });

  it('M8.7→: recipes kind (조합 제작은 꺼도 검증은 유지, §5.17-6)', () => {
    expectIssue(issuesAfter((d) => ((d.recipes.recipes[0] as Record<string, unknown>).kind = 'sad')), 'recipes.recipes[0].kind', /.+/);
  });

  it('M8.12 (§5.22): 적성 S·A·B, perStar는 스킬 필드·maxStar개, 진급 비용 maxStar−1개, 비법서 종류·얻는 법', () => {
    const h = (d: Raw) => d.heroes.heroes[0] as unknown as Record<string, any>;
    expectIssue(issuesAfter((d) => (h(d).aptitude.day = 'C')), 'heroes.heroes[0].aptitude.day', /S·A·B/);
    expectIssue(issuesAfter((d) => h(d).skill.perStar.mult.pop()), 'heroes.heroes[0].skill.perStar.mult', /maxStar/);
    expectIssue(issuesAfter((d) => (h(d).skill.perStar.radius = [1, 1, 1, 1, 1])), 'heroes.heroes[0].skill.perStar.radius', /없는 값/);
    expectIssue(issuesAfter((d) => d.balance.star.cost.pop()), 'balance.star.cost', /maxStar − 1/);
    const bk = (d: Raw) => d.bookSkills.books[0] as unknown as Record<string, any>;
    expectIssue(issuesAfter((d) => (bk(d).kind = 'gauge')), 'bookSkills.books[0].kind', /start 또는 passive/);
    expectIssue(issuesAfter((d) => (bk(d).source = 'shop')), 'bookSkills.books[0].source', /chapter 또는 perfect/);
    expectIssue(issuesAfter((d) => (bk(d).effect.atkPct = 1)), 'bookSkills.books[0].effect.atkPct', /알 수 없는 키/);
    expect(rawGameData.bookSkills.books.map((b) => b.id)).toEqual(['share_rice_cake', 'sturdy_rope', 'promise_sun_moon']);
  });

  it('M6.5: days.quietDays 필수', () => {
    expectIssue(issuesAfter((d) => delete (d.days as Record<string, unknown>).quietDays), 'days.quietDays', /필수 키/);
  });

  it('M8.11 (§5.20-13, D-064): 기쁨 키가 남아 있으면 오류 (start.joy·spawnCost·releaseRefund·days.morningJoyFloor·joyReward·이벤트 joy)', () => {
    const b = (d: Raw) => d.balance as unknown as Record<string, Record<string, unknown>>;
    expectIssue(issuesAfter((d) => (b(d).start.joy = 60)), 'balance.start.joy', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).grid.spawnCostBase = 10)), 'balance.grid.spawnCostBase', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).grid.spawnCostStep = 2)), 'balance.grid.spawnCostStep', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).grid.releaseRefund = 4)), 'balance.grid.releaseRefund', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => (b(d).days = { morningJoyFloor: 20 })), 'balance.days', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => ((d.monsters.base as unknown as Record<string, unknown>).joyReward = 3)), 'monsters.base.joyReward', /알 수 없는 키/);
    expectIssue(issuesAfter((d) => ((d.events.daily[1].effects as Record<string, unknown>).joy = 15)), 'events.daily[1].effects.joy', /알 수 없는 키/);
  });

  it('M8.11 (§5.20-13): spawn·swarm 필수·범위 (bossDropTier ≤ maxTier, killDropChance 0~1)', () => {
    const b = (d: Raw) => d.balance as unknown as Record<string, Record<string, unknown>>;
    expectIssue(issuesAfter((d) => delete b(d).spawn), 'balance.spawn', /필수 키/);
    expectIssue(issuesAfter((d) => delete b(d).swarm), 'balance.swarm', /필수 키/);
    expectIssue(issuesAfter((d) => (b(d).spawn.killDropChance = 1.5)), 'balance.spawn.killDropChance', /1 이하/);
    expectIssue(issuesAfter((d) => (b(d).spawn.bossDropTier = 6)), 'balance.spawn.bossDropTier', /maxTier/);
    expectIssue(issuesAfter((d) => (b(d).spawn.autoInterval = 0)), 'balance.spawn.autoInterval', /.+/);
    expectIssue(issuesAfter((d) => (b(d).swarm.laneMaxEnemies = 2.5)), 'balance.swarm.laneMaxEnemies', /정수/);
  });

  it('M8.5: lane.defenseInterceptRange·defenseMoveSpeed·defenseContact 필수, 0 이상', () => {
    const issues = issuesAfter((d) => {
      delete (d.balance.lane as Record<string, unknown>).defenseMoveSpeed;
      d.balance.lane.defenseInterceptRange = -1;
    });
    expectIssue(issues, 'balance.lane.defenseMoveSpeed', /필수 키/);
    expectIssue(issues, 'balance.lane.defenseInterceptRange', /0 이상/);
  });

  it('balance.version ≠ 4', () => {
    const issues = issuesAfter((d) => {
      (d.balance as Record<string, unknown>).version = 1;
    });
    expectIssue(issues, 'balance.version');
  });
});

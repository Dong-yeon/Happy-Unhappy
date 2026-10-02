import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, enemyStats, swarmGroups, type CoreEvent } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { WILDCARD, emptyIndices } from '../src/core/grid';
import { mulberry32, parseSeed } from '../src/core/rng';
import { RELEASE, dropTarget, gameGeometry } from '../src/scenes/layout';

const data = structuredClone(rawGameData) as unknown as GameData;
const DOG = 'companion_animal';

function game(seed = 1, cols = 4, rows = 4): GameState {
  const g = new GameState(data, { cols, rows }, mulberry32(seed), gameGeometry(data.balance.merge.soldierCap + data.balance.team.teamSize));
  // 1-1 장면 카드를 닫고 낮 시작
  g.confirmDay();
  return g;
}

// §5.20-13 (D-064): 기쁨·[조각 생성] 삭제 → 조각은 전투 중 저절로 + 처치 드롭, 몬스터 떼, 스킬 자동/수동, 놓아주기는 환급 없음
const SP = data.balance.spawn;
const SW = data.balance.swarm;
const ticks = (g: GameState, seconds: number) => {
  const out: CoreEvent[] = [];
  for (let k = 0; k < Math.round(seconds / FIXED_DT); k++) out.push(...g.tick(FIXED_DT));
  return out;
};
const pieces = (es: CoreEvent[]) => es.filter((e): e is Extract<CoreEvent, { type: 'piece' }> => e.type === 'piece');
/** 적·반격 없는 데이터 (조각 규칙만 보려고) */
function calm(d: GameData): void {
  for (const st of d.stages.stages) {
    st.day.enemies = [];
    st.day.chase = [];
  }
  d.balance.guardian.counterAtk = 0;
  for (const st of d.stages.stages) st.day.guardianHp = 1e9;
}
function gameWith(edit: (d: GameData) => void, seed = 1, cols = 4, rows = 4): GameState {
  const d = structuredClone(data);
  edit(d);
  const g = new GameState(d, { cols, rows }, mulberry32(seed), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize));
  g.confirmDay();
  return g;
}

describe('GameState — 조각이 생기는 길 (§5.20-13)', () => {
  it('기쁨·생성 API가 없다 (joy·spawn·spawnCost)', () => {
    const g = game();
    for (const k of ['joy', 'spawn', 'spawnCost', 'spawnBlock', 'debugAddJoy', 'releasePreview']) expect(k in g).toBe(false);
    expect('joy' in data.balance.start).toBe(false);
  });

  it(`저절로: 전투 중 ${SP.autoInterval}초마다 빈 칸에 1단계 1개 (체인 = 지금 팀 체인)`, () => {
    const g = gameWith(calm);
    expect(pieces(ticks(g, SP.autoInterval - 0.05))).toHaveLength(0);
    const es = pieces(ticks(g, 0.1));
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ source: 'auto', from: null });
    expect(es[0].index).not.toBeNull();
    expect(g.grid.cells[es[0].index!]).toMatchObject({ tier: 1, chain: 'bone' });
    expect(pieces(ticks(g, SP.autoInterval * 3))).toHaveLength(3);
    expect(g.stats.piecesAuto).toBe(4);
  });

  it('전투 밖(장면 카드)에서는 시간이 흐르지 않아 생기지 않는다', () => {
    const d = structuredClone(data);
    const g = new GameState(d, { cols: 4, rows: 4 }, mulberry32(1), gameGeometry(d.balance.merge.soldierCap + d.balance.team.teamSize));
    for (let k = 0; k < 600; k++) g.tick(FIXED_DT);
    expect(g.grid.cells.every((c) => c === null)).toBe(true);
  });

  it('그리드가 가득이면 버림 (piecesDiscarded, 이벤트 index null)', () => {
    const g = gameWith(calm);
    // 2~4단계만 (1단계 둘은 자동 뭉침으로 합쳐져 칸이 빈다, D-070)
    for (let i = 0; i < g.grid.cells.length; i++) g.grid.cells[i] = g.newPiece(DOG, (i % 3) + 2);
    const before = JSON.stringify(g.grid.cells);
    const es = pieces(ticks(g, SP.autoInterval + 0.05));
    expect(es).toHaveLength(1);
    expect(es[0].index).toBeNull();
    expect(JSON.stringify(g.grid.cells)).toBe(before);
    expect(g.stats.piecesDiscarded).toBe(1);
    expect(g.attemptStats.discarded).toBe(1);
  });

  it(`처치: ${SP.killDropChance * 100}% 확률로 1단계 1개 (처치 지점에서), 시드 고정이면 재현`, () => {
    const run = (seed: number) => {
      const g = gameWith((d) => (d.balance.spawn.autoInterval = 1e6), seed, 5, 4);
      const es = ticks(g, 40);
      const kills = es.filter((e) => e.type === 'enemyDie').length;
      return { kills, drops: pieces(es).filter((p) => p.source === 'drop'), g };
    };
    const a = run(3);
    expect(a.kills).toBeGreaterThan(0);
    expect(run(3).drops.length).toBe(a.drops.length);
    for (const p of a.drops) {
      expect(p.piece.tier).toBe(1);
      expect(p.from).toMatchObject({ role: 'offense' });
    }
    // 여러 판 합산 비율 ≈ killDropChance
    let kills = 0;
    let drops = 0;
    for (let s = 1; s <= 12; s++) {
      const r = run(s);
      kills += r.kills;
      drops += r.drops.length;
    }
    expect(drops / kills).toBeGreaterThan(SP.killDropChance * 0.5);
    expect(drops / kills).toBeLessThan(SP.killDropChance * 1.6);
  });

  it(`guardian 처치 = ${SP.bossDropTier}단계 ${SP.bossDropCount}개 확정`, () => {
    const g = gameWith((d) => {
      calm(d);
      d.balance.spawn.autoInterval = 1e6;
    });
    ticks(g, 2);
    g.debugKillGuardian();
    const es = pieces(g.tick(FIXED_DT));
    expect(es).toHaveLength(SP.bossDropCount);
    for (const p of es) expect(p).toMatchObject({ source: 'boss', piece: { tier: SP.bossDropTier } });
  });

  it('밤 보스 웨이브 적 처치도 확정 드롭 (보스는 hp × 1)', () => {
    const g = gameWith((d) => (d.balance.spawn.autoInterval = 1e6), 1, 5, 4);
    g.debugSetStage(1);
    g.debugToNight();
    g.defense.worries.length = 0;
    const boss = g.defense.spawnWorry({ ...enemyStats(data, 'mitten', 5, false), boss: true }, 80, []);
    expect(boss.hp).toBeCloseTo(enemyStats(data, 'mitten', 5, false).hp, 9);
    boss.hp = 0;
    const es = pieces(g.tick(FIXED_DT));
    expect(es.filter((p) => p.source === 'boss')).toHaveLength(SP.bossDropCount);
  });
});

describe('GameState — 몬스터 떼 (§5.20-13)', () => {
  it(`스테이지 적 수 × ${SW.countMult} (낮 무리·추격·밤 웨이브), 보스 웨이브는 그대로`, () => {
    const st = data.stages.stages[0];
    const n = (gs: { count: number }[]) => gs.reduce((a, x) => a + Math.max(1, Math.round(x.count * SW.countMult)), 0);
    const g = gameWith(() => {});
    expect(g.abyss.enemies.length + g.abyss.roadQueue.length).toBe(n(st.day.enemies));
    expect(g.abyss.chaseQueue.length).toBe(n(st.day.chase));
    g.debugToNight();
    expect(g.wave.waves.map((w) => w.enemies.length)).toEqual(st.night.waves.map((w) => n(w)));
    const s5 = data.stages.stages[4];
    expect(swarmGroups(data, s5.night.bossWave!)[0].count).toBe(Math.round(s5.night.bossWave![0].count * SW.countMult)); // 함수는 곱한다
    const g5 = gameWith(() => {});
    g5.debugFail();
    g5.debugSetStage(5);
    g5.confirmDay();
    g5.debugToNight();
    expect(g5.wave.waves[g5.wave.waves.length - 1]).toMatchObject({ boss: true, enemies: ['mitten'] });
  });

  it(`레인 동시 적 최대 ${SW.laneMaxEnemies}: 넘으면 대기열 → 자리가 나면 나온다 (낮·밤)`, () => {
    const g = gameWith((d) => {
      d.stages.stages[0].day.enemies = [{ type: 'shadow', count: 20 }]; // × 3 = 60
    });
    expect(g.abyss.enemies).toHaveLength(SW.laneMaxEnemies);
    expect(g.abyss.roadQueue).toHaveLength(60 - SW.laneMaxEnemies);
    g.abyss.enemies.splice(0, 5);
    g.tick(FIXED_DT);
    expect(g.abyss.enemies.length).toBeLessThanOrEqual(SW.laneMaxEnemies);
    expect(g.abyss.roadQueue.length).toBeLessThan(60 - SW.laneMaxEnemies);

    const n = gameWith((d) => {
      d.stages.stages[0].night.waves = [[{ type: 'shadow', count: 20 }]];
      d.balance.wave.spawnInterval = 0.01;
      d.balance.lane.defenseInterceptRange = 0;
    });
    n.debugToNight();
    n.defense.happy.atk = 0;
    n.defense.units.length = 0;
    let maxSeen = 0;
    for (let k = 0; k < 60 * 6; k++) {
      n.tick(FIXED_DT);
      maxSeen = Math.max(maxSeen, n.defense.worries.length);
    }
    expect(maxSeen).toBe(SW.laneMaxEnemies);
    expect(n.nightQueued).toBeGreaterThan(0);
  });
});

describe('GameState — 스킬 자동/수동 (§5.20-13)', () => {
  /** 낮에 레인에 있는 삽살의 게이지를 가득 채우기 직전으로 */
  function nearFull(g: GameState): void {
    const p = g.progressOf('sapsal');
    p.gauge = g.heroDef('sapsal').skill.gauge - 1;
  }
  const mergeBone = (g: GameState, tier: number) => {
    g.grid.cells.fill(null);
    g.grid.cells[0] = g.newPiece('bone', tier);
    g.grid.cells[1] = g.newPiece('bone', tier);
    expect(g.drop(0, 1)).toBe('merge');
  };
  const skills = (es: CoreEvent[]) => es.filter((e) => e.type === 'skill');

  it('기본 자동: 게이지가 차면 바로 발동하고 0', () => {
    const g = gameWith(calm);
    expect(g.autoSkill).toBe(true);
    nearFull(g);
    mergeBone(g, 2); // 결과 3단계 = +7
    expect(skills(g.tick(0))).toHaveLength(1);
    expect(g.progressOf('sapsal').gauge).toBe(0);
  });

  it('수동: 가득 차도 기다림 → castReady로 발동 (탭), 레인에 없거나 덜 찼으면 false', () => {
    const g = gameWith(calm);
    g.setAutoSkill(false);
    expect(g.tick(0).some((e) => e.type === 'autoSkill' && !e.on)).toBe(true);
    expect(g.castReady('sapsal')).toBe(false); // 게이지 0
    nearFull(g);
    mergeBone(g, 2);
    expect(skills(g.tick(0))).toHaveLength(0);
    expect(g.skillReady('sapsal')).toBe(true);
    ticks(g, 1);
    expect(g.skillReady('sapsal')).toBe(true); // 틱이 지나도 저절로 안 나감
    expect(g.castReady('sapsal')).toBe(true);
    expect(skills(g.tick(0))).toHaveLength(1);
    expect(g.progressOf('sapsal').gauge).toBe(0);
    expect(g.castReady('haetae')).toBe(false); // 레인에 없음
  });

  it('수동 → 자동 전환: 찬 게이지는 다음 틱에 발동', () => {
    const g = gameWith(calm);
    g.setAutoSkill(false);
    nearFull(g);
    mergeBone(g, 2);
    g.setAutoSkill(true);
    expect(skills(g.tick(FIXED_DT))).toHaveLength(1);
  });

  it('5단계 머지는 수동 모드에서도 즉시 발동', () => {
    const g = gameWith(calm);
    g.setAutoSkill(false);
    mergeBone(g, 4);
    expect(skills(g.tick(0))).toHaveLength(1);
  });
});

describe('GameState — 놓아주기 (환급 없음)', () => {
  it('놓아주기: 조각 제거 + 와일드카드 무시', () => {
    const g = game();
    g.grid.cells.fill(null);
    g.grid.cells[0] = g.newPiece(DOG, 2);
    g.grid.cells[1] = g.newPiece(WILDCARD, 0);
    expect(g.release(0)).toBe(true);
    expect(g.release(1)).toBe(false);
    expect(g.release(2)).toBe(false);
    expect(emptyIndices(g.grid)).not.toContain(1);
    expect(g.grid.cells[0]).toBeNull();
  });

  it('놓아주기 영역에 드롭 → dropTarget release', () => {
    const g = game();
    expect(dropTarget(g.grid, RELEASE.x, RELEASE.y)).toEqual({ kind: 'release' });
  });

  it('와일드카드는 tier 0으로 만든다', () => {
    const g = game();
    const i = g.debugGrant(WILDCARD, 3)!;
    expect(g.grid.cells[i]!.tier).toBe(0);
  });
});

describe('rng', () => {
  it('mulberry32: 같은 시드 같은 수열, [0,1)', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('parseSeed', () => {
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed(null)).toBeNull();
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('abc')).toBeNull();
    expect(parseSeed('1.5')).toBeNull();
  });
});

// 밤(디펜스) 웨이브 (스펙 §5.19-3·3-5). 구성은 stages.json night 그대로 — 낮 결과와 무관 (D-055).
// 웨이브마다 적 묶음({type, count}[])을 종류별로 번갈아 한 줄로 세워 spawnInterval 간격으로 내보낸다.
// bossWave가 있으면 일반 웨이브 다음에 마지막 웨이브로 온다 (그 적은 boss = 핵 피해 bossSinkDamage).
//
// 흐름: idle → (start) → delay → spawning → clearing → gap → spawning … → 마지막 clearing → done

import type { EnemyGroup } from '../data/types';

const EPS = 1e-9;

export interface WaveTiming {
  spawnInterval: number;
  waveGap: number;
  nightStartDelay: number;
}

/** 적 묶음 → 종류 id 줄 (종류별로 하나씩 번갈아: [그림자 3, 살쾡이 2] → 그·살·그·살·그) */
export function interleave(groups: readonly EnemyGroup[]): string[] {
  const left = groups.map((g) => g.count);
  const out: string[] = [];
  for (let more = true; more; ) {
    more = false;
    groups.forEach((g, i) => {
      if (left[i] > 0) {
        out.push(g.type);
        left[i] -= 1;
        more = true;
      }
    });
  }
  return out;
}

/** 한 웨이브: 나올 적 종류 순서 + 보스 웨이브인지 */
export interface NightWave {
  enemies: string[];
  boss: boolean;
}

/**
 * idle: 밤이 시작되지 않음 / delay: 첫 웨이브 전 / spawning: 등장 중 / clearing: 다 나왔고 남은 적 대기 /
 * gap: 다음 웨이브까지 / done: 마지막 웨이브까지 끝남
 */
export type WavePhase = 'idle' | 'delay' | 'spawning' | 'clearing' | 'gap' | 'done';

export class NightWaves {
  /** 오늘 밤 웨이브 (일반 + 보스) */
  waves: NightWave[] = [];
  /** 지금(또는 다음) 웨이브 번호 */
  slot = 0;
  phase: WavePhase = 'idle';
  /** delay·gap: 다음 웨이브까지 / spawning: 다음 등장까지 남은 시간 */
  timer = 0;
  spawned = 0;
  /** 디버그: 웨이브 진행(등장·간격)만 멈춘다. 이미 나온 적은 계속 움직임 */
  paused = false;

  constructor(private readonly cfg: WaveTiming) {}

  /** 밤 시작: 스테이지의 웨이브 구성으로 */
  start(waves: readonly EnemyGroup[][], bossWave?: readonly EnemyGroup[]): void {
    this.waves = waves.map((w) => ({ enemies: interleave(w), boss: false }));
    if (bossWave && bossWave.length) this.waves.push({ enemies: interleave(bossWave), boss: true });
    this.slot = 0;
    this.spawned = 0;
    this.phase = this.waves.length ? 'delay' : 'done';
    this.timer = this.cfg.nightStartDelay;
  }

  /** 밤이 끝남 (실패·새벽) */
  stop(): void {
    this.phase = 'idle';
    this.waves = [];
  }

  get waveCount(): number {
    return this.waves.length;
  }

  /** 지금 진행 중인 웨이브가 보스 웨이브 */
  get isBoss(): boolean {
    return this.active && (this.waves[this.slot]?.boss ?? false);
  }

  /** 웨이브가 진행 중 (적이 나오는 중이거나 남아 있음) */
  get active(): boolean {
    return this.phase === 'spawning' || this.phase === 'clearing';
  }

  /** 이번 웨이브 적 수 */
  get count(): number {
    return this.waves[this.slot]?.enemies.length ?? 0;
  }

  /** 디버그: 대기·간격 중이면 다음 웨이브를 바로 시작 */
  startNext(): void {
    if (this.phase === 'delay' || this.phase === 'gap') this.timer = 0;
  }

  /**
   * 한 틱. 이번 틱에 등장시킬 적 (종류 id, 보스 여부)를 돌려준다.
   * fieldEmpty: 방어 레인에 적이 하나도 없는지 (웨이브 종료 판정)
   */
  step(dt: number, fieldEmpty: boolean): { type: string; boss: boolean }[] {
    if (this.paused || this.phase === 'idle' || this.phase === 'done') return [];
    if (this.phase === 'delay' || this.phase === 'gap') {
      this.timer -= dt;
      if (this.timer > EPS) return [];
      this.phase = 'spawning';
      this.spawned = 0;
      this.timer = 0;
    }
    if (this.phase === 'clearing') {
      if (!fieldEmpty) return [];
      if (this.slot + 1 < this.waves.length) {
        this.slot += 1;
        this.phase = 'gap';
        this.timer = this.cfg.waveGap;
      } else {
        this.phase = 'done';
      }
      return [];
    }
    // spawning: 첫 마리는 시작 틱에, 이후 틱마다 시간을 빼고 0 이하가 될 때마다 한 마리씩
    const wave = this.waves[this.slot];
    const out: { type: string; boss: boolean }[] = [];
    if (this.spawned > 0) this.timer -= dt;
    while (this.spawned < wave.enemies.length && this.timer <= EPS) {
      out.push({ type: wave.enemies[this.spawned], boss: wave.boss });
      this.spawned += 1;
      this.timer += this.cfg.spawnInterval;
    }
    if (this.spawned >= wave.enemies.length) this.phase = 'clearing';
    return out;
  }
}

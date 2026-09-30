// M3 임시 웨이브 (스펙 §4.3.1). M5에서 하루 구조(아침·낮·저녁)로 교체한다.
// 웨이브 n: 걱정 countBase + countStep × (n-1)마리, spawnInterval 간격, HP = hpBase × hpGrowthPerDay^(n-1).
// 모든 걱정이 처치·가라앉으면 waveGap초 후 다음 웨이브. 무한 반복.

/** 게임 시작 후 첫 웨이브까지 (M3 임시 값, M5에서 하루 흐름으로 교체) */
export const M3_FIRST_WAVE_DELAY = 2;
const EPS = 1e-9;

export interface WaveConfig {
  countBase: number;
  countStep: number;
  spawnInterval: number;
  waveGap: number;
  hpBase: number;
  hpGrowthPerDay: number;
}

export function waveCount(cfg: WaveConfig, n: number): number {
  return Math.max(0, Math.floor(cfg.countBase + cfg.countStep * (n - 1)));
}

export function waveHp(cfg: WaveConfig, n: number): number {
  return cfg.hpBase * Math.pow(cfg.hpGrowthPerDay, n - 1);
}

/** waiting: 첫 웨이브 전 / spawning: 등장 중 / clearing: 다 나왔고 남은 걱정 대기 / gap: 다음 웨이브까지 */
export type WavePhase = 'waiting' | 'spawning' | 'clearing' | 'gap';

export class WaveRunner {
  /** 현재 웨이브 번호 (0 = 아직 시작 전) */
  n = 0;
  phase: WavePhase = 'waiting';
  /** waiting·gap: 다음 웨이브까지 남은 시간 / spawning: 다음 등장까지 남은 시간 */
  timer: number;
  spawned = 0;
  /** 디버그: 웨이브 진행(등장·간격)만 멈춘다. 이미 나온 걱정은 계속 움직임 */
  paused = false;

  constructor(
    private readonly cfg: WaveConfig,
    startDelay = M3_FIRST_WAVE_DELAY,
  ) {
    this.timer = startDelay;
  }

  get count(): number {
    return waveCount(this.cfg, this.n);
  }

  get hp(): number {
    return waveHp(this.cfg, this.n);
  }

  /** 다음 웨이브 즉시 시작 (디버그 "다음 웨이브" 포함). 첫 걱정은 이번 틱에 나온다 */
  startNext(): void {
    this.n += 1;
    this.phase = 'spawning';
    this.spawned = 0;
    this.timer = 0;
  }

  /**
   * 한 틱 (§4.3.1 처리 순서 1단계). 이번 틱에 등장시킬 걱정 수를 돌려준다.
   * fieldEmpty: 레인에 걱정이 하나도 없는지 (웨이브 종료 판정)
   */
  step(dt: number, fieldEmpty: boolean): number {
    if (this.paused) return 0;
    if (this.phase === 'waiting' || this.phase === 'gap') {
      this.timer -= dt;
      if (this.timer > EPS) return 0;
      this.startNext();
    }
    if (this.phase === 'clearing') {
      if (fieldEmpty) {
        this.phase = 'gap';
        this.timer = this.cfg.waveGap;
      }
      return 0;
    }
    // spawning
    let spawns = 0;
    const count = this.count;
    // 첫 마리는 시작 틱에. 이후 틱마다 시간을 빼고 0 이하가 될 때마다 한 마리씩
    if (this.spawned > 0) this.timer -= dt;
    while (this.spawned < count && this.timer <= EPS) {
      this.spawned += 1;
      spawns += 1;
      this.timer += this.cfg.spawnInterval;
    }
    if (this.spawned >= count) this.phase = 'clearing';
    return spawns;
  }
}

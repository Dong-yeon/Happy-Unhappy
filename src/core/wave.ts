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
  /**
   * HP 성장에 쓰는 단계: 웨이브 번호 → 레벨. 기본은 웨이브 번호 그대로 (M3 임시: 웨이브 = 일차).
   * 시뮬레이터 --dayMode m5는 일차(⌈n / wavesPerDay⌉)로 바꿔 끼운다. M5에서 하루 구조로 교체.
   */
  hpLevel: (n: number) => number = (n) => n;
  /**
   * 역류 보스 웨이브 (§4.3.2). bossPending이면 다음 웨이브 시작 때 보스 웨이브를 끼워 넣는다.
   * 보스 웨이브는 일반 웨이브 번호 n을 올리지 않는다 (보스 뒤에 원래 다음 웨이브가 이어짐).
   */
  bossPending = false;
  /** 지금 진행 중인 웨이브가 보스 웨이브인지 */
  isBoss = false;
  /**
   * 보스 HP 성장에 쓰는 일차. 인자 n = 보스 직전까지 시작한 일반 웨이브 번호 (보스는 웨이브 n+1 자리 앞에 끼어든다).
   * M4 무한 웨이브는 하루 구조가 없으므로 항상 1일차. 시뮬 --dayMode m5는 ⌈(n+1) / wavesPerDay⌉로 바꿔 끼운다.
   */
  bossDayOf: (n: number) => number = () => 1;

  /** 이번 보스(또는 다음 보스)의 일차 */
  get bossDay(): number {
    return this.bossDayOf(this.n);
  }

  constructor(
    private readonly cfg: WaveConfig,
    startDelay = M3_FIRST_WAVE_DELAY,
  ) {
    this.timer = startDelay;
  }

  get count(): number {
    return this.isBoss ? 1 : waveCount(this.cfg, this.n);
  }

  /** 웨이브가 진행 중 (걱정이 나오는 중이거나 남아 있음). Unhappy 멈춤 판정에 쓴다 */
  get active(): boolean {
    return this.phase === 'spawning' || this.phase === 'clearing';
  }

  get hp(): number {
    return waveHp(this.cfg, this.hpLevel(this.n));
  }

  /** 다음 웨이브 즉시 시작 (디버그 "다음 웨이브" 포함). 첫 걱정은 이번 틱에 나온다 */
  startNext(): void {
    this.n += 1;
    this.isBoss = false;
    this.phase = 'spawning';
    this.spawned = 0;
    this.timer = 0;
  }

  /** 보스 웨이브 시작 (웨이브 번호 유지) */
  private startBoss(): void {
    this.bossPending = false;
    this.isBoss = true;
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
      if (this.bossPending) this.startBoss();
      else this.startNext();
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

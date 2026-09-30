// 하루 3웨이브 (스펙 §5.1, §5.7). M3·M4의 무한 웨이브를 대체한다.
// 일차 d의 웨이브: 걱정 round((countBase + countStep × (d-1)) × worryMultiplier)마리(최소 1), spawnInterval 간격,
// HP = hpBase × hpGrowthPerDay^(d-1) × worryMultiplier. 웨이브 칸 하나는 역류 보스로 교체될 수 있다 (D-021).
//
// 흐름: idle → (startDay) → delay → spawning → clearing → gap → spawning … → 저녁 clearing → done
//   delay: 첫 웨이브 전 dayStartDelay초 (전날 넘어온 역류면 bossPrepSeconds초 준비 시간)

const EPS = 1e-9;

export type SlotId = 'morning' | 'noon' | 'evening';
export const SLOT_IDS: readonly SlotId[] = ['morning', 'noon', 'evening'];

export interface WaveConfig {
  wavesPerDay: number;
  countBase: number;
  countStep: number;
  spawnInterval: number;
  waveGap: number;
  dayStartDelay: number;
  bossPrepSeconds: number;
  hpBase: number;
  hpGrowthPerDay: number;
}

/** 일차·배율 → 한 웨이브의 걱정 수 (최소 1) */
export function waveCount(cfg: WaveConfig, day: number, mult = 1): number {
  return Math.max(1, Math.round((cfg.countBase + cfg.countStep * (day - 1)) * mult));
}

/** 일차·배율 → 걱정 HP */
export function waveHp(cfg: WaveConfig, day: number, mult = 1): number {
  return cfg.hpBase * Math.pow(cfg.hpGrowthPerDay, day - 1) * mult;
}

/**
 * idle: 하루가 시작되지 않음 / delay: 첫 웨이브 전 / spawning: 등장 중 / clearing: 다 나왔고 남은 걱정 대기 /
 * gap: 다음 웨이브까지 / done: 저녁 웨이브까지 끝남
 */
export type WavePhase = 'idle' | 'delay' | 'spawning' | 'clearing' | 'gap' | 'done';

export class DayWaves {
  day = 1;
  /** 그날 걱정 수·HP 배율 (이벤트 worryMultiplier) */
  mult = 1;
  /** 지금(또는 다음) 웨이브 칸 번호 0 ~ wavesPerDay-1 */
  slot = 0;
  phase: WavePhase = 'idle';
  /** delay·gap: 다음 웨이브까지 / spawning: 다음 등장까지 남은 시간 */
  timer = 0;
  spawned = 0;
  /** 디버그: 웨이브 진행(등장·간격)만 멈춘다. 이미 나온 걱정은 계속 움직임 */
  paused = false;
  /** 오늘 역류 보스로 교체된 칸 */
  readonly bossSlots = new Set<number>();
  /** 오늘 아침이 전날 넘어온 역류 (준비 시간 bossPrepSeconds) */
  prepMorning = false;

  constructor(private readonly cfg: WaveConfig) {}

  get wavesPerDay(): number {
    return this.cfg.wavesPerDay;
  }

  /** 하루 시작: 첫 웨이브 전 대기. carriedBoss면 아침이 보스이고 대기 = 준비 시간 */
  startDay(day: number, mult: number, carriedBoss: boolean): void {
    this.day = day;
    this.mult = mult;
    this.slot = 0;
    this.spawned = 0;
    this.bossSlots.clear();
    this.prepMorning = carriedBoss;
    if (carriedBoss) this.bossSlots.add(0);
    this.phase = 'delay';
    this.timer = carriedBoss ? this.cfg.bossPrepSeconds : this.cfg.dayStartDelay;
  }

  get slotId(): SlotId {
    return SLOT_IDS[Math.min(this.slot, SLOT_IDS.length - 1)];
  }

  /** 지금 진행 중인 웨이브가 보스 웨이브 */
  get isBoss(): boolean {
    return this.active && this.bossSlots.has(this.slot);
  }

  /** 웨이브가 진행 중 (걱정이 나오는 중이거나 남아 있음). Unhappy 멈춤 판정 */
  get active(): boolean {
    return this.phase === 'spawning' || this.phase === 'clearing';
  }

  /** 준비 시간 중 (전날 넘어온 역류의 아침 보스 전) */
  get inBossPrep(): boolean {
    return this.phase === 'delay' && this.prepMorning;
  }

  get count(): number {
    return this.bossSlots.has(this.slot) ? 1 : waveCount(this.cfg, this.day, this.mult);
  }

  get hp(): number {
    return waveHp(this.cfg, this.day, this.mult);
  }

  /** 아직 시작하지 않은 오늘의 다음 웨이브 칸. 없으면 null (저녁 도중·이후) */
  nextSlot(): number | null {
    if (this.phase === 'delay' || this.phase === 'gap') return this.slot;
    if (this.phase === 'spawning' || this.phase === 'clearing') {
      return this.slot + 1 < this.cfg.wavesPerDay ? this.slot + 1 : null;
    }
    return null;
  }

  /** 웨이브 칸을 보스로 교체 (하루는 항상 wavesPerDay웨이브) */
  markBoss(slot: number): void {
    this.bossSlots.add(slot);
  }

  /** 디버그: 대기·간격 중이면 다음 웨이브를 바로 시작 */
  startNext(): void {
    if (this.phase === 'delay' || this.phase === 'gap') this.timer = 0;
  }

  /**
   * 한 틱 (처리 순서 1단계). 이번 틱에 등장시킬 수를 돌려준다.
   * fieldEmpty: 방어 레인에 걱정이 하나도 없는지 (웨이브 종료 판정)
   */
  step(dt: number, fieldEmpty: boolean): number {
    if (this.paused || this.phase === 'idle' || this.phase === 'done') return 0;
    if (this.phase === 'delay' || this.phase === 'gap') {
      this.timer -= dt;
      if (this.timer > EPS) return 0;
      this.phase = 'spawning';
      this.spawned = 0;
      this.timer = 0;
    }
    if (this.phase === 'clearing') {
      if (!fieldEmpty) return 0;
      if (this.slot + 1 < this.cfg.wavesPerDay) {
        this.slot += 1;
        this.phase = 'gap';
        this.timer = this.cfg.waveGap;
      } else {
        this.phase = 'done';
      }
      return 0;
    }
    // spawning: 첫 마리는 시작 틱에, 이후 틱마다 시간을 빼고 0 이하가 될 때마다 한 마리씩
    let spawns = 0;
    const count = this.count;
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

// 방어 레인 표시: 걱정·방어 유닛 + 흐름 연출 (§4.2.1, §4.3.1).
// 상태는 항상 core에서 읽는다. 이벤트는 연출(처치 빛 점, 가라앉음, 소멸)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { Unit, Worry } from '../core/lane';
import type { Chain } from '../data/types';
import { DEFENSE_UNIT_Y, PORTAL, REGION } from './layout';
import { text } from './ui';

const WORRY_R = 8;
const BOSS_R = 13;
const BOSS_COLOR = 0xc0506a;
/** 걱정은 방어선 위에 발을 딛도록 중심을 이만큼 올려 그린다 */
const WORRY_DRAW_OFFSET_Y = -9;
const UNIT_SIZE = 16;
const WORRY_COLOR = 0x9b7fb8;
const JOY_DOT_COLOR = 0xf2c94c;
const HP_BAR_W = 16;

const SUMMON_MS = 250; // 조각 → 창문 → 슬롯
const JOY_DOT_MS = 400; // 처치 지점 → 창문 → HUD 기쁨
const SINK_MS = 400; // 거울 쪽으로 흘러감 → 그림자 벽에 흡수 (각 구간)

interface HpView {
  container: Phaser.GameObjects.Container;
  bar: Phaser.GameObjects.Rectangle;
}

/** 가라앉음 흐름의 도착점 (심연 레인의 그림자 벽) */
export interface SinkTarget {
  point(): { x: number; y: number };
  /** 벽에 흡수된 순간 (벽이 잠깐 부풀어 오름) */
  onAbsorb(): void;
}

export class DefenseLaneView {
  private readonly worries = new Map<number, HpView>();
  private readonly units = new Map<number, HpView>();
  private readonly chainColor = new Map<string, number>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
    private readonly joyTarget: { x: number; y: number },
    private readonly sinkTarget: SinkTarget,
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
  }

  /** 소환 연출: 드롭 지점 → ☀ 창문 포탈 → 슬롯. core에서는 이미 전투 중 */
  onSummon(unit: Unit, fromX: number, fromY: number): void {
    const v = this.makeUnit(unit);
    v.container.setPosition(fromX, fromY).setDepth(15);
    this.scene.tweens.chain({
      targets: v.container,
      tweens: [
        { x: PORTAL.happy.x, y: PORTAL.happy.y, scale: 0.6, duration: SUMMON_MS / 2, ease: 'Sine.easeIn' },
        { x: unit.x, y: DEFENSE_UNIT_Y, scale: 1, duration: SUMMON_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => v.container.setDepth(3),
    });
  }

  /** core 이벤트 → 연출. sync() 전에 호출 (사라질 표시의 마지막 위치를 쓰기 위해) */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'worryDie': {
          this.removeWorry(e.worryId);
          this.joyDot(e.x, e.y + WORRY_DRAW_OFFSET_Y);
          break;
        }
        case 'sink': {
          const v = this.worries.get(e.worryId);
          this.worries.delete(e.worryId);
          if (v) this.sinkAway(v.container);
          break;
        }
        case 'unitDie':
          this.removeUnit(e.unitId);
          break;
        default:
          break;
      }
    }
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const lane = this.state.defense;
    const liveW = new Set<number>();
    for (const w of lane.worries) {
      liveW.add(w.id);
      const v = this.worries.get(w.id) ?? this.makeWorry(w);
      v.container.setPosition(w.x, w.y + WORRY_DRAW_OFFSET_Y);
      setHp(v, w.hp, w.maxHp);
    }
    for (const id of [...this.worries.keys()]) if (!liveW.has(id)) this.removeWorry(id);

    const liveU = new Set<number>();
    for (const u of lane.units) {
      liveU.add(u.id);
      const v = this.units.get(u.id) ?? this.makeUnit(u);
      setHp(v, u.hp, u.maxHp);
    }
    for (const id of [...this.units.keys()]) if (!liveU.has(id)) this.removeUnit(id);
  }

  private makeWorry(w: Worry): HpView {
    // 역류 보스: 크고 붉게
    const r = w.boss ? BOSS_R : WORRY_R;
    const body = this.scene.add.circle(0, 0, r, w.boss ? BOSS_COLOR : WORRY_COLOR).setStrokeStyle(w.boss ? 2 : 1, 0x3b2d4a);
    const face = text(this.scene, 0, 0, w.boss ? '!' : '~', { fontSize: w.boss ? '13px' : '9px', color: '#2a1f35', fontStyle: 'bold' }).setOrigin(0.5);
    const { bg, bar } = this.hpBar(-r - 4);
    const container = this.scene.add.container(w.x, w.y, [body, face, bg, bar]).setDepth(4);
    const v = { container, bar };
    this.worries.set(w.id, v);
    return v;
  }

  private makeUnit(u: Unit): HpView {
    const maxTier = this.state.grid.maxTier;
    const fill = this.chainColor.get(u.chain) ?? 0x999999;
    const body = this.scene.add.rectangle(0, 0, UNIT_SIZE, UNIT_SIZE, fill).setStrokeStyle(1, 0x1b1d24);
    const label = text(this.scene, 0, 0, u.tier >= maxTier ? '★' : String(u.tier), {
      fontSize: '10px',
      color: '#1b1d24',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    const { bg, bar } = this.hpBar(UNIT_SIZE / 2 + 3);
    const container = this.scene.add.container(u.x, DEFENSE_UNIT_Y, [body, label, bg, bar]).setDepth(3);
    const v = { container, bar };
    this.units.set(u.id, v);
    return v;
  }

  private hpBar(y: number): { bg: Phaser.GameObjects.Rectangle; bar: Phaser.GameObjects.Rectangle } {
    const bg = this.scene.add.rectangle(-HP_BAR_W / 2, y, HP_BAR_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const bar = this.scene.add.rectangle(-HP_BAR_W / 2, y, HP_BAR_W, 3, 0x7ed67e).setOrigin(0, 0.5);
    return { bg, bar };
  }

  private removeWorry(id: number): void {
    this.worries.get(id)?.container.destroy();
    this.worries.delete(id);
  }

  private removeUnit(id: number): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  /** 처치 → 작은 빛 점이 ☀ 창문을 지나 HUD 기쁨으로 (HUD 숫자는 core 값으로 이미 갱신됨) */
  private joyDot(x: number, y: number): void {
    const dot = this.scene.add.circle(x, y, 3, JOY_DOT_COLOR).setDepth(40);
    this.scene.tweens.chain({
      targets: dot,
      tweens: [
        { x: PORTAL.happy.x, y: PORTAL.happy.y, duration: JOY_DOT_MS / 2, ease: 'Sine.easeIn' },
        { x: this.joyTarget.x, y: this.joyTarget.y, duration: JOY_DOT_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => dot.destroy(),
    });
  }

  /** 가라앉음: 방어선 → 거울 → 오른쪽 레인의 그림자 벽에 흡수 (§4.2.1) */
  private sinkAway(c: Phaser.GameObjects.Container): void {
    c.setDepth(4);
    const wall = this.sinkTarget.point();
    this.scene.tweens.chain({
      targets: c,
      tweens: [
        { x: REGION.mirror.x + REGION.mirror.w / 2, y: c.y + 14, scale: 0.6, alpha: 0.7, duration: SINK_MS, ease: 'Sine.easeIn' },
        { x: wall.x, y: wall.y, scale: 0.4, alpha: 0.4, duration: SINK_MS, ease: 'Sine.easeInOut' },
      ],
      onComplete: () => {
        c.destroy();
        this.sinkTarget.onAbsorb();
      },
    });
  }
}

function setHp(v: HpView, hp: number, maxHp: number): void {
  v.bar.width = HP_BAR_W * Math.max(0, Math.min(1, hp / maxHp));
}

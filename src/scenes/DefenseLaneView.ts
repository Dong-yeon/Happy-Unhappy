// 낮의 방어 레인 표시 (§4.3.1, §5.11-2): 가로 레인. Happy 거점은 왼쪽, 걱정은 오른쪽에서 밀려온다.
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(처치 빛 점, 가라앉음, 귀환)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { Unit, Worry } from '../core/lane';
import type { Chain } from '../data/types';
import { isWildcard, type Piece } from '../core/grid';
import { CORE, HOME, PORTAL, PORTAL_RADIUS, REGION, cellCenter, progressX, toScreen } from './layout';
import { COLOR, text } from './ui';

const WORRY_R = 8;
const BOSS_R = 13;
const BOSS_COLOR = 0xc0506a;
/** 걱정은 방어선에 닿도록 중심을 진행 축으로 이만큼 앞(오른쪽)에 그린다 (core y 기준) */
const WORRY_DRAW_OFFSET = 9;
const UNIT_SIZE = 16;
const WORRY_COLOR = 0x9b7fb8;
const JOY_DOT_COLOR = 0xf2c94c;
const HP_BAR_W = 16;

const SUMMON_MS = 250; // 조각 → 창문 → 슬롯
const JOY_DOT_MS = 400; // 처치 지점 → 창문 → HUD 기쁨
const SINK_MS = 450;
const RETURN_MS = 450; // 해질녘 귀환: 유닛 자리 → 창문 → 그리드 칸 (D-022)
/** 유닛은 core 위치보다 이만큼 거점 쪽(진행 축)에 그린다 (방어선에서 걱정과 겹치지 않게) */
const UNIT_DRAW_OFFSET = CORE.homeY - CORE.lineY;
/** 타격 연출 (§4.3.3): 대상 위치 원 번쩍 + 맞은 쪽 흰색 깜빡임 */
const HIT_MS = 100;
const HIT_BY_US = 0xfff3b0; // 유닛·Happy가 걱정을 침
const HIT_BY_WORRY = 0xd28cff; // 걱정이 유닛을 침
/** 홈으로 돌아가는 중 (쉬는 중) */
const RETURNING_ALPHA = 0.85;

interface HpView {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Shape;
  bar: Phaser.GameObjects.Rectangle;
  color: number;
  /** 소환 연출 중에는 core 위치를 따라가지 않는다 */
  tweening?: boolean;
}

export class DefenseLaneView {
  /** 낮 레인 전체 (밤에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly worries = new Map<number, HpView>();
  private readonly units = new Map<number, HpView>();
  private readonly chainColor = new Map<string, number>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
    private readonly joyTarget: { x: number; y: number },
    /** 걱정 표시 이름 (monsters.worry.name, §5.15-2) */
    worryName = '걱정',
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    const g = REGION.ground;
    // 땅 띠(따뜻한 톤) + 방어선(세로) + Happy 거점
    const bg = scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.defense).setOrigin(0);
    const lineX = progressX(CORE.lineY);
    const line = scene.add.line(0, 0, lineX, g.y + 6, lineX, g.y + g.h - 6, COLOR.line).setOrigin(0).setLineWidth(1);
    const spawnLabel = text(scene, g.x + g.w - 6, g.y + 4, `← ${worryName}`, { fontSize: '10px', color: '#c9b98a' }).setOrigin(1, 0);
    const laneLabel = text(scene, g.x + g.w / 2, g.y + g.h - 4, '낮 · 방어 레인', { fontSize: '9px', color: '#8f835f' }).setOrigin(0.5, 1);
    const home = HOME.defense;
    const happy = scene.add.circle(home.x, home.y, 10, COLOR.happy);
    const happyLabel = text(scene, 2, home.y - 17, 'Happy', { fontSize: '8px', color: '#f2c94c' }).setOrigin(0, 0.5) // 화면 왼쪽 끝이라 왼쪽 정렬;
    this.root = scene.add.container(0, 0, [bg, line, spawnLabel, laneLabel, happy, happyLabel]).setDepth(1);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
  }

  /** 소환 연출: 드롭 지점 → ☀ 창문 포탈 → 슬롯. core에서는 이미 전투 중 */
  onSummon(unit: Unit, fromX: number, fromY: number): void {
    const v = this.makeUnit(unit);
    const to = this.unitPos(unit);
    v.tweening = true;
    v.container.setPosition(fromX, fromY);
    this.root.remove(v.container);
    v.container.setDepth(15);
    this.scene.tweens.chain({
      targets: v.container,
      tweens: [
        { x: PORTAL.happy.x, y: PORTAL.happy.y, scale: 0.6, duration: SUMMON_MS / 2, ease: 'Sine.easeIn' },
        { x: to.x, y: to.y, scale: 1, duration: SUMMON_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => {
        v.tweening = false;
        if (!v.container.active) return;
        v.container.setDepth(0);
        this.root.add(v.container);
      },
    });
  }

  /** core 이벤트 → 연출. sync() 전에 호출 (사라질 표시의 마지막 위치를 쓰기 위해) */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'worryDie': {
          this.removeWorry(e.worryId);
          const p = toScreen('defense', e.x, e.y - WORRY_DRAW_OFFSET);
          this.joyDot(p.x, p.y);
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
        case 'injured': {
          // 영웅·전설 부상: 쓰러진 자리에서 창문을 지나 그리드로 (§5.13-2)
          if (e.side !== 'happy') break;
          const from = toScreen('defense', e.ret.x, e.ret.y + UNIT_DRAW_OFFSET);
          this.returnFlow(e.ret.piece, from.x, from.y, e.ret.placedAt, e.ret.lost);
          break;
        }
        case 'attack': {
          // 유닛·Happy → 걱정 / 걱정 → 유닛
          const target = e.attacker.kind === 'worry' ? this.units.get(e.targetId) : this.worries.get(e.targetId);
          if (target) this.hit(target, e.attacker.kind === 'worry' ? HIT_BY_WORRY : HIT_BY_US);
          break;
        }
        case 'dayReturn': {
          if (e.side !== 'happy') break;
          for (const r of e.returns) {
            const v = this.units.get(r.unitId);
            const from = v ? { x: v.container.x, y: v.container.y } : toScreen('defense', r.x, CORE.homeY);
            if (v) {
              this.scene.tweens.killTweensOf(v.container);
              v.container.destroy();
              this.units.delete(r.unitId);
            }
            this.returnFlow(r.piece, from.x, from.y, r.placedAt, r.lost);
          }
          break;
        }
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
      const p = toScreen('defense', w.x, w.y - WORRY_DRAW_OFFSET);
      v.container.setPosition(p.x, p.y);
      setHp(v, w.hp, w.maxHp);
    }
    for (const id of [...this.worries.keys()]) if (!liveW.has(id)) this.removeWorry(id);

    const liveU = new Set<number>();
    for (const u of lane.units) {
      liveU.add(u.id);
      const v = this.units.get(u.id) ?? this.makeUnit(u);
      if (!v.tweening) {
        // 제한 이동(§4.3.3): core의 u.x, u.y를 매 프레임 따라간다. 복귀 중에는 반투명
        const p = this.unitPos(u);
        v.container.setPosition(p.x, p.y).setAlpha(u.returning ? RETURNING_ALPHA : 1);
      }
      setHp(v, u.hp, u.maxHp);
    }
    for (const id of [...this.units.keys()]) if (!liveU.has(id)) this.removeUnit(id);
  }

  /** 방어 유닛은 자기 위치보다 살짝 뒤(왼쪽)에 그린다 (방어선에 서 있으면 방어선 바로 뒤 줄) */
  private unitPos(u: Unit): { x: number; y: number } {
    return toScreen('defense', u.x, u.y + UNIT_DRAW_OFFSET);
  }

  /** 타격: 대상 위치에 0.1초 원 번쩍 + 맞은 쪽 흰색 깜빡임 */
  private hit(v: HpView, color: number): void {
    const flash = this.scene.add.circle(v.container.x, v.container.y, 9, color, 0.9).setDepth(35);
    this.scene.tweens.add({ targets: flash, scale: 1.6, alpha: 0, duration: HIT_MS, onComplete: () => flash.destroy() });
    v.body.setFillStyle(0xffffff);
    this.scene.time.delayedCall(HIT_MS, () => v.body.active && v.body.setFillStyle(v.color));
  }

  private makeWorry(w: Worry): HpView {
    // 역류 보스: 크고 붉게
    const r = w.boss ? BOSS_R : WORRY_R;
    const body = this.scene.add.circle(0, 0, r, w.boss ? BOSS_COLOR : WORRY_COLOR).setStrokeStyle(w.boss ? 2 : 1, 0x3b2d4a);
    const face = text(this.scene, 0, 0, w.boss ? '!' : '~', { fontSize: w.boss ? '13px' : '9px', color: '#2a1f35', fontStyle: 'bold' }).setOrigin(0.5);
    const { bg, bar } = this.hpBar(-r - 4);
    const p = toScreen('defense', w.x, w.y - WORRY_DRAW_OFFSET);
    const container = this.scene.add.container(p.x, p.y, [body, face, bg, bar]);
    this.root.add(container);
    const v: HpView = { container, body, bar, color: w.boss ? BOSS_COLOR : WORRY_COLOR };
    this.worries.set(w.id, v);
    return v;
  }

  private makeUnit(u: Unit): HpView {
    const maxTier = this.state.grid.maxTier;
    const fill = this.chainColor.get(u.chain) ?? 0x999999;
    // 전설 = 금 테두리, 빛나는 영웅 = 금빛 테두리 (§5.13)
    const body = this.scene.add
      .rectangle(0, 0, UNIT_SIZE, UNIT_SIZE, fill)
      .setStrokeStyle(u.legend ? 3 : u.shining ? 2 : 1, u.legend ? 0xf2c94c : u.shining ? 0xfff1a8 : 0x1b1d24);
    const label = text(this.scene, 0, 0, u.legend ? '◆' : u.tier >= maxTier ? '★' : String(u.tier), {
      fontSize: '10px',
      color: '#1b1d24',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    const { bg, bar } = this.hpBar(UNIT_SIZE / 2 + 3);
    const p = this.unitPos(u);
    const container = this.scene.add.container(p.x, p.y, [body, label, bg, bar]);
    this.root.add(container);
    const v: HpView = { container, body, bar, color: fill };
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

  /**
   * 해질녘 귀환 (D-022): 살아남은 방어 유닛이 빛 조각이 되어 ☀ 창문 포탈을 지나 그리드 칸으로.
   * 대기열이면 귀환 대기 표시로, 소실이면 창문에서 사라짐.
   */
  private returnFlow(piece: Piece, x: number, y: number, placedAt: number | null, lost: boolean): void {
    const fill = isWildcard(piece) ? 0xffffff : (this.chainColor.get(piece.chain) ?? 0xffffff);
    const light = this.scene.add.rectangle(x, y, 12, 12, fill).setStrokeStyle(1, 0xffffff).setDepth(40);
    const { cols, rows } = this.state.grid;
    const dest =
      placedAt !== null
        ? cellCenter(cols, rows, placedAt)
        : lost
          ? { x: PORTAL.happy.x, y: PORTAL.happy.y }
          : { x: PORTAL.happy.x - PORTAL_RADIUS - 16, y: PORTAL.happy.y };
    this.scene.tweens.chain({
      targets: light,
      tweens: [
        { x: PORTAL.happy.x, y: PORTAL.happy.y, duration: RETURN_MS / 2, ease: 'Sine.easeIn' },
        { x: dest.x, y: dest.y, alpha: lost ? 0 : 1, duration: RETURN_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => light.destroy(),
    });
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

  /** 가라앉음: 방어선을 지나 왼쪽 땅 아래로 가라앉으며 사라진다 (그날 밤 그림자 벽을 단단하게, §5.11) */
  private sinkAway(c: Phaser.GameObjects.Container): void {
    this.scene.tweens.add({
      targets: c,
      x: REGION.ground.x - 6,
      y: c.y + 18,
      scale: 0.5,
      alpha: 0,
      duration: SINK_MS,
      ease: 'Sine.easeIn',
      onComplete: () => c.destroy(),
    });
  }
}

function setHp(v: HpView, hp: number, maxHp: number): void {
  v.bar.width = HP_BAR_W * Math.max(0, Math.min(1, hp / maxHp));
}

// 밤(디펜스) 레인 표시 — 핵 지키기 (§4.3.1, §5.19-3): 가로 레인. 이야기책(핵)은 왼쪽, 적은 오른쪽에서 밀려온다.
// 우리 편 = 밤덱 영웅 + 전투 중 머지 병사. 영웅이 쓰러지면 거점 위에 일어나기까지 카운트다운. 거점 위에 핵 HP 막대.
// 상태는 항상 core에서 읽고 layout.toScreen()으로 화면에 옮긴다. 이벤트는 연출(처치 빛 점, 가라앉음, 타격)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { GameData } from '../data/types';
import { CORE, HOME, REGION, progressX, toScreen } from './layout';
import { flashUnit, makeEnemyView, storyBook, makeUnitView, syncEnemyView, syncUnitView, type EnemyView, type UnitView } from './laneUnits';
import { COLOR, text } from './ui';

/** 걱정은 방어선에 닿도록 중심을 진행 축으로 이만큼 앞(오른쪽)에 그린다 (core y 기준) */
const WORRY_DRAW_OFFSET = 9;
const JOY_DOT_COLOR = 0xf2c94c;
const CORE_BAR_W = 64;
const JOY_DOT_MS = 400; // 처치 지점 → HUD 기쁨
const SINK_MS = 450;
/** 우리 편은 core 위치보다 이만큼 거점 쪽(진행 축)에 그린다 (방어선에서 걱정과 겹치지 않게) */
const UNIT_DRAW_OFFSET = CORE.homeY - CORE.lineY;
/** 타격 연출 (§4.3.3): 대상 위치 원 번쩍 + 맞은 쪽 흰색 깜빡임 */
const HIT_MS = 100;
const HIT_BY_US = 0xfff3b0;
const HIT_BY_WORRY = 0xd28cff;
/** 홈으로 돌아가는 중 */
const RETURNING_ALPHA = 0.85;

export class DefenseLaneView {
  /** 밤 레인 전체 (낮에는 숨김) */
  readonly root: Phaser.GameObjects.Container;
  private readonly worries = new Map<number, EnemyView>();
  private readonly units = new Map<number, UnitView>();
  private readonly downLabel: Phaser.GameObjects.Text;
  private readonly coreFill: Phaser.GameObjects.Rectangle;
  private readonly coreText: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly joyTarget: { x: number; y: number },
  ) {
    const g = REGION.ground;
    // 밤 땅 띠(1챕터: 오두막 앞마당에 내려앉은 이야기책, 도형 단계는 배경색만) + 방어선(세로) + Happy 거점
    const bg = scene.add.rectangle(g.x, g.y, g.w, g.h, COLOR.abyss).setOrigin(0);
    const lineX = progressX(CORE.lineY);
    const line = scene.add.line(0, 0, lineX, g.y + 6, lineX, g.y + g.h - 6, COLOR.line).setOrigin(0).setLineWidth(1);
    const spawnLabel = text(scene, g.x + g.w - 6, g.y + 4, '← 핵을 노리는 무리', { fontSize: '10px', color: '#c9b98a' }).setOrigin(1, 0);
    const laneLabel = text(scene, g.x + g.w / 2, g.y + g.h - 4, '밤 · 핵 지키기', { fontSize: '9px', color: '#8f835f' }).setOrigin(0.5, 1);
    const home = HOME.defense;
    // 본거지 이야기책 (핵을 품고 있음, D-056)
    const happy = storyBook(scene, home.x, home.y);
    // 핵 HP (§5.19-3): 레인 왼쪽 위 "◆ 핵 100/100" + 막대
    const cx = g.x + 8;
    const cy = g.y + 10;
    const coreGem = scene.add.rectangle(cx + 4, cy, 7, 7, 0xffe08a).setAngle(45).setStrokeStyle(1, 0xffffff);
    const coreFrame = scene.add.rectangle(cx + 14, cy, CORE_BAR_W, 6, 0x1b1d24).setOrigin(0, 0.5).setStrokeStyle(1, 0x8f835f);
    this.coreFill = scene.add.rectangle(cx + 14, cy, CORE_BAR_W, 6, 0xffe08a).setOrigin(0, 0.5);
    this.coreText = text(scene, cx + 18 + CORE_BAR_W, cy, '', { fontSize: '9px', color: '#ffe08a' }).setOrigin(0, 0.5);
    this.downLabel = text(scene, home.x + 4, home.y - 26, '', { fontSize: '9px', color: '#ff9e9e', backgroundColor: '#1b1d24', padding: { x: 3, y: 1 } })
      .setOrigin(0, 0.5)
      .setVisible(false);
    this.root = scene.add
      .container(0, 0, [bg, line, spawnLabel, laneLabel, happy, coreGem, coreFrame, this.coreFill, this.coreText, this.downLabel])
      .setDepth(1)
      .setVisible(false);
  }

  setShown(shown: boolean): void {
    this.root.setVisible(shown);
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
        case 'coreHit': {
          // 핵이 맞음: 막대 붉게 깜빡
          this.coreFill.setFillStyle(0xff6b6b);
          this.scene.time.delayedCall(180, () => this.coreFill.active && this.coreFill.setFillStyle(0xffe08a));
          break;
        }
        case 'unitDie':
          this.removeUnit(e.unitId);
          break;
        case 'attack': {
          if (e.attacker.kind === 'worry') {
            const t = this.units.get(e.targetId);
            if (t) {
              this.flash(t.container.x, t.container.y, HIT_BY_WORRY);
              flashUnit(this.scene, t, HIT_MS);
            }
          } else {
            const t = this.worries.get(e.targetId);
            if (t) {
              this.flash(t.container.x, t.container.y, HIT_BY_US);
              t.body.setFillStyle(0xffffff);
              this.scene.time.delayedCall(HIT_MS, () => t.body.active && t.body.setFillStyle(t.color));
            }
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
      let v = this.worries.get(w.id);
      if (!v) {
        v = makeEnemyView(this.scene, w.type, w.boss);
        this.root.add(v.container);
        this.worries.set(w.id, v);
      }
      const p = toScreen('defense', w.x, w.y - WORRY_DRAW_OFFSET);
      v.container.setPosition(p.x, p.y);
      syncEnemyView(v, w.hp, w.maxHp, w.slowTimer > 0);
    }
    for (const id of [...this.worries.keys()]) if (!liveW.has(id)) this.removeWorry(id);

    const liveU = new Set<number>();
    for (const u of lane.units) {
      liveU.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = makeUnitView(this.scene, this.data, u, 'defense');
        this.root.add(v.container);
        this.units.set(u.id, v);
      }
      // 제한 이동(§4.3.3): core의 u.x, u.y를 매 프레임 따라간다. 복귀 중에는 반투명
      const p = toScreen('defense', u.x, u.y + UNIT_DRAW_OFFSET);
      v.container.setPosition(p.x, p.y).setAlpha(u.returning ? RETURNING_ALPHA : 1);
      syncUnitView(v, u, this.state, 'defense');
    }
    for (const id of [...this.units.keys()]) if (!liveU.has(id)) this.removeUnit(id);

    // 핵 HP
    const max = this.data.balance.core.hp;
    const hp = this.state.coreHp;
    this.coreFill.width = CORE_BAR_W * Math.max(0, Math.min(1, hp / max));
    const ct = `핵 ${Math.ceil(hp)}/${max}`;
    if (this.coreText.text !== ct) this.coreText.setText(ct);

    // 쓰러짐 카운트다운 (§5.17-9)
    const down = this.state.defenseDown;
    this.downLabel.setVisible(down > 0);
    if (down > 0) this.downLabel.setText(`쓰러짐 · ${Math.ceil(down)}초 뒤 일어남`);
  }

  private flash(x: number, y: number, color: number): void {
    const f = this.scene.add.circle(x, y, 9, color, 0.9).setDepth(35);
    this.scene.tweens.add({ targets: f, scale: 1.6, alpha: 0, duration: HIT_MS, onComplete: () => f.destroy() });
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

  /** 처치 → 작은 빛 점이 HUD 기쁨으로 (HUD 숫자는 core 값으로 이미 갱신됨) */
  private joyDot(x: number, y: number): void {
    const dot = this.scene.add.circle(x, y, 3, JOY_DOT_COLOR).setDepth(40);
    this.scene.tweens.add({
      targets: dot,
      x: this.joyTarget.x,
      y: this.joyTarget.y,
      duration: JOY_DOT_MS,
      ease: 'Sine.easeIn',
      onComplete: () => dot.destroy(),
    });
  }

  /** 거점에 닿음: 방어선을 지나 왼쪽 이야기책으로 빨려 들어가며 사라진다 (핵 HP −) */
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

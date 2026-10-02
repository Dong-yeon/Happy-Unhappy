// 영웅 슬롯 (§5.17-2·9, 구 포탈 받침): 초상 원 + 이름 + 떡/동아줄 점수. 조각을 끌어다 놓으면 먹이기.
// 평소 / 드래그 중 강조(밝게) / 못 먹임(어둡게). 먹이면 점수 숫자가 잠깐 커진다.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { GameData } from '../data/types';
import { chainShort } from './labels';
import { heroColor, heroName } from './laneUnits';
import { HERO_SLOT } from './layout';
import { COLOR, text } from './ui';

export class HeroSlotView {
  private readonly box: Phaser.GameObjects.Rectangle;
  private readonly portrait: Phaser.GameObjects.Arc;
  private readonly initial: Phaser.GameObjects.Text;
  private readonly name: Phaser.GameObjects.Text;
  private readonly scores: Phaser.GameObjects.Text;
  private shownKey = '';
  private hovered = false;
  private closed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    readonly role: Role,
  ) {
    const r = HERO_SLOT[role];
    this.box = scene.add.rectangle(r.x, r.y, r.w, r.h, COLOR.cell).setOrigin(0).setStrokeStyle(1, COLOR.mirror).setDepth(5);
    const cy = r.y + r.h / 2;
    this.portrait = scene.add.circle(r.x + 18, cy, 13, heroColor(role)).setStrokeStyle(2, 0x1b1d24).setDepth(6);
    this.initial = text(scene, r.x + 18, cy, '', { fontSize: '12px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5).setDepth(7);
    this.name = text(scene, r.x + 36, r.y + 5, '', { fontSize: '10px', color: '#e8e8e8', fontStyle: 'bold' }).setDepth(6);
    this.scores = text(scene, r.x + 36, r.y + r.h - 5, '', { fontSize: '9px', color: '#cfd6ea' }).setOrigin(0, 1).setDepth(6);
    this.sync();
  }

  get center(): { x: number; y: number } {
    const r = HERO_SLOT[this.role];
    return { x: r.x + 18, y: r.y + r.h / 2 };
  }

  setHovered(h: boolean): void {
    if (h === this.hovered) return;
    this.hovered = h;
    this.apply();
  }

  setClosed(c: boolean): void {
    if (c === this.closed) return;
    this.closed = c;
    this.apply();
  }

  private apply(): void {
    this.box.setFillStyle(this.closed ? COLOR.portalClosed : this.hovered ? COLOR.buttonOn : COLOR.cell);
    this.box.setStrokeStyle(this.hovered ? 2 : 1, this.hovered ? 0xffffff : COLOR.mirror);
  }

  /** 매 프레임: 이름·점수 (바뀔 때만 다시 쓴다) */
  sync(): void {
    const h = this.state.heroes[this.role];
    const pts = this.data.chains.map((c) => `${chainShort(this.data, c.archetypeId)} ${h.points[c.archetypeId] ?? 0}`).join(' · ');
    const key = `${h.id}|${pts}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    const n = heroName(this.data, h.id);
    this.initial.setText(n.slice(0, 1));
    this.name.setText(`${this.role === 'offense' ? '☀ 낮' : '☾ 밤'} · ${n}`);
    this.scores.setText(pts);
  }

  /** 먹이기 연출: 드롭 지점 → 초상, 점수 숫자 톡 */
  onFeed(fromX: number, fromY: number, color: number, points: number): void {
    const c = this.center;
    const light = this.scene.add.rectangle(fromX, fromY, 12, 12, color).setStrokeStyle(1, 0xffffff).setDepth(40);
    this.scene.tweens.add({ targets: light, x: c.x, y: c.y, scale: 0.4, duration: 220, ease: 'Sine.easeIn', onComplete: () => light.destroy() });
    const pop = text(this.scene, c.x, c.y - 18, `+${points}`, { fontSize: '11px', color: '#ffe08a', fontStyle: 'bold' }).setOrigin(0.5).setDepth(41);
    this.scene.tweens.add({ targets: pop, y: c.y - 30, alpha: 0, duration: 700, onComplete: () => pop.destroy() });
    this.scene.tweens.add({ targets: this.portrait, scale: 1.2, yoyo: true, duration: 120 });
  }
}

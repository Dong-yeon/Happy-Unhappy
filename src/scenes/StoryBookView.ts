// 이야기책 (§5.20-8, D-061): 펼친 양면 책. 맨 앞 장 = 챕터 표지(제목·진행 n/10), 그 뒤 1-1 ~ 1-10 자리.
// 연 장 = 제목·삽화 자리(빈 사각형, 그림은 M9)·핵·이야기 한 장·플레이 한 줄, 못 연 장 = 빈 페이지 + "?" + 스테이지 번호.
// 좌우 버튼(또는 좌우 끌기)으로 넘긴다. 도형 + 텍스트만.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import type { GameData } from '../data/types';
import { VIEW_H, VIEW_W } from './layout';
import { Button, text } from './ui';

const DEPTH = 75;
const PAGE_W = 168;
const PAGE_H = 440;
const TOP = 52;
const PAPER = 0xf3ead2;
const INK = '#3b2f1e';

export class StoryBookView {
  private readonly objs: Phaser.GameObjects.GameObject[] = [];
  private readonly buttons: Button[] = [];
  private pageObjs: Phaser.GameObjects.GameObject[] = [];
  private spread = 0;
  private closed = false;
  private readonly prev: Button;
  private readonly next: Button;
  private readonly pageNo: Phaser.GameObjects.Text;
  private dragX: number | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly onClose: () => void,
  ) {
    const bg = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0e1016, 0.96).setOrigin(0).setDepth(DEPTH).setInteractive();
    bg.on('pointerdown', (p: Phaser.Input.Pointer) => (this.dragX = p.worldX));
    bg.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.dragX === null) return;
      const dx = p.worldX - this.dragX;
      this.dragX = null;
      if (dx < -40) this.turn(1);
      else if (dx > 40) this.turn(-1);
    });
    const title = text(scene, VIEW_W / 2, 14, '이야기책', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' }).setOrigin(0.5, 0).setDepth(DEPTH + 1);
    // 책 표지(뒤판) + 가운데 접힘
    const cover = scene.add.rectangle(VIEW_W / 2, TOP + PAGE_H / 2, PAGE_W * 2 + 12, PAGE_H + 10, 0x6b4f2f).setDepth(DEPTH + 1);
    const spine = scene.add.rectangle(VIEW_W / 2, TOP + PAGE_H / 2, 3, PAGE_H, 0x8a6a42).setDepth(DEPTH + 3);
    this.pageNo = text(scene, VIEW_W / 2, TOP + PAGE_H + 14, '', { fontSize: '10px', color: '#9fb4e0' }).setOrigin(0.5, 0).setDepth(DEPTH + 1);
    this.objs.push(bg, title, cover, spine, this.pageNo);
    this.prev = new Button(scene, 56, VIEW_H - 36, 80, 30, '◀', () => this.turn(-1), '12px');
    this.next = new Button(scene, VIEW_W - 56, VIEW_H - 36, 80, 30, '▶', () => this.turn(1), '12px');
    const close = new Button(scene, VIEW_W / 2, VIEW_H - 36, 100, 30, '닫기', () => this.close(), '12px');
    for (const b of [this.prev, this.next, close]) {
      b.container.setDepth(DEPTH + 4);
      this.buttons.push(b);
    }
    // 마지막으로 연 장이 보이게
    const last = state.pages.length ? Math.max(...state.pages) : 0;
    this.spread = Math.floor(last / 2);
    this.draw();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** 장 수 = 표지 1 + 스테이지 수 */
  private get pageCount(): number {
    return 1 + this.data.stages.stages.length;
  }

  private get spreads(): number {
    return Math.ceil(this.pageCount / 2);
  }

  private turn(d: number): void {
    const n = Math.max(0, Math.min(this.spreads - 1, this.spread + d));
    if (n === this.spread) return;
    this.spread = n;
    this.draw();
  }

  private draw(): void {
    for (const o of this.pageObjs) o.destroy();
    this.pageObjs = [];
    const left = this.spread * 2;
    this.drawPage(left, VIEW_W / 2 - PAGE_W - 2);
    this.drawPage(left + 1, VIEW_W / 2 + 2);
    this.prev.setEnabled(this.spread > 0);
    this.next.setEnabled(this.spread < this.spreads - 1);
    this.pageNo.setText(`${this.spread + 1} / ${this.spreads}`);
  }

  private t(x: number, y: number, s: string, style: Phaser.Types.GameObjects.Text.TextStyle): Phaser.GameObjects.Text {
    const o = text(this.scene, x, y, s, { color: INK, align: 'center', wordWrap: { width: PAGE_W - 20 }, ...style })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 3);
    this.pageObjs.push(o);
    return o;
  }

  /** 장 하나: 0 = 표지, n = 1-n */
  private drawPage(index: number, x: number): void {
    const s = this.scene;
    const cx = x + PAGE_W / 2;
    if (index >= this.pageCount) {
      this.pageObjs.push(s.add.rectangle(x, TOP, PAGE_W, PAGE_H, 0xe5dcc4).setOrigin(0).setDepth(DEPTH + 2));
      return;
    }
    this.pageObjs.push(s.add.rectangle(x, TOP, PAGE_W, PAGE_H, PAPER).setOrigin(0).setDepth(DEPTH + 2));
    if (index === 0) {
      const done = new Set(this.state.pages).size;
      this.t(cx, TOP + 60, '1권 1장', { fontSize: '10px', color: '#8a6a42' });
      this.t(cx, TOP + 84, this.data.chapterComplete.title, { fontSize: '16px', fontStyle: 'bold' });
      this.pageObjs.push(s.add.circle(cx - 18, TOP + 170, 14, 0xffd36b).setDepth(DEPTH + 3), s.add.circle(cx + 18, TOP + 170, 12, 0xd9deee).setDepth(DEPTH + 3));
      this.t(cx, TOP + 220, `펼친 장 ${done} / ${this.data.stages.stages.length}`, { fontSize: '11px' });
      this.t(cx, TOP + PAGE_H - 40, '이야기 모험대의 책', { fontSize: '9px', color: '#8a6a42' });
      return;
    }
    const stage = index;
    const st = this.data.stages.stages[stage - 1];
    const open = this.state.pages.includes(stage);
    this.t(cx, TOP + 12, `1-${stage}`, { fontSize: '10px', color: '#8a6a42' });
    if (!open) {
      this.t(cx, TOP + PAGE_H / 2 - 30, '?', { fontSize: '40px', color: '#b8a888', fontStyle: 'bold' });
      this.t(cx, TOP + PAGE_H / 2 + 24, '아직 펼치지 못한 장', { fontSize: '9px', color: '#a89878' });
      return;
    }
    let y = TOP + 28;
    y += this.t(cx, y, st.title, { fontSize: '13px', fontStyle: 'bold' }).height + 8;
    // 삽화 자리 (M9)
    const ill = s.add.rectangle(cx, y + 36, PAGE_W - 24, 70, 0xe8dcbc).setStrokeStyle(1, 0xb8a888).setDepth(DEPTH + 3);
    this.pageObjs.push(ill);
    this.t(cx, y + 30, '(삽화)', { fontSize: '8px', color: '#b8a888' });
    y += 80;
    y += this.t(cx, y, `◆ ${st.coreName}`, { fontSize: '10px', color: '#a0702a' }).height + 8;
    y += this.t(cx, y, st.page, { fontSize: '10px', lineSpacing: 3 }).height + 10;
    const notes = this.state.pageNotes[stage] ?? [];
    if (notes.length) this.t(cx, y, notes.join('\n'), { fontSize: '9px', color: '#5a6b8a', lineSpacing: 3 });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const o of [...this.objs, ...this.pageObjs]) o.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.onClose();
  }
}

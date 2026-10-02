// 편성 화면 (§5.20-2, D-058): 위 탭 [낮 공격대]/[밤 수비대], 팀 줄 1~5(각 앞·가운데·뒤 3칸), 아래 영웅 카드.
// 카드를 칸에 끌어다 놓기 / 칸끼리 바꾸기 / 칸에서 밖으로 끌어 빼기. 인연이 켜지면 팀 줄에 표시.
// [확인] → core.setFormation (전투 중이고 바뀌었으면 core가 그 단계를 처음부터). 도형 + 텍스트만.
// §5.22: 카드에 Lv·★·☀/☾ 적성(그 칸 쪽 적성 강조), 카드를 탭하면 영웅 상세(잉크 붓기·진급·비법서).
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { activeBonds, type Formation } from '../core/roster';
import type { GameData } from '../data/types';
import { HeroDetailView } from './HeroDetailView';
import { heroChainColor } from './laneUnits';
import { VIEW_H, VIEW_W, inRect, type Rect } from './layout';
import { Button, COLOR, text } from './ui';

const DEPTH = 80;
const SIDES = ['offense', 'defense'] as const;
type SideKey = (typeof SIDES)[number];
const ROW_Y = 78;
const ROW_H = 50;
const SLOT_W = 62;
const SLOT_H = 40;
const SLOT_X0 = 46;
const CARD_W = 82;
const CARD_H = 50;
const CARDS_Y = ROW_Y + ROW_H * 5 + 14;
const ROLE_LABEL: Record<string, string> = { tank: '탱커', attack: '공격', support: '서포트' };
const ORDER_LABEL = ['앞', '가운데', '뒤'];
const APT_COLOR: Record<string, string> = { S: '#ffd36b', A: '#cfd6ea', B: '#ff9e9e' };
/** 이만큼 움직이지 않고 떼면 탭 (영웅 상세) */
const TAP_PX = 6;

type Where = { side: SideKey; team: number; slot: number } | null;

export class FormationView {
  private readonly objs: Phaser.GameObjects.GameObject[] = [];
  private readonly buttons: Button[] = [];
  /** 그리는 내용 (탭이 바뀌거나 배치가 바뀌면 다시 그림) */
  private dyn: Phaser.GameObjects.GameObject[] = [];
  private draft: Record<SideKey, (string | null)[][]>;
  private tab: SideKey = 'offense';
  private drag: { id: string; from: Where; ghost: Phaser.GameObjects.Container; card: boolean; x: number; y: number } | null = null;
  private detail: HeroDetailView | null = null;
  private restarted = false;
  private readonly error: Phaser.GameObjects.Text;
  private closed = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    /** 닫힘 (편성이 바뀌어 재시작했으면 restarted) */
    private readonly onClose: (r: { restarted: boolean }) => void,
    cancellable = true,
  ) {
    const b = data.balance.team;
    const empty = () => Array.from({ length: b.maxTeams }, () => new Array<string | null>(b.teamSize).fill(null));
    this.draft = { offense: empty(), defense: empty() };
    for (const side of SIDES) state.formation[side].forEach((t, i) => t.forEach((id, k) => (this.draft[side][i][k] = id)));

    const bg = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x11141b, 0.97).setOrigin(0).setDepth(DEPTH).setInteractive();
    const title = text(scene, VIEW_W / 2, 10, '편성', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' }).setOrigin(0.5, 0).setDepth(DEPTH + 1);
    const hint = text(scene, VIEW_W / 2, 30, state.inBattle ? '전투 중에 바꾸면 지금 단계를 처음부터 다시 해요' : '카드를 칸에 끌어다 놓기 · 칸끼리 바꾸기 · 밖으로 빼기', {
      fontSize: '9px',
      color: state.inBattle ? '#ffb46b' : '#9fb4e0',
    })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH + 1);
    this.error = text(scene, VIEW_W / 2, VIEW_H - 62, '', { fontSize: '10px', color: '#ff9e9e' }).setOrigin(0.5).setDepth(DEPTH + 1);
    this.objs.push(bg, title, hint, this.error);
    const tabs = SIDES.map((side, i) => {
      const btn = new Button(scene, VIEW_W / 2 + (i === 0 ? -66 : 66), 56, 124, 22, side === 'offense' ? '☀ 낮 공격대' : '☾ 밤 수비대', () => {
        this.tab = side;
        tabs.forEach((t, k) => t.setActive(SIDES[k] === this.tab));
        this.redraw();
      }, '11px');
      btn.container.setDepth(DEPTH + 1);
      this.buttons.push(btn);
      return btn;
    });
    tabs[0].setActive(true);
    const ok = new Button(scene, cancellable ? VIEW_W / 2 - 60 : VIEW_W / 2, VIEW_H - 32, 110, 30, '확인', () => this.confirm(), '12px');
    ok.container.setDepth(DEPTH + 1);
    this.buttons.push(ok);
    if (cancellable) {
      const cancel = new Button(scene, VIEW_W / 2 + 60, VIEW_H - 32, 110, 30, '취소', () => this.close(false), '12px');
      cancel.container.setDepth(DEPTH + 1);
      this.buttons.push(cancel);
    }
    scene.input.on('pointerdown', this.onDown, this);
    scene.input.on('pointermove', this.onMove, this);
    scene.input.on('pointerup', this.onUp, this);
    this.redraw();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** 지금 초안 → Formation (빈 칸을 당겨 붙임, 빈 팀은 core가 정리) */
  private formation(): Formation {
    const f = (side: SideKey) => this.draft[side].map((t) => t.filter((x): x is string => x !== null));
    return { offense: f('offense'), defense: f('defense') };
  }

  private slotRect(team: number, slot: number): Rect {
    return { x: SLOT_X0 + slot * (SLOT_W + 4), y: ROW_Y + team * ROW_H, w: SLOT_W, h: SLOT_H };
  }

  private cardRect(i: number): Rect {
    return { x: 8 + (i % 4) * (CARD_W + 5), y: CARDS_Y + Math.floor(i / 4) * (CARD_H + 6), w: CARD_W, h: CARD_H };
  }

  private whereOf(id: string): Where {
    for (const side of SIDES)
      for (let t = 0; t < this.draft[side].length; t++) {
        const k = this.draft[side][t].indexOf(id);
        if (k >= 0) return { side, team: t, slot: k };
      }
    return null;
  }

  private add<T extends Phaser.GameObjects.GameObject>(o: T): T {
    (o as unknown as Phaser.GameObjects.Components.Depth).setDepth?.(DEPTH + 2);
    this.dyn.push(o);
    return o;
  }

  private redraw(): void {
    for (const o of this.dyn) o.destroy();
    this.dyn = [];
    const s = this.scene;
    const bonds = activeBonds(this.data, this.formation());
    const teams = this.draft[this.tab];
    teams.forEach((t, ti) => {
      const y = ROW_Y + ti * ROW_H;
      this.add(text(s, 10, y + SLOT_H / 2, `${ti + 1}팀`, { fontSize: '11px', color: '#cfd6ea' }).setOrigin(0, 0.5));
      t.forEach((id, k) => {
        const r = this.slotRect(ti, k);
        this.add(s.add.rectangle(r.x, r.y, r.w, r.h, id ? 0x3d4459 : 0x252a37).setOrigin(0).setStrokeStyle(1, COLOR.cellLine));
        if (!id) {
          this.add(text(s, r.x + r.w / 2, r.y + r.h / 2, ORDER_LABEL[k], { fontSize: '9px', color: '#5d6a91' }).setOrigin(0.5));
          return;
        }
        this.drawHero(id, r.x + r.w / 2, r.y + r.h / 2, true);
        // 이 칸 쪽 적성 (☀ 공격대 = 낮 / ☾ 수비대 = 밤)
        const apt = this.state.heroDef(id).aptitude[this.tab === 'offense' ? 'day' : 'night'];
        this.add(text(s, r.x + r.w - 3, r.y + 2, `${this.tab === 'offense' ? '☀' : '☾'}${apt}`, { fontSize: '8px', color: APT_COLOR[apt], fontStyle: 'bold' }).setOrigin(1, 0));
      });
      // 이 팀에 켜진 인연 (해와 달처럼 양쪽에 걸친 인연은 해당 영웅이 있는 팀에)
      const tags = bonds.filter((b) => (b.side === this.tab && b.team === ti) || (b.side === null && t.some((id) => id && b.heroes.includes(id))));
      if (tags.length) {
        this.add(
          text(s, SLOT_X0 + 3 * (SLOT_W + 4) + 2, y + SLOT_H / 2, tags.map((b) => `♥${b.bond.name}`).join('\n'), {
            fontSize: '8px',
            color: '#ffb6c8',
            lineSpacing: 1,
          }).setOrigin(0, 0.5),
        );
      }
    });
    // 영웅 카드 (보유 영웅 전부, 배치된 곳 표시)
    this.state.owned.forEach((id, i) => {
      const r = this.cardRect(i);
      const w = this.whereOf(id);
      this.add(s.add.rectangle(r.x, r.y, r.w, r.h, w ? 0x262b38 : 0x3d4459).setOrigin(0).setStrokeStyle(1, w ? 0x444b60 : COLOR.mirror));
      this.drawHero(id, r.x + 14, r.y + r.h / 2, false);
      const def = this.state.heroDef(id);
      const pr = this.state.progressOf(id);
      this.add(text(s, r.x + 28, r.y + 4, def.name, { fontSize: '10px', color: '#ffffff', fontStyle: 'bold' }));
      this.add(text(s, r.x + 28, r.y + 16, `Lv${pr.level} · ${pr.star}★`, { fontSize: '8px', color: '#ffe08a' }));
      this.add(text(s, r.x + 28, r.y + 27, `${ROLE_LABEL[def.role]}·${def.attackType === 'melee' ? '근접' : '원거리'}`, { fontSize: '7px', color: '#cfd6ea' }));
      // ☀/☾ 적성: 배치된 쪽을 굵게
      (['day', 'night'] as const).forEach((k, j) => {
        const on = w && (k === 'day') === (w.side === 'offense');
        this.add(
          text(s, r.x + r.w - 3 - (1 - j) * 20, r.y + r.h - 12, `${k === 'day' ? '☀' : '☾'}${def.aptitude[k]}`, {
            fontSize: on ? '9px' : '8px',
            color: APT_COLOR[def.aptitude[k]],
            fontStyle: on ? 'bold' : 'normal',
          }).setOrigin(1, 0),
        );
      });
      const where = w ? `${w.side === 'offense' ? '☀' : '☾'}${w.team + 1}팀 ${['앞', '중', '뒤'][w.slot]}` : '대기';
      const bondNames = this.data.bonds.bonds.filter((b) => (b.kind === 'sameTeam' ? b.heroes.includes(id) : b.kind === 'split' ? b.offense === id || b.defense === id : false)).map((b) => b.name);
      this.add(text(s, r.x + 4, r.y + 38, where, { fontSize: '7px', color: w ? '#9fb4e0' : '#8a8f9e' }));
      // 이 영웅이 낄 수 있는 인연: 하나면 이름, 둘 이상이면 개수 (이름과 겹치지 않게). 켜진 인연 이름은 팀 줄 오른쪽에
      if (bondNames.length) {
        const tag = bondNames.length === 1 ? `♥${bondNames[0]}` : `♥×${bondNames.length}`;
        this.add(text(s, r.x + r.w - 3, r.y + 4, tag, { fontSize: '7px', color: '#ffb6c8' }).setOrigin(1, 0));
      }
    });
  }

  private drawHero(id: string, x: number, y: number, withName: boolean): void {
    const s = this.scene;
    const def = this.state.heroDef(id);
    this.add(s.add.circle(x, withName ? y - 5 : y, 10, heroChainColor(this.data, id)).setStrokeStyle(2, def.attackType === 'ranged' ? 0xf2c94c : 0x1b1d24));
    this.add(text(s, x, withName ? y - 5 : y, def.name.slice(0, 1), { fontSize: '10px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5));
    if (withName) this.add(text(s, x, y + 12, def.name, { fontSize: '8px', color: '#e8e8e8' }).setOrigin(0.5));
  }

  private world(p: Phaser.Input.Pointer): Phaser.Math.Vector2 {
    return this.scene.cameras.main.getWorldPoint(p.x, p.y);
  }

  private hitSlot(x: number, y: number): Where {
    for (let t = 0; t < this.draft[this.tab].length; t++)
      for (let k = 0; k < this.draft[this.tab][t].length; k++) if (inRect(this.slotRect(t, k), x, y)) return { side: this.tab, team: t, slot: k };
    return null;
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.closed || this.drag || this.detail) return;
    const w = this.world(p);
    let id: string | null = null;
    let from: Where = null;
    let card = false;
    const slot = this.hitSlot(w.x, w.y);
    if (slot) {
      id = this.draft[slot.side][slot.team][slot.slot];
      from = slot;
    } else {
      this.state.owned.forEach((h, i) => {
        if (inRect(this.cardRect(i), w.x, w.y)) {
          id = h;
          from = this.whereOf(h);
          card = true;
        }
      });
    }
    if (!id) return;
    const def = this.state.heroDef(id);
    const ghost = this.scene.add
      .container(w.x, w.y, [
        this.scene.add.circle(0, 0, 12, heroChainColor(this.data, id)).setStrokeStyle(2, 0xffffff),
        text(this.scene, 0, 0, def.name.slice(0, 1), { fontSize: '11px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5),
      ])
      .setDepth(DEPTH + 5);
    this.drag = { id, from, ghost, card, x: w.x, y: w.y };
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (!this.drag) return;
    const w = this.world(p);
    this.drag.ghost.setPosition(w.x, w.y);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost.destroy();
    const w = this.world(p);
    // 카드 탭 → 영웅 상세 (§5.22-7)
    if (d.card && Math.hypot(w.x - d.x, w.y - d.y) < TAP_PX) {
      this.openDetail(d.id);
      return;
    }
    const to = this.hitSlot(w.x, w.y);
    const put = (at: Where, id: string | null) => {
      if (at) this.draft[at.side][at.team][at.slot] = id;
    };
    if (to) {
      const there = this.draft[to.side][to.team][to.slot];
      if (d.from && d.from.side === to.side && d.from.team === to.team && d.from.slot === to.slot) return;
      put(d.from, there); // 칸끼리 바꾸기 (카드에서 왔고 원래 자리가 없으면 밀려난 영웅은 대기로)
      put(to, d.id);
    } else if (d.from && w.y < CARDS_Y - 6) {
      // 팀 줄 영역 안의 빈 곳에 놓음 → 그대로
      return;
    } else if (d.from) {
      put(d.from, null); // 밖으로 빼기
    }
    this.error.setText('');
    this.redraw();
  }

  private openDetail(id: string): void {
    this.detail = new HeroDetailView(this.scene, this.state, this.data, id, (r) => {
      this.detail = null;
      if (r.restarted) this.restarted = true;
      this.redraw();
    });
  }

  private confirm(): void {
    const r = this.state.setFormation(this.formation());
    if (!r.ok) {
      this.error.setText(r.reason);
      return;
    }
    this.close(r.restarted || this.restarted);
  }

  close(restarted = false): void {
    if (this.closed) return;
    this.closed = true;
    this.scene.input.off('pointerdown', this.onDown, this);
    this.scene.input.off('pointermove', this.onMove, this);
    this.scene.input.off('pointerup', this.onUp, this);
    this.drag?.ghost.destroy();
    this.detail?.close();
    for (const o of [...this.objs, ...this.dyn]) o.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.onClose({ restarted });
  }
}

// 영웅 상세 (§5.22-7): 편성 화면에서 카드 탭. 초상·이름·역할·공격 방식·☀/☾ 적성·Lv + 경험치 막대·★ + [진급](별가루)·
// 고유 스킬(지금 ★ 값 → 다음 ★ 값)·배우는 칸 1~2(잠김 조건, 탭하면 비법서 바꾸기)·[잉크 붓기](10 / 다음 레벨까지).
// 잉크 붓기·진급은 전투 밖에서만(core가 거절), 비법서는 언제든(전투 중이면 core가 단계 재시작). 도형 + 텍스트만.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { levelNeed, skillAtStar } from '../core/roster';
import type { Aptitude, GameData, SkillDef } from '../data/types';
import { heroChainColor } from './laneUnits';
import { VIEW_H, VIEW_W } from './layout';
import { Button, text } from './ui';
import { countUi } from '../metrics/scene';

const DEPTH = 90;
const ROLE_LABEL: Record<string, string> = { tank: '탱커', attack: '공격', support: '서포트' };
const APT_COLOR: Record<Aptitude, string> = { S: '#ffd36b', A: '#cfd6ea', B: '#ff9e9e' };

/** 고유 스킬 한 줄 설명 (그 ★ 값) */
export function skillLine(sk: SkillDef): string {
  switch (sk.kind) {
    case 'strike':
      return `앞의 적 ${sk.pierce}마리에 공격 ×${sk.mult}`;
    case 'ward':
      return `가까운 적 ${sk.stunSeconds}초 정지 + 팀 보호막 ${Math.round(sk.shieldPct * 100)}%`;
    case 'beam':
      return `모든 적에 공격 ×${sk.mult}`;
    case 'mend':
      return `팀 hp ${Math.round(sk.healPct * 100)}% 회복 + 쓰러진 팀원 ${sk.revive}명 일으킴`;
  }
}

export class HeroDetailView {
  private readonly objs: Phaser.GameObjects.GameObject[] = [];
  private dyn: Phaser.GameObjects.GameObject[] = [];
  private buttons: Button[] = [];
  private closed = false;
  private msg = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly heroId: string,
    private readonly onClose: (r: { restarted: boolean }) => void,
  ) {
    const bg = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0e1016, 0.98).setOrigin(0).setDepth(DEPTH).setInteractive();
    this.objs.push(bg);
    countUi(scene, 'heroDetailOpened');
    this.draw();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private add<T extends Phaser.GameObjects.GameObject>(o: T): T {
    (o as unknown as Phaser.GameObjects.Components.Depth).setDepth?.(DEPTH + 1);
    this.dyn.push(o);
    return o;
  }

  private t(x: number, y: number, s: string, style: Phaser.Types.GameObjects.Text.TextStyle = {}): Phaser.GameObjects.Text {
    return this.add(text(this.scene, x, y, s, { fontSize: '11px', color: '#e8e8e8', ...style }));
  }

  private btn(x: number, y: number, w: number, label: string, onClick: () => void, enabled = true, h = 26): Button {
    const b = new Button(this.scene, x, y, w, h, label, onClick, '11px');
    b.container.setDepth(DEPTH + 2);
    b.setEnabled(enabled);
    this.buttons.push(b);
    return b;
  }

  private draw(): void {
    for (const o of this.dyn) o.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.dyn = [];
    this.buttons = [];
    const s = this.state;
    const id = this.heroId;
    const def = s.heroDef(id);
    const p = s.progressOf(id);
    const cfg = this.data.balance;
    const out = s.atBoundary;
    const L = 20;

    // 머리: 초상·이름·역할·적성
    this.add(this.scene.add.circle(52, 62, 28, heroChainColor(this.data, id)).setStrokeStyle(3, def.attackType === 'ranged' ? 0xf2c94c : 0x1b1d24));
    this.t(52, 62, def.name.slice(0, 1), { fontSize: '22px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    this.t(92, 34, def.name, { fontSize: '17px', fontStyle: 'bold', color: '#ffffff' });
    this.t(92, 58, `${ROLE_LABEL[def.role]} · ${def.attackType === 'melee' ? '근접' : '원거리'}`, { color: '#cfd6ea' });
    const a = def.aptitude;
    const side = s.sideOfHero(id);
    const inForm = s.formation.offense.some((t) => t.includes(id)) || s.formation.defense.some((t) => t.includes(id));
    const aptTxt = (k: 'day' | 'night') => `${k === 'day' ? '☀' : '☾'}${a[k]} ×${cfg.aptitude[a[k]]}`;
    this.t(92, 78, aptTxt('day'), { color: APT_COLOR[a.day], fontStyle: inForm && side === 'offense' ? 'bold' : 'normal' });
    this.t(172, 78, aptTxt('night'), { color: APT_COLOR[a.night], fontStyle: inForm && side === 'defense' ? 'bold' : 'normal' });
    if (inForm) this.t(250, 78, side === 'offense' ? '(공격대)' : '(수비대)', { fontSize: '9px', color: '#9fb4e0' });

    // 레벨 + 경험치 막대
    let y = 112;
    const need = p.level >= cfg.exp.maxLevel ? 0 : levelNeed(cfg.exp, p.level);
    this.t(L, y, `Lv ${p.level}${p.level >= cfg.exp.maxLevel ? ' (최고)' : ''}`, { fontSize: '13px', fontStyle: 'bold' });
    const bw = 200;
    this.add(this.scene.add.rectangle(110, y + 9, bw, 8, 0x1b1d24).setOrigin(0, 0.5).setStrokeStyle(1, 0x566081));
    this.add(this.scene.add.rectangle(110, y + 9, need ? bw * Math.min(1, p.exp / need) : bw, 8, 0x9fe0a0).setOrigin(0, 0.5));
    this.t(110 + bw, y + 16, need ? `${Math.floor(p.exp)} / ${need}` : '—', { fontSize: '9px', color: '#9aa1b5' }).setOrigin(1, 0);
    y += 34;
    const ink = Math.floor(s.ink);
    const toNext = s.inkToNext(id);
    this.t(L, y + 4, `잉크 ${ink}`, { color: '#9fd8ff' });
    const canPour = out && ink > 0 && toNext > 0;
    this.btn(150, y + 10, 92, `잉크 ${cfg.ink.pourStep} 붓기`, () => this.pour(cfg.ink.pourStep), canPour);
    this.btn(270, y + 10, 128, `다음 레벨까지 (${toNext})`, () => this.pour(toNext), canPour);
    y += 30;
    this.t(L, y, `잉크 1 = 경험치 ${cfg.ink.expPerInk}${out ? '' : ' · 붓기·진급은 전투 밖에서만'}`, { fontSize: '9px', color: out ? '#7d86a0' : '#ffb46b' });

    // 성급
    y += 26;
    const stars = '★'.repeat(p.star) + '☆'.repeat(cfg.star.maxStar - p.star);
    this.t(L, y, stars, { fontSize: '16px', color: '#ffd36b' });
    const cost = s.promoteCost(id);
    this.t(L, y + 22, `별가루 ${s.stardust}`, { fontSize: '10px', color: '#ffe08a' });
    this.btn(270, y + 12, 128, cost === null ? '최고 ★' : `진급 (별가루 ${cost})`, () => this.promote(), cost !== null && out && s.stardust >= cost);

    // 고유 스킬 (지금 ★ → 다음 ★)
    y += 48;
    const sk = s.skillOf(id);
    this.t(L, y, `고유 스킬 · ${sk.name}`, { fontSize: '12px', fontStyle: 'bold', color: '#9fe0ff' });
    y += 18;
    this.t(L, y, `${p.star}★  ${skillLine(sk)} · 게이지 ${sk.gauge}`, { fontSize: '10px', wordWrap: { width: VIEW_W - 40 } });
    y += 16;
    if (p.star < cfg.star.maxStar) {
      const nx = skillAtStar(def, p.star + 1);
      this.t(L, y, `${p.star + 1}★  ${skillLine(nx)} · 게이지 ${nx.gauge}`, { fontSize: '10px', color: '#7d86a0', wordWrap: { width: VIEW_W - 40 } });
    }
    this.t(L, y + 16, '★은 고유 스킬만 강해진다 (머지로 게이지를 채우면 발동)', { fontSize: '8px', color: '#5d6a91' });

    // 배우는 칸
    y += 42;
    this.t(L, y, '배우는 스킬 (비법서)', { fontSize: '12px', fontStyle: 'bold', color: '#ffb6c8' });
    y += 20;
    const slots = s.slotsOf(id);
    const locks = [`Lv ${cfg.learn.levelSlot}에 열림`, `${cfg.learn.starSlot}★에 열림`];
    const eq = s.equipped[id] ?? [];
    for (let k = 0; k < 2; k++) {
      const open = k < slots;
      const book = open ? (eq[k] ?? null) : null;
      const label = !open ? `🔒 ${locks[slots === 0 ? k : 1]}` : book ? `${s.bookDef(book).name} (${s.bookDef(book).kind === 'start' ? '시작형' : '상시형'})` : '(비어 있음 · 탭해서 끼우기)';
      this.btn(VIEW_W / 2, y + 14, VIEW_W - 40, label, () => this.cycle(k), open && s.ownedBooks.length > 0, 28);
      if (book) this.t(L + 4, y + 30, s.bookDef(book).desc, { fontSize: '8px', color: '#9aa1b5' });
      y += 46;
    }
    if (!s.ownedBooks.length) this.t(L, y - 4, '비법서는 챕터를 완성하면 얻는다 (10장 모두 흠집 없음 → 숨은 비법서)', { fontSize: '8px', color: '#5d6a91' });
    if (this.msg) this.t(VIEW_W / 2, VIEW_H - 70, this.msg, { fontSize: '10px', color: '#ffb46b' }).setOrigin(0.5);
    this.btn(VIEW_W / 2, VIEW_H - 36, 120, '닫기', () => this.close(), true, 30);
  }

  private pour(n: number): void {
    const r = this.state.pourInk(this.heroId, n);
    if (r.spent > 0) countUi(this.scene, 'inkPoured', r.spent);
    this.msg = r.spent ? `잉크 ${r.spent} → 경험치 ${r.spent * this.data.balance.ink.expPerInk}${r.levels ? ` · 레벨 업!` : ''}` : '';
    this.draw();
  }

  private promote(): void {
    if (this.state.promote(this.heroId)) this.msg = `${this.state.progressOf(this.heroId).star}★ 진급!`;
    this.draw();
  }

  private restarted = false;

  /** 칸 탭: 빈 칸 → 가진 비법서 차례로 → 빈 칸 (다른 영웅이 끼고 있으면 옮겨 옴) */
  private cycle(slot: number): void {
    const s = this.state;
    const books = s.ownedBooks;
    const cur = (s.equipped[this.heroId] ?? [])[slot] ?? null;
    const i = cur === null ? -1 : books.indexOf(cur);
    const next = i + 1 < books.length ? books[i + 1] : null;
    const holder = next ? s.bookHolder(next) : null;
    const r = s.equip(this.heroId, slot, next);
    if (r.ok && r.restarted) this.restarted = true;
    this.msg = !r.ok ? r.reason : r.restarted ? '전투 중에 바꿔서 지금 단계를 처음부터' : holder && holder !== this.heroId ? `${s.heroDef(holder).name}에게서 옮겨 왔다` : '';
    this.draw();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const o of [...this.objs, ...this.dyn]) o.destroy();
    for (const b of this.buttons) b.container.destroy();
    this.onClose({ restarted: this.restarted });
  }
}

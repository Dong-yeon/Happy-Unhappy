// 초상 선반 (전장 아래 띠, layout REGION.shelf): 왼쪽 "N팀 출격"(릴레이 교대 때 0.3초 슬라이드) + 켜진 인연,
// 오른쪽 정렬로 지금 레인 팀(전투 밖이면 다음에 나갈 공격대 팀) 영웅 초상 3개 (지름 40, 간격 8, 오른쪽 여백 8).
// 초상 둘레 = 스킬 게이지, 초상 아래 = HP 막대(3px) + 체인 이름(9px, 그림 밖). 자동 모드는 표시만, 수동 모드([자동] 끔)는 탭 = 스킬 (castReady).
// 상태는 core에서 읽기만 한다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { GameData } from '../data/types';
import { heroChainColor, heroName } from './laneUnits';
import { skinOf } from './skin/Skin';
import { REGION, SKILL_BTN_R, skillButtonCenter } from './layout';
import { text } from './ui';

const DEPTH = 12;
const RING_W = 3;
const GAUGE_COLOR = 0xe8c56a;
const READY_COLOR = 0xffffff;
const HP_W = SKILL_BTN_R * 2 - 4;
const HP_H = 3;
/** 선반 띠 어둡기 */
const SHELF_ALPHA = 0.32;
/** 릴레이 교대 슬라이드 */
const SLIDE_MS = 300;
const SLIDE_PX = 40;
const LABEL_X = 8;

interface Orb {
  container: Phaser.GameObjects.Container;
  disc: Phaser.GameObjects.Arc;
  initial: Phaser.GameObjects.Text;
  chain: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Graphics;
  glow: Phaser.GameObjects.Arc;
  hp: Phaser.GameObjects.Rectangle;
  heroId: string | null;
  /** 스킨 초상 (§5.23-1: 영웅 그림 + 게이지 테두리) */
  portrait: Phaser.GameObjects.Image | null;
  /** 초상 원 모양 마스크 (화면 좌표, 초상 위치가 바뀔 때 다시 만듦) */
  mask: Phaser.GameObjects.Graphics | null;
  /** 마지막으로 그린 게이지 비율·준비 여부 (같으면 다시 그리지 않음) */
  drawn: string;
  /** 지금 보이는 게이지 비율 (이어받기 때 차오르는 연출용) */
  shown: number;
}

/** 이어받기 게이지: 조각이 책에 들어간 뒤(0.4초) 이 속도(비율/초)로 차오름 */
const HANDOVER_DELAY_MS = 400;
const HANDOVER_FILL_PER_S = 1.6;

export class SkillButtonsView {
  private readonly orbs: Orb[] = [];
  private readonly teamLabel: Phaser.GameObjects.Text;
  private readonly bonds: Phaser.GameObjects.Text;
  private key = '';
  /** 이어받기 연출: 이 시각까지는 게이지를 그대로 두었다가 차오르게 */
  private fillFrom = 0;
  private filling = false;
  /** 이어받기 전 게이지 비율 (새 팀 초상이 여기서부터 차오름) */
  private readonly fillStart = new Map<string, number>();
  private lastNow = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    teamSize: number,
  ) {
    const sh = REGION.shelf;
    scene.add.rectangle(sh.x, sh.y, sh.w, sh.h, 0x000000, SHELF_ALPHA).setOrigin(0).setDepth(2);
    scene.add.rectangle(sh.x, sh.y, sh.w, 1, 0x000000, 0.35).setOrigin(0).setDepth(2);
    this.teamLabel = text(scene, LABEL_X, sh.y + 14, '', { fontSize: '11px', color: '#e8e8e8', fontStyle: 'bold' }).setOrigin(0, 0.5).setDepth(DEPTH);
    this.bonds = text(scene, LABEL_X, sh.y + 31, '', { fontSize: '9px', color: '#ffd1dc' }).setOrigin(0, 0.5).setDepth(DEPTH);
    const r = SKILL_BTN_R;
    for (let i = 0; i < teamSize; i++) {
      const shadow = scene.add.circle(0, 2, r + RING_W, 0x000000, 0.45);
      const glow = scene.add.circle(0, 0, r + RING_W + 3, READY_COLOR, 0.35).setVisible(false);
      const track = scene.add.circle(0, 0, r + RING_W / 2, 0x000000, 0).setStrokeStyle(RING_W, 0x1b1d24, 0.9);
      const ring = scene.add.graphics();
      const disc = scene.add.circle(0, 0, r, 0xffffff).setInteractive({ useHandCursor: true });
      const initial = text(scene, 0, 0, '', { fontSize: '14px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
      // 초상 아래: HP 막대 + 체인 이름 (그림 밖)
      const hpY = r + RING_W + 2;
      const hpBg = scene.add.rectangle(-HP_W / 2, hpY, HP_W, HP_H, 0x1b1d24).setOrigin(0, 0);
      const hp = scene.add.rectangle(-HP_W / 2, hpY, HP_W, HP_H, 0x7ed67e).setOrigin(0, 0);
      const chain = text(scene, 0, hpY + HP_H + 1, '', { fontSize: '9px', color: '#e8e8e8' }).setOrigin(0.5, 0);
      const container = scene.add.container(0, 0, [shadow, glow, track, ring, disc, initial, hpBg, hp, chain]).setDepth(DEPTH);
      const orb: Orb = { container, disc, initial, chain, ring, glow, hp, heroId: null, portrait: null, mask: null, drawn: '', shown: 0 };
      disc.on('pointerup', () => {
        if (orb.heroId) this.state.castReady(orb.heroId);
      });
      this.orbs.push(orb);
    }
    this.sync();
  }

  /** 스킬 발동 → 그 초상 번쩍 / 릴레이 교대 → 팀 표시 슬라이드 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'teamSwap') {
        this.slideLabel();
        continue;
      }
      if (e.type === 'handover' && e.amount > 0) {
        // 회수 조각이 책에 빨려 들어간 뒤 새 팀 게이지가 차오른다
        this.fillFrom = this.scene.time.now + HANDOVER_DELAY_MS;
        this.filling = true;
        for (const g of e.gauges) this.fillStart.set(g.heroId, Math.max(0, g.gauge - e.amount / e.gauges.length) / g.max);
        continue;
      }
      if (e.type !== 'skill') continue;
      const o = this.orbs.find((x) => x.heroId === e.heroId);
      if (!o) continue;
      o.container.setScale(1.18);
      this.scene.tweens.add({ targets: o.container, scale: 1, duration: 250 });
    }
  }

  /** 초상 i번째 중심 (화면) — 회수 조각이 날아갈 곳 등 */
  orbCenter(heroId: string): { x: number; y: number } | null {
    const o = this.orbs.find((x) => x.heroId === heroId && x.container.visible);
    return o ? { x: o.container.x, y: o.container.y } : null;
  }

  /** "2팀 출격": 왼쪽에서 0.3초 미끄러져 들어옴 */
  private slideLabel(): void {
    this.syncLabel();
    this.scene.tweens.killTweensOf(this.teamLabel);
    this.teamLabel.setX(LABEL_X - SLIDE_PX).setAlpha(0);
    this.scene.tweens.add({ targets: this.teamLabel, x: LABEL_X, alpha: 1, duration: SLIDE_MS, ease: 'Cubic.easeOut' });
  }

  private syncLabel(): void {
    const s = this.state;
    const fighting = s.phase === 'day' || s.phase === 'night';
    const tl = fighting ? `${s.activeTeam[s.laneRole] + 1}팀 출격` : '';
    if (this.teamLabel.text !== tl) this.teamLabel.setText(tl);
  }

  sync(): void {
    const s = this.state;
    const role = s.laneRole;
    const ids = s.activeTeamIds(role);
    const team = s.activeTeam[role];
    this.syncLabel();
    const bonds = s.bonds.filter((b) => (b.side === role && b.team === team) || (b.side === null && ids.some((id) => b.heroes.includes(id))));
    // 아래 줄: "2팀 대기 · 쓰러짐 n(낮) · ♥인연"
    const fighting = s.phase === 'day' || s.phase === 'night';
    const teams = s.teams(role).length;
    const size = ids.length;
    const alive = s.teamUnits(role).filter((u) => u.role === 'hero').length;
    const parts: string[] = [];
    if (fighting && team + 1 < teams) parts.push(`${team + 2}팀 대기`);
    if (s.phase === 'day' && alive < size) parts.push(`쓰러짐 ${size - alive}`);
    parts.push(...bonds.map((b) => `♥${b.bond.name}`));
    const bl = parts.join(' · ');
    if (this.bonds.text !== bl) this.bonds.setText(bl);
    const key = ids.join(',');
    this.orbs.forEach((o, i) => {
      const id = ids[i] ?? null;
      o.container.setVisible(id !== null);
      if (o.disc.input) o.disc.input.enabled = id !== null;
      if (!id) {
        o.heroId = null;
        return;
      }
      if (key !== this.key) {
        const p = skillButtonCenter(i, ids.length);
        o.container.setPosition(p.x, p.y);
        o.heroId = id;
        o.disc.setFillStyle(heroChainColor(this.data, id));
        o.initial.setText(heroName(this.data, id).slice(0, 1));
        // 스킨이면 영웅 초상 그림을 원 안에 (게이지 테두리는 그대로)
        o.portrait?.destroy();
        o.portrait = null;
        const skin = skinOf(this.scene);
        if (skin.has(`hero.${id}`)) {
          // 초상 크롭: 그림을 원보다 크게(정수 배율 반올림) 넣고 원 모양 마스크로 자른다 (얼굴 위주)
          o.portrait = skin.image(this.scene, `hero.${id}`, 0, 4, SKILL_BTN_R * 2, true);
          o.container.addAt(o.portrait, o.container.getIndex(o.disc) + 1);
          o.mask?.destroy();
          o.mask = this.scene.make.graphics({}, false).fillCircle(p.x, p.y, SKILL_BTN_R - 1);
          o.portrait.setMask(o.mask.createGeometryMask());
          o.initial.setText('');
        }
        const c = this.data.chains.find((x) => x.archetypeId === s.heroDef(id).chain);
        o.chain.setText(c?.name ?? ''); // 체인 이름 (뼈다귀·방울·떡·동아줄)
        o.drawn = '';
      }
      const def = s.heroDef(id);
      const actual = Math.min(1, s.progressOf(id).gauge / def.skill.gauge);
      const now = this.scene.time.now;
      const start = this.fillStart.get(id);
      if (start !== undefined) {
        o.shown = Math.min(actual, start);
        this.fillStart.delete(id);
      }
      if (this.filling && actual > o.shown) {
        if (now >= this.fillFrom) o.shown = Math.min(actual, o.shown + (HANDOVER_FILL_PER_S * Math.max(0, now - this.lastNow)) / 1000);
      } else o.shown = actual;
      const ratio = o.shown;
      const ready = !s.autoSkill && s.skillReady(id);
      const unit = s.heroUnit(id);
      const down = s.timeFlows && !unit;
      o.container.setAlpha(down ? 0.4 : 1);
      o.hp.width = HP_W * (unit ? Math.max(0, Math.min(1, unit.hp / unit.maxHp)) : down ? 0 : 1);
      o.glow.setVisible(ready);
      if (ready) o.glow.setAlpha(0.25 + 0.2 * Math.sin(this.scene.time.now / 120));
      const drawn = `${ratio.toFixed(3)}:${ready}`;
      if (drawn === o.drawn) return;
      o.drawn = drawn;
      o.ring.clear();
      if (ratio > 0) {
        o.ring.lineStyle(RING_W, ready ? READY_COLOR : GAUGE_COLOR, 1);
        o.ring.beginPath();
        o.ring.arc(0, 0, SKILL_BTN_R + RING_W / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio, false);
        o.ring.strokePath();
      }
    });
    this.key = key;
    const now = this.scene.time.now;
    if (this.filling && now >= this.fillFrom && this.orbs.every((o) => !o.heroId || o.shown >= Math.min(1, s.progressOf(o.heroId).gauge / s.heroDef(o.heroId).skill.gauge) - 1e-6)) this.filling = false;
    this.lastNow = now;
  }
}

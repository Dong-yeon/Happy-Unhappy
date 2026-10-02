// 원형 스킬 버튼 (§5.20-13, D-064): 전장과 머지 판 경계에 떠 있는 지금 레인 팀(전투 밖이면 다음에 나갈 공격대 팀) 영웅 초상 3개.
// 둘레 = 스킬 게이지, 아래 작은 글씨 = 자기 체인. 수동 모드([자동] 끔)에서 게이지가 찬 영웅은 빛나고 탭하면 발동.
// 판 왼쪽 위에 이 팀에 켜진 인연. 별도 "지금 팀" 줄·박스 없음. 도형 + 텍스트만, 상태는 core에서 읽기만 한다 (발동은 castReady).
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import type { GameData } from '../data/types';
import { chainShortName, heroChainColor, heroName } from './laneUnits';
import { REGION, SKILL_BTN_R, skillButtonCenter } from './layout';
import { text } from './ui';

const DEPTH = 12;
const RING_W = 4;
const GAUGE_COLOR = 0xe8c56a;
const READY_COLOR = 0xffffff;

interface Orb {
  container: Phaser.GameObjects.Container;
  disc: Phaser.GameObjects.Arc;
  initial: Phaser.GameObjects.Text;
  chain: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Graphics;
  glow: Phaser.GameObjects.Arc;
  heroId: string | null;
  /** 마지막으로 그린 게이지 비율·준비 여부 (같으면 다시 그리지 않음) */
  drawn: string;
}

export class SkillButtonsView {
  private readonly orbs: Orb[] = [];
  private readonly bonds: Phaser.GameObjects.Text;
  private key = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    teamSize: number,
  ) {
    this.bonds = text(scene, REGION.board.x + 8, REGION.board.y + 6, '', { fontSize: '9px', color: '#ffb6c8' }).setDepth(DEPTH);
    for (let i = 0; i < teamSize; i++) {
      const shadow = scene.add.circle(0, 2, SKILL_BTN_R + RING_W, 0x000000, 0.45);
      const glow = scene.add.circle(0, 0, SKILL_BTN_R + RING_W + 3, READY_COLOR, 0.35).setVisible(false);
      const track = scene.add.circle(0, 0, SKILL_BTN_R + RING_W / 2, 0x000000, 0).setStrokeStyle(RING_W, 0x1b1d24, 0.9);
      const ring = scene.add.graphics();
      const disc = scene.add.circle(0, 0, SKILL_BTN_R, 0xffffff).setInteractive({ useHandCursor: true });
      const initial = text(scene, 0, 0, '', { fontSize: '14px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
      const chain = text(scene, 0, SKILL_BTN_R + RING_W + 1, '', { fontSize: '9px', color: '#9aa1b5' }).setOrigin(0.5, 0);
      const container = scene.add.container(0, 0, [shadow, glow, track, ring, disc, initial, chain]).setDepth(DEPTH);
      const orb: Orb = { container, disc, initial, chain, ring, glow, heroId: null, drawn: '' };
      disc.on('pointerup', () => {
        if (orb.heroId) this.state.castReady(orb.heroId);
      });
      this.orbs.push(orb);
    }
    this.sync();
  }

  /** 스킬 발동 → 그 버튼 번쩍 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type !== 'skill') continue;
      const o = this.orbs.find((x) => x.heroId === e.heroId);
      if (!o) continue;
      o.container.setScale(1.18);
      this.scene.tweens.add({ targets: o.container, scale: 1, duration: 250 });
    }
  }

  sync(): void {
    const s = this.state;
    const role = s.laneRole;
    const ids = s.activeTeamIds(role);
    const team = s.activeTeam[role];
    const bonds = s.bonds.filter((b) => (b.side === role && b.team === team) || (b.side === null && ids.some((id) => b.heroes.includes(id))));
    const bl = bonds.map((b) => `♥${b.bond.name}`).join(' ');
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
        const c = this.data.chains.find((x) => x.archetypeId === s.heroDef(id).chain);
        o.chain.setText(c ? chainShortName(c) : '');
        o.drawn = '';
      }
      const def = s.heroDef(id);
      const ratio = Math.min(1, s.progressOf(id).gauge / def.skill.gauge);
      const ready = !s.autoSkill && s.skillReady(id);
      const down = s.timeFlows && !s.heroUnit(id);
      o.container.setAlpha(down ? 0.4 : 1);
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
  }
}

// 레인 우리 편 표시 (§5.17-9, [11]-5, 도형만): 영웅 = 초상 원 + 이름 첫 글자 + hp 바 + 기세 표시 /
// 병사 = 영웅보다 작은 사각형 + 체인 색 + 단 + 얇은 수명 바. 두 레인 뷰가 같이 쓴다.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { Unit } from '../core/lane';
import type { GameData } from '../data/types';
import { COLOR, text } from './ui';

const HERO_R = 11;
const SOLDIER = 10;
const HP_W = 22;
const S_HP_W = 12;

export interface UnitView {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Shape;
  hp: Phaser.GameObjects.Rectangle;
  hpW: number;
  /** 병사 수명 바 */
  life: Phaser.GameObjects.Rectangle | null;
  /** 영웅 기세 표시 */
  momentum: Phaser.GameObjects.Text | null;
  color: number;
}

/** 영웅 초상 색: 낮덱 = 해, 밤덱 = 달 */
export function heroColor(role: Role): number {
  return role === 'offense' ? COLOR.happy : COLOR.unhappy;
}

export function heroName(data: GameData, id: string): string {
  return data.heroes.heroes.find((h) => h.id === id)?.name ?? id;
}

export function makeUnitView(scene: Phaser.Scene, data: GameData, u: Unit, role: Role): UnitView {
  if (u.role === 'hero') {
    const color = heroColor(role);
    const body = scene.add.circle(0, 0, HERO_R, color).setStrokeStyle(2, 0x1b1d24);
    const label = text(scene, 0, 0, heroName(data, u.chain).slice(0, 1), { fontSize: '11px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    const bg = scene.add.rectangle(-HP_W / 2, HERO_R + 4, HP_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const hp = scene.add.rectangle(-HP_W / 2, HERO_R + 4, HP_W, 3, 0x7ed67e).setOrigin(0, 0.5);
    const momentum = text(scene, 0, -HERO_R - 7, '', { fontSize: '8px', color: '#ffb46b', fontStyle: 'bold' }).setOrigin(0.5);
    const container = scene.add.container(0, 0, [body, label, bg, hp, momentum]);
    return { container, body, hp, hpW: HP_W, life: null, momentum, color };
  }
  const color = parseInt((data.chains.find((c) => c.archetypeId === u.chain)?.color ?? '#999999').slice(1), 16);
  const body = scene.add.rectangle(0, 0, SOLDIER, SOLDIER, color).setStrokeStyle(1, u.soldier === 'shield' ? 0xf5f2e8 : 0x1b1d24);
  const label = text(scene, 0, 0, String(u.tier), { fontSize: '7px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
  const bg = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 2, S_HP_W, 2, 0x1b1d24).setOrigin(0, 0.5);
  const hp = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 2, S_HP_W, 2, 0x7ed67e).setOrigin(0, 0.5);
  const life = scene.add.rectangle(-S_HP_W / 2, SOLDIER / 2 + 4, S_HP_W, 1, 0xe6e9f5).setOrigin(0, 0.5);
  const container = scene.add.container(0, 0, [body, label, bg, hp, life]);
  return { container, body, hp, hpW: S_HP_W, life, momentum: null, color };
}

/** 매 프레임: hp·수명·기세 */
export function syncUnitView(v: UnitView, u: Unit, state: GameState, role: Role): void {
  v.hp.width = v.hpW * Math.max(0, Math.min(1, u.hp / u.maxHp));
  if (v.life && u.life !== undefined && u.lifeMax) v.life.width = v.hpW * Math.max(0, Math.min(1, u.life / u.lifeMax));
  if (v.momentum) {
    const m = state.heroes[role].momentum;
    const t = m.stacks > 0 ? `기세 ${m.stacks}` : '';
    if (v.momentum.text !== t) v.momentum.setText(t);
  }
}

/** 타격: 맞은 쪽 흰색 깜빡임 */
export function flashUnit(scene: Phaser.Scene, v: UnitView, ms: number): void {
  v.body.setFillStyle(0xffffff);
  scene.time.delayedCall(ms, () => v.body.active && v.body.setFillStyle(v.color));
}

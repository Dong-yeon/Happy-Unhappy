// 맡긴 추억 줄 (§5.11-2·3): 손거울 오른쪽에 laneCap칸. 낮에 손거울에 놓은 조각이 해질녘까지 여기서 기다린다.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { Chain } from '../data/types';
import { PARTY_ROW, PORTAL } from './layout';
import { COLOR, text } from './ui';

const RESERVE_MS = 300;

/** i번째 칸 중심 (화면) */
export function partySlot(i: number): { x: number; y: number } {
  return { x: PARTY_ROW.x + i * (PARTY_ROW.cell + PARTY_ROW.gap) + PARTY_ROW.cell / 2, y: PARTY_ROW.y };
}

export class PartyView {
  private readonly cells: { box: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }[] = [];
  private readonly title: Phaser.GameObjects.Text;
  private readonly chainColor = new Map<string, number>();
  private shownKey = '';
  /** 맡기는 연출 중인 칸 (도착 전에는 비워 보인다) */
  private incoming = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
    cap: number,
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    for (let i = 0; i < cap; i++) {
      const p = partySlot(i);
      const box = scene.add.rectangle(p.x, p.y, PARTY_ROW.cell, PARTY_ROW.cell, COLOR.cell).setStrokeStyle(1, COLOR.portalUnhappy).setDepth(6);
      const label = text(scene, p.x, p.y, '', { fontSize: '8px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5).setDepth(7);
      this.cells.push({ box, label });
    }
    this.title = text(scene, PARTY_ROW.x, PARTY_ROW.y - PARTY_ROW.cell / 2 - 3, '맡긴 추억', { fontSize: '8px', color: '#9fb0e0' })
      .setOrigin(0, 1)
      .setDepth(6);
  }

  /** 낮에만 보인다 (해질녘에 비워진다) */
  setShown(shown: boolean): void {
    for (const c of this.cells) {
      c.box.setVisible(shown);
      c.label.setVisible(shown);
    }
    this.title.setVisible(shown);
  }

  /** 맡기기 연출: 드롭 지점 → ◐ 손거울 → 줄의 칸 */
  onReserve(piece: Piece, fromX: number, fromY: number): void {
    const index = this.state.nightParty.length - 1;
    const dest = partySlot(Math.max(0, index));
    const light = this.scene.add.rectangle(fromX, fromY, 12, 12, this.colorOf(piece)).setStrokeStyle(1, 0xffffff).setDepth(40);
    this.incoming += 1;
    this.sync();
    this.scene.tweens.chain({
      targets: light,
      tweens: [
        { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y, scale: 0.7, duration: RESERVE_MS / 2, ease: 'Sine.easeIn' },
        { x: dest.x, y: dest.y, scale: 1, duration: RESERVE_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => {
        light.destroy();
        this.incoming = Math.max(0, this.incoming - 1);
        this.shownKey = '';
        this.sync();
      },
    });
  }

  sync(): void {
    const party = this.state.nightParty;
    const visible = party.length - this.incoming;
    const key = `${party.map((p) => p.id).join(',')}:${visible}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    const maxTier = this.state.grid.maxTier;
    this.cells.forEach((c, i) => {
      const p = i < visible ? party[i] : undefined;
      c.box.setFillStyle(p ? this.colorOf(p) : COLOR.cell);
      c.label.setText(p ? (p.legend ? '◆' : p.tier >= maxTier ? '★' : String(p.tier)) : '');
      c.box.setStrokeStyle(p?.legend ? 2 : 1, p?.legend || p?.shining ? 0xf2c94c : COLOR.portalUnhappy);
    });
  }

  private colorOf(p: Piece): number {
    return isWildcard(p) ? COLOR.wildcard : (this.chainColor.get(p.chain) ?? 0x999999);
  }
}

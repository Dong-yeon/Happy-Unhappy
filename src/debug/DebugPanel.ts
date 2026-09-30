// ?debug=1 디버그 버튼 (M1 그리드 프리셋 + M2 지급). M7에서 정식 디버그 패널로 흡수.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { WILDCARD, type GridSize } from '../core/grid';
import type { GameData } from '../data/types';
import { REGION } from '../scenes/layout';
import { Button, text } from '../scenes/ui';
import { saveGridOverride } from './gridPreset';

const DEBUG_JOY = 100;

export function createDebugPanel(
  scene: Phaser.Scene,
  data: GameData,
  state: GameState,
  current: GridSize,
  seed: number | null,
  onChange: () => void,
): void {
  const x0 = REGION.defenseLane.x + 8;
  let y = REGION.defenseLane.y + 26;
  text(scene, x0, y, `DEBUG${seed === null ? '' : ` seed=${seed}`}`, { fontSize: '9px', color: '#ff9e6b' });
  y += 22;

  // 그리드 프리셋: 저장(M6)이 생기면 저장 초기화를 함께 한다
  data.balance.grid.gridPresets.forEach(([cols, rows], i) => {
    const active = cols === current.cols && rows === current.rows;
    new Button(scene, x0 + 20 + i * 44, y, 40, 20, `${cols}×${rows}`, () => {
      if (active) return;
      saveGridOverride({ cols, rows });
      scene.scene.start('Boot');
    }, '10px').setActive(active);
  });
  y += 26;

  new Button(scene, x0 + 40, y, 80, 20, `기쁨 +${DEBUG_JOY}`, () => {
    state.debugAddJoy(DEBUG_JOY);
    onChange();
  }, '10px');
  y += 26;

  // 체인·단계 선택 후 지급
  const { chains } = data;
  const maxTier = data.balance.grid.maxTier;
  let chainIdx = 0;
  let tier = 1;
  const chainLabel = () => chains[chainIdx].tierNames[maxTier - 1];
  const tierLabel = () => (tier >= maxTier ? `${tier}★` : `${tier}단계`);
  new Button(scene, x0 + 40, y, 80, 20, chainLabel(), (b) => {
    chainIdx = (chainIdx + 1) % chains.length;
    b.setLabel(chainLabel());
  }, '10px');
  new Button(scene, x0 + 106, y, 44, 20, tierLabel(), (b) => {
    tier = (tier % maxTier) + 1;
    b.setLabel(tierLabel());
  }, '10px');
  y += 26;

  const grant = (chain: string, t: number) => {
    if (state.debugGrant(chain, t) === null) console.info('[debug] 빈 칸 없음 — 지급 안 함');
    onChange();
  };
  new Button(scene, x0 + 40, y, 80, 20, '조각 지급', () => grant(chains[chainIdx].archetypeId, tier), '10px');
  new Button(scene, x0 + 124, y, 80, 20, '와일드카드', () => grant(WILDCARD, 0), '10px');
}

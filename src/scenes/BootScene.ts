import Phaser from 'phaser';
import { loadGameData } from '../data';
import { resolveGridSize } from '../core/grid';
import { isDebug, loadGridOverride } from '../debug/gridPreset';
import { gridFits } from './layout';

/** 데이터 로드·검증 → 실패 시 ErrorScene, 성공 시 GameScene */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    const result = loadGameData();
    if (!result.ok) {
      console.error('[data] 검증 실패', result.issues);
      this.scene.start('Error', { issues: result.issues });
      return;
    }
    const data = result.data;
    const g = data.balance.grid;

    for (const [cols, rows] of g.gridPresets) {
      if (!gridFits(cols, rows)) console.warn(`[layout] 그리드 프리셋 ${cols}×${rows}가 그리드 영역에 들어가지 않음`);
    }

    const override = isDebug() ? loadGridOverride() : null;
    const gridSize = resolveGridSize(g.gridPresets, { cols: g.gridCols, rows: g.gridRows }, override);

    this.registry.set('data', data);
    this.registry.set('gridSize', gridSize);
    this.scene.start('Game');
  }
}

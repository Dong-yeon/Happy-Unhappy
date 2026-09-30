import Phaser from 'phaser';
import type { Issue } from '../data/validate';
import { VIEW_W } from './layout';
import { setupCamera, text } from './ui';

const MAX_LINES = 18;

/** 데이터 검증 실패 화면: 경로와 원인 표시 */
export class ErrorScene extends Phaser.Scene {
  constructor() {
    super('Error');
  }

  create({ issues }: { issues: Issue[] }): void {
    setupCamera(this);
    text(this, 12, 12, `데이터 검증 실패 (${issues.length}건)`, { fontSize: '15px', color: '#ff8a8a' });
    const shown = issues.slice(0, MAX_LINES).map((i) => `• ${i.path}\n   ${i.reason}`);
    if (issues.length > MAX_LINES) shown.push(`… 외 ${issues.length - MAX_LINES}건 (콘솔 참고)`);
    text(this, 12, 40, shown.join('\n'), { fontSize: '10px', lineSpacing: 2, wordWrap: { width: VIEW_W - 24 } });
  }
}

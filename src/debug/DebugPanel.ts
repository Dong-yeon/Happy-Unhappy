// ?debug=1 디버그 패널 (M1 그리드 프리셋 + M2 지급 + M3 웨이브·배속). M7에서 정식 디버그 패널로 흡수.
// 기본은 접힘: 포탈 받침 왼쪽 빈 자리의 [DBG] 토글만 보인다. 펼치면 방어 레인 위에 겹쳐 뜬다.
// 심연 레인(오른쪽, M4)은 접었을 때도 펼쳤을 때도 가리지 않는다.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { WILDCARD, type GridSize } from '../core/grid';
import type { GameData } from '../data/types';
import { REGION } from '../scenes/layout';
import { Button, text } from '../scenes/ui';
import { saveGridOverride } from './gridPreset';

const DEBUG_JOY = 100;
const SPEEDS = [1, 3, 10] as const;
const PANEL_DEPTH = 50;
const PANEL_BG = 0x111318;
const PANEL_ALPHA = 0.9;

export interface DebugControls {
  /** 배속: scene이 tick(dt × speed)로 적용 */
  setSpeed(speed: number): void;
  /** core 상태를 바꾼 뒤 표시 갱신 */
  onChange(): void;
}

export function createDebugPanel(
  scene: Phaser.Scene,
  data: GameData,
  state: GameState,
  current: GridSize,
  seed: number | null,
  controls: DebugControls,
): void {
  const lane = REGION.defenseLane;
  const x0 = lane.x + 8;
  const top = lane.y + 4;
  const buttons: Button[] = [];
  const items: Phaser.GameObjects.GameObject[] = [];
  const btn = (...args: ConstructorParameters<typeof Button>) => {
    const b = new Button(...args);
    b.container.setDepth(PANEL_DEPTH + 1);
    buttons.push(b);
    return b;
  };
  const label = (y: number, s: string) => {
    const t = text(scene, x0, y, s, { fontSize: '9px', color: '#ff9e6b' }).setDepth(PANEL_DEPTH + 1);
    items.push(t);
  };

  let y = top + 8;
  label(y, `DEBUG${seed === null ? '' : ` seed=${seed}`}`);
  y += 22;

  // 그리드 프리셋: 저장(M6)이 생기면 저장 초기화를 함께 한다
  data.balance.grid.gridPresets.forEach(([cols, rows], i) => {
    const active = cols === current.cols && rows === current.rows;
    btn(scene, x0 + 20 + i * 44, y, 40, 20, `${cols}×${rows}`, () => {
      if (active) return;
      saveGridOverride({ cols, rows });
      scene.scene.start('Boot');
    }, '10px').setActive(active);
  });
  y += 26;

  btn(scene, x0 + 40, y, 80, 20, `기쁨 +${DEBUG_JOY}`, () => {
    state.debugAddJoy(DEBUG_JOY);
    controls.onChange();
  }, '10px');
  y += 26;

  // 체인·단계 선택 후 지급
  const { chains } = data;
  const maxTier = data.balance.grid.maxTier;
  let chainIdx = 0;
  let tier = 1;
  const chainLabel = () => chains[chainIdx].tierNames[maxTier - 1];
  const tierLabel = () => (tier >= maxTier ? `${tier}★` : `${tier}단계`);
  btn(scene, x0 + 40, y, 80, 20, chainLabel(), (b) => {
    chainIdx = (chainIdx + 1) % chains.length;
    b.setLabel(chainLabel());
  }, '10px');
  btn(scene, x0 + 106, y, 44, 20, tierLabel(), (b) => {
    tier = (tier % maxTier) + 1;
    b.setLabel(tierLabel());
  }, '10px');
  y += 26;

  const grant = (chain: string, t: number) => {
    if (state.debugGrant(chain, t) === null) console.info('[debug] 빈 칸 없음 — 지급 안 함');
    controls.onChange();
  };
  btn(scene, x0 + 40, y, 80, 20, '조각 지급', () => grant(chains[chainIdx].archetypeId, tier), '10px');
  btn(scene, x0 + 124, y, 80, 20, '와일드카드', () => grant(WILDCARD, 0), '10px');
  y += 30;

  label(y - 8, '웨이브 · 배속');
  y += 14;
  const pauseLabel = () => (state.wave.paused ? '웨이브 재개' : '웨이브 정지');
  btn(scene, x0 + 40, y, 80, 20, pauseLabel(), (b) => {
    state.wave.paused = !state.wave.paused;
    b.setLabel(pauseLabel()).setActive(state.wave.paused);
  }, '10px');
  btn(scene, x0 + 124, y, 80, 20, '다음 웨이브', () => {
    state.wave.startNext();
    controls.onChange();
  }, '10px');
  y += 26;

  const speedBtns: Button[] = [];
  SPEEDS.forEach((s, i) => {
    const b = btn(scene, x0 + 20 + i * 44, y, 40, 20, `×${s}`, () => {
      controls.setSpeed(s);
      speedBtns.forEach((o, j) => o.setActive(j === i));
    }, '10px').setActive(s === 1);
    speedBtns.push(b);
  });
  y += 18;

  // 배경은 내용 높이에 맞춘다 (방어 레인 안, 심연 레인에 닿지 않음)
  const bg = scene.add
    .rectangle(lane.x + 2, top, lane.w - 4, y - top, PANEL_BG, PANEL_ALPHA)
    .setOrigin(0)
    .setDepth(PANEL_DEPTH)
    .setInteractive(); // 패널 뒤로 입력이 새지 않게
  items.push(bg);

  // 접기/펼치기 토글: 포탈 받침 왼쪽 빈 자리 (그리드·레인·포탈 밖)
  let open = false;
  const base = REGION.portalBase;
  const toggle = new Button(scene, base.x + 30, base.y + base.h / 2, 48, 20, '', () => {
    open = !open;
    apply();
  }, '10px');
  toggle.container.setDepth(PANEL_DEPTH + 2);
  const apply = () => {
    toggle.setLabel(open ? 'DBG ▾' : 'DBG ▸').setActive(open);
    for (const b of buttons) b.setShown(open);
    for (const it of items) (it as unknown as Phaser.GameObjects.Components.Visible).setVisible(open);
    if (bg.input) bg.input.enabled = open;
  };
  apply();
}

// ?debug=1 디버그 패널. M7에서 정식 디버그 패널로 흡수.
// 기본은 접힘: 포탈 받침 왼쪽 빈 자리의 [DBG] 토글만 보인다. 펼치면 방어 레인 위에 겹쳐 뜬다 (심연 레인은 가리지 않음).
// 탭: 기본(그리드·조각) / 웨이브(정지·다음·배속) / 낮밤(guardian·쓰러짐·즉시 성공·실패) / 스테이지(이동·갈림길·완성·이야기책)
//     / 저장(초기화·JSON 복사) / metrics(내보내기·요약·초기화)
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { WILDCARD, type GridSize } from '../core/grid';
import type { GameData } from '../data/types';
import type { MetricsRecorder } from '../metrics/recorder';
import { formatSummary, summarizeMetrics } from '../metrics/model';
import { realToday } from '../platform/clock';
import { storageStatus } from '../platform/storage';
import { REGION } from '../scenes/layout';
import type { SaveSession } from '../scenes/session';
import { Button, text } from '../scenes/ui';
import { copyOrShow, exportFileName } from './exportModal';
import { saveGridOverride } from './gridPreset';

const SPEEDS = [1, 3, 10] as const;
// 모달(DayUi, depth 60~72) 위: 장면 카드·결과 화면에서도 쓸 수 있게
const PANEL_DEPTH = 100;
const PANEL_BG = 0x111318;
const PANEL_ALPHA = 0.92;
const TABS = ['기본', '웨이브', '낮밤', '스테이지', '저장', 'metrics'] as const;
/** 탭 버튼 한 줄에 4개 (두 줄) */
const TABS_PER_ROW = 4;
const ROWS = 7;
/** [metrics 초기화] 두 번 탭 확인 시간 */
const RESET_CONFIRM_MS = 3000;
type Tab = (typeof TABS)[number];

export interface DebugControls {
  /** 배속: scene이 tick(dt × speed)로 적용 */
  setSpeed(speed: number): void;
  /** core 상태를 바꾼 뒤 표시 갱신 */
  onChange(): void;
  /** 이야기책 열기 */
  openDiary(): void;
  /** 저장을 바꾼 뒤 다시 부팅 */
  reboot(): void;
  metrics: MetricsRecorder;
}

export function createDebugPanel(
  scene: Phaser.Scene,
  data: GameData,
  state: GameState,
  session: SaveSession,
  current: GridSize,
  controls: DebugControls,
): void {
  const lane = REGION.debugPanel;
  const x0 = lane.x + 8;
  const top = lane.y + 4;
  const pages = new Map<Tab, { buttons: Button[]; items: Phaser.GameObjects.GameObject[] }>();
  for (const t of TABS) pages.set(t, { buttons: [], items: [] });
  let page: Tab = '기본';

  const btn = (tab: Tab, ...args: ConstructorParameters<typeof Button>) => {
    const b = new Button(...args);
    b.container.setDepth(PANEL_DEPTH + 1);
    pages.get(tab)!.buttons.push(b);
    return b;
  };
  const label = (tab: Tab, y: number, s: string) => {
    // 패널 밖으로 넘치지 않게 줄바꿈
    const t = text(scene, x0, y, s, { fontSize: '9px', color: '#ff9e6b', wordWrap: { width: lane.w - 20 } }).setDepth(PANEL_DEPTH + 1);
    pages.get(tab)!.items.push(t);
    return t;
  };

  const header = text(scene, x0, top + 6, '', { fontSize: '9px', color: '#ff9e6b' }).setDepth(PANEL_DEPTH + 1);
  const syncHeader = () => {
    const h = `DEBUG seed=${state.seed}${storageStatus.lastError ? ' · 저장 실패' : ''}`;
    if (header.text !== h) header.setText(h).setColor(storageStatus.lastError ? '#ff5f5f' : '#ff9e6b');
  };
  const tabBtns = TABS.map((t, i) =>
    new Button(scene, x0 + 19 + (i % TABS_PER_ROW) * 41, top + 26 + Math.floor(i / TABS_PER_ROW) * 21, 38, 18, t, () => {
      page = t;
      apply();
      if (t === 'metrics') onMetricsShow();
    }, '9px'),
  );
  for (const b of tabBtns) b.container.setDepth(PANEL_DEPTH + 1);
  const y0 = top + 76;
  /** metrics 탭을 열 때 요약을 바로 갱신 (아래 metrics 블록이 설정) */
  let onMetricsShow = () => {};

  // ── 기본: 그리드 프리셋·조각 지급 (기쁨은 §5.20-13에서 삭제) ──
  {
    let y = y0;
    label('기본', y - 16, '그리드 (전환: 게임 저장만 초기화)');
    y += 10;
    data.balance.grid.gridPresets.forEach(([cols, rows], i) => {
      const active = cols === current.cols && rows === current.rows;
      btn('기본', scene, x0 + 20 + i * 44, y, 40, 20, `${cols}×${rows}`, () => {
        if (active) return;
        session.resetGame();
        saveGridOverride({ cols, rows });
        controls.reboot();
      }, '10px').setActive(active);
    });
    y += 26;
    const { chains } = data;
    const maxTier = data.balance.grid.maxTier;
    let chainIdx = 0;
    let tier = 1;
    const chainLabel = () => chains[chainIdx].tierNames[maxTier - 1];
    const tierLabel = () => (tier >= maxTier ? `${tier}★` : `${tier}단계`);
    btn('기본', scene, x0 + 40, y, 80, 20, chainLabel(), (b) => {
      chainIdx = (chainIdx + 1) % chains.length;
      b.setLabel(chainLabel());
    }, '10px');
    btn('기본', scene, x0 + 106, y, 44, 20, tierLabel(), (b) => {
      tier = (tier % maxTier) + 1;
      b.setLabel(tierLabel());
    }, '10px');
    y += 26;
    const grant = (chain: string, t: number) => {
      if (state.debugGrant(chain, t) === null) console.info('[debug] 빈 칸 없음 — 지급 안 함');
      controls.onChange();
    };
    btn('기본', scene, x0 + 40, y, 80, 20, '조각 지급', () => grant(chains[chainIdx].archetypeId, tier), '10px');
    btn('기본', scene, x0 + 124, y, 80, 20, '와일드카드', () => grant(WILDCARD, 0), '10px');
  }

  // ── 웨이브: 정지·다음·배속 ──
  {
    let y = y0;
    label('웨이브', y - 16, '웨이브 · 배속');
    y += 10;
    const pauseLabel = () => (state.wave.paused ? '웨이브 재개' : '웨이브 정지');
    btn('웨이브', scene, x0 + 40, y, 80, 20, pauseLabel(), (b) => {
      state.wave.paused = !state.wave.paused;
      b.setLabel(pauseLabel()).setActive(state.wave.paused);
    }, '10px');
    btn('웨이브', scene, x0 + 124, y, 80, 20, '대기 건너뛰기', () => {
      state.wave.startNext();
      controls.onChange();
    }, '10px');
    y += 26;
    const speedBtns: Button[] = [];
    SPEEDS.forEach((s, i) => {
      const b = btn('웨이브', scene, x0 + 20 + i * 44, y, 40, 20, `×${s}`, () => {
        controls.setSpeed(s);
        speedBtns.forEach((o, j) => o.setActive(j === i));
      }, '10px').setActive(s === 1);
      speedBtns.push(b);
    });
  }

  // ── 낮밤: guardian·쓰러짐·즉시 성공·실패 (§5.19) ──
  {
    let y = y0;
    label('낮밤', y - 16, '낮(핵 찾아 돌아오기) · 밤(핵 지키기)');
    y += 10;
    btn('낮밤', scene, x0 + 40, y, 80, 20, 'guardian HP 0', () => {
      state.debugKillGuardian();
      controls.onChange();
    }, '10px');
    btn('낮밤', scene, x0 + 124, y, 80, 20, '낮 우리 편 전멸', () => {
      state.debugKillAbyssUnits();
      controls.onChange();
    }, '10px');
    y += 26;
    btn('낮밤', scene, x0 + 40, y, 80, 20, '낮 성공 → 밤', () => {
      state.debugToNight();
      controls.onChange();
    }, '10px');
    btn('낮밤', scene, x0 + 124, y, 80, 20, '밤 영웅 쓰러짐', () => {
      state.debugKnockDefenseHero();
      controls.onChange();
    }, '10px');
    y += 26;
    btn('낮밤', scene, x0 + 40, y, 80, 20, '밤 성공', () => {
      state.debugEndNight();
      controls.onChange();
    }, '10px');
    btn('낮밤', scene, x0 + 124, y, 80, 20, '지금 시도 실패', () => {
      state.debugFail();
      controls.onChange();
    }, '10px');
  }

  // ── 스테이지: 이동·갈림길·즉시 완성·이야기책 (§5.19-1) ──
  {
    let y = y0;
    label('스테이지', y - 16, '스테이지 (이동은 장면 카드·이야기 한 장에서만)');
    y += 10;
    const len = data.balance.chapter.length;
    let target = state.stage;
    const stageLabel = () => `1-${target}`;
    btn('스테이지', scene, x0 + 14, y, 26, 20, '−', () => {
      target = Math.max(1, target - 1);
      stageBtn.setLabel(stageLabel());
    }, '11px');
    const stageBtn = btn('스테이지', scene, x0 + 58, y, 56, 20, stageLabel(), () => undefined, '10px');
    btn('스테이지', scene, x0 + 102, y, 26, 20, '+', () => {
      target = Math.min(len, target + 1);
      stageBtn.setLabel(stageLabel());
    }, '11px');
    btn('스테이지', scene, x0 + 142, y, 44, 20, '이동', () => {
      state.debugSetStage(target);
      controls.onChange();
    }, '10px');
    y += 26;
    btn('스테이지', scene, x0 + 40, y, 80, 20, '스킬 발동', () => {
      state.debugCastSkills();
      controls.onChange();
    }, '10px');
    // chapterComplete 이벤트 → 씬이 저장
    btn('스테이지', scene, x0 + 124, y, 80, 20, '즉시 완성', () => {
      state.debugCompleteChapter();
      controls.onChange();
    }, '10px');
    y += 26;
    btn('스테이지', scene, x0 + 40, y, 80, 20, '이야기책', () => controls.openDiary(), '10px');
    // 영웅 지급 (§5.20-1): 삽살·해태·누이·오라비 / 테스트 영웅 2명 (팀 2개 이상·인연 시험용)
    btn('스테이지', scene, x0 + 124, y, 80, 20, '영웅 전부 지급', () => {
      state.debugGrantAllHeroes();
      controls.onChange();
    }, '9px');
    y += 26;
    btn('스테이지', scene, x0 + 40, y, 80, 20, '테스트 영웅 2명', () => {
      state.debugGrantTestHeroes();
      controls.onChange();
    }, '9px');
    btn('스테이지', scene, x0 + 124, y, 80, 20, '5단계 조각 2', () => {
      const chain = state.spawnChains[0];
      state.debugGrant(chain, data.balance.grid.maxTier - 1);
      state.debugGrant(chain, data.balance.grid.maxTier - 1);
      controls.onChange();
    }, '9px');
    y += 26;
    const now = label('스테이지', y - 8, '');
    scene.time.addEvent({
      delay: 500,
      loop: true,
      callback: () => {
        const tries = state.attempts[state.stage - 1];
        const flags = state.retry ? ` · 재도전(${state.retry})` : '';
        now.setText(`1-${state.stage} · 이 스테이지 ${tries}번 · 통산 ${state.attempt}번 · 영웅 ${state.owned.length}명${flags}`);
      },
    });
  }

  // ── 저장: 초기화·JSON ──
  {
    let y = y0;
    label('저장', y - 16, '저장 (hau_save_v4)');
    y += 10;
    btn('저장', scene, x0 + 40, y, 80, 20, '초기화: 게임만', () => {
      session.resetGame();
      controls.reboot();
    }, '9px');
    btn('저장', scene, x0 + 124, y, 80, 20, '초기화: 전부', () => {
      session.resetAll();
      controls.reboot();
    }, '9px');
    y += 26;
    btn('저장', scene, x0 + 40, y, 80, 20, '저장 JSON 복사', () => {
      const raw = session.rawJson();
      console.info('[debug] 저장 JSON', raw);
      navigator.clipboard?.writeText(raw).catch(() => console.warn('[debug] 클립보드 복사 실패 — 콘솔 참고'));
    }, '9px');
    scene.time.addEvent({ delay: 500, loop: true, callback: () => syncHeader() });
  }

  // ── metrics: 내보내기·요약·초기화 (§5.10-5) ──
  {
    const m = controls.metrics;
    let y = y0;
    label('metrics', y - 16, 'metrics (hau_metrics_v4)');
    y += 10;
    const status = label('metrics', y + 16, '');
    btn('metrics', scene, x0 + 40, y, 80, 20, 'JSON 복사', () => {
      void copyOrShow(m.json(), exportFileName(realToday())).then((r) =>
        status.setText(r === 'copied' ? '클립보드에 복사함' : '복사 불가 → 텍스트·파일 저장 창'),
      );
    }, '10px');
    let armedAt = -Infinity;
    btn('metrics', scene, x0 + 124, y, 80, 20, 'metrics 초기화', (b) => {
      const now = scene.time.now;
      if (now - armedAt <= RESET_CONFIRM_MS) {
        m.reset();
        armedAt = -Infinity;
        b.setLabel('metrics 초기화').setActive(false);
        status.setText('초기화함');
        return;
      }
      armedAt = now;
      b.setLabel('한 번 더 탭').setActive(true);
      scene.time.delayedCall(RESET_CONFIRM_MS, () => b.container.active && b.setLabel('metrics 초기화').setActive(false));
    }, '9px');
    const summary = text(scene, x0, y + 32, '', { fontSize: '8px', color: '#e8c9a0', lineSpacing: 2, wordWrap: { width: lane.w - 18 } }).setDepth(
      PANEL_DEPTH + 1,
    );
    pages.get('metrics')!.items.push(summary);
    const syncSummary = () => {
      const d = m.data;
      summary.setText(
        `${formatSummary('현재 일생', summarizeMetrics([m.life], d.sessions.filter((x) => x.startedAt >= m.life.startedAt)))}\n` +
          `${formatSummary('전체', summarizeMetrics(d.lives, d.sessions))}\n` +
          `시도 도중 복원 ${m.life.midAttemptRestores}`,
      );
    };
    scene.time.addEvent({ delay: 1000, loop: true, callback: () => page === 'metrics' && syncSummary() });
    onMetricsShow = syncSummary;
    syncSummary();
  }

  const bottom = y0 + 26 * ROWS + 12;
  const bg = scene.add
    .rectangle(lane.x + 2, top, lane.w - 4, bottom - top, PANEL_BG, PANEL_ALPHA)
    .setOrigin(0)
    .setDepth(PANEL_DEPTH)
    .setInteractive(); // 패널 뒤로 입력이 새지 않게

  // 접기/펼치기 토글: 전장 왼쪽 아래 (§5.20-13: 해·달 띠는 얇아짐)
  let open = false;
  const base = REGION.ground;
  const toggle = new Button(scene, base.x + 30, base.y + base.h - 14, 48, 20, '', () => {
    open = !open;
    apply();
  }, '10px');
  toggle.container.setDepth(PANEL_DEPTH + 2);

  function apply(): void {
    toggle.setLabel(open ? 'DBG ▾' : 'DBG ▸').setActive(open);
    bg.setVisible(open);
    if (bg.input) bg.input.enabled = open;
    header.setVisible(open);
    tabBtns.forEach((b, i) => b.setShown(open).setActive(TABS[i] === page));
    for (const [t, p] of pages) {
      const show = open && t === page;
      for (const b of p.buttons) b.setShown(show);
      for (const it of p.items) (it as unknown as Phaser.GameObjects.Components.Visible).setVisible(show);
    }
  }
  syncHeader();
  apply();
}

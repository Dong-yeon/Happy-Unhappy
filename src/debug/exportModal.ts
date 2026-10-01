// metrics 내보내기 (§5.10-5). clipboard API가 없거나 실패하면(폰에서 LAN http:// 접속 = 보안 컨텍스트 아님)
// 전체 화면 DOM 오버레이에 선택 가능한 <textarea> + [파일로 저장](Blob 다운로드)을 띄운다.
// DOM 오버레이라 Phaser 입력과 분리된다 (캔버스 위에 덮임).

const OVERLAY_ID = 'hau-export-overlay';

/** 'hau_metrics_YYYYMMDD.json' (날짜는 호출부가 YYYY-MM-DD로 넘긴다) */
export function exportFileName(date: string): string {
  return `hau_metrics_${date.replaceAll('-', '')}.json`;
}

/**
 * 복사 시도 → 결과: 'copied' (클립보드 성공) / 'fallback' (모달을 띄움)
 */
export async function copyOrShow(json: string, fileName: string): Promise<'copied' | 'fallback'> {
  const clip = window.isSecureContext ? navigator.clipboard : undefined;
  if (clip?.writeText) {
    try {
      await clip.writeText(json);
      return 'copied';
    } catch (e) {
      console.warn(`[metrics] 클립보드 복사 실패 — ${(e as Error).message}. 텍스트·파일 저장으로 대신함`);
    }
  }
  showExportModal(json, fileName);
  return 'fallback';
}

export function downloadJson(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function showExportModal(json: string, fileName: string): void {
  document.getElementById(OVERLAY_ID)?.remove();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1000',
    background: 'rgba(14,16,22,0.96)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    boxSizing: 'border-box',
    fontFamily: 'sans-serif',
    color: '#e8e8e8',
  } satisfies Partial<CSSStyleDeclaration>);

  const title = document.createElement('div');
  title.textContent = `metrics JSON (${Math.round(json.length / 1024)}KB) — 길게 눌러 전체 선택·복사하거나 파일로 저장`;
  title.style.fontSize = '13px';

  const area = document.createElement('textarea');
  area.value = json;
  area.readOnly = true;
  Object.assign(area.style, {
    flex: '1',
    width: '100%',
    fontSize: '11px',
    fontFamily: 'monospace',
    background: '#1b1d24',
    color: '#e8e8e8',
    border: '1px solid #566081',
    boxSizing: 'border-box',
  } satisfies Partial<CSSStyleDeclaration>);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  const button = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      flex: '1',
      padding: '12px',
      fontSize: '14px',
      background: '#46506b',
      color: '#fff',
      border: '1px solid #566081',
    } satisfies Partial<CSSStyleDeclaration>);
    b.addEventListener('click', onClick);
    row.appendChild(b);
  };
  button('전체 선택', () => {
    area.focus();
    area.select();
    area.setSelectionRange(0, json.length);
  });
  button(`파일로 저장 (${fileName})`, () => downloadJson(json, fileName));
  button('닫기', () => overlay.remove());

  overlay.append(title, area, row);
  document.body.appendChild(overlay);
}

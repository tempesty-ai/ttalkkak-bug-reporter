// 영역 선택 오버레이. 패널이 chrome.scripting.executeScript로 이 파일을 활성 탭에 주입한다.
// 사용자가 드래그로 영역을 지정하면 뷰포트 기준 좌표(rect)와 devicePixelRatio를 패널로 보낸다.
// 실제 캡처·crop은 패널에서 captureVisibleTab 후 처리 (오버레이가 스샷에 안 잡히도록 여기서 먼저 제거).

(() => {
  // 중복 주입 방지: 이미 선택 중이면 무시.
  if (window.__qaRegionSelectActive) return;
  window.__qaRegionSelectActive = true;

  const Z = '2147483647';
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;z-index:${Z};cursor:crosshair;background:rgba(0,0,0,0.28);user-select:none;`;

  const box = document.createElement('div');
  box.style.cssText = `position:fixed;display:none;border:2px solid #4f46e5;background:rgba(79,70,229,0.12);z-index:${Z};pointer-events:none;`;

  const hint = document.createElement('div');
  hint.style.cssText = `position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;background:#111;color:#fff;font:13px/1.4 'Malgun Gothic',system-ui,sans-serif;padding:7px 8px 7px 14px;border-radius:8px;z-index:${Z};box-shadow:0 4px 14px rgba(0,0,0,0.3);`;
  const hintText = document.createElement('span');
  hintText.textContent = '드래그해서 영역을 선택하세요';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ 취소 (ESC)';
  cancelBtn.style.cssText = "background:#374151;color:#fff;border:none;border-radius:6px;padding:5px 12px;font:600 12px 'Malgun Gothic',system-ui,sans-serif;cursor:pointer;";
  // 클릭은 키보드 포커스와 무관하게 항상 취소된다.
  cancelBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); cancel(); });
  hint.append(hintText, cancelBtn);

  document.documentElement.append(overlay, box, hint);
  // ESC가 페이지로 오도록 오버레이에 포커스 시도.
  overlay.tabIndex = -1;
  try { overlay.focus({ preventScroll: true }); } catch { /* 무시 */ }

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    overlay.remove();
    box.remove();
    hint.remove();
    window.removeEventListener('keydown', onKey, true);
    window.__qaRegionSelectActive = false;
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      /* 패널이 닫혔을 수 있음 — 무시 */
    }
  }

  function cancel() {
    cleanup();
    send({ type: 'REGION_CANCELLED' });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  overlay.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = '0px';
    box.style.height = '0px';
    box.style.display = 'block';
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  });

  overlay.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = {
      x: Math.min(e.clientX, startX),
      y: Math.min(e.clientY, startY),
      width: Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY),
    };

    // 너무 작으면 실수 클릭으로 보고 취소.
    if (rect.width < 5 || rect.height < 5) {
      cancel();
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    cleanup();
    // 오버레이 제거가 화면에 반영된 다음 프레임 이후에 캡처 신호를 보낸다.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => send({ type: 'REGION_SELECTED', rect, dpr }), 30),
      ),
    );
  });

  window.addEventListener('keydown', onKey, true);
})();

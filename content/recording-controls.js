// 녹화 플로팅 컨트롤 (페이지 왼쪽 하단).
// 패널이 화면 공유를 받은 직후 이 파일을 활성 탭에 주입한다.
//
// 두 단계로 동작한다.
//   setup     — 녹화 범위를 고른다: [영역 지정] [전체 녹화] [취소]
//   recording — 경과 시간 + [중지]
// 주입 직전에 패널이 window.__qaRecInit = { phase, canRegion } 을 심어둔다.

(() => {
  if (window.__qaRecCtrl) return;
  window.__qaRecCtrl = true;

  const init = window.__qaRecInit || {};
  // 전체 화면/창을 공유하면 페이지 좌표와 영상 좌표가 어긋나 영역 지정을 쓸 수 없다.
  const canRegion = init.canRegion !== false;

  const Z = '2147483647';
  const FONT = "'Malgun Gothic', system-ui, sans-serif";

  const style = document.createElement('style');
  style.id = 'qa-rec-style';
  style.textContent = '@keyframes qaRecBlink{0%,100%{opacity:1}50%{opacity:.25}}';

  const bar = document.createElement('div');
  bar.id = 'qa-rec-ctrl';
  // log-collector가 이 안의 클릭을 '사용자 재현 단계'로 기록하지 않도록 표시.
  bar.setAttribute('data-qa-ext-ui', '');
  bar.style.cssText = `position:fixed;bottom:20px;left:20px;z-index:${Z};display:flex;align-items:center;gap:10px;background:#141922;color:#fff;padding:9px 10px 9px 13px;font:13px/1.4 ${FONT};box-shadow:0 12px 32px -10px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14);`;

  const dot = document.createElement('span');
  dot.style.cssText = 'flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#e5484d;';

  const label = document.createElement('span');
  label.style.cssText = 'white-space:nowrap;';

  const time = document.createElement('span');
  time.style.cssText = 'font:500 12px/1 Consolas,monospace;color:#c7d2fe;font-variant-numeric:tabular-nums;';

  const actions = document.createElement('span');
  actions.style.cssText = 'display:flex;align-items:center;gap:6px;';

  bar.append(dot, label, time, actions);
  document.documentElement.append(style, bar);

  function send(type) {
    try {
      chrome.runtime.sendMessage({ type });
    } catch {
      /* 패널이 닫혔을 수 있음 — 무시 */
    }
  }

  function mkBtn(text, kind) {
    const b = document.createElement('button');
    b.textContent = text;
    const base = `border:none;padding:6px 12px;font:600 12.5px ${FONT};cursor:pointer;white-space:nowrap;`;
    if (kind === 'primary') b.style.cssText = `${base}background:#4f46e5;color:#fff;`;
    else if (kind === 'danger') b.style.cssText = `${base}background:#e5484d;color:#fff;`;
    else b.style.cssText = `${base}background:transparent;color:#c8ccd6;border:1px solid rgba(255,255,255,.22);`;
    return b;
  }

  /* ---------- 단계 ---------- */

  let timer = null;

  function clearActions() {
    while (actions.firstChild) actions.firstChild.remove();
  }

  function setupPhase() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    dot.style.animation = 'none';
    dot.style.background = '#e0940b';
    label.textContent = '녹화 범위를 고르세요';
    time.textContent = '';
    clearActions();

    if (canRegion) {
      const region = mkBtn('영역 지정', 'primary');
      region.addEventListener('click', () => {
        // 영역을 드래그하는 동안엔 바를 숨긴다 — 선택도 가리고 녹화에도 찍힌다.
        bar.style.display = 'none';
        send('REC_PICK_REGION');
      });
      actions.append(region);
    }

    const full = mkBtn('전체 녹화', canRegion ? 'ghost' : 'primary');
    full.addEventListener('click', () => send('REC_START_FULL'));

    const cancel = mkBtn('취소', 'ghost');
    cancel.addEventListener('click', () => {
      send('REC_CANCEL');
      remove();
    });

    actions.append(full, cancel);
  }

  function recordingPhase(startedAt) {
    bar.style.display = 'flex';
    dot.style.background = '#e5484d';
    dot.style.animation = 'qaRecBlink 1.4s infinite';
    label.textContent = '녹화 중';
    clearActions();

    const stop = mkBtn('■ 중지', 'danger');
    stop.addEventListener('click', () => {
      send('STOP_RECORDING');
      remove();
    });
    actions.append(stop);

    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const p = (n) => String(n).padStart(2, '0');
      time.textContent = `${p(Math.floor(s / 60))}:${p(s % 60)}`;
    };
    tick();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  function remove() {
    if (timer) clearInterval(timer);
    bar.remove();
    style.remove();
    window.__qaRecCtrl = false;
    chrome.runtime.onMessage.removeListener(onMsg);
  }

  function onMsg(msg) {
    if (msg?.type === 'REMOVE_RECORDING_CONTROLS') remove();
    else if (msg?.type === 'REC_PHASE_RECORDING') recordingPhase(msg.startedAt || Date.now());
    else if (msg?.type === 'REC_PHASE_SETUP') {
      bar.style.display = 'flex';
      setupPhase();
    }
  }
  chrome.runtime.onMessage.addListener(onMsg);

  if (init.phase === 'recording') recordingPhase(init.startedAt || Date.now());
  else setupPhase();
})();

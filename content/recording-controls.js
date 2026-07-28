// 녹화 중 페이지에 뜨는 플로팅 컨트롤 (녹화 표시 + 중지 버튼).
// 패널이 SW를 통해 이 파일을 활성 탭에 주입한다. 중지 클릭 시 SW로 STOP_RECORDING 전달.

(() => {
  if (window.__qaRecCtrl) return;
  window.__qaRecCtrl = true;

  const Z = '2147483647';
  const style = document.createElement('style');
  style.id = 'qa-rec-style';
  style.textContent = '@keyframes qaRecBlink{0%,100%{opacity:1}50%{opacity:.2}}';

  const bar = document.createElement('div');
  bar.id = 'qa-rec-ctrl';
  bar.style.cssText = `position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:${Z};display:flex;align-items:center;gap:12px;background:#111;color:#fff;padding:10px 16px;border-radius:999px;font:13px/1 'Malgun Gothic',system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);`;

  const dot = document.createElement('span');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#ef4444;animation:qaRecBlink 1s infinite;';

  const label = document.createElement('span');
  label.textContent = '녹화 중';

  const stop = document.createElement('button');
  stop.textContent = '■ 중지';
  stop.style.cssText = "background:#ef4444;color:#fff;border:none;border-radius:999px;padding:6px 14px;font:600 13px 'Malgun Gothic',system-ui,sans-serif;cursor:pointer;";
  stop.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    } catch {
      /* 무시 */
    }
    remove();
  });

  bar.append(dot, label, stop);
  document.documentElement.append(style, bar);

  function remove() {
    bar.remove();
    style.remove();
    window.__qaRecCtrl = false;
    chrome.runtime.onMessage.removeListener(onMsg);
  }

  function onMsg(msg) {
    if (msg?.type === 'REMOVE_RECORDING_CONTROLS') remove();
  }
  chrome.runtime.onMessage.addListener(onMsg);
})();

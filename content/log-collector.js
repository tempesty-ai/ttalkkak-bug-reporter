// 페이지의 콘솔 에러·실패 네트워크 요청을 수집 (MAIN world에서 실행).
// content script 기본(ISOLATED)에선 페이지의 console/fetch를 못 후킹하므로(함정 8),
// manifest에서 world:'MAIN', run_at:'document_start'로 주입해 일찍부터 후킹한다.
// 수집 데이터는 window.__qaCollected에 쌓고, 패널이 executeScript(MAIN)로 읽어간다.

(() => {
  if (window.__qaCollected) return; // 중복 주입 방지
  const store = { consoleErrors: [], failedRequests: [] };
  window.__qaCollected = store;

  const MAX = 50;
  const push = (arr, item) => {
    arr.push(item);
    if (arr.length > MAX) arr.shift();
  };
  const now = () => new Date().toISOString();

  // console.error 후킹 (원본은 그대로 호출)
  const origError = console.error;
  console.error = function hookedError(...args) {
    try {
      push(store.consoleErrors, { message: args.map((a) => safeStr(a)).join(' '), at: now() });
    } catch {
      /* 수집 실패는 무시 */
    }
    return origError.apply(this, args);
  };

  // 전역 에러 / 처리되지 않은 프라미스
  window.addEventListener('error', (e) => {
    const loc = e.filename ? ` (${e.filename}:${e.lineno})` : '';
    push(store.consoleErrors, { message: `${e.message}${loc}`, at: now() });
  });
  window.addEventListener('unhandledrejection', (e) => {
    push(store.consoleErrors, { message: `Unhandled Promise: ${safeStr(e.reason)}`, at: now() });
  });

  // fetch 후킹
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function hookedFetch(...args) {
      const url = reqUrl(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      try {
        const res = await origFetch.apply(this, args);
        if (!res.ok) push(store.failedRequests, { url, method, status: res.status, at: now() });
        return res;
      } catch (err) {
        push(store.failedRequests, { url, method, status: 0, at: now() });
        throw err;
      }
    };
  }

  // XHR 후킹
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function hookedOpen(method, url) {
    this.__qaMethod = method;
    this.__qaUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function hookedSend(...a) {
    this.addEventListener('loadend', () => {
      try {
        if (this.status === 0 || this.status >= 400) {
          push(store.failedRequests, {
            url: this.__qaUrl,
            method: this.__qaMethod || 'GET',
            status: this.status,
            at: now(),
          });
        }
      } catch {
        /* 무시 */
      }
    });
    return origSend.apply(this, a);
  };

  function safeStr(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  function reqUrl(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (input.url) return input.url;
    return String(input);
  }
})();

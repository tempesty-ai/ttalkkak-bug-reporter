// 사이드 패널: 캡처 → 미리보기 → 리포트 폼 → ClickUp 등록을 한 곳에서 처리.
// 패널은 페이지 조작 중에도 열려 있고, 닫혔다 다시 열리면 session storage에서 미제출 캡처를 복원한다.
//
// 캡처는 버튼 클릭(사용자 제스처) 안에서 호출하고, host_permissions <all_urls> 덕에
// captureVisibleTab이 activeTab 제스처 없이도 동작한다.

import {
  getLocal,
  setLocal,
  getSession,
  setSession,
  removeSession,
  SESSION_KEYS,
  LOCAL_KEYS,
} from '../lib/storage.js';
import { submitReport, getAuthorizedUser } from '../lib/clickup.js';
import { createAnnotator } from './annotator.js';

const els = {
  viewLauncher: document.getElementById('view-launcher'),
  viewReport: document.getElementById('view-report'),
  launcherStatus: document.getElementById('launcher-status'),
  configWarning: document.getElementById('config-warning'),
  canvas: document.getElementById('annotate-canvas'),
  videoPreview: document.getElementById('video-preview'),
  videoPlayBtn: document.getElementById('video-play-btn'),
  toolbar: document.querySelector('.annotate-toolbar'),
  undoBtn: document.getElementById('undo-btn'),
  clearBtn: document.getElementById('clear-btn'),
  recordingBanner: document.getElementById('recording-banner'),
  recStop: document.getElementById('rec-stop'),
  collectSummary: document.getElementById('collect-summary'),
  collectDetail: document.getElementById('collect-detail'),
  collectRefresh: document.getElementById('collect-refresh'),
  collectReread: document.getElementById('collect-reread'),
  autoCollect: document.getElementById('auto-collect'),
  title: document.getElementById('task-title'),
  priority: document.getElementById('task-priority'),
  description: document.getElementById('task-description'),
  mentionName: document.getElementById('mention-name'),
  targetInfo: document.getElementById('target-info'),
  submitBtn: document.getElementById('submit-btn'),
  btnText: document.querySelector('#submit-btn .btn-text'),
  spinner: document.querySelector('#submit-btn .spinner'),
  backBtn: document.getElementById('back-btn'),
  toast: document.getElementById('toast'),
  toastMsg: document.getElementById('toast-msg'),
  toastLink: document.getElementById('toast-link'),
};

let captureBlob = null;
let captureFilename = 'screenshot.png';
let toastTimer = null;
let annotator = null;
let regionTab = null; // 영역 선택 시작 시점의 대상 탭
let recordingTab = null; // 녹화 시작 시점의 대상 탭
let currentSourceUrl = ''; // 현재 캡처의 원본 페이지 URL (멘션 하이퍼링크 대상)
let mediaRecorder = null; // 패널 내 MediaRecorder (getDisplayMedia 방식)
let recordedChunks = [];
let recordingStream = null;

const DEFAULT_TOOL = 'arrow';
const DEFAULT_COLOR = '#e11d48';

let autoCollectEnabled = true; // 리포트에 자동 수집 정보 첨부 여부

/* ---------- 공통 유틸 ---------- */

/** data: URL은 CSP 영향 없이 동기 디코딩이 안전. */
function dataUrlToBlob(dataUrl) {
  const [head, base64] = dataUrl.split(',');
  const mime = head.match(/data:(.*?);base64/)?.[1] || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    img.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('영상 변환에 실패했습니다.'));
    fr.readAsDataURL(blob);
  });
}

function showLauncherStatus(message) {
  els.launcherStatus.textContent = message;
  els.launcherStatus.hidden = !message;
}

/**
 * @param {string} message
 * @param {'success'|'error'} kind
 * @param {string} [linkUrl]
 */
function showToast(message, kind, linkUrl) {
  clearTimeout(toastTimer);
  els.toastMsg.textContent = message;
  els.toast.className = `toast is-${kind}`;
  els.toast.hidden = false;

  if (linkUrl) {
    els.toastLink.href = linkUrl;
    els.toastLink.hidden = false;
  } else {
    els.toastLink.hidden = true;
  }

  if (kind === 'error') {
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 6000);
  }
}

function setLoading(on) {
  els.spinner.hidden = !on;
  els.submitBtn.disabled = on;
  els.btnText.textContent = on ? '등록 중…' : 'ClickUp에 등록';
}

/** ISO 문자열(또는 현재)을 'YYYY-MM-DD 오후 h:mm:ss' 형식으로. */
function formatDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  const date = d.toLocaleDateString('sv-SE'); // 2026-07-27
  const time = d.toLocaleTimeString('ko-KR'); // 오후 4:02:54
  return `${date} ${time}`;
}

/**
 * QA 템플릿으로 제목/설명 기본값 구성.
 * 설명은 마크다운(소제목은 굵게). 제출 시 제목이 H3로 맨 위에 붙는다.
 */
function buildDefaults(cap) {
  const title = '[고객사] 이슈 내용';
  const lines = [
    '**이슈 내용**',
    '',
    '',
    '**재현 방법**',
    '1. ',
    '2. ',
    '',
    '**URL**',
    cap.sourceUrl || '-',
    '',
    '**캡처 시각**',
    formatDateTime(cap.capturedAt),
  ];
  if (autoCollectEnabled) {
    const collected = formatCollected(cap.metadata);
    if (collected) lines.push(collected);
  }
  return { title, description: lines.join('\n') };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** cap.metadata의 자동 수집 정보를 마크다운 섹션으로. 없으면 빈 문자열. */
function formatCollected(meta) {
  if (!meta) return '';
  const errs = meta.consoleErrors || [];
  const reqs = meta.failedRequests || [];
  if (!meta.viewport && !errs.length && !reqs.length) return '';

  const lines = ['', '**🔎 자동 수집 정보**'];
  if (meta.viewport) lines.push(`- 뷰포트: ${meta.viewport}`);
  lines.push(`- 콘솔 에러: ${errs.length}건`);
  errs.slice(0, 5).forEach((e) => lines.push(`  - ${truncate(e.message, 200)}`));
  lines.push(`- 실패 요청: ${reqs.length}건`);
  reqs.slice(0, 5).forEach((r) => lines.push(`  - ${r.status} ${r.method} ${truncate(r.url, 120)}`));
  return lines.join('\n');
}

/** 탭의 모든 프레임 MAIN world에서 수집 데이터를 읽어 병합. 주입 불가 페이지면 null. */
async function collectPageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // iframe까지 포함
      world: 'MAIN',
      func: () => {
        const c = window.__qaCollected || { consoleErrors: [], failedRequests: [] };
        return {
          consoleErrors: c.consoleErrors || [],
          failedRequests: c.failedRequests || [],
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        };
      },
    });
    const merged = { consoleErrors: [], failedRequests: [], viewport: '' };
    for (const r of results) {
      if (!r?.result) continue;
      merged.consoleErrors.push(...(r.result.consoleErrors || []));
      merged.failedRequests.push(...(r.result.failedRequests || []));
    }
    // 뷰포트는 최상위 프레임(첫 결과) 기준.
    merged.viewport = results[0]?.result?.viewport || '';
    return merged;
  } catch {
    return null; // chrome:// 등 주입 불가
  }
}

/** 캡처 메타데이터 구성 (userAgent + 자동 수집 정보). */
async function buildCapMeta(tab) {
  const meta = { userAgent: navigator.userAgent };
  if (tab?.id && isCapturableUrl(tab.url)) {
    const info = await collectPageInfo(tab.id);
    if (info) {
      meta.viewport = info.viewport;
      meta.consoleErrors = info.consoleErrors;
      meta.failedRequests = info.failedRequests;
    }
  }
  return meta;
}

/** 런처의 진단 카드 갱신. */
async function updateCollectCard() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  els.collectDetail.hidden = true;
  els.collectDetail.innerHTML = '';

  if (!tab || !isCapturableUrl(tab.url)) {
    els.collectSummary.textContent = '이 페이지에선 진단 정보를 수집할 수 없어요.';
    return;
  }
  const info = await collectPageInfo(tab.id);
  if (!info) {
    els.collectSummary.textContent = '진단 정보를 불러올 수 없어요.';
    return;
  }

  const e = info.consoleErrors.length;
  const r = info.failedRequests.length;
  els.collectSummary.innerHTML = `콘솔 에러 <b>${e}</b>건 · 실패 요청 <b>${r}</b>건 · 뷰포트 ${info.viewport}`;

  const items = [
    ...info.consoleErrors.slice(-3).map((x) => `🟥 ${truncate(x.message, 90)}`),
    ...info.failedRequests.slice(-3).map((x) => `🌐 ${x.status} ${truncate(x.url, 70)}`),
  ];
  if (items.length) {
    els.collectDetail.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    els.collectDetail.hidden = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 탭 로드 완료까지 대기 (타임아웃 포함). */
function waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

/** 페이지를 새로고침한 뒤(로드 중 에러까지 수집) 진단 카드 갱신. */
async function reloadAndDiagnose() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isCapturableUrl(tab.url)) {
    els.collectSummary.textContent = '이 페이지에선 진단할 수 없어요.';
    return;
  }
  els.collectRefresh.disabled = true;
  els.collectDetail.hidden = true;
  els.collectSummary.textContent = '새로고침 후 진단 중…';
  try {
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    await sleep(800); // 로드 직후 늦게 나는 에러 여유
    await updateCollectCard();
  } catch {
    els.collectSummary.textContent = '진단에 실패했어요.';
  } finally {
    els.collectRefresh.disabled = false;
  }
}

/**
 * 내 ClickUp {id, name}을 반환. id·name 둘 다 캐시돼 있어야 캐시 사용,
 * 아니면 API로 다시 조회해 저장. (멘션 렌더에 정확한 이름이 필요)
 */
async function ensureMyUser(token) {
  const cfg = await getLocal([LOCAL_KEYS.MY_USER_ID, LOCAL_KEYS.MY_USER_NAME]);
  if (cfg[LOCAL_KEYS.MY_USER_ID] && cfg[LOCAL_KEYS.MY_USER_NAME]) {
    return { id: cfg[LOCAL_KEYS.MY_USER_ID], name: cfg[LOCAL_KEYS.MY_USER_NAME] };
  }
  try {
    const data = await getAuthorizedUser(token);
    const id = data?.user?.id || null;
    const name = data?.user?.username || data?.user?.email || '';
    if (id && name) await setLocal({ [LOCAL_KEYS.MY_USER_ID]: id, [LOCAL_KEYS.MY_USER_NAME]: name });
    return { id, name };
  } catch {
    return { id: null, name: '' }; // 실패해도 태스크 생성은 계속 진행
  }
}

/* ---------- 뷰 전환 ---------- */

function showLauncher() {
  els.viewReport.hidden = true;
  els.viewLauncher.hidden = false;
  updateCollectCard();
}

/** 캡처 진행 중 런처 버튼 잠금. (영상 버튼은 Phase 5 전까지 항상 비활성) */
function setActionsEnabled(on) {
  document.querySelectorAll('#view-launcher .action-btn[data-action]').forEach((b) => {
    if (b.dataset.action === 'video') {
      b.disabled = true;
      return;
    }
    b.disabled = !on;
  });
}

/** 툴바 버튼 활성 상태 표시. */
function setActiveTool(toolBtn) {
  els.toolbar.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.classList.remove('active'));
  if (toolBtn) toolBtn.classList.add('active');
}

function setActiveColor(colorBtn) {
  els.toolbar.querySelectorAll('.color-btn').forEach((b) => b.classList.remove('active'));
  if (colorBtn) colorBtn.classList.add('active');
}

async function showReport(cap) {
  if (annotator) {
    annotator.destroy();
    annotator = null;
  }

  if (cap.type === 'video') {
    // 영상: 주석 편집 없음 → 툴바/캔버스 숨기고 video 프리뷰.
    els.toolbar.hidden = true;
    els.canvas.hidden = true;
    els.videoPreview.hidden = false;
    els.videoPreview.src = cap.dataUrl;
    els.videoPlayBtn.hidden = false;
    els.videoPlayBtn.textContent = '▶ 재생';
    captureBlob = dataUrlToBlob(cap.dataUrl);
    captureFilename = `recording-${(cap.capturedAt || 'rec').replace(/[:.]/g, '-')}.webm`;
  } else {
    // 이미지: 캔버스 주석 편집기 초기화.
    els.videoPreview.hidden = true;
    els.videoPreview.removeAttribute('src');
    els.videoPlayBtn.hidden = true;
    els.toolbar.hidden = false;
    els.canvas.hidden = false;
    annotator = createAnnotator(els.canvas, cap.dataUrl);
    annotator.setTool(DEFAULT_TOOL);
    annotator.setColor(DEFAULT_COLOR);
    setActiveTool(els.toolbar.querySelector(`.tool-btn[data-tool="${DEFAULT_TOOL}"]`));
    setActiveColor(els.toolbar.querySelector(`.color-btn[data-color="${DEFAULT_COLOR}"]`));
  }

  const defaults = buildDefaults(cap);
  els.title.value = defaults.title;
  els.description.value = defaults.description;
  els.priority.value = '3';

  // 멘션 입력칸: 캐시된 내 이름으로 미리 채움 (없으면 비워 placeholder 예시 노출).
  const meCache = await getLocal([LOCAL_KEYS.MY_USER_NAME]);
  els.mentionName.value = meCache[LOCAL_KEYS.MY_USER_NAME] || '';
  currentSourceUrl = cap.sourceUrl || '';

  const stamp = (cap.capturedAt || 'capture').replace(/[:.]/g, '-');
  captureFilename = `screenshot-${stamp}.png`;
  captureBlob = dataUrlToBlob(cap.dataUrl);

  const cfg = await getLocal([LOCAL_KEYS.DEFAULT_LIST_ID]);
  const listId = cfg[LOCAL_KEYS.DEFAULT_LIST_ID];
  if (listId) {
    els.targetInfo.textContent = `등록 대상 리스트 ID: ${listId}`;
    els.targetInfo.hidden = false;
  } else {
    els.targetInfo.hidden = true;
  }

  els.toast.hidden = true;
  setLoading(false);
  els.viewLauncher.hidden = true;
  els.viewReport.hidden = false;
}

/* ---------- 캡처 ---------- */

function isCapturableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//.test(url) || url.startsWith('file://');
}

async function captureVisible() {
  showLauncherStatus('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!isCapturableUrl(tab.url)) {
    throw new Error('이 페이지는 캡처할 수 없습니다. 일반 웹페이지(http/https)에서 시도해주세요.');
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  const cap = {
    type: 'image',
    dataUrl,
    sourceUrl: tab.url,
    sourceTitle: tab.title || '',
    capturedAt: new Date().toISOString(),
    metadata: await buildCapMeta(tab),
  };

  // 패널이 닫혔다 다시 열려도 복원되도록 저장.
  await setSession({ [SESSION_KEYS.PENDING_CAPTURE]: cap });
  await showReport(cap);
}

/** 영역 선택 오버레이를 활성 탭에 주입. 결과는 onMessage(REGION_SELECTED)로 돌아온다. */
async function startRegionSelect() {
  showLauncherStatus('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!isCapturableUrl(tab.url)) {
    throw new Error('이 페이지는 캡처할 수 없습니다. 일반 웹페이지(http/https)에서 시도해주세요.');
  }
  regionTab = tab;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/region-select.js'] });
  showLauncherStatus('페이지에서 영역을 드래그하세요… (ESC 취소)');
}

/** 전체 뷰포트 dataURL을 rect(뷰포트 CSS px)만큼 잘라 새 dataURL 반환. */
function cropDataUrl(dataUrl, rect, dpr) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = Math.round(rect.x * dpr);
      const sy = Math.round(rect.y * dpr);
      const sw = Math.max(1, Math.round(rect.width * dpr));
      const sh = Math.max(1, Math.round(rect.height * dpr));
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('캡처 이미지를 불러오지 못했습니다.'));
    img.src = dataUrl;
  });
}

async function handleRegionSelected(rect, dpr) {
  try {
    const tab = regionTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const croppedDataUrl = await cropDataUrl(fullDataUrl, rect, dpr);

    const cap = {
      type: 'image',
      dataUrl: croppedDataUrl,
      sourceUrl: tab.url,
      sourceTitle: tab.title || '',
      capturedAt: new Date().toISOString(),
      metadata: await buildCapMeta(tab),
    };
    await setSession({ [SESSION_KEYS.PENDING_CAPTURE]: cap });
    await showReport(cap);
  } catch (err) {
    showLauncherStatus(err.message || '영역 캡처 중 오류가 발생했습니다.');
  }
}

/* ---------- 전체 페이지 캡처 ---------- */
// 아래 fp* 함수는 executeScript로 페이지에 주입되어 실행됨 (외부 스코프 참조 금지).

function fpBegin() {
  document.documentElement.style.scrollBehavior = 'auto';
  const originalScrollY = window.scrollY;
  let fixedCount = 0;
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (const el of all) {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') {
      el.setAttribute('data-qa-fp-fixed', '');
      fixedCount += 1;
    }
  }
  const scrollHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );
  return {
    scrollHeight,
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    originalScrollY,
    fixedCount,
  };
}

function fpScroll(y, hideFixed) {
  let style = document.getElementById('qa-fp-hide-style');
  if (hideFixed && !style) {
    // 첫 컷 이후엔 고정/스티키 요소를 숨겨 매 컷 반복되지 않게 함 (함정 6).
    style = document.createElement('style');
    style.id = 'qa-fp-hide-style';
    style.textContent = '[data-qa-fp-fixed]{visibility:hidden !important;}';
    document.documentElement.appendChild(style);
  }
  window.scrollTo(0, y);
  return { scrollY: window.scrollY };
}

function fpEnd(originalScrollY) {
  const style = document.getElementById('qa-fp-hide-style');
  if (style) style.remove();
  document.querySelectorAll('[data-qa-fp-fixed]').forEach((el) => el.removeAttribute('data-qa-fp-fixed'));
  window.scrollTo(0, originalScrollY);
}

const FP_MAX_CANVAS_PX = 30000; // 캔버스 높이 한도. 초과 시 상단부터 이 높이까지만.
const FP_MAX_SLICES = 40;
const FP_SETTLE_MS = 600; // 스크롤 안정 + captureVisibleTab 레이트리밋(<=2/s)

async function stitchSlices(slices, m) {
  const width = Math.round(m.viewportW * m.dpr);
  let fullH = Math.round(m.scrollHeight * m.dpr);
  let truncated = false;
  if (fullH > FP_MAX_CANVAS_PX) {
    fullH = FP_MAX_CANVAS_PX;
    truncated = true;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = fullH;
  const ctx = canvas.getContext('2d');
  for (const slice of slices) {
    // eslint-disable-next-line no-await-in-loop
    const img = await loadImage(slice.dataUrl);
    ctx.drawImage(img, 0, Math.round(slice.y * m.dpr));
  }
  return { dataUrl: canvas.toDataURL('image/png'), truncated };
}

async function captureFullPage() {
  showLauncherStatus('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!isCapturableUrl(tab.url)) {
    throw new Error('이 페이지는 캡처할 수 없습니다. 일반 웹페이지(http/https)에서 시도해주세요.');
  }

  setActionsEnabled(false);
  try {
    const [{ result: m }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fpBegin });
    const maxScroll = Math.max(0, m.scrollHeight - m.viewportH);
    const slices = [];

    try {
      let y = 0;
      let first = true;
      while (slices.length < FP_MAX_SLICES) {
        // eslint-disable-next-line no-await-in-loop
        const [{ result: s }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: fpScroll,
          args: [y, !first],
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(FP_SETTLE_MS);
        // eslint-disable-next-line no-await-in-loop
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        slices.push({ y: s.scrollY, dataUrl });
        showLauncherStatus(`전체 페이지 캡처 중… ${slices.length}컷`);
        first = false;
        if (s.scrollY >= maxScroll) break;
        y += m.viewportH;
      }
    } finally {
      // 중간에 실패해도 페이지(스크롤/고정요소) 원상복구.
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: fpEnd, args: [m.originalScrollY] })
        .catch(() => {});
    }

    const { dataUrl, truncated } = await stitchSlices(slices, m);
    const cap = {
      type: 'image',
      dataUrl,
      sourceUrl: tab.url,
      sourceTitle: tab.title || '',
      capturedAt: new Date().toISOString(),
      metadata: await buildCapMeta(tab),
    };
    await setSession({ [SESSION_KEYS.PENDING_CAPTURE]: cap });
    await showReport(cap);
    if (truncated) showToast('페이지가 매우 길어 상단 일부만 캡처했어요.', 'error');
  } finally {
    setActionsEnabled(true);
  }
}

/* ---------- 영상 녹화 ---------- */

function enterRecordingState() {
  els.recordingBanner.hidden = false;
  setActionsEnabled(false);
  showLauncherStatus('');
}

function exitRecordingState() {
  els.recordingBanner.hidden = true;
  setActionsEnabled(true);
}

async function startVideoRecording() {
  showLauncherStatus('');

  // getDisplayMedia는 사용자 제스처가 필요 → 다른 await보다 먼저 호출.
  let stream;
  // CaptureController: 녹화 시작 후 '녹화 대상 탭'으로 포커스를 옮김.
  const controller = typeof CaptureController !== 'undefined' ? new CaptureController() : null;
  try {
    const opts = {
      video: { frameRate: 30 },
      audio: false,
      // 패널(확장) 자신은 공유 대상에서 제외 → 사용자가 '제품 탭'을 직접 선택.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    };
    if (controller) opts.controller = controller;
    stream = await navigator.mediaDevices.getDisplayMedia(opts);
  } catch {
    throw new Error('화면 공유가 취소되었거나 시작하지 못했습니다.');
  }

  // 캡처된 탭으로 화면 전환 (지원 브라우저에서만).
  if (controller) {
    try {
      controller.setFocusBehavior('focus-captured-surface');
    } catch {
      /* 미지원/타이밍 이슈 무시 */
    }
  }

  recordingStream = stream;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  recordingTab = tab || null;

  recordedChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = handleRecorderStop;
  mediaRecorder.start(1000);

  // 크롬 자체 '공유 중지' 바로 멈추면 트랙이 종료됨 → 녹화도 마무리.
  const [videoTrack] = stream.getVideoTracks();
  if (videoTrack) videoTrack.addEventListener('ended', () => stopVideoRecording());

  await setSession({ recording: true });
  if (tab?.id) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/recording-controls.js'] });
    } catch {
      /* 주입 불가 페이지 무시 */
    }
  }
  enterRecordingState();
}

function stopVideoRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

async function handleRecorderStop() {
  if (recordingStream) {
    recordingStream.getTracks().forEach((t) => t.stop());
    recordingStream = null;
  }
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  recordedChunks = [];
  mediaRecorder = null;

  await setSession({ recording: false });
  if (recordingTab?.id) {
    try {
      await chrome.tabs.sendMessage(recordingTab.id, { type: 'REMOVE_RECORDING_CONTROLS' });
    } catch {
      /* 컨트롤 없거나 탭 닫힘 */
    }
  }
  exitRecordingState();

  const dataUrl = await blobToDataUrl(blob);
  const cap = {
    type: 'video',
    dataUrl,
    sourceUrl: recordingTab?.url || '',
    sourceTitle: recordingTab?.title || '',
    capturedAt: new Date().toISOString(),
    metadata: await buildCapMeta(recordingTab),
  };
  try {
    await setSession({ [SESSION_KEYS.PENDING_CAPTURE]: cap });
  } catch {
    /* 영상이 커서 quota 초과 시 메모리로만 유지 */
  }
  await showReport(cap);
}

async function handleAction(action) {
  try {
    if (action === 'visible') {
      await captureVisible();
    } else if (action === 'region') {
      await startRegionSelect();
    } else if (action === 'fullpage') {
      await captureFullPage();
    } else if (action === 'video') {
      await startVideoRecording();
    }
  } catch (err) {
    showLauncherStatus(err.message || '캡처 중 오류가 발생했습니다.');
  }
}

/* ---------- 등록 ---------- */

async function handleSubmit() {
  const cfg = await getLocal([LOCAL_KEYS.CLICKUP_TOKEN, LOCAL_KEYS.DEFAULT_LIST_ID]);
  const token = cfg[LOCAL_KEYS.CLICKUP_TOKEN];
  const listId = cfg[LOCAL_KEYS.DEFAULT_LIST_ID];

  if (!token || !listId) {
    showToast('먼저 설정 페이지에서 ClickUp 토큰과 리스트 ID를 입력해주세요.', 'error');
    return;
  }

  const name = els.title.value.trim();
  if (!name) {
    showToast('태스크 제목을 입력해주세요.', 'error');
    els.title.focus();
    return;
  }

  setLoading(true);
  try {
    // 본인 배정 + 본문 맨 아래에 '멘션 표시' 하이퍼링크.
    // (실제 멘션이 아니라 하이퍼링크 — 표시 텍스트는 입력값, 링크는 보이기용)
    const me = await ensureMyUser(token);
    const assignees = me.id ? [me.id] : undefined;

    let mentionMd = '';
    const mentionText = els.mentionName.value.trim();
    if (mentionText) {
      // 링크는 표시용 — 유효한 URL이어야 하이퍼링크로 렌더됨. 캡처 페이지 주소 사용.
      const link = /^https?:\/\//.test(currentSourceUrl) ? currentSourceUrl : 'https://app.clickup.com';
      mentionMd = `\n\n[@${mentionText}](${link})`;
    }
    const markdownContent = els.description.value + mentionMd;

    // 주석이 합쳐진 이미지를 첨부. 실패 시 원본으로 폴백.
    let blob = captureBlob;
    if (annotator) {
      const annotated = await annotator.getBlob();
      if (annotated) blob = annotated;
    }

    const { taskUrl } = await submitReport({
      token,
      listId,
      task: {
        name,
        markdownContent,
        priority: Number(els.priority.value) || 3,
        assignees,
      },
      blob,
      filename: captureFilename,
    });

    await removeSession(SESSION_KEYS.PENDING_CAPTURE);
    showToast('ClickUp에 등록되었습니다.', 'success', taskUrl);
    els.spinner.hidden = true;
    els.submitBtn.disabled = true;
    els.btnText.textContent = '등록 완료';
  } catch (err) {
    showToast(err.userMessage || err.message || '등록 중 오류가 발생했습니다.', 'error');
    setLoading(false);
  }
}

async function resetToLauncher() {
  await removeSession(SESSION_KEYS.PENDING_CAPTURE);
  captureBlob = null;
  if (annotator) {
    annotator.destroy();
    annotator = null;
  }
  els.videoPreview.removeAttribute('src');
  els.videoPreview.hidden = true;
  showLauncher();
  await checkConfig();
}

/* ---------- 설정 안내 ---------- */

async function checkConfig() {
  const cfg = await getLocal([LOCAL_KEYS.CLICKUP_TOKEN, LOCAL_KEYS.DEFAULT_LIST_ID]);
  const configured = cfg[LOCAL_KEYS.CLICKUP_TOKEN] && cfg[LOCAL_KEYS.DEFAULT_LIST_ID];
  els.configWarning.hidden = Boolean(configured);
}

/* ---------- 초기화 ---------- */

async function init() {
  // 자동 수집 첨부 여부 프리퍼런스 로드 (기본 켜짐).
  const prefs = await getLocal([LOCAL_KEYS.AUTO_COLLECT]);
  autoCollectEnabled = prefs[LOCAL_KEYS.AUTO_COLLECT] !== false;
  els.autoCollect.checked = autoCollectEnabled;

  // 패널이 닫히면 패널 내 녹화(MediaRecorder)는 유지되지 않으므로, 남은 플래그는 정리.
  const { recording } = await getSession('recording');
  if (recording) {
    await setSession({ recording: false });
  }

  // 미제출 캡처가 있으면 리포트 뷰로 복원.
  const { [SESSION_KEYS.PENDING_CAPTURE]: cap } = await getSession(SESSION_KEYS.PENDING_CAPTURE);
  if (cap && cap.dataUrl) {
    await showReport(cap);
  } else {
    showLauncher();
    await checkConfig();
  }
}

document.querySelectorAll('.action-btn').forEach((btn) => {
  btn.addEventListener('click', () => handleAction(btn.dataset.action));
});
els.submitBtn.addEventListener('click', handleSubmit);
els.backBtn.addEventListener('click', resetToLauncher);

// 주석 툴바
els.toolbar.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!annotator) return;
    annotator.setTool(btn.dataset.tool);
    setActiveTool(btn);
  });
});
els.toolbar.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!annotator) return;
    annotator.setColor(btn.dataset.color);
    setActiveColor(btn);
  });
});
els.undoBtn.addEventListener('click', () => annotator && annotator.undo());
els.clearBtn.addEventListener('click', () => annotator && annotator.clear());

// 자동 수집 카드
els.autoCollect.addEventListener('change', async () => {
  autoCollectEnabled = els.autoCollect.checked;
  await setLocal({ [LOCAL_KEYS.AUTO_COLLECT]: autoCollectEnabled });
});
els.collectRefresh.addEventListener('click', reloadAndDiagnose);
els.collectReread.addEventListener('click', () => updateCollectCard());

// 영역 선택 오버레이(content script)로부터의 결과 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REGION_SELECTED') {
    handleRegionSelected(msg.rect, msg.dpr);
  } else if (msg?.type === 'REGION_CANCELLED') {
    showLauncherStatus('영역 선택을 취소했습니다.');
  } else if (msg?.type === 'STOP_RECORDING') {
    // 페이지 플로팅 컨트롤의 중지 버튼
    stopVideoRecording();
  }
});

els.recStop.addEventListener('click', stopVideoRecording);

// 영상 재생/일시정지 토글 (native controls와 라벨 동기화)
els.videoPlayBtn.addEventListener('click', () => {
  if (els.videoPreview.paused) els.videoPreview.play();
  else els.videoPreview.pause();
});
els.videoPreview.addEventListener('play', () => {
  els.videoPlayBtn.textContent = '⏸ 일시정지';
});
els.videoPreview.addEventListener('pause', () => {
  els.videoPlayBtn.textContent = '▶ 재생';
});
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-options-link').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();

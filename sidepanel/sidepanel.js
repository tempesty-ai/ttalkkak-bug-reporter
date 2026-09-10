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
import { submitReport, getAuthorizedUser, getList, listPathParts, joinListPath } from '../lib/clickup.js';
import { chatJson } from '../lib/openai.js';
import { TEAM_DEFAULTS } from '../lib/team-config.js';
import { putBlob, getBlob } from '../lib/media-store.js';
import { createAnnotator } from './annotator.js';

// 뷰어 탭이 같은 키로 읽어간다. (이미지·영상 공용)
const MEDIA_STORE_KEY = 'lastMedia';

const els = {
  viewLauncher: document.getElementById('view-launcher'),
  viewReport: document.getElementById('view-report'),
  launcherStatus: document.getElementById('launcher-status'),
  configWarning: document.getElementById('config-warning'),
  canvas: document.getElementById('annotate-canvas'),
  videoPreview: document.getElementById('video-preview'),
  videoPlayBtn: document.getElementById('video-play-btn'),
  videoActions: document.getElementById('video-actions'),
  videoOpenBtn: document.getElementById('video-open-btn'),
  zoomBtn: document.getElementById('zoom-btn'),
  toolbar: document.querySelector('.annotate-toolbar'),
  undoBtn: document.getElementById('undo-btn'),
  clearBtn: document.getElementById('clear-btn'),
  recordingBanner: document.getElementById('recording-banner'),
  recStop: document.getElementById('rec-stop'),
  recTime: document.getElementById('rec-time'),
  livePreview: document.getElementById('live-preview'),
  liveImg: document.getElementById('live-img'),
  liveEmpty: document.getElementById('live-empty'),
  liveState: document.getElementById('live-state'),
  liveLabel: document.getElementById('live-label'),
  followBtn: document.getElementById('follow-btn'),
  followLabel: document.getElementById('follow-label'),
  envUrl: document.getElementById('env-url'),
  envUa: document.getElementById('env-ua'),
  envScreen: document.getElementById('env-screen'),
  envClock: document.getElementById('env-clock'),
  descMeta: document.getElementById('desc-meta'),
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
  aiSubmitBtn: document.getElementById('ai-submit-btn'),
  aiBtnText: document.querySelector('#ai-submit-btn .ai-btn-text'),
  aiSpinner: document.querySelector('#ai-submit-btn .ai-spinner'),
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
let currentMeta = null; // 현재 캡처의 metadata (자동 수집 정보 — AI 등록 시 보존용)
let mediaRecorder = null; // 패널 내 MediaRecorder (getDisplayMedia 방식)
let recordedChunks = [];
let recordingStream = null;

const DEFAULT_TOOL = 'arrow';
const DEFAULT_COLOR = '#e5484d';

let autoCollectEnabled = true; // 리포트에 자동 수집 정보 첨부 여부
let collectPollTimer = null; // 진단 카드 실시간 폴링
let busyDiagnosing = false; // 새로고침 후 진단 진행 중
let envClockTimer = null; // 환경 정보 카드의 1초 시계
let recTimer = null; // 녹화 경과 시간
let recStartedAt = 0;
let liveTimer = null; // 라이브 미리보기 폴링
let liveBusy = false; // 직전 프레임 캡처가 아직 안 끝났으면 건너뛴다
let capturing = false; // 실제 캡처 진행 중 — 라이브 폴링이 쿼터를 뺏지 않도록
let following = true; // 리포트 화면에서 캡처가 현재 화면을 계속 따라갈지
let regionMode = 'image'; // 영역 선택 결과를 스크린샷으로 쓸지 녹화로 쓸지
let pendingRegionStream = null; // 영역 지정을 기다리는 동안 잡아둔 화면 공유 스트림
let cropSourceStream = null; // 영역 녹화의 원본(전체 탭) 스트림
let cropVideoEl = null; // 원본 스트림을 물고 있는 <video> (캔버스로 옮겨 그리는 소스)
let cropRafId = null; // 크롭 드로잉 루프
let monitorEl = null; // 녹화 중 LIVE 영역에 띄우는 실시간 모니터

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
  els.btnText.textContent = on ? '등록 중…' : '그대로 ClickUp에 등록';
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
/** 상호작용 1건을 한글 재현 문장으로. 연속 반복은 " (×N)"으로 붙는다. */
function formatStep(s) {
  const n = timesSuffix(s.count);
  if (s.action === 'input') return `${s.target}에 "${s.extra}" 입력${n}`;
  if (s.action === 'select') return `${s.target}에서 "${s.extra}" 선택${n}`;
  if (s.action === 'check') return `${s.target} 체크${n}`;
  if (s.action === 'uncheck') return `${s.target} 체크 해제${n}`;
  return `${s.target} 클릭${n}`;
}

/**
 * 자동 기록된 상호작용을 사람이 읽는 재현 문장 배열로.
 *
 * 본문에 바로 끼워 넣지 않는다. '그대로 ClickUp에 등록'은 사용자가 쓴 것을 그대로 올리는
 * 기능이라, 손대지 않은 자동 문장이 섞이면 안 된다. 이 값은 'AI로 다듬어 등록'의 재료로만 쓴다.
 *
 * 세션에 저장된 캡처는 옛 수집기가 만든 기록을 들고 있을 수 있어 여기서도 한 번 정리한다.
 */
function recordedSteps(meta) {
  if (!autoCollectEnabled || !meta || !Array.isArray(meta.interactions)) return [];
  return cleanInteractions(meta.interactions)
    .slice(-8)
    .map((s) => formatStep(s));
}

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

/** 같은 항목 중복 제거 (keyFn 기준). 반환 항목엔 count(발생 횟수) 부여. */
function dedupeBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    const existing = map.get(k);
    if (existing) existing.count += 1;
    else map.set(k, { ...item, count: 1 });
  }
  return [...map.values()];
}

/** 발생 횟수 접미사 (2회 이상일 때만 " (×N)"). */
function timesSuffix(n) {
  return n > 1 ? ` (×${n})` : '';
}

// 메시지 끝에 붙는 '(파일:줄)' 위치 표기.
const ERR_LOCATION_RE = /\s*\((\S+:\d+)\)\s*$/;

/**
 * 같은 콘솔 에러를 위치 표기 때문에 따로 세지 않도록 합친다.
 *
 * SPA에서는 ResizeObserver 경고 같은 게 라우트마다 다른 URL을 달고 올라와서,
 * 메시지 전체로 비교하면 같은 에러가 4~5줄로 흩어진다. 위치를 떼고 묶되,
 * 위치가 하나뿐이면 그대로 남기고 여러 곳이면 '(N곳)'으로 요약한다.
 */
function dedupeConsoleErrors(list) {
  const map = new Map();
  for (const e of list || []) {
    const raw = String(e.message || '');
    const loc = (raw.match(ERR_LOCATION_RE) || [])[1] || '';
    const key = raw.replace(ERR_LOCATION_RE, '').trim();
    const prev = map.get(key);
    if (prev) {
      prev.count += e.count || 1;
      if (loc) prev.locations.add(loc);
    } else {
      map.set(key, { at: e.at, count: e.count || 1, locations: new Set(loc ? [loc] : []) });
    }
  }
  return [...map.entries()].map(([key, v]) => {
    const where = v.locations.size > 1 ? ` (${v.locations.size}곳)` : v.locations.size === 1 ? ` (${[...v.locations][0]})` : '';
    return { message: `${key}${where}`, at: v.at, count: v.count };
  });
}

/**
 * '보이는 문자열' 기준으로 합친다.
 *
 * collectPageInfo가 원본 메시지로 이미 중복을 제거하지만, 출력할 때 길이를 잘라내면
 * 뒷부분(스택·타임스탬프)만 다르던 항목들이 같은 줄로 보이게 된다. 그 상태로 두면
 * 리포트에 똑같은 줄이 여러 개 남는다.
 * @returns {Array<{text:string, count:number}>}
 */
function dedupeByText(items, toText) {
  const map = new Map();
  for (const it of items || []) {
    const text = toText(it);
    const prev = map.get(text);
    if (prev) prev.count += it.count || 1;
    else map.set(text, { text, count: it.count || 1 });
  }
  return [...map.values()];
}

const COLLECT_LIST_MAX = 5;

/** 목록에 다 못 담은 나머지를 알려준다. 머릿수와 줄 수가 어긋나 보이지 않도록. */
function moreSuffix(total, shown) {
  return total > shown ? ` 외 ${total - shown}건` : '';
}

/** cap.metadata의 자동 수집 정보를 마크다운 섹션으로. 없으면 빈 문자열. */
function formatCollected(meta) {
  if (!meta) return '';
  const errs = dedupeByText(meta.consoleErrors, (e) => truncate(e.message, 200));
  const reqs = dedupeByText(
    meta.failedRequests,
    (r) => `${r.status} ${r.method} ${truncate(r.url, 120)}`,
  );
  if (!errs.length && !reqs.length) return '';

  const lines = ['', '**🔎 자동 수집 정보**'];
  if (errs.length) {
    lines.push(`- 콘솔 에러: ${errs.length}건${moreSuffix(errs.length, COLLECT_LIST_MAX)}`);
    errs.slice(0, COLLECT_LIST_MAX).forEach((e) => lines.push(`  - ${e.text}${timesSuffix(e.count)}`));
  }
  if (reqs.length) {
    lines.push(`- 실패 요청: ${reqs.length}건${moreSuffix(reqs.length, COLLECT_LIST_MAX)}`);
    reqs.slice(0, COLLECT_LIST_MAX).forEach((r) => lines.push(`  - ${r.text}${timesSuffix(r.count)}`));
  }
  return lines.join('\n');
}

/**
 * 확장이 페이지에 심은 컨트롤을 눌렀던 기록. log-collector에도 필터를 넣었지만
 * 그건 선언형 content script라 페이지가 '다시 로드돼야' 적용된다.
 * 이미 열려 있는 탭에 쌓인 기록까지 없애려면 읽는 쪽에서도 걸러야 한다.
 *
 * 페이지에 흔한 '취소' 같은 일반 단어는 넣지 않는다 — 진짜 사용자 조작을 지우는 게 더 나쁘다.
 */
const EXT_UI_STEPS = new Set([
  "'영역 지정' 버튼",
  "'전체 녹화' 버튼",
  "'■ 중지' 버튼",
  "'✕ 취소 (ESC)' 버튼",
]);

/** 확장 UI 기록 제거 + 연속 중복 합치기. 옛 수집기가 남긴 데이터도 여기서 정리된다. */
function cleanInteractions(list) {
  const out = [];
  for (const s of list || []) {
    if (EXT_UI_STEPS.has(s.target)) continue;
    const last = out[out.length - 1];
    if (last && last.action === s.action && last.target === s.target && last.extra === s.extra) {
      last.count = (last.count || 1) + (s.count || 1);
      continue;
    }
    out.push({ ...s, count: s.count || 1 });
  }
  return out;
}

/** 탭의 모든 프레임 MAIN world에서 수집 데이터를 읽어 병합. 주입 불가 페이지면 null. */
async function collectPageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // iframe까지 포함
      world: 'MAIN',
      func: () => {
        const c = window.__qaCollected || { consoleErrors: [], failedRequests: [], interactions: [] };
        return {
          consoleErrors: c.consoleErrors || [],
          failedRequests: c.failedRequests || [],
          interactions: c.interactions || [],
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        };
      },
    });
    const merged = { consoleErrors: [], failedRequests: [], interactions: [], viewport: '' };
    for (const r of results) {
      if (!r?.result) continue;
      merged.consoleErrors.push(...(r.result.consoleErrors || []));
      merged.failedRequests.push(...(r.result.failedRequests || []));
      merged.interactions.push(...(r.result.interactions || []));
    }
    // 상호작용은 시간순 정렬 후 최근 것만.
    merged.interactions.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    merged.interactions = cleanInteractions(merged.interactions);
    merged.viewport = results[0]?.result?.viewport || '';
    // 같은 에러/요청 중복 제거 → 1건 + count
    merged.consoleErrors = dedupeConsoleErrors(merged.consoleErrors);
    merged.failedRequests = dedupeBy(merged.failedRequests, (r) => `${r.status} ${r.method} ${r.url}`);
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
      meta.interactions = info.interactions;
    }
  }
  return meta;
}

/** 수치 3열 대신 단일 안내 문구를 보여준다 (수집 불가·진단 중 등). */
function setCollectMessage(text) {
  els.collectSummary.innerHTML = `<span class="collect-msg">${escapeHtml(text)}</span>`;
}

/** 수치 한 칸. value가 0보다 크고 tone이 있으면 그 색으로. */
function metricCell(value, label, tone, tip) {
  const cls = ['collect-metric', value > 0 && tone ? tone : ''].filter(Boolean).join(' ');
  const title = tip ? ` title="${escapeHtml(tip)}"` : '';
  return `<div><b class="${cls}"${title}>${value}</b><span class="metric-label">${escapeHtml(label)}</span></div>`;
}

/** 런처의 진단 카드 갱신. */
async function updateCollectCard() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  els.collectDetail.hidden = true;
  els.collectDetail.innerHTML = '';
  updateEnvCard(tab);

  if (!tab || !isCapturableUrl(tab.url)) {
    setCollectMessage('이 페이지에선 진단 정보를 수집할 수 없어요.');
    return;
  }
  const info = await collectPageInfo(tab.id);
  if (!info) {
    setCollectMessage('진단 정보를 불러올 수 없어요.');
    return;
  }

  const errs = info.consoleErrors;
  const reqs = info.failedRequests;

  // 수치 위에 마우스를 올리면 실제 내용을 툴팁으로. (좁은 패널이라 본문에 다 못 편다)
  const errTip = errs.length
    ? errs.slice(-15).map((x, i) => `${i + 1}. ${truncate(x.message, 250)}${timesSuffix(x.count)}`).join('\n')
    : '';
  const reqTip = reqs.length
    ? reqs.slice(-15).map((x, i) => `${i + 1}. ${x.status} ${x.method} ${truncate(x.url, 160)}${timesSuffix(x.count)}`).join('\n')
    : '';

  els.collectSummary.innerHTML =
    metricCell(errs.length, '콘솔 에러', 'status-bad', errTip) +
    metricCell(reqs.length, '실패 요청', '', reqTip);

  // 잘라낸 뒤 같아 보이는 항목은 합친다 — 목록에 똑같은 줄이 나란히 남지 않도록.
  const items = [
    ...dedupeByText(errs, (x) => truncate(x.message, 120)).map((x) => ({
      net: false,
      text: `${x.text}${timesSuffix(x.count)}`,
    })),
    ...dedupeByText(reqs, (x) => `${x.status} ${x.method} ${truncate(x.url, 90)}`).map((x) => ({
      net: true,
      text: `${x.text}${timesSuffix(x.count)}`,
    })),
  ];
  if (items.length) {
    els.collectDetail.innerHTML = items
      .map((it) => `<li${it.net ? ' class="is-net"' : ''}>${escapeHtml(it.text)}</li>`)
      .join('');
    els.collectDetail.hidden = false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 환경 정보 카드 ---------- */

/** userAgent에서 'Chrome 130 · Windows 11' 형태로. */
function formatBrowser(ua) {
  const m = ua.match(/(Edg|Chrome|Firefox|Version)\/(\d+)/);
  const names = { Edg: 'Edge', Chrome: 'Chrome', Firefox: 'Firefox', Version: 'Safari' };
  const name = m ? names[m[1]] : '브라우저';
  const os = /Windows NT 10/.test(ua)
    ? 'Windows 10/11'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : '';
  return `${name}${m ? ` ${m[2]}` : ''}${os ? ` · ${os}` : ''}`;
}

/** 표시용 시간대 라벨. 사내 기본은 KST, 그 외 지역은 UTC 오프셋. */
function tzLabel() {
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Seoul') return 'KST';
  } catch {
    /* Intl 실패 시 오프셋으로 폴백 */
  }
  const h = -new Date().getTimezoneOffset() / 60;
  return `UTC${h >= 0 ? '+' : ''}${h}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 오늘 날짜를 YYYY-MM-DD로 (로컬 기준). */
function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowText() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${date} ${time} ${tzLabel()}`;
}

/** URL·브라우저·화면 갱신. (시각은 startEnvClock이 1초마다 따로 갱신) */
function updateEnvCard(tab) {
  els.envUrl.textContent = tab?.url || '—';
  els.envUa.textContent = formatBrowser(navigator.userAgent);
  // 원시 devicePixelRatio는 0.8999999761581421처럼 나와서 소수 둘째 자리로 정리.
  const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  els.envScreen.textContent = `${window.screen.width} × ${window.screen.height} · DPR ${dpr}`;
}

function startEnvClock() {
  stopEnvClock();
  els.envClock.textContent = nowText();
  envClockTimer = setInterval(() => {
    els.envClock.textContent = nowText();
  }, 1000);
}

function stopEnvClock() {
  if (envClockTimer) {
    clearInterval(envClockTimer);
    envClockTimer = null;
  }
}

/* ---------- 라이브 미리보기 ---------- */

// captureVisibleTab은 초당 2회로 제한된다. 실제 캡처가 끼어들 여유까지 두고 1초 주기.
const LIVE_INTERVAL_MS = 1000;

function setLiveState(text, idle) {
  els.liveState.classList.toggle('is-idle', Boolean(idle));
  els.liveLabel.textContent = text;
}

function showLiveMessage(text) {
  els.liveImg.hidden = true;
  els.liveEmpty.hidden = false;
  els.liveEmpty.textContent = text;
}

/** 리포트 화면의 따라가기 상태를 켜고 끈다. */
function setFollowing(on) {
  following = on;
  els.followBtn.classList.toggle('is-idle', !on);
  els.followLabel.textContent = on ? '따라가는 중' : '고정됨';
}

/**
 * 현재 탭을 한 장 찍어 미리보기에 반영. 실패는 조용히 넘긴다(다음 주기에 회복).
 *
 * 런처에선 썸네일(jpeg)이면 충분하지만, 리포트 화면의 프레임은 그대로 ClickUp에
 * 첨부되므로 무손실 png로 찍는다.
 */
async function refreshLivePreview() {
  // 녹화 중엔 그 자리를 실시간 모니터가 쓰고 있다.
  if (monitorEl) return;
  if (liveBusy || capturing || document.hidden) return;
  const onLauncher = isLauncherVisible();
  const onReport = !onLauncher && following && annotator;
  if (!onLauncher && !onReport) return;

  liveBusy = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isCapturableUrl(tab.url)) {
      if (onLauncher) {
        showLiveMessage('이 페이지는 미리보기를 만들 수 없어요.');
        setLiveState('대기 중', true);
      }
      return;
    }

    if (onLauncher) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
      els.liveImg.src = dataUrl;
      els.liveImg.hidden = false;
      els.liveEmpty.hidden = true;
      setLiveState('따라가는 중', false);
    } else {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      // 베이스 이미지만 교체 — 그려둔 주석은 그대로 남는다.
      await annotator.setImage(dataUrl);
      captureBlob = dataUrlToBlob(dataUrl); // AI에 보낼 이미지도 같이 최신화
      currentSourceUrl = tab.url || currentSourceUrl;
    }
  } catch {
    /* 쿼터 초과·탭 전환 중 등 — 다음 주기에 자연히 회복 */
  } finally {
    liveBusy = false;
  }
}

function startLivePreview() {
  stopLivePreview();
  if (monitorEl) return; // 녹화 중이면 모니터가 우선
  refreshLivePreview();
  liveTimer = setInterval(refreshLivePreview, LIVE_INTERVAL_MS);
}

function stopLivePreview() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

/**
 * 녹화 중 LIVE 자리에 '지금 실제로 기록되고 있는 영상'을 그대로 흘린다.
 * 영역 녹화면 크롭된 캔버스 스트림이 넘어오므로, 잘린 그 화면이 그대로 보인다.
 */
function showRecMonitor(stream) {
  hideRecMonitor();
  const v = document.createElement('video');
  v.className = 'live-monitor';
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  monitorEl = v;
  els.liveImg.hidden = true;
  els.liveEmpty.hidden = true;
  els.livePreview.append(v);
  els.livePreview.disabled = true; // 녹화 중엔 눌러도 새 캡처를 뜨면 안 된다
  setLiveState('녹화 중', false);
  v.play().catch(() => {
    /* 자동재생 실패는 무시 — 프레임은 계속 들어온다 */
  });
}

function hideRecMonitor() {
  if (monitorEl) {
    monitorEl.pause();
    monitorEl.srcObject = null;
    monitorEl.remove();
    monitorEl = null;
  }
  els.livePreview.disabled = false;
}

const isLauncherVisible = () => !els.viewLauncher.hidden;

/** 런처가 보이는 동안 진단 카드를 주기적으로 갱신 (페이지 활동 실시간 반영). */
function startCollectPolling() {
  stopCollectPolling();
  collectPollTimer = setInterval(() => {
    if (!busyDiagnosing && isLauncherVisible()) updateCollectCard();
  }, 3000);
}

function stopCollectPolling() {
  if (collectPollTimer) {
    clearInterval(collectPollTimer);
    collectPollTimer = null;
  }
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
    setCollectMessage('이 페이지에선 진단할 수 없어요.');
    return;
  }
  els.collectRefresh.disabled = true;
  els.collectDetail.hidden = true;
  setCollectMessage('새로고침 후 진단 중…');
  busyDiagnosing = true;
  try {
    await chrome.tabs.reload(tab.id, { bypassCache: true }); // 강력 새로고침(캐시 무시)
    await waitForTabComplete(tab.id);
    await sleep(800); // 로드 직후 늦게 나는 에러 여유
    await updateCollectCard();
  } catch {
    setCollectMessage('진단에 실패했어요.');
  } finally {
    busyDiagnosing = false;
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

/**
 * 등록 대상 줄을 리스트 '이름'으로 보여준다. 숫자 ID만으로는 어디에 올라가는지 알 수 없다.
 * 이름은 로컬에 캐시하고, 없으면 한 번만 API로 조회해 채워 넣는다.
 */
async function renderTargetInfo() {
  const cfg = await getLocal([LOCAL_KEYS.DEFAULT_LIST_ID, LOCAL_KEYS.DEFAULT_LIST_PATH, LOCAL_KEYS.CLICKUP_TOKEN]);
  const listId = cfg[LOCAL_KEYS.DEFAULT_LIST_ID];
  if (!listId) {
    els.targetInfo.hidden = true;
    return;
  }

  const paint = (path) => {
    const text = path ? escapeHtml(path) : `리스트 ID ${escapeHtml(listId)}`;
    els.targetInfo.innerHTML =
      `<span class="target-label">클릭업 게시공간</span><span class="target-name">${text}</span>`;
    els.targetInfo.title = `리스트 ID: ${listId}`;
    els.targetInfo.hidden = false;
  };

  const cached = joinListPath(cfg[LOCAL_KEYS.DEFAULT_LIST_PATH]);
  paint(cached);
  if (cached || !cfg[LOCAL_KEYS.CLICKUP_TOKEN]) return;

  // 캐시가 없을 때만 조회. 실패해도 ID 표시로 남으므로 조용히 넘어간다.
  try {
    const parts = listPathParts(await getList(listId, cfg[LOCAL_KEYS.CLICKUP_TOKEN]));
    if (!parts.length) return;
    await setLocal({ [LOCAL_KEYS.DEFAULT_LIST_PATH]: parts });
    paint(joinListPath(parts));
  } catch {
    /* 경로를 못 가져와도 등록에는 지장 없다 */
  }
}

/**
 * 뷰어 탭에서 그린 주석을 패널로 되받는다.
 *
 * 뷰어가 내보낸 이미지는 주석이 이미 합쳐진(flatten) 상태다. 그래서 패널 쪽 도형 목록을
 * 비운 뒤 베이스 이미지로 깔아야 한다. 안 그러면 같은 주석이 두 번 그려진다.
 */
async function applyAnnotationFromViewer() {
  if (!annotator) return;
  try {
    const blob = await getBlob(MEDIA_STORE_KEY);
    if (!blob || !(blob.type || '').startsWith('image/')) return;
    const dataUrl = await blobToDataUrl(blob);
    annotator.clear();
    await annotator.setImage(dataUrl);
    captureBlob = blob;
    setFollowing(false); // 손으로 편집했으니 라이브 갱신이 덮어쓰면 안 된다
    showToast('주석을 반영했습니다.', 'success');
  } catch {
    showToast('주석을 반영하지 못했습니다.', 'error');
  }
}

/* ---------- 뷰 전환 ---------- */

function showLauncher() {
  els.viewReport.hidden = true;
  els.viewLauncher.hidden = false;
  updateCollectCard();
  startCollectPolling();
  startEnvClock();
  startLivePreview();
}

/** 캡처 진행 중 런처 버튼 잠금. */
// 예전엔 'video'를 무조건 disabled로 두는 분기가 있었다. 녹화가 구현된 뒤로는
// 이 함수가 한 번이라도 불리면 영상 버튼이 영구히 잠기는 버그였다.
function setActionsEnabled(on) {
  document.querySelectorAll('#view-launcher .action-btn[data-action]').forEach((b) => {
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
  stopCollectPolling(); // 리포트 화면에선 진단 폴링 중지
  stopEnvClock(); // 환경 카드가 안 보이므로 시계도 중지
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
    els.videoActions.hidden = false;
    els.videoPlayBtn.textContent = '▶ 재생';
    els.zoomBtn.hidden = true; // 영상은 자체 컨트롤(전체화면) 사용
    els.followBtn.hidden = true; // 녹화본은 따라갈 대상이 아니다
    setFollowing(false);
    captureBlob = dataUrlToBlob(cap.dataUrl);
    captureFilename = `recording-${(cap.capturedAt || 'rec').replace(/[:.]/g, '-')}.webm`;
  } else {
    // 이미지: 캔버스 주석 편집기 초기화.
    els.videoPreview.hidden = true;
    els.videoPreview.removeAttribute('src');
    els.videoActions.hidden = true;
    els.toolbar.hidden = false;
    els.canvas.hidden = false;
    els.zoomBtn.hidden = false; // 이미지 캡처만 확대 보기 제공
    els.followBtn.hidden = false;
    setFollowing(true); // 주석을 그리기 전까지는 현재 화면을 계속 따라간다
    annotator = createAnnotator(els.canvas, cap.dataUrl);
    annotator.setTool(DEFAULT_TOOL);
    annotator.setColor(DEFAULT_COLOR);
    setActiveTool(els.toolbar.querySelector(`.tool-btn[data-tool="${DEFAULT_TOOL}"]`));
    setActiveColor(els.toolbar.querySelector(`.color-btn[data-color="${DEFAULT_COLOR}"]`));
    // 이미지 첨부용 파일명/blob (영상 분기는 위에서 .webm으로 이미 설정됨 — 덮어쓰지 말 것)
    const stamp = (cap.capturedAt || 'capture').replace(/[:.]/g, '-');
    captureFilename = `screenshot-${stamp}.png`;
    captureBlob = dataUrlToBlob(cap.dataUrl);
  }

  const defaults = buildDefaults(cap);
  els.title.value = ''; // 제목은 placeholder([고객사] 이슈 내용)로만 안내 → 지울 필요 없음
  els.description.value = defaults.description;
  els.priority.value = '3';

  // 기록된 조작이 있다는 것과, 그게 AI 등록에서만 쓰인다는 걸 알려준다.
  // 본문에는 넣지 않으므로 '자동 작성됨'이라고 하면 안 된다.
  const stepCount = recordedSteps(cap.metadata).length;
  els.descMeta.textContent = stepCount ? `기록된 조작 ${stepCount}개 · AI 등록 시 반영` : '';
  els.descMeta.hidden = !stepCount;

  // 멘션 입력칸: 캐시된 내 이름으로 미리 채움 (없으면 비워 placeholder 예시 노출).
  const meCache = await getLocal([LOCAL_KEYS.MY_USER_NAME]);
  els.mentionName.value = meCache[LOCAL_KEYS.MY_USER_NAME] || '';
  currentSourceUrl = cap.sourceUrl || '';
  currentMeta = cap.metadata || null;
  updateAiButtonVisibility(); // OpenAI 키 있을 때만 AI 버튼 노출

  await renderTargetInfo();

  els.toast.hidden = true;
  setLoading(false);
  els.viewLauncher.hidden = true;
  els.viewReport.hidden = false;
  startLivePreview(); // 리포트에서도 following이면 계속 따라간다
}

/* ---------- 캡처 ---------- */

function isCapturableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//.test(url) || url.startsWith('file://');
}

/**
 * 대상 탭이 새 프레임을 그릴 때까지 기다린다.
 *
 * captureVisibleTab은 탭이 '마지막으로 합성한 프레임'을 돌려준다. 패널에 포커스가 있어
 * 페이지가 아직 다시 그리지 않았거나, 직전에 오버레이를 걷어낸 뒤라면 이전 화면이 찍힌다.
 * rAF를 두 번 넘겨 한 프레임이 실제로 그려진 걸 보장한 뒤 캡처한다.
 */
async function waitForFreshFrame(tabId) {
  // .catch로 먼저 무력화한다. race에 그대로 넘기면 주입 실패 시 race가 즉시 거부돼
  // 아래 최소 대기까지 통째로 건너뛰게 된다.
  const painted = chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    })
    .catch(() => null);

  // 탭이 가려져 rAF가 안 뛰는 경우까지 붙잡고 있지 않도록 상한을 둔다.
  await Promise.race([painted, sleep(400)]);
}

async function captureVisible() {
  showLauncherStatus('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!isCapturableUrl(tab.url)) {
    throw new Error('이 페이지는 캡처할 수 없습니다. 일반 웹페이지(http/https)에서 시도해주세요.');
  }

  await waitForFreshFrame(tab.id);
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

/**
 * 영역 선택 오버레이를 활성 탭에 주입. 결과는 onMessage(REGION_SELECTED)로 돌아온다.
 * @param {'image'|'video'} mode 선택한 영역을 스크린샷으로 쓸지, 녹화 범위로 쓸지
 */
async function startRegionSelect(mode = 'image') {
  showLauncherStatus('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!isCapturableUrl(tab.url)) {
    throw new Error('이 페이지는 캡처할 수 없습니다. 일반 웹페이지(http/https)에서 시도해주세요.');
  }
  regionTab = tab;
  regionMode = mode;
  // 오버레이가 자기 모드를 알도록 주입 직전에 심어둔다 (files: 주입엔 args를 못 넘긴다).
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (m) => {
      window.__qaRegionMode = m;
    },
    args: [mode],
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/region-select.js'] });
  showLauncherStatus(
    mode === 'video'
      ? '페이지에서 녹화할 영역을 드래그하세요… (ESC 취소)'
      : '페이지에서 영역을 드래그하세요… (ESC 취소)',
  );
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

async function handleRegionSelected(rect, dpr, viewport) {
  // 녹화 모드면 스크린샷 경로를 타지 않고 크롭 녹화를 시작한다.
  if (regionMode === 'video') {
    regionMode = 'image';
    try {
      await startCroppedRecording(rect, viewport);
      await finishRecordingSetup();
    } catch (err) {
      releasePendingRegionStream();
      showLauncherStatus(err.message || '영역 녹화를 시작하지 못했습니다.');
    }
    return;
  }

  try {
    const tab = regionTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    // 선택 오버레이가 화면에서 완전히 걷힌 프레임을 기다렸다가 찍는다.
    await waitForFreshFrame(tab.id);
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
  const dpr = window.devicePixelRatio || 1;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const docEl = document.scrollingElement || document.documentElement;
  const winScrolls = docEl.scrollHeight > viewportH + 4;

  let mode = 'window';
  let rect = { top: 0, left: 0, width: viewportW, height: viewportH };
  let scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let step = viewportH;
  let originalScroll = window.scrollY;
  let fixedCount = 0;

  // 창이 스크롤되지 않으면(대시보드 등) 내부 스크롤 컨테이너를 찾는다.
  if (!winScrolls) {
    let best = null;
    let bestScore = 0;
    const els = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of els) {
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 20) continue;
      const r = el.getBoundingClientRect();
      if (r.width < viewportW * 0.4 || r.height < viewportH * 0.35) continue; // 사이드바 등 작은 스크롤 제외
      const score = scrollable * r.width * r.height; // 스크롤 여력 + 화면 점유가 큰 요소 우선
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (best) {
      mode = 'element';
      best.setAttribute('data-qa-fp-scroll', '');
      const r = best.getBoundingClientRect();
      const top = Math.max(0, r.top);
      const left = Math.max(0, r.left);
      rect = { top, left, width: Math.min(r.width, viewportW - left), height: Math.min(r.height, viewportH - top) };
      scrollHeight = best.scrollHeight;
      step = best.clientHeight;
      originalScroll = best.scrollTop;
    }
  }

  // 창 스크롤일 때만 고정/스티키를 표시(첫 컷 뒤 숨김). 내부 컨테이너는 잘라내므로 불필요.
  if (mode === 'window') {
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (const el of all) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') { el.setAttribute('data-qa-fp-fixed', ''); fixedCount += 1; }
    }
  }

  const maxScroll = Math.max(0, scrollHeight - step);
  return { mode, rect, scrollHeight, step, maxScroll, viewportW, viewportH, dpr, originalScroll, fixedCount };
}

function fpScroll(y, hideFixed) {
  const t = document.querySelector('[data-qa-fp-scroll]');
  if (t) {
    t.scrollTop = y; // 내부 컨테이너 스크롤
    return { scroll: t.scrollTop };
  }
  let style = document.getElementById('qa-fp-hide-style');
  if (hideFixed && !style) {
    // 첫 컷 이후엔 고정/스티키 요소를 숨겨 매 컷 반복되지 않게 함 (함정 6).
    style = document.createElement('style');
    style.id = 'qa-fp-hide-style';
    style.textContent = '[data-qa-fp-fixed]{visibility:hidden !important;}';
    document.documentElement.appendChild(style);
  }
  window.scrollTo(0, y);
  return { scroll: window.scrollY };
}

function fpEnd(originalScroll) {
  const style = document.getElementById('qa-fp-hide-style');
  if (style) style.remove();
  document.querySelectorAll('[data-qa-fp-fixed]').forEach((el) => el.removeAttribute('data-qa-fp-fixed'));
  const t = document.querySelector('[data-qa-fp-scroll]');
  if (t) {
    t.scrollTop = originalScroll;
    t.removeAttribute('data-qa-fp-scroll');
  } else {
    window.scrollTo(0, originalScroll);
  }
}

const FP_MAX_CANVAS_PX = 30000; // 캔버스 높이 한도. 초과 시 상단부터 이 높이까지만.
const FP_MAX_SLICES = 40;
const FP_SETTLE_MS = 600; // 스크롤 안정 + captureVisibleTab 레이트리밋(<=2/s)

async function stitchSlices(slices, m) {
  const rd = m.rect; // 잘라낼 영역(뷰포트 CSS px). window 모드면 뷰포트 전체.
  const width = Math.round(rd.width * m.dpr);
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
  const sx = Math.round(rd.left * m.dpr);
  const sy = Math.round(rd.top * m.dpr);
  const sw = Math.round(rd.width * m.dpr);
  const sh = Math.round(rd.height * m.dpr);
  for (const slice of slices) {
    // eslint-disable-next-line no-await-in-loop
    const img = await loadImage(slice.dataUrl);
    // 캡처된 뷰포트에서 컨테이너 영역만 잘라, 스크롤 위치에 맞춰 이어붙임.
    ctx.drawImage(img, sx, sy, sw, sh, 0, Math.round(slice.scroll * m.dpr), sw, sh);
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
        slices.push({ scroll: s.scroll, dataUrl });
        showLauncherStatus(`전체 페이지 캡처 중… ${slices.length}컷`);
        first = false;
        if (s.scroll >= m.maxScroll) break;
        y += m.step;
      }
    } finally {
      // 중간에 실패해도 페이지(스크롤/고정요소) 원상복구.
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: fpEnd, args: [m.originalScroll] })
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

/** 녹화 경과 시간을 mm:ss로. */
function tickRecTime() {
  const s = Math.max(0, Math.floor((Date.now() - recStartedAt) / 1000));
  els.recTime.textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

function enterRecordingState() {
  els.recordingBanner.hidden = false;
  setActionsEnabled(false);
  showLauncherStatus('');
  // 스크린샷 폴링은 멈추고, 그 자리에 녹화 중인 영상을 그대로 띄운다.
  stopLivePreview();
  if (recordingStream) showRecMonitor(recordingStream);
  recStartedAt = Date.now();
  tickRecTime();
  clearInterval(recTimer);
  recTimer = setInterval(tickRecTime, 1000);
}

function exitRecordingState() {
  els.recordingBanner.hidden = true;
  setActionsEnabled(true);
  clearInterval(recTimer);
  recTimer = null;
  hideRecMonitor();
  if (isLauncherVisible()) startLivePreview();
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  recordingTab = tab || null;

  // 아직 녹화를 시작하지 않는다. 페이지 왼쪽 하단 바에서 '전체'인지 '영역'인지 고르게 한다.
  // 영역 지정은 좌표를 뷰포트 기준으로 환산하므로 '크롬 탭'을 공유했을 때만 가능하다.
  const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  const canRegion = !surface || surface === 'browser';
  pendingRegionStream = stream;

  if (!tab?.id) {
    // 컨트롤 바를 못 띄우는 상황이면 전체 녹화로 바로 시작 (선택지를 줄 방법이 없다).
    beginRecording(stream, stream);
    await finishRecordingSetup();
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (v) => {
        window.__qaRecInit = v;
      },
      args: [{ phase: 'setup', canRegion }],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/recording-controls.js'],
    });
    showLauncherStatus('페이지 왼쪽 아래에서 녹화 범위를 골라주세요.');
  } catch {
    // 주입 불가 페이지(스토어·chrome:// 등)면 전체 녹화로 진행.
    beginRecording(stream, stream);
    await finishRecordingSetup();
  }
}

/** 컨트롤 바의 '전체 녹화' — 공유받은 화면을 그대로 녹화. */
async function startFullRecordingFromSetup() {
  const stream = pendingRegionStream;
  pendingRegionStream = null;
  if (!stream) return;
  beginRecording(stream, stream);
  await finishRecordingSetup();
}

/**
 * 녹화가 실제로 시작된 뒤의 공통 마무리 — 세션 플래그, 패널 배너,
 * 그리고 페이지 컨트롤 바를 '녹화 중' 단계로 전환.
 */
async function finishRecordingSetup() {
  recStartedAt = Date.now();
  await setSession({ recording: true });
  if (recordingTab?.id) {
    try {
      await chrome.tabs.sendMessage(recordingTab.id, {
        type: 'REC_PHASE_RECORDING',
        startedAt: recStartedAt,
      });
    } catch {
      /* 컨트롤 바가 없는 페이지 — 패널 배너로도 중지할 수 있다 */
    }
  }
  enterRecordingState();
  showLauncherStatus('');
}

/** 준비 단계에서 취소되거나 실패했을 때 잡아둔 화면 공유를 놓아준다. */
function releasePendingRegionStream() {
  if (pendingRegionStream) {
    pendingRegionStream.getTracks().forEach((t) => t.stop());
    pendingRegionStream = null;
  }
}

/**
 * 영역 녹화 2단계 — 전체 탭 영상을 매 프레임 캔버스에 잘라 옮겨 그리고,
 * 그 캔버스 스트림을 녹화한다. (getDisplayMedia에는 영역 지정 옵션이 없다)
 */
async function startCroppedRecording(rect, viewport) {
  const source = pendingRegionStream;
  pendingRegionStream = null;
  if (!source) throw new Error('녹화할 화면 공유가 없습니다. 다시 시도해주세요.');

  const videoEl = document.createElement('video');
  videoEl.srcObject = source;
  videoEl.muted = true;
  videoEl.playsInline = true;
  // 화면 밖에 붙여둔다. 떼어놓은 <video>는 프레임 렌더가 보장되지 않아
  // drawImage가 빈 프레임을 가져갈 수 있다. (display:none이면 아예 안 그린다)
  videoEl.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(videoEl);
  await videoEl.play();

  // play()는 MediaStream에서 메타데이터보다 먼저 resolve될 수 있다.
  // 그 시점의 videoWidth는 0이거나 임시값이라, 그대로 쓰면 캔버스가 몇 px짜리로 잡힌다.
  await new Promise((resolve) => {
    if (videoEl.readyState >= 1 && videoEl.videoWidth) {
      resolve();
      return;
    }
    const done = () => {
      videoEl.removeEventListener('loadedmetadata', done);
      resolve();
    };
    videoEl.addEventListener('loadedmetadata', done);
    setTimeout(done, 3000); // 이벤트가 안 와도 영원히 멈춰 있지 않도록
  });

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) {
    videoEl.remove();
    source.getTracks().forEach((t) => t.stop());
    throw new Error('공유된 화면의 크기를 읽지 못했습니다. 다시 시도해주세요.');
  }

  // rect는 페이지 CSS px → 캡처 영상 해상도로 비율 환산. (dpr·브라우저 스케일 모두 흡수)
  const sx = vw / (viewport?.w || vw);
  const sy = vh / (viewport?.h || vh);
  const srcX = Math.max(0, rect.x * sx);
  const srcY = Math.max(0, rect.y * sy);
  const srcW = Math.min(vw - srcX, rect.width * sx);
  const srcH = Math.min(vh - srcY, rect.height * sy);

  // 환산이 어긋나 몇 px짜리로 잡히면 재생조차 안 되는 영상이 나온다. 미리 막는다.
  if (srcW < 16 || srcH < 16) {
    videoEl.remove();
    source.getTracks().forEach((t) => t.stop());
    throw new Error('선택한 영역이 너무 작습니다. 더 넓게 드래그해주세요.');
  }

  const canvas = document.createElement('canvas');
  // 짝수로 맞춘다 — 홀수 해상도는 일부 인코더에서 거부된다.
  canvas.width = Math.max(2, Math.round(srcW / 2) * 2);
  canvas.height = Math.max(2, Math.round(srcH / 2) * 2);
  const ctx = canvas.getContext('2d');

  const draw = () => {
    ctx.drawImage(videoEl, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    cropRafId = requestAnimationFrame(draw);
  };
  draw();

  cropSourceStream = source;
  cropVideoEl = videoEl;
  const outStream = canvas.captureStream(30);
  beginRecording(outStream, source);
}

/** MediaRecorder 시작 + 녹화 상태 진입. (전체 탭 녹화와 영역 녹화가 공유) */
function beginRecording(streamToRecord, endWatchStream) {
  recordingStream = streamToRecord;
  recordedChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  mediaRecorder = new MediaRecorder(streamToRecord, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = handleRecorderStop;
  mediaRecorder.start(1000);

  // 크롬 자체 '공유 중지' 바로 멈추면 원본 트랙이 끝난다 → 녹화도 마무리.
  const [track] = (endWatchStream || streamToRecord).getVideoTracks();
  if (track) track.addEventListener('ended', () => stopVideoRecording());
}

function stopVideoRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

async function handleRecorderStop() {
  // 영역 녹화면 드로잉 루프와 원본 스트림까지 같이 정리해야 한다.
  if (cropRafId) {
    cancelAnimationFrame(cropRafId);
    cropRafId = null;
  }
  if (cropSourceStream) {
    cropSourceStream.getTracks().forEach((t) => t.stop());
    cropSourceStream = null;
  }
  if (cropVideoEl) {
    cropVideoEl.pause();
    cropVideoEl.srcObject = null;
    cropVideoEl.remove(); // DOM에 붙여둔 소스 <video>도 걷어낸다
    cropVideoEl = null;
  }
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
  // 실제 캡처 중엔 라이브 폴링을 멈춘다 — captureVisibleTab 쿼터(초당 2회)를 나눠 쓰면
  // 정작 본 캡처가 쿼터 초과로 실패한다.
  capturing = true;
  stopLivePreview();
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
  } finally {
    capturing = false;
    // 실패했거나 영역 선택처럼 런처에 머무는 흐름이면 미리보기를 다시 돌린다.
    if (isLauncherVisible()) startLivePreview();
  }
}

/* ---------- 등록 ---------- */

/* ---------- AI(OpenAI)로 다듬어 등록 ---------- */

/** OpenAI 키(개인 설정 또는 팀 배포 기본값)가 있을 때만 'AI로 다듬어 등록' 버튼을 노출. */
async function updateAiButtonVisibility() {
  const cfg = await getLocal([LOCAL_KEYS.OPENAI_API_KEY]);
  const apiKey = cfg[LOCAL_KEYS.OPENAI_API_KEY] || TEAM_DEFAULTS.openaiApiKey;
  els.aiSubmitBtn.hidden = !apiKey;
}

/** AI 결과(JSON)를 마크다운 설명으로. */
function buildAiDescription(r) {
  const lines = [];
  if (r.precondition) lines.push('**사전조건**', String(r.precondition), '');
  lines.push('**재현 방법**');
  const steps = Array.isArray(r.steps) ? r.steps : r.steps ? [r.steps] : [];
  if (steps.length) {
    steps.forEach((s, i) => lines.push(/^\s*\d/.test(String(s)) ? String(s) : `${i + 1}. ${s}`));
  } else {
    lines.push('1. ');
  }
  lines.push('');
  if (r.expected) lines.push('**기대 결과**', String(r.expected), '');
  if (r.actual) lines.push('**실제 결과**', String(r.actual), '');
  return lines.join('\n').trim();
}

/** 등록된 리포트를 로컬에 예시로 저장 (AI가 스타일 학습에 참고). 최근 8개 유지. */
async function saveExample(title, description) {
  try {
    const cfg = await getLocal([LOCAL_KEYS.REPORT_EXAMPLES]);
    const list = Array.isArray(cfg[LOCAL_KEYS.REPORT_EXAMPLES]) ? cfg[LOCAL_KEYS.REPORT_EXAMPLES] : [];
    list.unshift({ title: String(title || '').slice(0, 200), description: String(description || '').slice(0, 1500) });
    await setLocal({ [LOCAL_KEYS.REPORT_EXAMPLES]: list.slice(0, 8) });
  } catch {
    /* 저장 실패는 무시 */
  }
}

/** 최근 예시로 few-shot 참고 블록 구성. */
async function buildExamplesBlock() {
  const cfg = await getLocal([LOCAL_KEYS.REPORT_EXAMPLES]);
  const examples = (cfg[LOCAL_KEYS.REPORT_EXAMPLES] || []).slice(0, 3);
  if (!examples.length) return '';
  return (
    '\n\n[우리 팀 기존 리포트 예시 — 아래 스타일·형식·말투를 참고해 비슷하게 작성하세요]\n' +
    examples.map((ex, i) => `예시${i + 1}) 제목: ${ex.title}\n${ex.description}`).join('\n\n---\n')
  );
}

function setAiLoading(on) {
  els.aiSpinner.hidden = !on;
  els.aiSubmitBtn.disabled = on;
  els.submitBtn.disabled = on;
  els.aiBtnText.textContent = on ? 'AI 작성 중…' : 'AI로 다듬어 등록';
}

async function handleAiSubmit() {
  const cfg = await getLocal([
    LOCAL_KEYS.OPENAI_API_KEY,
    LOCAL_KEYS.OPENAI_MODEL,
    LOCAL_KEYS.OPENAI_BASE_URL,
    LOCAL_KEYS.OPENAI_SEND_IMAGE,
  ]);
  // 개인 옵션값 우선, 없으면 팀 배포 기본값(team-config.js) 사용.
  const apiKey = cfg[LOCAL_KEYS.OPENAI_API_KEY] || TEAM_DEFAULTS.openaiApiKey;
  if (!apiKey) {
    showToast('설정 페이지에서 OpenAI API 키를 먼저 입력해주세요.', 'error');
    return;
  }
  const model = cfg[LOCAL_KEYS.OPENAI_MODEL] || TEAM_DEFAULTS.openaiModel || 'gpt-4o-mini';
  const baseUrl = cfg[LOCAL_KEYS.OPENAI_BASE_URL] || TEAM_DEFAULTS.openaiBaseUrl;

  setAiLoading(true);
  try {
    const system =
      '당신은 QA 버그 리포트 정리 전문가입니다. 주어진 대략적인 메모, 사용자 행동(재현 스텝), 콘솔 에러, (제공되면) 스크린샷을 종합해 명확한 한국어 버그 리포트를 작성하세요. ' +
      '반드시 아래 형식의 JSON만 출력하세요. 다른 말/설명 금지. ' +
      '{"title":"간결한 제목","precondition":"사전 조건","steps":["1. ...","2. ..."],"expected":"기대 결과","actual":"실제 결과"}';
    const examplesBlock = await buildExamplesBlock();
    // 자동 기록된 조작은 본문에 넣지 않고 여기서만 재료로 넘긴다.
    // (본문에 미리 넣으면 '그대로 등록'에도 딸려 올라간다)
    const steps = recordedSteps(currentMeta);
    const stepsBlock = steps.length
      ? `\n\n[자동 기록된 사용자 조작 — 재현 단계를 쓸 때 참고하되, 메모와 어긋나면 메모를 따르세요]\n` +
        steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '';
    const user =
      `제목(초안): ${els.title.value}\n\n` +
      `아래 메모와 자동 수집 정보를 바탕으로 정리해주세요:\n${els.description.value}` +
      stepsBlock +
      examplesBlock;

    let imagesDataUrls;
    if (cfg[LOCAL_KEYS.OPENAI_SEND_IMAGE] && captureBlob && (captureBlob.type || '').startsWith('image/')) {
      imagesDataUrls = [await blobToDataUrl(captureBlob)];
    }

    const result = await chatJson({
      baseUrl,
      apiKey,
      model,
      system,
      user,
      imagesDataUrls,
    });

    if (result.title) els.title.value = String(result.title).slice(0, 255);
    let desc = buildAiDescription(result);
    if (autoCollectEnabled) {
      const collected = formatCollected(currentMeta);
      if (collected) desc += `\n${collected}`;
    }
    els.description.value = desc;

    // 다듬은 내용으로 바로 등록
    await handleSubmit();
  } catch (err) {
    showToast(`AI 작성 실패: ${err.userMessage || err.message}`, 'error');
  } finally {
    setAiLoading(false);
  }
}

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
    // 본문 맨 위에 등록일을 H3로. 리스트에서 열었을 때 언제 접수된 건인지 바로 보이게.
    const dateHeading = `### [${todayStamp()}]\n\n`;
    const markdownContent = dateHeading + els.description.value + mentionMd;

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
    await saveExample(name, els.description.value); // 다음 AI 작성이 참고할 예시로 저장
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
els.aiSubmitBtn.addEventListener('click', handleAiSubmit);
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

// 확대 보기 — 패널 안 라이트박스로는 폭이 좁아 요소가 안 보인다.
// 영상과 마찬가지로 뷰어 탭에서 연다. (거기선 전체화면·1:1 보기가 된다)
els.zoomBtn.addEventListener('click', async () => {
  if (els.canvas.hidden || !annotator) return; // 이미지 캡처일 때만
  try {
    // 캔버스에는 base 이미지 + 주석이 합쳐져 있으므로 그대로 내보낸다.
    const blob = await annotator.getBlob();
    if (!blob) return;
    await putBlob(MEDIA_STORE_KEY, blob);
    await chrome.tabs.create({
      url: `${chrome.runtime.getURL('viewer/viewer.html')}?name=${encodeURIComponent(captureFilename)}`,
    });
  } catch {
    showToast('캡처를 새 탭에서 열지 못했습니다.', 'error');
  }
});

// 자동 수집 카드
els.autoCollect.addEventListener('change', async () => {
  autoCollectEnabled = els.autoCollect.checked;
  await setLocal({ [LOCAL_KEYS.AUTO_COLLECT]: autoCollectEnabled });
});
els.collectRefresh.addEventListener('click', reloadAndDiagnose);
els.collectReread.addEventListener('click', () => updateCollectCard());

// 탭 전환/페이지 이동 시 자동 재진단 (런처가 보일 때만)
chrome.tabs.onActivated.addListener(() => {
  if (!busyDiagnosing && isLauncherVisible()) updateCollectCard();
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete' && !busyDiagnosing && isLauncherVisible()) updateCollectCard();
});

// 영역 선택 오버레이(content script)로부터의 결과 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'REGION_SELECTED') {
    handleRegionSelected(msg.rect, msg.dpr, msg.viewport);
  } else if (msg?.type === 'REGION_CANCELLED') {
    // 녹화 준비 중이었다면 컨트롤 바를 되돌려 다시 고를 수 있게 한다.
    if (regionMode === 'video' && pendingRegionStream && recordingTab?.id) {
      chrome.tabs.sendMessage(recordingTab.id, { type: 'REC_PHASE_SETUP' }).catch(() => {});
      regionMode = 'image';
      return;
    }
    regionMode = 'image';
    releasePendingRegionStream();
    showLauncherStatus('영역 선택을 취소했습니다.');
  } else if (msg?.type === 'ANNOTATION_APPLIED') {
    applyAnnotationFromViewer();
  } else if (msg?.type === 'REC_PICK_REGION') {
    startRegionSelect('video').catch((err) => showLauncherStatus(err.message || '영역 선택을 시작하지 못했습니다.'));
  } else if (msg?.type === 'REC_START_FULL') {
    startFullRecordingFromSetup();
  } else if (msg?.type === 'REC_CANCEL') {
    releasePendingRegionStream();
    showLauncherStatus('녹화를 취소했습니다.');
  } else if (msg?.type === 'STOP_RECORDING') {
    // 페이지 플로팅 컨트롤의 중지 버튼
    stopVideoRecording();
  }
});

els.recStop.addEventListener('click', stopVideoRecording);

// 라이브 미리보기를 누르면 지금 보이는 그 화면을 캡처.
els.livePreview.addEventListener('click', () => handleAction('visible'));

els.followBtn.addEventListener('click', () => {
  setFollowing(!following);
  if (following) refreshLivePreview();
});

// 주석을 그리기 시작하면 자동으로 고정. 안 그러면 1초 뒤 배경이 바뀌어
// 방금 가리킨 지점과 주석이 어긋난다.
els.canvas.addEventListener('pointerdown', () => setFollowing(false));

// 패널이 접히면 폴링 중지 — 보이지도 않는 화면을 계속 찍을 이유가 없다.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopLivePreview();
    setLiveState('멈춤', true);
  } else if (isLauncherVisible()) {
    startLivePreview();
  }
});

// 탭을 바꾸거나 페이지 로드가 끝나면 다음 주기를 기다리지 않고 바로 갱신.
chrome.tabs.onActivated.addListener(() => refreshLivePreview());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete') refreshLivePreview();
});

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

// 사이드 패널은 Fullscreen API가 막혀 <video>의 전체화면 버튼이 동작하지 않는다.
// 전용 뷰어 탭에서 열어 진짜 전체화면으로 보게 한다.
// blob: URL을 넘기면 패널이 닫힐 때 무효가 되므로, IndexedDB에 담아 뷰어가 직접 꺼내 쓰게 한다.
els.videoOpenBtn.addEventListener('click', async () => {
  if (!captureBlob) return;
  try {
    await putBlob(MEDIA_STORE_KEY, captureBlob);
    const url = `${chrome.runtime.getURL('viewer/viewer.html')}?name=${encodeURIComponent(captureFilename)}`;
    await chrome.tabs.create({ url });
  } catch {
    showToast('영상을 새 탭에서 열지 못했습니다.', 'error');
  }
});
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-options-link').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();

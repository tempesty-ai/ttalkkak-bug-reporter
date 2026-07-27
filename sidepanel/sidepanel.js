// 사이드 패널: 캡처 → 미리보기 → 리포트 폼 → ClickUp 등록을 한 곳에서 처리.
// 패널은 페이지 조작 중에도 열려 있고, 닫혔다 다시 열리면 session storage에서 미제출 캡처를 복원한다.
//
// 캡처는 버튼 클릭(사용자 제스처) 안에서 호출하고, host_permissions <all_urls> 덕에
// captureVisibleTab이 activeTab 제스처 없이도 동작한다.

import {
  getLocal,
  getSession,
  setSession,
  removeSession,
  SESSION_KEYS,
  LOCAL_KEYS,
} from '../lib/storage.js';
import { submitReport } from '../lib/clickup.js';

const els = {
  viewLauncher: document.getElementById('view-launcher'),
  viewReport: document.getElementById('view-report'),
  launcherStatus: document.getElementById('launcher-status'),
  configWarning: document.getElementById('config-warning'),
  previewImg: document.getElementById('capture-preview'),
  title: document.getElementById('task-title'),
  priority: document.getElementById('task-priority'),
  description: document.getElementById('task-description'),
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

/** QA 템플릿으로 제목/설명 기본값 구성. */
function buildDefaults(cap) {
  const title = `[QA] ${cap.sourceTitle || cap.sourceUrl || '버그 리포트'}`;
  const when = cap.capturedAt ? new Date(cap.capturedAt).toLocaleString('ko-KR') : '-';
  const description = [
    `URL: ${cap.sourceUrl || '-'}`,
    `캡처 시각: ${when}`,
    `User-Agent: ${cap.metadata?.userAgent || navigator.userAgent}`,
    '',
    '재현 단계:',
    '1. ',
    '2. ',
    '',
    '기대 결과:',
    '',
    '실제 결과:',
    '',
  ].join('\n');
  return { title, description };
}

/* ---------- 뷰 전환 ---------- */

function showLauncher() {
  els.viewReport.hidden = true;
  els.viewLauncher.hidden = false;
}

async function showReport(cap) {
  els.previewImg.src = cap.dataUrl;

  const defaults = buildDefaults(cap);
  els.title.value = defaults.title;
  els.description.value = defaults.description;
  els.priority.value = '3';

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
    metadata: { userAgent: navigator.userAgent },
  };

  // 패널이 닫혔다 다시 열려도 복원되도록 저장.
  await setSession({ [SESSION_KEYS.PENDING_CAPTURE]: cap });
  await showReport(cap);
}

async function handleAction(action) {
  try {
    if (action === 'visible') {
      await captureVisible();
    }
    // 나머지 동작은 이후 Phase (버튼 disabled).
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
    const { taskUrl } = await submitReport({
      token,
      listId,
      task: {
        name,
        description: els.description.value,
        priority: Number(els.priority.value) || 3,
      },
      blob: captureBlob,
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
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-options-link').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();

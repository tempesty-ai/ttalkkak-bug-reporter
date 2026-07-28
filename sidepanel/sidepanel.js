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
  toolbar: document.querySelector('.annotate-toolbar'),
  undoBtn: document.getElementById('undo-btn'),
  clearBtn: document.getElementById('clear-btn'),
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
let annotator = null;

const DEFAULT_TOOL = 'arrow';
const DEFAULT_COLOR = '#e11d48';

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
  const description = [
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
  ].join('\n');
  return { title, description };
}

/** 내 ClickUp user id를 캐시에서 읽거나, 없으면 API로 조회해 저장. 실패 시 null. */
async function ensureMyUserId(token) {
  const cfg = await getLocal([LOCAL_KEYS.MY_USER_ID]);
  if (cfg[LOCAL_KEYS.MY_USER_ID]) return cfg[LOCAL_KEYS.MY_USER_ID];
  try {
    const data = await getAuthorizedUser(token);
    const uid = data?.user?.id;
    if (uid) await setLocal({ [LOCAL_KEYS.MY_USER_ID]: uid });
    return uid || null;
  } catch {
    return null; // 배정 실패해도 태스크 생성은 계속 진행
  }
}

/* ---------- 뷰 전환 ---------- */

function showLauncher() {
  els.viewReport.hidden = true;
  els.viewLauncher.hidden = false;
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
  // 이전 캔버스 편집기 정리 후 새로 초기화.
  if (annotator) annotator.destroy();
  annotator = createAnnotator(els.canvas, cap.dataUrl);
  annotator.setTool(DEFAULT_TOOL);
  annotator.setColor(DEFAULT_COLOR);
  setActiveTool(els.toolbar.querySelector(`.tool-btn[data-tool="${DEFAULT_TOOL}"]`));
  setActiveColor(els.toolbar.querySelector(`.color-btn[data-color="${DEFAULT_COLOR}"]`));

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
    // 본문은 사용자가 작성한 마크다운 그대로. (제목은 태스크 name에만 들어가고 본문엔 반복하지 않음)
    const markdownContent = els.description.value;

    // 항상 본인에게 배정 (ClickUp 본문 멘션 미지원 → 멘션은 수동).
    let assignees;
    const uid = await ensureMyUserId(token);
    if (uid) assignees = [uid];

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
document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('open-options-link').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();

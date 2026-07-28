// 서비스 워커 (MV3, ES Module).
// UI는 사이드 패널로 통합. 아이콘 클릭 시 패널이 열리도록 동작을 설정한다.
// 영상 녹화 오케스트레이션(offscreen 생성/정리, 플로팅 컨트롤 주입)을 담당한다.
//
// 주의: SW는 30초 유휴 시 종료된다. 상태는 전역 변수가 아니라 chrome.storage에 저장할 것.

const DEBUG = false;
const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// 툴바 아이콘 클릭 → 사이드 패널 토글. SW가 깰 때마다 보장되도록 최상위에서 호출.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => {
    if (DEBUG) console.error('[QA Capture] setPanelBehavior 실패:', err);
  });

chrome.runtime.onInstalled.addListener((details) => {
  if (DEBUG) console.log('[QA Capture] installed:', details.reason);
});

/* ---------- 영상 녹화 오케스트레이션 ---------- */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'QA 버그 리포트용 탭 화면 녹화',
  });
}

async function startRecording(streamId, tabId) {
  await ensureOffscreen();
  // offscreen에게 녹화 시작 지시 (target으로 대상 구분).
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
  if (!res?.ok) throw new Error(res?.error || '녹화 시작에 실패했습니다.');

  await chrome.storage.session.set({ recording: true, recordingTabId: tabId });

  // 페이지에 플로팅 컨트롤 표시 (주입 불가 페이지면 무시).
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/recording-controls.js'] });
  } catch (err) {
    if (DEBUG) console.warn('[QA Capture] 컨트롤 주입 실패:', err);
  }
}

async function stopRecording() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
  }
}

// 녹화 완료(offscreen이 브로드캐스트) 후 정리. dataUrl은 패널이 직접 수신한다.
async function cleanupAfterRecording() {
  const { recordingTabId } = await chrome.storage.session.get('recordingTabId');
  await chrome.storage.session.set({ recording: false });
  await chrome.storage.session.remove('recordingTabId');

  if (recordingTabId) {
    try {
      await chrome.tabs.sendMessage(recordingTabId, { type: 'REMOVE_RECORDING_CONTROLS' });
    } catch {
      /* 탭이 닫혔거나 컨트롤이 없을 수 있음 */
    }
  }
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // offscreen 대상 메시지는 SW가 처리하지 않음

  switch (msg?.type) {
    case 'START_RECORDING':
      startRecording(msg.streamId, msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'STOP_RECORDING':
      stopRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'RECORDING_COMPLETE':
    case 'RECORDING_FAILED':
      // 정리만 수행 (dataUrl은 패널이 직접 받음).
      cleanupAfterRecording();
      return false;

    default:
      return false;
  }
});

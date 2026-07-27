// 설정 페이지: ClickUp 토큰·기본 리스트 ID 저장 (chrome.storage.local — 영구 보관).
// 연결 테스트로 토큰 유효성을 즉시 확인할 수 있다 (잘못된 토큰 → 한글 에러).

import { getLocal, setLocal, LOCAL_KEYS } from '../lib/storage.js';
import { getAuthorizedUser } from '../lib/clickup.js';

const tokenEl = document.getElementById('token');
const listIdEl = document.getElementById('list-id');
const saveBtn = document.getElementById('save-btn');
const testBtn = document.getElementById('test-btn');
const toggleBtn = document.getElementById('toggle-token');
const statusEl = document.getElementById('status');

/**
 * @param {string} message
 * @param {'success'|'error'} kind
 */
function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status is-${kind}`;
  statusEl.hidden = false;
}

async function loadSettings() {
  const cfg = await getLocal([LOCAL_KEYS.CLICKUP_TOKEN, LOCAL_KEYS.DEFAULT_LIST_ID]);
  tokenEl.value = cfg[LOCAL_KEYS.CLICKUP_TOKEN] || '';
  listIdEl.value = cfg[LOCAL_KEYS.DEFAULT_LIST_ID] || '';
}

async function saveSettings() {
  const token = tokenEl.value.trim();
  const listId = listIdEl.value.trim();

  if (!token) {
    showStatus('토큰을 입력해주세요.', 'error');
    return;
  }
  if (!listId) {
    showStatus('기본 리스트 ID를 입력해주세요.', 'error');
    return;
  }

  await setLocal({
    [LOCAL_KEYS.CLICKUP_TOKEN]: token,
    [LOCAL_KEYS.DEFAULT_LIST_ID]: listId,
  });
  showStatus('저장되었습니다.', 'success');
}

async function testConnection() {
  const token = tokenEl.value.trim();
  if (!token) {
    showStatus('토큰을 먼저 입력해주세요.', 'error');
    return;
  }

  testBtn.disabled = true;
  const original = testBtn.textContent;
  testBtn.textContent = '확인 중…';
  try {
    const data = await getAuthorizedUser(token);
    const name = data?.user?.username || data?.user?.email || '알 수 없음';
    showStatus(`연결 성공 — 사용자: ${name}`, 'success');
  } catch (err) {
    showStatus(err.userMessage || err.message || '연결에 실패했습니다.', 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = original;
  }
}

function toggleTokenVisibility() {
  const isHidden = tokenEl.type === 'password';
  tokenEl.type = isHidden ? 'text' : 'password';
  toggleBtn.textContent = isHidden ? '숨김' : '표시';
}

saveBtn.addEventListener('click', saveSettings);
testBtn.addEventListener('click', testConnection);
toggleBtn.addEventListener('click', toggleTokenVisibility);

loadSettings();

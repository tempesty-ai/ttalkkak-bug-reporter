// 설정 페이지: ClickUp 토큰·기본 리스트 ID 저장 (chrome.storage.local — 영구 보관).
// - 연결 테스트로 토큰 유효성 즉시 확인.
// - '리스트 찾아보기'로 워크스페이스→스페이스→폴더→리스트 계층을 훑어 리스트를 선택
//   (ClickUp URL에는 숫자 리스트 ID가 안 나오는 경우가 많아 필요).

import { getLocal, setLocal, LOCAL_KEYS } from '../lib/storage.js';
import {
  getAuthorizedUser,
  getTeams,
  getSpaces,
  getFolders,
  getFolderLists,
  getFolderlessLists,
} from '../lib/clickup.js';
import { listModels } from '../lib/openai.js';
import { TEAM_DEFAULTS } from '../lib/team-config.js';

const tokenEl = document.getElementById('token');
const listIdEl = document.getElementById('list-id');
const listNameEl = document.getElementById('list-name-label');
const saveBtn = document.getElementById('save-btn');
const testBtn = document.getElementById('test-btn');
const toggleBtn = document.getElementById('toggle-token');
const statusEl = document.getElementById('status');

// 리스트 피커 요소
const findListBtn = document.getElementById('find-list-btn');
const picker = document.getElementById('list-picker');
const pkTeam = document.getElementById('pk-team');
const pkSpace = document.getElementById('pk-space');
const pkFolder = document.getElementById('pk-folder');
const pkList = document.getElementById('pk-list');
const pkApply = document.getElementById('pk-apply');
const pkStatus = document.getElementById('pk-status');

// 스페이스 직속(폴더 없음) 리스트를 나타내는 폴더 드롭다운의 특수 값.
const FOLDERLESS = '__folderless__';

/**
 * @param {string} message
 * @param {'success'|'error'} kind
 */
function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `status is-${kind}`;
  statusEl.hidden = false;
}

function showPickerStatus(message) {
  pkStatus.textContent = message || '';
  pkStatus.hidden = !message;
}

/**
 * select를 항목으로 채운다.
 * @param {HTMLSelectElement} select
 * @param {Array<{id:string, name:string}>} items
 * @param {string} placeholder
 */
function fillSelect(select, items, placeholder) {
  select.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = placeholder;
  select.appendChild(ph);
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = it.name;
    select.appendChild(opt);
  }
}

function resetSelect(select, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>`;
  select.disabled = true;
}

/* ---------- 설정 저장/로드 ---------- */

const openaiKeyEl = document.getElementById('openai-key');
const openaiModelEl = document.getElementById('openai-model');
const openaiBaseEl = document.getElementById('openai-base');
const openaiImageEl = document.getElementById('openai-image');

async function loadSettings() {
  const cfg = await getLocal([
    LOCAL_KEYS.CLICKUP_TOKEN,
    LOCAL_KEYS.DEFAULT_LIST_ID,
    LOCAL_KEYS.OPENAI_BASE_URL,
    LOCAL_KEYS.OPENAI_SEND_IMAGE,
  ]);
  tokenEl.value = cfg[LOCAL_KEYS.CLICKUP_TOKEN] || '';
  listIdEl.value = cfg[LOCAL_KEYS.DEFAULT_LIST_ID] || '';
  // 접속 토큰·모델은 team-config.js에 고정(비활성 표시용). base URL·이미지 옵션만 개인 저장값 우선.
  openaiKeyEl.value = TEAM_DEFAULTS.openaiApiKey || '';
  openaiModelEl.value = TEAM_DEFAULTS.openaiModel || 'gpt-4o-mini';
  openaiBaseEl.value = cfg[LOCAL_KEYS.OPENAI_BASE_URL] || TEAM_DEFAULTS.openaiBaseUrl || '';
  openaiImageEl.checked = Boolean(cfg[LOCAL_KEYS.OPENAI_SEND_IMAGE]);
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

  // 접속 토큰·모델은 team-config.js에 고정이라 저장하지 않는다(항상 team-config 값 사용).
  await setLocal({
    [LOCAL_KEYS.CLICKUP_TOKEN]: token,
    [LOCAL_KEYS.DEFAULT_LIST_ID]: listId,
    [LOCAL_KEYS.OPENAI_BASE_URL]: openaiBaseEl.value.trim(),
    [LOCAL_KEYS.OPENAI_SEND_IMAGE]: openaiImageEl.checked,
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

/* ---------- 리스트 피커 ---------- */

async function openPicker() {
  const token = tokenEl.value.trim();
  if (!token) {
    showStatus('먼저 토큰을 입력해주세요.', 'error');
    return;
  }

  picker.hidden = false;
  showPickerStatus('');
  resetSelect(pkSpace, '—');
  resetSelect(pkFolder, '—');
  resetSelect(pkList, '—');
  pkApply.disabled = true;

  fillSelect(pkTeam, [], '불러오는 중…');
  pkTeam.disabled = true;
  try {
    const teams = await getTeams(token);
    if (!teams.length) {
      showPickerStatus('접근 가능한 워크스페이스가 없습니다.');
      return;
    }
    fillSelect(pkTeam, teams, '워크스페이스 선택');
    pkTeam.disabled = false;
  } catch (err) {
    showPickerStatus(err.userMessage || err.message || '워크스페이스를 불러오지 못했습니다.');
  }
}

async function onTeamChange() {
  const token = tokenEl.value.trim();
  const teamId = pkTeam.value;
  resetSelect(pkSpace, '—');
  resetSelect(pkFolder, '—');
  resetSelect(pkList, '—');
  pkApply.disabled = true;
  if (!teamId) return;

  showPickerStatus('스페이스 불러오는 중…');
  try {
    const spaces = await getSpaces(teamId, token);
    fillSelect(pkSpace, spaces, spaces.length ? '스페이스 선택' : '스페이스 없음');
    pkSpace.disabled = !spaces.length;
    showPickerStatus('');
  } catch (err) {
    showPickerStatus(err.userMessage || err.message || '스페이스를 불러오지 못했습니다.');
  }
}

async function onSpaceChange() {
  const token = tokenEl.value.trim();
  const spaceId = pkSpace.value;
  resetSelect(pkFolder, '—');
  resetSelect(pkList, '—');
  pkApply.disabled = true;
  if (!spaceId) return;

  showPickerStatus('폴더 불러오는 중…');
  try {
    const folders = await getFolders(spaceId, token);
    // 폴더 목록 앞에 '스페이스 직속 리스트' 항목을 추가.
    const items = [{ id: FOLDERLESS, name: '📂 (폴더 없음 · 스페이스 직속)' }, ...folders];
    fillSelect(pkFolder, items, '폴더 선택');
    pkFolder.disabled = false;
    showPickerStatus('');
  } catch (err) {
    showPickerStatus(err.userMessage || err.message || '폴더를 불러오지 못했습니다.');
  }
}

async function onFolderChange() {
  const token = tokenEl.value.trim();
  const folderValue = pkFolder.value;
  const spaceId = pkSpace.value;
  resetSelect(pkList, '—');
  pkApply.disabled = true;
  if (!folderValue) return;

  showPickerStatus('리스트 불러오는 중…');
  try {
    const lists =
      folderValue === FOLDERLESS
        ? await getFolderlessLists(spaceId, token)
        : await getFolderLists(folderValue, token);
    fillSelect(pkList, lists, lists.length ? '리스트 선택' : '리스트 없음');
    pkList.disabled = !lists.length;
    showPickerStatus('');
  } catch (err) {
    showPickerStatus(err.userMessage || err.message || '리스트를 불러오지 못했습니다.');
  }
}

function onListChange() {
  pkApply.disabled = !pkList.value;
}

function applyPickedList() {
  const listId = pkList.value;
  if (!listId) return;
  const listName = pkList.options[pkList.selectedIndex].textContent;

  listIdEl.value = listId;
  listNameEl.textContent = `선택됨: ${listName} (ID ${listId})`;
  listNameEl.hidden = false;
  picker.hidden = true;
  showStatus('리스트를 선택했습니다. "저장"을 눌러 반영하세요.', 'success');
}

/* ---------- 바인딩 ---------- */

async function testOpenAI() {
  const btn = document.getElementById('openai-test');
  const apiKey = openaiKeyEl.value.trim();
  if (!apiKey) {
    showStatus('OpenAI API 키를 먼저 입력해주세요.', 'error');
    return;
  }
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '확인 중…';
  try {
    const models = await listModels({ baseUrl: openaiBaseEl.value.trim(), apiKey });
    showStatus(`OpenAI 연결 성공! 사용 가능한 모델 ${models.length}개 확인됨.`, 'success');
  } catch (err) {
    showStatus(err.userMessage || err.message || 'OpenAI 연결 실패', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

saveBtn.addEventListener('click', saveSettings);
testBtn.addEventListener('click', testConnection);
toggleBtn.addEventListener('click', toggleTokenVisibility);
document.getElementById('openai-test').addEventListener('click', testOpenAI);

findListBtn.addEventListener('click', openPicker);
pkTeam.addEventListener('change', onTeamChange);
pkSpace.addEventListener('change', onSpaceChange);
pkFolder.addEventListener('change', onFolderChange);
pkList.addEventListener('change', onListChange);
pkApply.addEventListener('click', applyPickedList);

loadSettings();

// chrome.storage 얇은 래퍼.
// SW·팝업·에디터·옵션 어디서든 동일한 API로 쓰기 위해 한 곳에 모음.
// localStorage는 SW에서 접근 불가하므로 이 프로젝트에서는 절대 쓰지 않는다.

/** local 저장소는 영구 데이터(토큰/설정)용. */
export const LOCAL_KEYS = {
  CLICKUP_TOKEN: 'clickupToken',
  DEFAULT_TEAM_ID: 'defaultTeamId',
  DEFAULT_SPACE_ID: 'defaultSpaceId',
  DEFAULT_LIST_ID: 'defaultListId',
  USER_PREFERENCES: 'userPreferences',
};

/** session 저장소는 SW 재시작 시 초기화되는 임시 데이터용. */
export const SESSION_KEYS = {
  PENDING_CAPTURE: 'pendingCapture',
  RECORDING: 'recording',
  RECORDING_STARTED_AT: 'recordingStartedAt',
};

/**
 * @param {string|string[]|Object|null} keys
 * @returns {Promise<Object>}
 */
export function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

/**
 * @param {Object} items
 * @returns {Promise<void>}
 */
export function setLocal(items) {
  return chrome.storage.local.set(items);
}

/**
 * @param {string|string[]|Object|null} keys
 * @returns {Promise<Object>}
 */
export function getSession(keys) {
  return chrome.storage.session.get(keys);
}

/**
 * @param {Object} items
 * @returns {Promise<void>}
 */
export function setSession(items) {
  return chrome.storage.session.set(items);
}

/**
 * @param {string|string[]} keys
 * @returns {Promise<void>}
 */
export function removeSession(keys) {
  return chrome.storage.session.remove(keys);
}

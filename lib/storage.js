// chrome.storage 얇은 래퍼.
// SW·팝업·에디터·옵션 어디서든 동일한 API로 쓰기 위해 한 곳에 모음.
// localStorage는 SW에서 접근 불가하므로 이 프로젝트에서는 절대 쓰지 않는다.

/** local 저장소는 영구 데이터(토큰/설정)용. */
export const LOCAL_KEYS = {
  CLICKUP_TOKEN: 'clickupToken',
  DEFAULT_TEAM_ID: 'defaultTeamId',
  DEFAULT_SPACE_ID: 'defaultSpaceId',
  DEFAULT_LIST_ID: 'defaultListId',
  // 등록 대상을 ID 대신 사람이 읽는 경로로 보여주기 위한 캐시. 조각 배열로 담는다. (예: ['study','test'])
  // 키 이름이 defaultListName에서 바뀐 이유: 표기가 '이름'에서 '경로'로 달라져
  // 옛 캐시를 그대로 쓰면 스페이스 없는 낡은 값이 계속 보인다. 키를 갈아 자연히 무효화한다.
  DEFAULT_LIST_PATH: 'defaultListPath',
  MY_USER_ID: 'myUserId',
  MY_USER_NAME: 'myUserName',
  AUTO_COLLECT: 'autoCollect',
  OPENAI_API_KEY: 'openaiApiKey',
  OPENAI_MODEL: 'openaiModel',
  OPENAI_BASE_URL: 'openaiBaseUrl',
  OPENAI_SEND_IMAGE: 'openaiSendImage',
  REPORT_EXAMPLES: 'reportExamples',
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

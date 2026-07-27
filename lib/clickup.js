// ClickUp API 래퍼.
// 인증은 raw 토큰을 그대로 Authorization 헤더에 넣는다 (Bearer 접두어 없음 — 401의 흔한 원인).
// 첨부는 FormData 필드명 'attachment'를 쓰고 Content-Type을 수동 지정하지 않는다 (boundary 자동).

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const MAX_RETRIES = 3; // 429/5xx/네트워크 오류 시 지수 백오프 재시도 횟수
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** HTTP 상태코드 → 사용자용 한글 메시지. */
const ERROR_MESSAGES = {
  400: '요청 형식이 올바르지 않습니다. 태스크 제목 등 필수 항목을 확인해주세요.',
  401: 'ClickUp 토큰이 유효하지 않습니다. 설정 페이지에서 다시 입력해주세요.',
  403: '접근 권한이 없습니다. 토큰 권한 또는 리스트 접근 권한을 확인해주세요.',
  404: '지정한 리스트를 찾을 수 없습니다. 설정 페이지에서 리스트 ID를 다시 확인해주세요.',
  429: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
};

/**
 * 사용자 노출용 메시지를 담은 Error 생성.
 * @param {number} status HTTP 상태코드 (네트워크 오류는 0)
 * @param {string} userMessage 한글 메시지
 * @param {*} [detail] 콘솔 디버깅용 원본
 * @returns {Error & {status:number, userMessage:string, detail:*}}
 */
function makeError(status, userMessage, detail) {
  const err = new Error(userMessage);
  err.status = status;
  err.userMessage = userMessage;
  err.detail = detail;
  return err;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** attempt(0-based) 기준 지수 백오프: 1s → 2s → 4s. */
function backoffMs(attempt) {
  return 1000 * 2 ** attempt;
}

/** 429 응답의 X-RateLimit-Reset(unix 초)을 존중하되, 비정상 값이면 지수 백오프로 폴백. */
function rateLimitWaitMs(res, attempt) {
  const reset = Number(res.headers.get('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = reset * 1000 - Date.now();
    // 이미 지난 값(음수)이거나 과도하게 긴 값이면 신뢰하지 않는다.
    if (waitMs > 0 && waitMs <= 60000) return waitMs + 250;
  }
  return backoffMs(attempt);
}

/** 실패 응답 본문을 안전하게 읽어 디버깅 detail로 반환. */
async function safeReadBody(res) {
  try {
    return await res.clone().json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

/**
 * ClickUp API 호출 공통 처리. 재시도·에러 매핑 포함.
 * @param {string} path '/list/{id}/task' 처럼 base 이후 경로
 * @param {Object} opts
 * @param {string} opts.token
 * @param {string} [opts.method]
 * @param {Object} [opts.jsonBody] JSON 바디 (지정 시 Content-Type: application/json)
 * @param {FormData} [opts.formBody] 멀티파트 바디 (Content-Type 자동)
 * @returns {Promise<Object|null>}
 */
async function apiFetch(path, { token, method = 'GET', jsonBody, formBody } = {}) {
  const headers = { Authorization: token }; // ⚠️ Bearer 없음
  let body;
  if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(jsonBody);
  } else if (formBody !== undefined) {
    body = formBody; // ⚠️ Content-Type 수동 설정 금지 (boundary 자동)
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${CLICKUP_API_BASE}${path}`, { method, headers, body });
    } catch (networkErr) {
      lastError = makeError(
        0,
        '네트워크 오류로 ClickUp에 연결하지 못했습니다. 사내망 연결을 확인해주세요.',
        networkErr.message,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      return res.status === 204 ? null : res.json();
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const waitMs = res.status === 429 ? rateLimitWaitMs(res, attempt) : backoffMs(attempt);
      await sleep(waitMs);
      continue;
    }

    const detail = await safeReadBody(res);
    throw makeError(
      res.status,
      ERROR_MESSAGES[res.status] || `ClickUp 오류가 발생했습니다. (HTTP ${res.status})`,
      detail,
    );
  }

  throw lastError; // 이론상 도달하지 않음
}

/**
 * 토큰 유효성 확인용. GET /user 성공 시 사용자 정보 반환.
 * (Phase 4 옵션 페이지 '토큰 테스트'에서 재사용 예정)
 * @param {string} token
 * @returns {Promise<Object>}
 */
export async function getAuthorizedUser(token) {
  if (!token) throw makeError(401, ERROR_MESSAGES[401]);
  return apiFetch('/user', { token });
}

/**
 * 리스트에 태스크 생성.
 * @param {string} listId
 * @param {string} token
 * @param {{name:string, description?:string, priority?:number, tags?:string[]}} task
 * @returns {Promise<{id:string, url:string}>}
 */
export async function createTask(listId, token, task) {
  if (!token) throw makeError(401, ERROR_MESSAGES[401]);
  if (!listId) {
    throw makeError(404, '리스트 ID가 설정되지 않았습니다. 설정 페이지에서 리스트 ID를 입력해주세요.');
  }
  if (!task || !task.name || !task.name.trim()) {
    throw makeError(400, '태스크 제목을 입력해주세요.');
  }

  const body = {
    name: task.name.trim(),
    description: task.description || '',
    priority: task.priority || 3,
  };
  if (Array.isArray(task.tags) && task.tags.length) body.tags = task.tags;

  return apiFetch(`/list/${encodeURIComponent(listId)}/task`, {
    token,
    method: 'POST',
    jsonBody: body,
  });
}

/**
 * 태스크에 파일 첨부.
 * @param {string} taskId
 * @param {string} token
 * @param {Blob} blob
 * @param {string} [filename]
 * @returns {Promise<Object>}
 */
export async function uploadAttachment(taskId, token, blob, filename = 'attachment.png') {
  if (!token) throw makeError(401, ERROR_MESSAGES[401]);
  if (!taskId) throw makeError(400, '첨부할 태스크를 찾을 수 없습니다.');

  const form = new FormData();
  form.append('attachment', blob, filename); // ⚠️ 필드명은 반드시 'attachment'

  return apiFetch(`/task/${encodeURIComponent(taskId)}/attachment`, {
    token,
    method: 'POST',
    formBody: form,
  });
}

/**
 * 태스크 생성 + 첨부를 한 번에. 에디터에서 호출하는 상위 헬퍼.
 * @param {Object} params
 * @param {string} params.token
 * @param {string} params.listId
 * @param {{name:string, description?:string, priority?:number, tags?:string[]}} params.task
 * @param {Blob} [params.blob] 첨부 파일 (없으면 첨부 생략)
 * @param {string} [params.filename]
 * @returns {Promise<{taskId:string, taskUrl:string}>}
 */
export async function submitReport({ token, listId, task, blob, filename }) {
  const created = await createTask(listId, token, task);
  if (blob) {
    await uploadAttachment(created.id, token, blob, filename);
  }
  return { taskId: created.id, taskUrl: created.url };
}

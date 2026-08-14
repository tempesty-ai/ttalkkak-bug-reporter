// 사내 로컬 Ollama LLM 연동. /api/chat 사용.
// 확장은 host_permissions(<all_urls>)로 사내망 서버에 CORS 제약 없이 fetch 가능.
// 데이터가 외부로 나가지 않는 완전 로컬 처리.

const DEFAULT_URL = 'http://localhost:11434';

function makeError(message, detail) {
  const err = new Error(message);
  err.userMessage = message;
  err.detail = detail;
  return err;
}

/** 응답 텍스트에서 JSON을 관대하게 파싱 (코드블록/잡텍스트 섞여도 시도). */
function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* fall through */
    }
  }
  throw makeError('AI 응답을 해석하지 못했습니다. 모델을 바꾸거나 다시 시도해주세요.', text);
}

/**
 * 연결 확인 + 설치된 모델 목록 조회 (/api/tags).
 * @param {string} baseUrl
 * @returns {Promise<string[]>} 모델명 배열
 */
export async function listModels(baseUrl) {
  const url = `${(baseUrl || DEFAULT_URL).replace(/\/+$/, '')}/api/tags`;
  let res;
  try {
    res = await fetch(url);
  } catch (networkErr) {
    throw makeError(
      'Ollama 서버에 연결하지 못했습니다. 주소·포트·실행 여부(및 외부 접속 허용)를 확인해주세요.',
      networkErr.message,
    );
  }
  if (!res.ok) throw makeError(`Ollama 응답 오류 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/**
 * Ollama /api/chat 호출 후 JSON 파싱해서 반환.
 * @param {Object} p
 * @param {string} p.baseUrl 예: http://localhost:11434
 * @param {string} p.model 예: llama3.2-vision
 * @param {string} p.system 시스템 프롬프트
 * @param {string} p.user 유저 프롬프트
 * @param {string[]} [p.imagesBase64] 비전 모델용 base64(접두어 없이) 이미지
 * @returns {Promise<Object>}
 */
export async function chatJson({ baseUrl, model, system, user, imagesBase64 }) {
  if (!model) throw makeError('Ollama 모델명이 설정되지 않았습니다. 설정 페이지에서 입력해주세요.');
  const url = `${(baseUrl || DEFAULT_URL).replace(/\/+$/, '')}/api/chat`;

  const userMsg = { role: 'user', content: user };
  if (Array.isArray(imagesBase64) && imagesBase64.length) userMsg.images = imagesBase64;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, userMsg],
        stream: false,
        format: 'json',
        options: { temperature: 0.2 },
      }),
    });
  } catch (networkErr) {
    throw makeError(
      'Ollama 서버에 연결하지 못했습니다. 서버 주소와 Ollama 실행 여부를 확인해주세요.',
      networkErr.message,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404) {
      throw makeError('모델을 찾을 수 없습니다. `ollama pull <모델>` 로 먼저 받아주세요.', body);
    }
    if (res.status === 403) {
      throw makeError(
        'Ollama가 확장 접속을 차단했어요(403). 환경변수 OLLAMA_ORIGINS=* 설정 후 Ollama를 재시작해주세요.',
        body,
      );
    }
    throw makeError(`Ollama 오류가 발생했습니다. (HTTP ${res.status})`, body);
  }

  const data = await res.json();
  const content = data?.message?.content || '';
  return parseLooseJson(content);
}

// OpenAI (호환) Chat Completions 연동.
// 확장은 host_permissions(<all_urls>)로 api.openai.com에 CORS 제약 없이 fetch 가능.
// base URL을 바꾸면 Azure OpenAI·사내 호환 엔드포인트도 사용 가능.

const DEFAULT_URL = 'https://api.openai.com/v1';

function makeError(message, detail) {
  const err = new Error(message);
  err.userMessage = message;
  err.detail = detail;
  return err;
}

/** 응답 텍스트에서 JSON을 관대하게 파싱. */
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

const base = (baseUrl) => (baseUrl || DEFAULT_URL).replace(/\/+$/, '');

/**
 * 연결 확인 + 모델 목록 (선택). 키 유효성 검증용.
 * @returns {Promise<string[]>}
 */
export async function listModels({ baseUrl, apiKey }) {
  if (!apiKey) throw makeError('OpenAI API 키가 설정되지 않았습니다. 설정에서 입력해주세요.');
  let res;
  try {
    res = await fetch(`${base(baseUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (networkErr) {
    throw makeError('OpenAI에 연결하지 못했습니다. 네트워크·주소를 확인해주세요.', networkErr.message);
  }
  if (res.status === 401) throw makeError('API 키가 유효하지 않습니다.');
  if (!res.ok) throw makeError(`OpenAI 오류가 발생했습니다. (HTTP ${res.status})`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

/**
 * Chat Completions 호출 후 JSON 파싱해서 반환.
 * @param {Object} p
 * @param {string} p.baseUrl
 * @param {string} p.apiKey
 * @param {string} p.model  예: gpt-4o-mini
 * @param {string} p.system
 * @param {string} p.user
 * @param {string[]} [p.imagesDataUrls]  비전 모델용 data URL (data:image/png;base64,...)
 * @returns {Promise<Object>}
 */
export async function chatJson({ baseUrl, apiKey, model, system, user, imagesDataUrls }) {
  if (!apiKey) throw makeError('OpenAI API 키가 설정되지 않았습니다. 설정에서 입력해주세요.');
  if (!model) throw makeError('AI 모델명이 설정되지 않았습니다.');
  const url = `${base(baseUrl)}/chat/completions`;
  const hasImages = Array.isArray(imagesDataUrls) && imagesDataUrls.length > 0;

  function request(withImages) {
    let userContent = user;
    if (withImages && hasImages) {
      userContent = [
        { type: 'text', text: user },
        ...imagesDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
      ];
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
  }

  let res;
  try {
    res = await request(true);
    // 비전 미지원 모델에 이미지 보내면 400 → 이미지 빼고 자동 재시도.
    if (res.status === 400 && hasImages) res = await request(false);
  } catch (networkErr) {
    throw makeError('OpenAI에 연결하지 못했습니다. 네트워크를 확인해주세요.', networkErr.message);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw makeError('API 키가 유효하지 않습니다. 설정에서 다시 확인해주세요.', body);
    if (res.status === 429) throw makeError('요청이 많거나 크레딧이 부족합니다. 잠시 후 다시 시도해주세요.', body);
    throw makeError(`OpenAI 오류가 발생했습니다. (HTTP ${res.status})`, body);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return parseLooseJson(content);
}

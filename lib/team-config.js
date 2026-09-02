// 팀 배포용 기본값.
//
// ZIP으로 팀에 배포하기 전에 아래 값을 채워두면, 팀원은 옵션에서
// AI 설정을 손대지 않아도 "AI로 다듬어 등록"이 바로 동작한다.
// (실제 OpenAI 키는 여기에 넣지 말 것 — 프록시 주소와 '접속 토큰'만.)
//
// 개인이 각자 옵션에 입력한 값이 있으면 그 값이 항상 우선한다(아래는 기본값일 뿐).
// ClickUp 개인 토큰은 사람마다 달라 여기서 다루지 않는다 — 각자 옵션에서 입력.

export const TEAM_DEFAULTS = {
  // 예: 'http://10.20.132.30:8787/v1'  (사내 프록시 주소, 끝에 /v1)
  openaiBaseUrl: '',

  // 프록시 접속 토큰 (proxy/config.local.json 의 accessToken 과 동일). 실제 OpenAI 키 아님.
  openaiApiKey: '',

  // 기본 모델
  openaiModel: 'gpt-4o-mini',
};

# 딸깍 OpenAI 프록시 (사내 로컬)

실제 OpenAI API 키를 **호스트 PC 한 곳에만** 두고, 팀원의 확장에는
서버 주소와 **팀 접속 토큰**만 배포하기 위한 작은 프록시입니다.
팀원은 실제 OpenAI 키를 볼 수 없습니다.

## 호스트(키를 가진 PC)에서 실행

1. `config.example.json` 을 `config.local.json` 으로 복사
2. `config.local.json` 값 채우기
   - `openaiKey` : 실제 OpenAI 키 (`sk-...`)
   - `accessToken` : 팀에게 나눠줄 접속 토큰 (아무 긴 문자열이나 직접 정함)
   - `port` : 기본 `8770`
3. `start-proxy.bat` 더블클릭 (또는 `node openai-proxy.mjs`)
4. 콘솔에 나오는 **이 PC의 사내 IP** 확인 (Windows: `ipconfig` → IPv4 주소)

> `config.local.json` 은 `.gitignore` 처리되어 저장소·ZIP에 올라가지 않습니다.
> 방화벽에서 해당 포트(기본 8770) 인바운드 허용이 필요할 수 있습니다.

## 팀원(확장 사용자) 설정

확장 옵션 → 🤖 AI 섹션:
- **base URL** : `http://<호스트 PC 사내 IP>:8770/v1`  (예: `http://192.168.0.10:8770/v1`)
- **API 키** : 호스트가 알려준 **accessToken** (실제 OpenAI 키 아님)
- **모델** : `gpt-4o-mini` 등

## 보안 메모

- `accessToken` 을 반드시 설정하세요. 없으면 사내망 누구나 이 프록시로 키를 쓸 수 있습니다.
- OpenAI 대시보드에서 해당 키에 **월 사용량 한도(budget cap)** 를 걸어두면 만일의 유출에도 피해가 상한선 안에서 멈춥니다.

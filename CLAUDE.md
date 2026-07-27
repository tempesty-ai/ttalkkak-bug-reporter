# 딸깍 버그리포팅 (QA Capture to ClickUp)
> Chrome 확장 프로그램. 화면 캡처·영상 녹화·주석 편집을 거쳐 ClickUp에 원클릭으로 태스크를 등록하는 QA 도구.
---
## 1. 프로젝트 개요
### 목적
QA 엔지니어가 버그를 발견한 순간부터 이슈 트래커(ClickUp)에 리포트가 등록되기까지 걸리는 시간을 **평균 5~10분 → 30초 이내**로 단축.
### 대상 사용자
- 사내 QA 팀
- Chrome 기반 사내 제품(XAIOps, InterMax 등)을 테스트하는 인원
- 고객사 이슈 대응 시 스크린샷·영상 첨부가 필요한 CS 파이프라인 사용자
### 핵심 차별점 (설계 시 절대 놓치지 말 것)
1. **스크린샷 + 영상 녹화** 둘 다 지원 (경쟁 도구 대부분 스크린샷만)
2. **ClickUp 리스트 사전 지정** — 매번 워크스페이스/리스트 고를 필요 없음
3. **콘솔 에러·네트워크 실패 요청 자동 수집** — QA가 손으로 개발자 도구 뒤질 필요 없음
4. **완전 로컬 처리** — 외부 서버 없음, 사내 네트워크에서만 동작
---
## 2. 핵심 제약사항 (반드시 준수)
### 사용 금지 (묻지 말고 절대 쓰지 말 것)
- ❌ **번들러 없음**: webpack, vite, rollup, esbuild 전부 사용 안 함. 순수 ES 모듈로만.
- ❌ **프레임워크 없음**: React, Vue, Svelte 사용 안 함. Vanilla JS.
- ❌ **TypeScript 없음**: 순수 JavaScript (`.js`). JSDoc 주석으로 타입 힌트는 OK.
- ❌ **외부 라이브러리 최소화**: fabric.js, konva.js 같은 무거운 라이브러리 쓰지 말 것. 캔버스 API로 직접 구현.
- ❌ **Manifest V2 패턴 금지**: `background.page`, `browser_action`, `chrome.extension.*` 등 전부 MV3로 마이그레이션된 API 사용.
### 반드시 사용
- ✅ **Manifest V3**
- ✅ **ES Modules** (`"type": "module"` in service worker)
- ✅ **`chrome.storage`** (localStorage 금지 — 서비스 워커에서 접근 불가)
- ✅ **`async/await`** (콜백 지옥 지양)
### 예외 허용
- 아이콘·UI 아이콘용 SVG 인라인은 OK
- 정말 필요하면 단일 파일 라이브러리 로컬 벤더링 OK (CDN 로딩은 CSP 위반)
---
## 3. 아키텍처
> **결정 이력 (2026-07-27):** UI를 팝업이 아니라 **크롬 사이드 패널(`chrome.sidePanel`)** 로 구현한다.
> 팝업은 페이지 클릭 시 즉시 닫혀 QA 작업(페이지 조작 중 캡처, 녹화 컨트롤, 영역 선택)에 불리하기 때문.
> 캡처 실행·미리보기·리포트 폼·ClickUp 등록을 **패널 한 곳**에서 처리하며, 별도 편집기 탭은 두지 않는다.
> (Phase 2 주석 도구도 패널 내부에서 동작.)

### 컴포넌트 구성
```
┌─────────────────────────────────────────────────────────────┐
│                        Chrome Browser                        │
│                                                              │
│  ┌──────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Popup   │───▶│  Service Worker  │───▶│   ClickUp API │  │
│  │ (팝업UI) │    │  (background)    │    │  (fetch)      │  │
│  └──────────┘    └──────────────────┘    └───────────────┘  │
│       ▲                   │  ▲                               │
│       │                   ▼  │                               │
│  ┌──────────┐    ┌──────────────────┐                       │
│  │  Editor  │◀───│ chrome.storage   │                       │
│  │ (편집기) │    │ (session/local)  │                       │
│  └──────────┘    └──────────────────┘                       │
│                           ▲                                  │
│                           │                                  │
│  ┌───────────────┐    ┌───────┴───────┐    ┌─────────────┐ │
│  │Content Script │    │   Offscreen   │    │   Options   │ │
│  │ (영역/스크롤) │    │ (녹화 전용)   │    │  (설정 UI)  │ │
│  └───────────────┘    └───────────────┘    └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```
### 메시지 흐름 (스크린샷 케이스)
1. 사용자가 툴바 아이콘 클릭 → SW의 `openPanelOnActionClick` 설정으로 사이드 패널 열림
2. 패널(런처 뷰)에서 "화면 캡처" 클릭 → `sidepanel.js`가 `chrome.tabs.captureVisibleTab()` 직접 호출
   (버튼 클릭 = 사용자 제스처, `<all_urls>` 권한으로 동작)
3. 결과 dataURL을 `chrome.storage.session`에 `pendingCapture`로 저장 (패널 재오픈 시 복원용)
4. 패널이 리포트 뷰로 전환 → 미리보기 + 제목/우선순위/설명 폼 표시
5. 사용자가 폼 작성 후 "ClickUp 등록" 클릭
6. `sidepanel.js`가 `lib/clickup.js`를 통해 API 호출
   - `POST /list/{list_id}/task` → task_id 획득
   - `POST /task/{task_id}/attachment` → 이미지 첨부
7. 성공 시 토스트 노출 + session의 `pendingCapture` 제거
### 메시지 흐름 (영상 녹화 케이스)
1. 사용자가 팝업에서 "동영상 녹화" 클릭
2. `popup.js` → SW로 `START_RECORDING` 메시지 전달
3. SW가 `chrome.offscreen.createDocument()`로 offscreen 페이지 생성
4. SW가 `chrome.tabCapture.getMediaStreamId({ targetTabId })` 호출 → streamId 획득
5. SW → offscreen으로 `streamId` 전달
6. Offscreen에서 `getUserMedia({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } })` → stream
7. Offscreen에서 `MediaRecorder`로 녹화 시작, chunk를 배열에 축적
8. 페이지에 플로팅 컨트롤 UI 표시 (content script)
9. 사용자가 "중지" 클릭 → SW로 `STOP_RECORDING` 전달 → offscreen이 blob 생성
10. Blob → dataURL 변환 → session storage → 편집기 → ClickUp 업로드
---
## 4. 폴더 구조
```
qa-capture-clickup/
├── manifest.json              # MV3 매니페스트
├── CLAUDE.md                  # 이 파일
├── README.md                  # 사용자용 설치·사용 가이드
├── sidepanel/                 # 메인 UI (런처 + 미리보기 + 리포트 폼 통합)
│   ├── sidepanel.html
│   ├── sidepanel.js
│   ├── sidepanel.css
│   └── tools/                # Phase 2 주석 도구별 모듈 (패널 내부에서 동작)
│       ├── arrow.js
│       ├── text.js
│       ├── step-number.js
│       └── highlight.js
├── background/
│   └── service-worker.js     # 패널 동작 설정, 캡처/녹화 오케스트레이션
├── content/
│   ├── region-select.js      # 영역 선택용 오버레이
│   ├── fullpage-capture.js   # 전체 페이지 스크롤+스티칭
│   ├── recording-controls.js # 녹화 중 플로팅 컨트롤 UI
│   └── log-collector.js      # 콘솔 에러·네트워크 요청 수집 (선택)
├── offscreen/
│   ├── offscreen.html        # MediaRecorder 실행용 히든 페이지
│   └── offscreen.js
├── options/
│   ├── options.html          # ClickUp 토큰·리스트 설정
│   ├── options.js
│   └── options.css
├── lib/
│   ├── clickup.js            # ClickUp API 래퍼
│   ├── capture-utils.js      # 캔버스 조작, dataURL 변환 등
│   └── storage.js            # chrome.storage 헬퍼
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```
---
## 5. Manifest V3 필수 규칙 (자주 까먹지 말 것)
### Service Worker 제약
- ❌ **DOM 없음** — `document`, `window` 접근 불가
- ❌ **MediaRecorder 없음** — 영상 녹화는 반드시 offscreen document에서
- ❌ **localStorage/sessionStorage 없음** — `chrome.storage` 사용
- ❌ **상시 대기 아님** — 30초 유휴 시 종료됨. 상태를 메모리 변수에 두지 말고 storage에 저장
- ❌ **동기 XHR 없음** — `fetch`만 사용
- ✅ **ES Module 지원** — `"type": "module"` 명시하면 `import` 가능
### 팝업 UI 제약
- 팝업은 다른 곳 클릭 시 **즉시 닫힘**. 녹화 중 컨트롤, 진행률 표시 등은 팝업에 두지 말고 페이지 내 플로팅 UI로.
- 팝업 닫힐 때 진행 중인 async 작업은 중단됨. 오래 걸리는 작업은 반드시 SW에 위임.
### Content Script 제약
- 기본은 **isolated world** — 페이지의 `window` 객체와 격리됨
- 페이지의 `window.fetch`, `console.error` 등을 후킹하려면 `<script>` 태그를 페이지에 주입해서 MAIN world에서 실행
- 페이지 CSP에 걸릴 수 있음. 인라인 스크립트 대신 `chrome.scripting.executeScript({ world: 'MAIN' })` 사용
### CSP (Content Security Policy)
- MV3 기본 CSP: `script-src 'self'`. 외부 CDN 로딩 불가.
- 라이브러리 필요하면 로컬 벤더링 (`lib/` 폴더에 복사).
- `eval()`, `new Function()` 사용 금지.
### 권한 (permissions)
```json
{
  "permissions": [
    "activeTab",        // 캡처용 (사용자 상호작용 필요)
    "tabs",             // 탭 URL/타이틀 조회
    "storage",          // 설정 저장
    "scripting",        // content script 동적 주입
    "tabCapture",       // 영상 녹화
    "offscreen",        // offscreen document 생성
    "downloads"         // 로컬 저장 옵션용
  ],
  "host_permissions": [
    "https://api.clickup.com/*",  // ClickUp API 호출
    "<all_urls>"                  // 아무 사이트에서나 캡처 가능하게
  ]
}
```
**`<all_urls>` 는 Chrome Web Store 심사 시 소명 필요.** 사내 배포(unpacked)면 문제 없음.
---
## 6. Chrome Extension API 사용 가이드
### `chrome.tabs.captureVisibleTab`
```js
// 서비스 워커 또는 팝업에서 호출 가능
const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
  format: 'png',      // 'jpeg'도 가능. png가 주석용으로 손실 없음
  quality: 100        // jpeg일 때만 유효
});
// dataUrl: "data:image/png;base64,iVBORw0..."
```
**주의**: `activeTab` 권한만으로 되지만 반드시 사용자 제스처(클릭) 이후에만 호출 가능.
### `chrome.tabCapture.getMediaStreamId`
```js
// SW에서 호출. streamId를 offscreen으로 넘겨야 함
chrome.tabCapture.getMediaStreamId(
  { targetTabId: tabId },
  (streamId) => { /* streamId를 offscreen에 postMessage */ }
);
```
**주의**: streamId는 **일회용**. 획득 후 즉시 offscreen에서 소비해야 함.
### `chrome.offscreen.createDocument`
```js
// 이미 존재하면 재사용해야 함
const existing = await chrome.offscreen.hasDocument();
if (!existing) {
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],  // MediaRecorder 사용 시
    justification: 'Recording tab for QA bug reports'
  });
}
```
### `chrome.scripting.executeScript`
```js
// 파일 주입
await chrome.scripting.executeScript({
  target: { tabId },
  files: ['content/region-select.js']
});
// 함수 주입 (인자 전달 가능)
await chrome.scripting.executeScript({
  target: { tabId },
  func: (selector) => document.querySelector(selector)?.outerHTML,
  args: ['#some-element'],
  world: 'MAIN'  // 페이지의 window에 접근 필요할 때만
});
```
### `chrome.storage`
```js
// local: 영구 저장 (~10MB), sync보다 빠름. 토큰/설정용.
await chrome.storage.local.set({ clickupToken: 'pk_xxx', defaultListId: '123' });
const { clickupToken } = await chrome.storage.local.get(['clickupToken']);
// session: SW 재시작 시 초기화. 캡처 임시 데이터용. (~10MB)
await chrome.storage.session.set({ pendingCapture: { dataUrl, ... } });
```
**주의**: `sync`는 워크스페이스간 동기화되지만 100KB 제한. 이미지/영상 dataURL 저장 금지.
---
## 7. ClickUp API 레퍼런스
### 인증
```js
const headers = {
  'Authorization': token,  // ⚠️ "Bearer" 접두어 없음! 그냥 raw 토큰
  'Content-Type': 'application/json'
};
```
**개인 API 토큰 발급 경로**: ClickUp 우상단 아바타 → Settings → Apps → API Token → Generate
### 계층 구조
```
Team (Workspace)
 └─ Space
     └─ Folder (선택)
         └─ List
             └─ Task
                 └─ Attachment
```
### 설정 UI에서 필요한 API 호출 (드롭다운 채우기)
```js
// 1. 워크스페이스 목록
GET https://api.clickup.com/api/v2/team
Response: { teams: [{ id, name, ... }] }
// 2. 스페이스 목록
GET https://api.clickup.com/api/v2/team/{team_id}/space?archived=false
Response: { spaces: [{ id, name, ... }] }
// 3. 폴더 목록 (있을 수도, 없을 수도)
GET https://api.clickup.com/api/v2/space/{space_id}/folder?archived=false
// 4. 리스트 목록 (폴더가 있는 경우)
GET https://api.clickup.com/api/v2/folder/{folder_id}/list
// 4-b. 리스트 목록 (폴더 없이 스페이스 직속)
GET https://api.clickup.com/api/v2/space/{space_id}/list?archived=false
```
### 태스크 생성
```js
POST https://api.clickup.com/api/v2/list/{list_id}/task
Body: {
  "name": "버그 리포트: 로그인 페이지 정렬 오류",
  "description": "재현 단계:\n1. ...\n2. ...\n\n환경: Chrome 130 / macOS 14.2",
  "priority": 3,          // 1=Urgent, 2=High, 3=Normal, 4=Low
  "tags": ["bug", "qa-auto"],
  "assignees": []         // user_id 배열
}
Response: { id: "task_id_xxx", url: "https://app.clickup.com/t/...", ... }
```
### 파일 첨부 (⚠️ 여기가 자주 실수하는 부분)
```js
// Content-Type: multipart/form-data (자동 설정, 수동으로 지정하지 말 것)
const formData = new FormData();
formData.append('attachment', blob, 'screenshot.png');
// ⚠️ 필드명은 반드시 'attachment' (스펠링 실수 주의)
const res = await fetch(
  `https://api.clickup.com/api/v2/task/${taskId}/attachment`,
  {
    method: 'POST',
    headers: {
      'Authorization': token
      // ⚠️ Content-Type 수동 설정 금지 — FormData가 boundary 포함해서 자동 설정
    },
    body: formData
  }
);
```
### Rate Limit
- Free/Unlimited/Business: 100 req/min per token
- 429 응답 시 `X-RateLimit-Reset` 헤더에 리셋 시각(unix timestamp) 포함
- 지수 백오프 재시도 로직을 `lib/clickup.js`에 구현할 것
### 자주 발생하는 에러
| HTTP | 원인 | 해결 |
|------|------|------|
| 401 | 토큰 잘못됨 or "Bearer" 접두어 붙임 | raw 토큰만 |
| 404 | list_id/task_id 오타 | 옵션 페이지에서 재선택 |
| 400 | body 형식 오류 | 필수 필드(name) 누락 확인 |
| 429 | rate limit | 백오프 후 재시도 |
---
## 8. 상태 관리
### 저장 위치별 용도
| 저장소 | 용도 | 예시 |
|--------|------|------|
| `chrome.storage.local` | 영구 설정 | ClickUp 토큰, 기본 리스트 ID, 유저 프리셋 |
| `chrome.storage.session` | 세션 임시 데이터 | 캡처된 이미지 dataURL, 녹화 상태 플래그 |
| 서비스 워커 메모리 | ❌ 사용 금지 | SW가 종료되면 사라짐 |
| localStorage | ❌ 접근 불가 | 존재하지 않음 |
### 저장 키 네이밍 규칙
```js
// local
{
  clickupToken: 'pk_xxxxx',
  defaultTeamId: '123',
  defaultSpaceId: '456',
  defaultListId: '789',
  userPreferences: {
    videoQuality: 'medium',    // low/medium/high
    autoCollectLogs: true,
    defaultPriority: 3
  }
}
// session
{
  pendingCapture: {
    type: 'image' | 'video',
    dataUrl: 'data:...',
    sourceUrl: 'https://...',
    sourceTitle: '...',
    capturedAt: '2026-01-15T10:30:00Z',
    metadata: {                // 자동 수집된 정보 (선택)
      userAgent: '...',
      consoleErrors: [...],
      failedRequests: [...]
    }
  },
  recording: false | true,
  recordingStartedAt: 1234567890
}
```
---
## 9. 메시지 전달 패턴
### SW에서 async 메시지 처리 (⚠️ 자주 실수)
```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_FULL_PAGE') {
    captureFullPage(msg.tabId).then((result) => {
      sendResponse({ ok: true, data: result });
    });
    return true;  // ⚠️ 반드시 return true — async 응답 대기 신호
  }
});
```
### Offscreen과 SW 간 메시지
```js
// SW에서 offscreen으로
chrome.runtime.sendMessage({ target: 'offscreen', type: 'START_RECORD', streamId });
// Offscreen 리스너
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;  // 자신 대상만 처리
  if (msg.type === 'START_RECORD') { /* ... */ }
});
```
### Content Script와 SW 간
```js
// Content → SW
const response = await chrome.runtime.sendMessage({ type: 'REGION_CAPTURED', bounds });
// SW → 특정 탭
await chrome.tabs.sendMessage(tabId, { type: 'START_SCROLL_CAPTURE' });
```
---
## 10. 코딩 규칙
### 파일·함수 명명
- 파일명: `kebab-case.js` (예: `region-select.js`)
- 함수·변수: `camelCase`
- 상수: `SCREAMING_SNAKE_CASE`
- 클래스: `PascalCase` (거의 안 씀. 이 프로젝트는 함수 위주)
### 주석
- 한글 OK (사내용). 다만 함수 시그니처 위 JSDoc은 영어로.
- 왜(WHY)를 적을 것. 뭐(WHAT)를 적지 말 것.
  ```js
  // ❌ x에 1을 더한다
  // ✅ Chrome API가 1-based index를 반환해서 0-based로 정규화
  ```
### 에러 처리
- 모든 async 함수는 try/catch. 사용자에게 노출될 에러는 한글 메시지로 변환.
- ClickUp API 에러는 반드시 사용자 친화적 메시지로 매핑:
  ```js
  const errorMessages = {
    401: 'ClickUp 토큰이 유효하지 않습니다. 설정 페이지에서 다시 입력해주세요.',
    404: '지정한 리스트를 찾을 수 없습니다. 리스트를 다시 선택해주세요.',
    429: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.'
  };
  ```
### 로깅
- `console.log`: 개발 중만 사용. 프로덕션 코드엔 남기지 말 것.
- `console.error`: 실제 에러만.
- 디버그용 로그는 `if (DEBUG)` 가드로 감쌀 것 (상수 하나 두고 배포 시 false).
### import/export
- ES Module 사용. 상대 경로:
  ```js
  import { createTask } from '../lib/clickup.js';  // .js 확장자 필수
  ```
---
## 11. 개발 워크플로
### 최초 로드
1. Chrome에서 `chrome://extensions` 접속
2. 우상단 "개발자 모드" 토글 ON
3. "압축해제된 확장 프로그램 로드" → 프로젝트 폴더 선택
4. 확장 카드에서 ID 확인 (디버깅 시 필요)
### 코드 수정 후
1. `chrome://extensions`에서 해당 확장의 새로고침 아이콘(🔄) 클릭
2. 팝업/편집기는 다시 열기
3. Service Worker는 자동 재시작. 상태가 필요하면 다시 트리거
### 디버깅
| 대상 | 방법 |
|------|------|
| 팝업 | 팝업 우클릭 → "검사" |
| 편집기 탭 | 편집기 탭에서 F12 |
| Service Worker | `chrome://extensions` → 확장 카드의 "서비스 워커" 링크 클릭 |
| Content Script | 대상 페이지에서 F12 → Sources → Content Scripts |
| Offscreen | `chrome://extensions` → 확장 카드 → "offscreen document 검사" |
### 첫 확인 순서 (버그 리포트 시)
1. `chrome://extensions`에서 확장 리로드했는지
2. 콘솔에 에러 있는지 (SW 콘솔 vs 페이지 콘솔 구분)
3. `chrome.storage.local`에 필요한 값 있는지 (`chrome.storage.local.get(null).then(console.log)`)
4. 권한(permissions)이 매니페스트에 있는지
---
## 12. 자주 발생하는 함정 (미리 방지)
### 함정 1: 서비스 워커에서 MediaRecorder 사용 시도
**증상**: `MediaRecorder is not defined`
**원인**: SW에는 미디어 API 없음
**해결**: offscreen document 사용 (섹션 5, 6 참고)
### 함정 2: `chrome.tabs.captureVisibleTab` "activeTab 필요" 에러
**증상**: 사용자 제스처 없이 호출하면 실패
**원인**: 팝업 열자마자가 아니라 다른 이벤트에서 호출
**해결**: 반드시 사용자 클릭 이벤트 핸들러 안에서 호출
### 함정 3: ClickUp 401 에러
**증상**: 토큰이 맞는데도 401
**원인**: `Authorization: Bearer pk_xxx` 형식으로 보냄
**해결**: `Authorization: pk_xxx` (Bearer 접두어 제거)
### 함정 4: ClickUp 첨부 업로드 실패
**증상**: 400 또는 무한 대기
**원인 1**: `Content-Type: multipart/form-data`를 수동 설정 (boundary가 없어 실패)
**원인 2**: FormData 필드명이 `attachment`가 아님
**해결**: FormData 사용, Content-Type 삭제, 필드명 확인
### 함정 5: 팝업 닫힘으로 async 작업 중단
**증상**: 팝업에서 시작한 fetch가 도중 실패
**원인**: 팝업이 닫히면 팝업 컨텍스트의 모든 pending 작업 중단
**해결**: 팝업은 SW에 메시지만 보내고 즉시 close(). 실제 작업은 SW에서.
### 함정 6: 전체 페이지 캡처 시 고정 헤더 중복
**증상**: 스크롤 캡처 이미지에 헤더가 여러 번 찍힘
**원인**: `position: fixed` 요소가 스크롤해도 그대로
**해결**: 캡처 전에 고정 요소를 임시로 `position: absolute`로 변경, 캡처 후 복원
### 함정 7: dataURL 크기 → storage 초과
**증상**: `chrome.storage.session.set` 실패 or 데이터 사라짐
**원인**: 큰 이미지/영상 dataURL이 storage 한도 초과
**해결**: Blob으로 저장하거나, IndexedDB 사용 (session storage 대안)
### 함정 8: 콘솔 에러 후킹이 페이지에 안 붙음
**증상**: `window.onerror` 훅이 안 잡힘
**원인**: 기본 content script는 isolated world라 페이지의 window와 다름
**해결**: `chrome.scripting.executeScript({ world: 'MAIN' })`로 주입
### 함정 9: 확장 리로드 후 storage 값 사라짐
**증상**: 옵션 저장했는데 다시 열면 비어있음
**원인**: `chrome.storage.session`을 사용함 (SW 재시작 시 초기화)
**해결**: 영구 데이터는 반드시 `chrome.storage.local`
### 함정 10: 개발자 모드 확장에 "임시 확장 프로그램" 경고
**증상**: Chrome 재시작 후 경고 팝업
**원인**: unpacked 확장의 기본 동작
**해결**: 개발용이면 무시. 사내 배포 시 CRX 서명 or Web Store 등록.
---
## 13. 기능 로드맵
### Phase 1: 최소 동작 (MVP) — 공모전 데모 가능 지점
- [ ] `manifest.json` 뼈대 (`sidePanel` + `side_panel`)
- [ ] 사이드 패널 런처 UI (버튼 4개: 화면/전체/영역/영상 — 이번 phase는 화면만 실제 동작)
- [ ] 서비스 워커 + `captureVisibleTab` + `openPanelOnActionClick`
- [ ] 패널 리포트 뷰 (이미지 표시 + 폼 + "ClickUp 등록" 버튼)
- [ ] 옵션 페이지 (ClickUp 토큰 저장 + 리스트 ID 수동 입력)
- [ ] `lib/clickup.js`: 태스크 생성 + 첨부
**검증**: 패널 열기 → 캡처 → 리포트 뷰 표시 → "등록" 클릭 → ClickUp에 태스크 생성 확인
### Phase 2: 편집 도구
- [ ] 캔버스 기반 편집기 (기존 이미지 위에 그리기)
- [ ] 화살표 도구
- [ ] 텍스트 도구
- [ ] 단계 번호 도구 (자동 증가)
- [ ] 하이라이트(형광펜)
- [ ] Undo/Redo
### Phase 3: 캡처 확장
- [ ] 영역 선택 (content script 오버레이 → crop)
- [ ] 전체 페이지 (스크롤+스티칭, 고정 요소 처리 포함)
### Phase 4: 옵션 페이지 UX 개선
- [ ] ClickUp 계층 드롭다운 (Team → Space → List 순차 로드)
- [ ] 저장 상태 표시
- [ ] 토큰 유효성 즉시 검증
### Phase 5: 영상 녹화 (핵심 차별점)
- [ ] Offscreen document 셋업
- [ ] `tabCapture` + `MediaRecorder` (webm 저장)
- [ ] 페이지 내 플로팅 컨트롤 UI (녹화 중 표시, 중지 버튼)
- [ ] 편집기에서 영상 프리뷰
- [ ] ClickUp에 영상 첨부
### Phase 6: 자동 정보 수집 (차별점 강화)
- [ ] 콘솔 에러 후킹 (MAIN world 주입)
- [ ] 실패한 fetch/XHR 요청 캡처
- [ ] userAgent, URL, 뷰포트 크기 자동 첨부
- [ ] 태스크 description에 자동 포맷팅
### Phase 7: 다듬기 & 배포 준비
- [ ] 아이콘 (16/48/128 png)
- [ ] 스타일 통일 (색상 팔레트, 폰트)
- [ ] 에러 토스트 UI
- [ ] README 작성
- [ ] (선택) Chrome Web Store 등록: privacy policy, screenshots, 심사
**Phase 1~3까지 = 공모전 발표 최소 기준**
**Phase 5까지 = 이상적인 발표 시연 범위**
**Phase 7 = 사내 정식 배포**
---
## 14. 검증 체크리스트 (Phase별)
### Phase 1 완료 조건
- [ ] `chrome://extensions`에서 오류 없이 로드됨
- [ ] 툴바 아이콘 클릭 시 사이드 패널이 정상 열림
- [ ] "화면 캡처" 클릭 시 패널이 리포트 뷰로 바뀌고 이미지가 표시됨
- [ ] 옵션에 유효한 토큰·리스트 ID 넣고 "등록" 클릭 시 ClickUp에 태스크 생성됨
- [ ] 태스크에 이미지가 첨부되어 있음
- [ ] 토큰이 잘못됐을 때 사용자에게 명확한 에러 메시지 노출
### Phase 5 완료 조건
- [ ] 녹화 시작 시 페이지에 플로팅 컨트롤 표시
- [ ] 다른 탭으로 이동해도 녹화가 계속됨 (또는 명시적으로 중지되어야 함)
- [ ] 중지 시 editor에서 영상 재생 가능
- [ ] ClickUp에 webm 파일로 첨부됨
- [ ] 녹화 중 팝업을 닫아도 녹화가 유지됨
---
## 15. 사용자에게 물어봐야 할 때
Claude Code는 다음 상황에선 임의로 결정하지 말고 사용자에게 확인할 것:
- **아키텍처 변경**: 폴더 구조·주요 라이브러리 추가·MV3 예외 사용
- **UX 결정**: 색상·레이아웃·문구가 명확히 정해지지 않은 경우
- **ClickUp 필드 매핑**: 어떤 정보를 어느 필드에 넣을지 (예: 재현 단계 → description vs comment)
- **에러 처리 정책**: 실패 시 재시도 횟수, 로컬 백업 여부 등
- **범위 확장**: Phase에 없는 기능 추가 요청 시 "이건 다음 phase로 미룰지 지금 넣을지" 확인
반대로 **묻지 말고 진행할 것**:
- 명백한 버그 수정
- 이 문서에 명시된 규칙에 맞추는 리팩토링
- 함정 섹션에 명시된 실수 예방
---
## 16. 참고 리소스
- Chrome Extensions MV3 공식 문서: https://developer.chrome.com/docs/extensions/
- ClickUp API 문서: https://developer.clickup.com/reference/
- Offscreen Documents: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Tab Capture API: https://developer.chrome.com/docs/extensions/reference/api/tabCapture

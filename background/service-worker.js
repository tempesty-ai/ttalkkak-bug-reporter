// 서비스 워커 (MV3, ES Module).
// UI는 사이드 패널로 통합됐다. 아이콘 클릭 시 패널이 열리도록 동작을 설정한다.
// 캡처/등록은 패널 컨텍스트에서 직접 수행하므로 SW의 역할은 최소한이다.
// 이후 Phase(영상 녹화 등)에서 오케스트레이션 로직이 여기에 붙는다.
//
// 주의: SW는 30초 유휴 시 종료된다. 상태는 전역 변수가 아니라 chrome.storage에 저장할 것.

const DEBUG = false;

// 툴바 아이콘 클릭 → 사이드 패널 토글. (default_popup 없이 동작)
// SW가 깰 때마다 보장되도록 최상위에서 호출.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => {
    if (DEBUG) console.error('[QA Capture] setPanelBehavior 실패:', err);
  });

chrome.runtime.onInstalled.addListener((details) => {
  if (DEBUG) console.log('[QA Capture] installed:', details.reason);
});

// 향후 Phase에서 사용할 메시지 라우터 자리.
// async 응답이 필요한 핸들러는 반드시 return true 로 채널을 열어둘 것.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    // 예: case 'START_RECORDING': ... return true;
    default:
      return false; // 처리하지 않음
  }
});

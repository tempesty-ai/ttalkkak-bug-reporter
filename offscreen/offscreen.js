// Offscreen 문서: 탭 스트림을 MediaRecorder로 녹화한다.
// SW에는 미디어 API가 없어서(함정 1) 녹화는 반드시 여기서 수행.
// SW ↔ offscreen 메시지는 target:'offscreen'으로 구분한다.

let recorder = null;
let chunks = [];
let activeStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false; // 자신 대상만 처리

  if (msg.type === 'OFFSCREEN_START') {
    startRecording(msg.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async 응답
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    stopRecording();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function startRecording(streamId) {
  if (recorder) throw new Error('이미 녹화 중입니다.');

  // 탭 캡처 스트림: chromeMediaSource='tab' + getMediaStreamId로 받은 streamId.
  // (레거시 mandatory 문법이지만 탭 캡처엔 이 형식이 필요)
  activeStream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  chunks = [];
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  recorder = new MediaRecorder(activeStream, { mimeType });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }
    const blob = new Blob(chunks, { type: 'video/webm' });
    chunks = [];
    recorder = null;

    try {
      const dataUrl = await blobToDataUrl(blob);
      // 브로드캐스트: 패널이 dataUrl을 받고, SW는 정리 작업을 한다.
      chrome.runtime.sendMessage({ type: 'RECORDING_COMPLETE', dataUrl });
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'RECORDING_FAILED', error: err.message });
    }
  };

  recorder.start(1000); // 1초마다 chunk flush (긴 녹화 안정성)
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('영상 변환에 실패했습니다.'));
    fr.readAsDataURL(blob);
  });
}

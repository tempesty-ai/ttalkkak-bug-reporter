// 캡처 뷰어 탭 (이미지 · 녹화 영상 공용).
// 패널이 IndexedDB에 담아둔 Blob을 읽어 크게 보여주고, 이미지는 여기서 주석까지 그린다.
//
// 사이드 패널은 폭이 좁고 Fullscreen API도 막혀 있어 캡처 세부를 볼 수 없다.
// 그래서 '크게 보기'와 '주석 편집'을 모두 이 탭이 맡고, 결과는 패널로 되돌려준다.

import { getBlob, putBlob } from '../lib/media-store.js';
import { createAnnotator } from '../sidepanel/annotator.js';

const MEDIA_KEY = 'lastMedia';
const DEFAULT_TOOL = 'arrow';
const DEFAULT_COLOR = '#e5484d';

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  empty: document.getElementById('empty'),
  meta: document.getElementById('meta'),
  title: document.getElementById('title'),
  stage: document.getElementById('stage'),
  tools: document.getElementById('tools'),
  undoBtn: document.getElementById('undo-btn'),
  clearBtn: document.getElementById('clear-btn'),
  zoomBtn: document.getElementById('zoom-btn'),
  zoomLabel: document.getElementById('zoom-label'),
  fullscreenBtn: document.getElementById('fullscreen-btn'),
  fullscreenLabel: document.getElementById('fullscreen-label'),
  downloadBtn: document.getElementById('download-btn'),
  applyBtn: document.getElementById('apply-btn'),
  closeBtn: document.getElementById('close-btn'),
};

let objectUrl = null;
let filename = 'capture.png';
let isVideo = false;
let annotator = null;

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function showEmpty() {
  els.empty.hidden = false;
  els.zoomBtn.hidden = true;
  els.fullscreenBtn.disabled = true;
  els.downloadBtn.disabled = true;
}

function setActive(nodeList, match) {
  nodeList.forEach((b) => b.classList.toggle('active', b === match));
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('name')) filename = params.get('name');

  let blob = null;
  try {
    blob = await getBlob(MEDIA_KEY);
  } catch {
    /* 아래에서 안내 문구로 처리 */
  }
  if (!blob) {
    showEmpty();
    return;
  }

  isVideo = (blob.type || '').startsWith('video/');
  objectUrl = URL.createObjectURL(blob);
  els.meta.textContent = formatSize(blob.size);

  if (isVideo) {
    els.title.textContent = '딸깍 · 녹화 영상';
    els.video.src = objectUrl;
    els.video.hidden = false;
    return;
  }

  els.title.textContent = '딸깍 · 캡처 이미지';
  els.canvas.hidden = false;
  els.zoomBtn.hidden = false;
  els.tools.hidden = false;
  els.applyBtn.hidden = false;

  annotator = createAnnotator(els.canvas, objectUrl);
  annotator.setTool(DEFAULT_TOOL);
  annotator.setColor(DEFAULT_COLOR);
  setActive(toolBtns, els.tools.querySelector(`.tool-btn[data-tool="${DEFAULT_TOOL}"]`));
  setActive(colorBtns, els.tools.querySelector(`.color-btn[data-color="${DEFAULT_COLOR}"]`));

  // createAnnotator가 이미지 로드 후 캔버스 크기를 원본에 맞추므로 그 뒤에 읽는다.
  const probe = new Image();
  probe.onload = () => {
    els.meta.textContent = [`${probe.naturalWidth} × ${probe.naturalHeight}`, formatSize(blob.size)]
      .filter(Boolean)
      .join(' · ');
  };
  probe.src = objectUrl;
}

/* ---------- 주석 도구 ---------- */

const toolBtns = [...document.querySelectorAll('.tool-btn[data-tool]')];
const colorBtns = [...document.querySelectorAll('.color-btn')];

toolBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!annotator) return;
    annotator.setTool(btn.dataset.tool);
    setActive(toolBtns, btn);
  });
});

colorBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!annotator) return;
    annotator.setColor(btn.dataset.color);
    setActive(colorBtns, btn);
  });
});

els.undoBtn.addEventListener('click', () => annotator && annotator.undo());
els.clearBtn.addEventListener('click', () => annotator && annotator.clear());

/* ---------- 조작 ---------- */

// 화면맞춤 ↔ 실제 크기(1:1). 1:1에선 스테이지가 스크롤된다.
els.zoomBtn.addEventListener('click', () => {
  const actual = els.canvas.classList.toggle('is-actual');
  els.stage.classList.toggle('is-scroll', actual);
  els.zoomLabel.textContent = actual ? '화면 맞춤' : '실제 크기';
});

els.fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  // 이미지는 문서 전체를 전체화면으로 한다.
  // 스테이지만 올리면 주석 툴바가 전체화면 밖에 남아 사라지고, 도구를 바꿀 수 없어
  // 처음 골라둔 화살표만 계속 그려진다.
  const target = isVideo ? els.video : document.documentElement;
  target.requestFullscreen().catch(() => {});
});

els.downloadBtn.addEventListener('click', async () => {
  // 이미지는 주석이 합쳐진 현재 캔버스를 내려받는다.
  const blob = annotator ? await annotator.getBlob() : null;
  const href = blob ? URL.createObjectURL(blob) : objectUrl;
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  if (blob) setTimeout(() => URL.revokeObjectURL(href), 10000);
});

// 그린 내용을 패널로 돌려준다. 이걸 눌러야 리포트 첨부에 반영된다.
els.applyBtn.addEventListener('click', async () => {
  if (!annotator) return;
  els.applyBtn.disabled = true;
  try {
    const blob = await annotator.getBlob();
    if (blob) {
      await putBlob(MEDIA_KEY, blob);
      // 패널이 열려 있지 않으면 받는 쪽이 없다 — 실패해도 저장은 끝났으므로 넘어간다.
      try {
        await chrome.runtime.sendMessage({ type: 'ANNOTATION_APPLIED' });
      } catch {
        /* 패널이 닫혀 있음 */
      }
    }
    window.close();
  } catch {
    els.applyBtn.disabled = false;
  }
});

/**
 * 전체화면에선 오른쪽 상단 기능들을 잠근다.
 *
 * 크기 전환·다운로드·닫기는 전체화면 상태에서 어색하거나 전체화면을 깨뜨린다.
 * 전체화면 토글만 살려둬야 빠져나올 수 있으므로 그것만 예외.
 * 주석 툴바는 그대로 둔다 — 크게 놓고 그리는 게 전체화면의 목적이다.
 */
function syncFullscreenUi() {
  const fs = !!document.fullscreenElement;
  for (const b of [els.zoomBtn, els.downloadBtn, els.applyBtn, els.closeBtn]) b.disabled = fs;
  els.fullscreenLabel.textContent = fs ? '전체화면 해제' : '전체화면';
}

document.addEventListener('fullscreenchange', syncFullscreenUi);

els.closeBtn.addEventListener('click', () => window.close());

// 전체화면이 아닐 때만 ESC로 탭을 닫는다 (전체화면 해제가 우선).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.fullscreenElement) window.close();
});

window.addEventListener('pagehide', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

init();

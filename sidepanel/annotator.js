// 캔버스 기반 주석 편집기 (외부 라이브러리 없이 Canvas API로 직접 구현).
// 보존 모드(retained): 도형 목록을 들고 매 프레임 전체를 다시 그린다 → undo/미리보기가 쉬움.
//
// 좌표계: 캔버스 내부 해상도는 원본 이미지 크기 그대로 두고(선명한 첨부용),
// 화면에는 CSS로 축소 표시한다. 포인터 좌표는 표시 크기 → 내부 해상도로 스케일 변환한다.

const TOOLS = ['arrow', 'highlight', 'step', 'text'];

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} dataUrl 캡처 이미지 data URL
 * @returns {{setTool:Function, setColor:Function, undo:Function, clear:Function, isEmpty:Function, getBlob:Function, destroy:Function}}
 */
export function createAnnotator(canvas, dataUrl) {
  const ctx = canvas.getContext('2d');
  const shapes = [];
  let tool = 'arrow';
  let color = '#e11d48';
  let baseImage = null;
  let drawing = false;
  let start = null;
  let preview = null;

  // 이미지 크기에 비례한 선 두께/글자 크기 (작은 캡처에서도 보이도록 하한 둠).
  let strokeWidth = 4;
  let fontSize = 20;

  const img = new Image();
  img.onload = () => {
    baseImage = img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    strokeWidth = Math.max(3, Math.round(img.naturalWidth / 300));
    fontSize = Math.max(16, Math.round(img.naturalWidth / 45));
    redraw();
  };
  img.src = dataUrl;

  /* ---------- 그리기 ---------- */

  function drawArrow(s) {
    const { x1, y1, x2, y2, w, c } = s;
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = w * 4;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function drawHighlight(s) {
    const { x1, y1, x2, y2, c } = s;
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = c;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.restore();
  }

  function drawStep(s) {
    const { x, y, n, w, c } = s;
    const r = w * 3;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 1.2)}px 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + r * 0.05);
  }

  function drawText(s) {
    const { x, y, text, size, c } = s;
    ctx.font = `bold ${size}px 'Segoe UI', 'Malgun Gothic', sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // 가독성을 위해 흰 외곽선 후 색 채움.
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = c;
    ctx.fillText(text, x, y);
  }

  function drawShape(s) {
    if (s.type === 'arrow') drawArrow(s);
    else if (s.type === 'highlight') drawHighlight(s);
    else if (s.type === 'step') drawStep(s);
    else if (s.type === 'text') drawText(s);
  }

  function redraw() {
    if (!baseImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0);
    for (const s of shapes) drawShape(s);
    if (preview) drawShape(preview);
  }

  /* ---------- 포인터 → 캔버스 좌표 ---------- */

  function toCanvasCoords(evt) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * sx,
      y: (evt.clientY - rect.top) * sy,
    };
  }

  function nextStepNumber() {
    return shapes.filter((s) => s.type === 'step').length + 1;
  }

  /* ---------- 포인터 이벤트 ---------- */

  function onPointerDown(evt) {
    if (!baseImage) return;
    start = toCanvasCoords(evt);
    drawing = true;
    preview = null;
    canvas.setPointerCapture(evt.pointerId);
  }

  function onPointerMove(evt) {
    if (!drawing || !start) return;
    if (tool !== 'arrow' && tool !== 'highlight') return;
    const p = toCanvasCoords(evt);
    preview = {
      type: tool,
      x1: start.x,
      y1: start.y,
      x2: p.x,
      y2: p.y,
      w: strokeWidth,
      c: color,
    };
    redraw();
  }

  function onPointerUp(evt) {
    if (!drawing || !start) return;
    drawing = false;
    const p = toCanvasCoords(evt);
    const dist = Math.hypot(p.x - start.x, p.y - start.y);

    if (tool === 'arrow' || tool === 'highlight') {
      if (dist > 5) {
        shapes.push({
          type: tool,
          x1: start.x,
          y1: start.y,
          x2: p.x,
          y2: p.y,
          w: strokeWidth,
          c: color,
        });
      }
    } else if (tool === 'step') {
      shapes.push({ type: 'step', x: start.x, y: start.y, n: nextStepNumber(), w: strokeWidth, c: color });
    } else if (tool === 'text') {
      // eslint-disable-next-line no-alert
      const text = window.prompt('텍스트를 입력하세요:');
      if (text && text.trim()) {
        shapes.push({ type: 'text', x: start.x, y: start.y, text: text.trim(), size: fontSize, c: color });
      }
    }

    preview = null;
    start = null;
    redraw();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);

  /* ---------- 공개 API ---------- */

  return {
    setTool(t) {
      if (TOOLS.includes(t)) tool = t;
    },
    setColor(c) {
      color = c;
    },
    undo() {
      shapes.pop();
      redraw();
    },
    clear() {
      shapes.length = 0;
      redraw();
    },
    isEmpty() {
      return shapes.length === 0;
    },
    /** 주석이 합쳐진 PNG Blob 반환. */
    getBlob() {
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    },
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
    },
  };
}

// 녹화 영상처럼 큰 Blob을 페이지 간에 넘기기 위한 IndexedDB 보관소.
//
// chrome.storage.session은 용량 한도(~10MB)에 쉽게 걸리고, blob: URL은 그것을 만든
// 문서(패널)가 닫히면 무효가 된다. 뷰어 탭은 패널과 무관하게 살아 있어야 하므로
// 확장 오리진에 공유되는 IndexedDB에 담아 넘긴다.

const DB_NAME = 'ttalkkak-media';
const DB_VERSION = 1;
const STORE = 'blobs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB를 열지 못했습니다.'));
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** @param {string} key @param {Blob} blob */
export async function putBlob(key, blob) {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (s) => s.put(blob, key));
  } finally {
    db.close();
  }
}

/** @param {string} key @returns {Promise<Blob|null>} */
export async function getBlob(key) {
  const db = await openDb();
  try {
    return (await tx(db, 'readonly', (s) => s.get(key))) || null;
  } finally {
    db.close();
  }
}

/** @param {string} key */
export async function deleteBlob(key) {
  const db = await openDb();
  try {
    await tx(db, 'readwrite', (s) => s.delete(key));
  } finally {
    db.close();
  }
}

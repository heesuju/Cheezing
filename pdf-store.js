// IndexedDB storage for a run's PDF, shared by the service worker and the
// offscreen page. Pages are stored as the run saves them, and the finished
// PDF is stored for the download; both live on disk, not in memory.
const pdfStore = (() => {
  const DB_NAME = 'cheezing-pdf';
  const PAGES = 'pages';   // auto-numbered { blob, width, height }, in saving order
  const OUTPUT = 'output'; // the finished PDF, under OUTPUT_KEY
  const OUTPUT_KEY = 'pdf';

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(PAGES, { autoIncrement: true });
        request.result.createObjectStore(OUTPUT);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Runs one request in its own transaction and resolves with its result
  async function run(storeName, mode, makeRequest) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = makeRequest(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    addPage: (page) => run(PAGES, 'readwrite', (store) => store.add(page)),
    pageKeys: () => run(PAGES, 'readonly', (store) => store.getAllKeys()),
    getPage: (key) => run(PAGES, 'readonly', (store) => store.get(key)),
    clearPages: () => run(PAGES, 'readwrite', (store) => store.clear()),
    setOutput: (blob) => run(OUTPUT, 'readwrite', (store) => store.put(blob, OUTPUT_KEY)),
    getOutput: () => run(OUTPUT, 'readonly', (store) => store.get(OUTPUT_KEY)),
    clearOutput: () => run(OUTPUT, 'readwrite', (store) => store.clear())
  };
})();

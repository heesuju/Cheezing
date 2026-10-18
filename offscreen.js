// Hidden page that turns the finished PDF into a blob: URL for the download.
// The service worker can't create one itself, and a data: URL would hold the
// whole PDF in memory as text. The PDF is read from IndexedDB, which this page
// shares with the service worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command !== 'getPdfUrl') return;
  pdfStore.getOutput().then((blob) => {
    sendResponse({ url: blob ? URL.createObjectURL(blob) : null });
  }, () => sendResponse({ url: null }));
  return true;
});

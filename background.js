importScripts('pdf-store.js', 'i18n.js');

let state = {
  isRecording: false,
  isPlaying: false,
  isPaused: false, // a capture is waiting for its tab to be visible again
  isSelectingArea: false,
  captureRect: null,
  prefix: '',
  actions: [],
  captureFirst: true,
  macroEnabled: false,
  savedRecordings: {},
  activeRecordingName: '',
  createPdf: true,
  skipDuplicates: true,   // don't save a capture identical to the previous one
  autoStopUnchanged: true, // end a macro run once the page stops changing
  maxCaptures: 0,         // end a macro run after this many saved captures (0 = no limit)
  runSaved: 0,            // captures saved in the current run
  runSkipped: 0,          // duplicate captures skipped in the current run
  longCapture: false,     // Long: scroll and stitch the whole page into one strip
  hiRes: false,           // Hi-Res: render at zoomMultiplier× (also applies to Long)
  zoomMultiplier: 4,      // 2 | 3 | 4 -- Hi-Res resolution multiplier (Settings)
  maxStripTiles: 2000     // Long: max scroll steps per capture, 0 = no limit (Settings)
};

const ZOOM_ATTACH_SETTLE_DELAY = 300; // ms for the page to repaint after the debugger bar appears
const DEFAULT_ZOOM_MULTIPLIER = 4;
const ZOOM_TILE_PX = 4096; // max output px per side of one zoom screenshot tile
const MAX_ZOOM_DIM = 32000; // max zoom output px per side (canvas dimension limit is 32767)
const MAX_ZOOM_AREA = 64000000; // max zoom output px, keeps canvas memory ~256MB
const SCROLL_SETTLE_DELAY = 250; // ms to let lazy content/repaints settle after each scroll step
const MAX_STRIP_HEIGHT = 32000; // px per stitched strip file (canvas dimension limit is 32767)
const MAX_STRIP_AREA = 64000000; // px per stitched strip file, keeps canvas memory ~256MB
const CAPTURE_MIN_INTERVAL = 550; // captureVisibleTab is capped at 2 calls/sec
const PDF_MAX_PAGE_DIM = 14400; // PDF spec limit for a page side, in points
const PDF_BAND_PIXELS = 4000000; // px converted at a time when writing a PDF page

// Settings that must survive Chrome shutting the service worker down when
// idle (which resets everything in memory). Messages wait for this to load.
const PERSISTED_KEYS = [
  'longCapture', 'hiRes', 'zoomMultiplier', 'createPdf', 'captureFirst', 'skipDuplicates',
  'autoStopUnchanged', 'maxCaptures', 'maxStripTiles', 'macroEnabled', 'prefix', 'activeRecordingName'
];

const stateReady = chrome.storage.local.get(['savedRecordings', 'options']).then(({ savedRecordings, options }) => {
  if (savedRecordings) state.savedRecordings = savedRecordings;
  if (options) {
    for (const key of PERSISTED_KEYS) {
      if (key in options) state[key] = options[key];
    }
    // Settings saved before Long/Hi-Res became independent toggles
    if ('captureMode' in options && !('longCapture' in options)) {
      state.longCapture = options.captureMode === 'scroll';
      state.hiRes = options.captureMode === 'zoom';
      state.zoomMultiplier = DEFAULT_ZOOM_MULTIPLIER; // moved to Settings with a new default
    }
  }
  // The selected recording's actions come from the saved recordings
  if (state.activeRecordingName && state.savedRecordings[state.activeRecordingName]) {
    state.actions = state.savedRecordings[state.activeRecordingName];
  } else {
    state.activeRecordingName = '';
  }
});

function saveOptions() {
  const options = {};
  for (const key of PERSISTED_KEYS) options[key] = state[key];
  chrome.storage.local.set({ options });
}

let lastActionTime = 0;
let pendingCaptureRatio = 'free';
let captureCount = 0;
let sessionPrefix = '';
let currentSubfolder = '';

function getTodayDateKey() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function getNextRunSubfolder() {
  const today = getTodayDateKey();
  const data = await chrome.storage.local.get(['runDate', 'runIndex']);
  let nextIndex = 1;
  if (data && data.runDate === today && typeof data.runIndex === 'number') {
    nextIndex = data.runIndex + 1;
  }
  await chrome.storage.local.set({ runDate: today, runIndex: nextIndex });
  return `${today}_${nextIndex}`;
}

// Status is shown by lighting up the camera lens in the toolbar icon (a
// badge can't be positioned or shaped). Lens centre/radius are fractions of
// the icon size, measured from the icon artwork.
const LENS = { x: 0.504, y: 0.621, r: 0.15 };
const STATUS_COLORS = { recording: '#e94560', playing: '#4caf50', paused: '#ff6d00' };
const STATUS_ICON_SIZES = [16, 32];
const DEFAULT_ICON = { 16: 'icons/icon_16.png', 32: 'icons/icon_32.png', 48: 'icons/icon_48.png', 128: 'icons/icon_128.png' };
let iconBitmaps = null;
let shownStatus = null;

async function updateStatusIcon() {
  const status = state.isRecording ? 'recording'
    : state.isPaused ? 'paused'
    : state.isPlaying ? 'playing'
    : null;
  if (status === shownStatus) return;
  shownStatus = status;

  if (!status) {
    await chrome.action.setIcon({ path: DEFAULT_ICON });
    return;
  }

  if (!iconBitmaps) {
    iconBitmaps = await Promise.all(STATUS_ICON_SIZES.map(async (size) => {
      const response = await fetch(chrome.runtime.getURL(DEFAULT_ICON[size]));
      return createImageBitmap(await response.blob());
    }));
  }
  if (shownStatus !== status) return; // status changed while the icons loaded

  const imageData = {};
  STATUS_ICON_SIZES.forEach((size, i) => {
    const ctx = new OffscreenCanvas(size, size).getContext('2d');
    ctx.drawImage(iconBitmaps[i], 0, 0, size, size);
    ctx.fillStyle = STATUS_COLORS[status];
    ctx.beginPath();
    ctx.arc(LENS.x * size, LENS.y * size, LENS.r * size, 0, Math.PI * 2);
    ctx.fill();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  });
  await chrome.action.setIcon({ imageData });
}

function broadcastState() {
  updateStatusIcon().catch(() => {});
  updateActionTitle();
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

function generateRecordingName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `Recording ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let name = base;
  let suffix = 1;
  while (state.savedRecordings[name]) {
    name = `${base} (${suffix++})`;
  }
  return name;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  stateReady.then(() => {
    handleMessage(message, sender, sendResponse);
    if (message.command !== 'getState' && message.command !== 'recordAction') saveOptions();
  });
  return true;
});

function clearCaptureArea(tabId) {
  state.captureRect = null;
  const send = (id) => chrome.tabs.sendMessage(id, { command: 'clearArea' }).catch(() => {});
  if (tabId !== null) {
    send(tabId);
  } else {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs[0]) send(tabs[0].id);
    });
  }
  broadcastState();
}

// The user closed Chrome's "is debugging this browser" bar (its Cancel
// button). That ends the area-selection session: stop a running macro, which
// can't click without the debugger, and clear the capture area.
chrome.debugger.onDetach.addListener((source, reason) => { onDebuggerDetach(source, reason); });

async function onDebuggerDetach(source, reason) {
  if (reason !== 'canceled_by_user') return;
  await stateReady;
  if (state.isPlaying) state.isPlaying = false;
  if (state.captureRect) clearCaptureArea(source.tabId ?? null);
  broadcastState();
  saveOptions();
}

function handleMessage(message, sender, sendResponse) {
  if (message.command === 'getState') {
    sendResponse(state);
  } else if (message.command === 'toggleRecording') {
    state.isRecording = !state.isRecording;
    if (state.isRecording) {
      lastActionTime = Date.now();
    } else if (!state.activeRecordingName && state.actions.length > 0) {
      // Auto-save a freshly recorded macro and select it
      const name = generateRecordingName();
      state.savedRecordings[name] = state.actions;
      state.activeRecordingName = name;
      chrome.storage.local.set({ savedRecordings: state.savedRecordings });
    }

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        const target = { tabId: tabs[0].id };
        
        if (state.isRecording) {
          chrome.debugger.attach(target, '1.3').catch(() => {});
        }

        chrome.tabs.sendMessage(tabs[0].id, {
          command: 'setRecordingState',
          isRecording: state.isRecording
        }).catch(() => {});
        
        if (state.isRecording) {
            chrome.scripting.executeScript({
                target: target,
                files: ['content.js']
            }).catch(() => {});
        }
      }
    });
    
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'startSelectingArea') {
    state.isSelectingArea = true;
    // Applied only once the area is drawn, so cancelling keeps the old one
    pendingCaptureRatio = message.ratio || 'free';
    broadcastState();

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        const target = { tabId: tabs[0].id };
        // Attach debugger so ratio is correct
        chrome.debugger.attach(target, '1.3').catch(() => {});

        chrome.scripting.executeScript({
            target: target,
            files: ['content.js']
        }).then(() => {
          chrome.tabs.sendMessage(tabs[0].id, { command: 'startSelectingArea', ratio: message.ratio }).catch(() => {});
        }).catch(() => {
          // Pages extensions can't script (chrome://, Web Store): don't stay stuck selecting
          state.isSelectingArea = false;
          broadcastState();
        });
      }
    });
    sendResponse(state);
  } else if (message.command === 'areaSelected') {
    state.isSelectingArea = false;
    state.captureRect = message.rect;
    state.captureRatio = pendingCaptureRatio;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'areaUpdated') {
    // Area moved or resized on the page; keeps its ratio
    state.captureRect = message.rect;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'areaSelectionCancelled') {
    state.isSelectingArea = false;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'clearArea') {
    // From the popup's Full button, or the area's own close button
    clearCaptureArea(sender && sender.tab ? sender.tab.id : null);
    sendResponse(state);
  } else if (message.command === 'clearActions') {
    state.actions = [];
    state.activeRecordingName = '';

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.debugger.detach({tabId: tabs[0].id}).catch(() => {});
      }
    });

    broadcastState();
    sendResponse(state);
  } else if (message.command === 'recordAction') {
    if (state.isRecording) {
      const now = Date.now();
      const delay = now - lastActionTime;
      lastActionTime = now;
      
      state.actions.push({
        ...message.action,
        delay: delay
      });
      broadcastState();
    }
    sendResponse({success: true});
  } else if (message.command === 'startPlayback') {
    if (!state.isPlaying) {
      if (!state.macroEnabled || state.actions.length === 0) {
        takeSingleCapture(message.prefix);
      } else {
        startPlayback(message.prefix);
      }
    }
    sendResponse(state);
  } else if (message.command === 'stopPlayback') {
    // The area stays shown: it is still the active capture area
    state.isPlaying = false;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'updatePrefix') {
    state.prefix = message.prefix;
    sendResponse(state);
  } else if (message.command === 'updateCaptureFirst') {
    state.captureFirst = message.captureFirst;
    sendResponse(state);
  } else if (message.command === 'updateCreatePdf') {
    state.createPdf = message.createPdf;
    sendResponse(state);
  } else if (message.command === 'updateOption') {
    if (['skipDuplicates', 'autoStopUnchanged', 'maxCaptures', 'maxStripTiles', 'longCapture', 'hiRes', 'zoomMultiplier'].includes(message.key)) {
      state[message.key] = message.value;
    }
    sendResponse(state);
  } else if (message.command === 'updateMacroEnabled') {
    state.macroEnabled = message.macroEnabled;
    sendResponse(state);
  } else if (message.command === 'loadRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      state.actions = state.savedRecordings[message.name];
      state.activeRecordingName = message.name;
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'deleteRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      delete state.savedRecordings[message.name];
      if (state.activeRecordingName === message.name) {
        state.activeRecordingName = '';
      }
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'renameRecording') {
    const oldName = message.oldName;
    const newName = message.newName && message.newName.trim();
    const oldExists = oldName && state.savedRecordings[oldName];
    const newIsFree = newName && (newName === oldName || !state.savedRecordings[newName]);
    if (oldExists && newIsFree && newName !== oldName) {
      state.savedRecordings[newName] = state.savedRecordings[oldName];
      delete state.savedRecordings[oldName];
      if (state.activeRecordingName === oldName) {
        state.activeRecordingName = newName;
      }
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  }
}

async function performCapture(tabs, tabId, prefix) {
  // Ask before the tab is closed/reloaded/navigated mid-capture. Only during
  // the capture itself, so a macro that clicks a link still navigates freely.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { command: 'setLeaveGuard', enable: true }).catch(() => {});
  let images;
  let streamed = null;
  try {
    if (state.longCapture) {
      // A Long capture saves its parts as they're finished, unless it may
      // still turn out to be a duplicate of the previous capture
      if (!(state.skipDuplicates && lastSignature !== null)) streamed = new StreamedCapture(prefix);
      images = await captureScrollStrip(tabs, tabId, state.hiRes, streamed);
    } else if (state.hiRes) {
      images = await captureHiRes(tabs, tabId);
    } else {
      images = await captureScreenshot(tabs, tabId);
    }
  } catch (err) {
    if (streamed) streamed.fail();
    throw err;
  } finally {
    await chrome.tabs.sendMessage(tabId, { command: 'setLeaveGuard', enable: false }).catch(() => {});
  }
  if (streamed) {
    streamed.finish();
  } else if (images && images.length > 0) {
    await recordCapture(images, prefix);
  }
}

// ── Saving, duplicates & counters ─────────────────────────────────────
// Every mode returns its images ([{ dataUrl, suffix }], several only for a
// Long capture split into parts). Each capture is compared with the previous
// one on a downscaled copy: any visible change (even a page number) counts as
// changed, while sub-pixel noise like a blinking caret averages away.
const SIGNATURE_WIDTH = 512;           // px width of the comparison thumbnail
const SIGNATURE_MAX_PIXELS = 4000000;  // cap for very long strips
const SIGNATURE_CHANNEL_DIFF = 32;     // per-channel difference that counts as a changed pixel
const SIGNATURE_MAX_CHANGED = 2;       // changed pixels tolerated as noise
const UNCHANGED_STOP_COUNT = 2;        // unchanged captures in a row before auto-stop

let lastSignature = null;
let unchangedStreak = 0;

function resetRunCounters() {
  captureCount = 0;
  state.runSaved = 0;
  state.runSkipped = 0;
  lastSignature = null;
  unchangedStreak = 0;
}

async function recordCapture(images, prefix) {
  if (comparesCaptures()) {
    const unchanged = compareWithPrevious(await captureSignature(images));
    if (unchanged && state.skipDuplicates) {
      state.runSkipped++;
      broadcastState();
      return;
    }
  }

  const number = ++captureCount;
  for (const image of images) {
    await saveCapture(image.dataUrl, prefix, { number, suffix: image.suffix || '' });
  }
  state.runSaved = captureCount;
  broadcastState();
}

// A Long capture saved part by part as the strip is built, so finished parts
// don't wait in memory. It can't be skipped as a duplicate (its first parts
// are saved before the rest exists), but is still compared for auto-stop.
class StreamedCapture {
  constructor(prefix) {
    this.prefix = prefix;
    this.number = 0;  // reserved when the first part is saved
    this.signature = [];
  }

  async add(image) {
    if (!this.number) this.number = ++captureCount;
    if (comparesCaptures()) this.signature.push(await imageSignature(image.dataUrl));
    await saveCapture(image.dataUrl, this.prefix, { number: this.number, suffix: image.suffix });
    state.runSaved = captureCount;
    broadcastState();
  }

  finish() {
    if (this.number && comparesCaptures()) compareWithPrevious(this.signature);
  }

  // Parts already saved stay; the next capture has nothing whole to compare with
  fail() {
    lastSignature = null;
    unchangedStreak = 0;
  }
}

function comparesCaptures() {
  return state.skipDuplicates || state.autoStopUnchanged;
}

// Records the capture's signature and returns whether it matches the previous one
function compareWithPrevious(signature) {
  const unchanged = lastSignature !== null && signaturesMatch(signature, lastSignature);
  lastSignature = signature;
  unchangedStreak = unchanged ? unchangedStreak + 1 : 0;
  return unchanged;
}

async function captureSignature(images) {
  const signature = [];
  for (const { dataUrl } of images) signature.push(await imageSignature(dataUrl));
  return signature;
}

async function imageSignature(dataUrl) {
  const bitmap = await dataUrlToBitmap(dataUrl);
  const scale = Math.min(1, SIGNATURE_WIDTH / bitmap.width,
    Math.sqrt(SIGNATURE_MAX_PIXELS / (bitmap.width * bitmap.height)));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

function signaturesMatch(a, b) {
  if (a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].w !== b[i].w || a[i].h !== b[i].h) return false;
    const da = a[i].data;
    const db = b[i].data;
    for (let p = 0; p < da.length; p += 4) {
      if (Math.abs(da[p] - db[p]) > SIGNATURE_CHANNEL_DIFF ||
          Math.abs(da[p + 1] - db[p + 1]) > SIGNATURE_CHANNEL_DIFF ||
          Math.abs(da[p + 2] - db[p + 2]) > SIGNATURE_CHANNEL_DIFF) {
        if (++changed > SIGNATURE_MAX_CHANGED) return false;
      }
    }
  }
  return true;
}

// Ends a macro run when it has nothing left to capture. Returns true if stopped.
function checkAutoStop() {
  let reason = null;
  if (state.autoStopUnchanged && unchangedStreak >= UNCHANGED_STOP_COUNT) {
    reason = 'unchanged';
  } else if (state.maxCaptures > 0 && captureCount >= state.maxCaptures) {
    reason = 'max';
  }
  if (!reason) return false;
  state.isPlaying = false;
  showFinishedNotification(reason);
  return true;
}

async function getStrings() {
  const { settings } = await chrome.storage.local.get('settings');
  return I18N[(settings && settings.language) || 'en'] || I18N.en;
}

async function showFinishedNotification(reason) {
  const strings = await getStrings();
  const message = (reason === 'max' ? strings.finishedMax : strings.finishedUnchanged)
    .replace('{n}', state.runSaved);
  chrome.notifications.create('capture-finished', {
    type: 'basic',
    iconUrl: DEFAULT_ICON[128],
    title: strings.finishedNotifyTitle,
    message
  }).catch(() => {});
}

// Hover text of the toolbar icon, e.g. "Cheezing: 12 saved · 2 skipped"
async function updateActionTitle() {
  const strings = await getStrings();
  let title = strings.appTitle;
  if (state.isPlaying) {
    title += ': ' + strings.countSaved.replace('{n}', state.runSaved);
    if (state.runSkipped > 0) title += ' · ' + strings.countSkipped.replace('{n}', state.runSkipped);
  }
  chrome.action.setTitle({ title }).catch(() => {});
}

// ── Page settle ────────────────────────────────────────────────────────
// After macro actions, capture only once the page has finished reacting:
// tab loaded, no network requests in flight, no DOM changes, and images and
// fonts in view loaded -- each quiet for SETTLE_QUIET ms. Network activity is
// observed through the debugger session macro playback already holds.
const SETTLE_MIN_DELAY = 300;   // let click handlers start their work first
const SETTLE_QUIET = 500;       // ms every signal must stay quiet
const SETTLE_TIMEOUT = 5000;    // give up and capture anyway (e.g. live tickers)
const SETTLE_POLL_INTERVAL = 150;
const LONG_REQUEST_MS = 5000;   // ignore long-polls/streams older than this

const inflightRequests = new Map(); // requestId -> start time, for the playback tab
let lastNetworkActivity = 0;
let networkTabId = null;

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== networkTabId) return;
  if (method === 'Network.requestWillBeSent') {
    if (params.type === 'EventSource' || params.type === 'WebSocket') return;
    inflightRequests.set(params.requestId, Date.now());
    lastNetworkActivity = Date.now();
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    if (inflightRequests.delete(params.requestId)) lastNetworkActivity = Date.now();
  }
});

async function startNetworkTracking(target) {
  inflightRequests.clear();
  lastNetworkActivity = 0;
  networkTabId = target.tabId;
  await chrome.debugger.sendCommand(target, 'Network.enable').catch(() => { networkTabId = null; });
}

function msSinceNetworkActivity() {
  const now = Date.now();
  for (const [id, startedAt] of inflightRequests) {
    if (now - startedAt > LONG_REQUEST_MS) inflightRequests.delete(id);
    else return 0;
  }
  return now - lastNetworkActivity;
}

async function waitForPageSettle(tabId) {
  const start = Date.now();
  await sleep(SETTLE_MIN_DELAY);
  while (state.isPlaying && Date.now() - start < SETTLE_TIMEOUT) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') {
      // Re-injected in case the macro navigated to a new page
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
      const activity = await chrome.tabs.sendMessage(tabId, { command: 'getPageActivity' }).catch(() => null);
      if (activity &&
          activity.msSinceMutation >= SETTLE_QUIET &&
          activity.pendingImages === 0 &&
          !activity.fontsLoading &&
          msSinceNetworkActivity() >= SETTLE_QUIET) {
        return;
      }
    }
    await sleep(SETTLE_POLL_INTERVAL);
  }
}

// ── Capture pause ──────────────────────────────────────────────────────
// Screenshots need the tab to be the visible tab of a non-minimized window:
// captureVisibleTab grabs whichever tab is showing, and hidden tabs may stop
// painting. Extensions can't intercept a tab switch or minimize, so before
// each screenshot we check, and pause until the tab is back in view.
const PAUSED_NOTIFICATION_ID = 'capture-paused';
const PAUSE_POLL_INTERVAL = 500;
const RESUME_SETTLE_DELAY = 400; // ms for the tab to repaint after coming back
let pausedTabId = null;

async function isTabCapturable(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    state.isPlaying = false; // the captured tab was closed -- end the run
    throw new Error('Capture stopped: the tab was closed.');
  }
  const win = await chrome.windows.get(tab.windowId);
  return tab.active && win.state !== 'minimized';
}

// Returns false right away if the tab is capturable, or true once it is
// again after a pause (callers then redo anything the user may have changed,
// like the scroll position). Throws if stopped or the tab closes meanwhile.
async function waitUntilCapturable(tabId) {
  if (await isTabCapturable(tabId)) return false;

  pausedTabId = tabId;
  state.isPaused = true;
  broadcastState();
  showPausedNotification();
  try {
    while (!(await isTabCapturable(tabId))) {
      if (!state.isPlaying) throw new Error('Capture stopped while paused.');
      await sleep(PAUSE_POLL_INTERVAL);
    }
  } finally {
    pausedTabId = null;
    state.isPaused = false;
    broadcastState();
    chrome.notifications.clear(PAUSED_NOTIFICATION_ID).catch(() => {});
  }
  await sleep(RESUME_SETTLE_DELAY);
  return true;
}

async function showPausedNotification() {
  const { settings } = await chrome.storage.local.get('settings');
  const strings = I18N[(settings && settings.language) || 'en'] || I18N.en;
  chrome.notifications.create(PAUSED_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: DEFAULT_ICON[128],
    title: strings.pausedNotifyTitle,
    message: strings.pausedNotifyMessage,
    priority: 2
  }).catch(() => {});
}

// Clicking the notification brings the captured tab back into view
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== PAUSED_NOTIFICATION_ID || pausedTabId === null) return;
  const tab = await chrome.tabs.get(pausedTabId).catch(() => null);
  if (!tab) return;
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
});

async function captureScreenshot(tabs, tabId) {
  // Hide rectangle before capturing
  if (state.captureRect) {
    await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});
    await sleep(100); // small buffer for DOM update
  }

  await waitUntilCapturable(tabId);
  let dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {format: 'png'});

  // Show rectangle again
  if (state.captureRect) {
    await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    dataUrl = await cropImage(dataUrl, state.captureRect);
  }

  return [{ dataUrl }];
}

// Rate-limited captureVisibleTab: multi-tile modes fire many captures in a
// row and Chrome rejects anything faster than 2/sec.
let lastCaptureAt = 0;
async function captureTab(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const rateLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err && err.message));
      if (!rateLimited || attempt >= 3) throw err;
    }
  }
}

// ── Scroll Strip Capture ───────────────────────────────────────────────
// Scrolls the page (or the scrollable panel under the selected area) one
// region-height at a time and stitches every step into one continuous image.
// Each step crops from the position the scroller actually reached, so the
// last step (which can't scroll a full height) contributes only new rows.
// With `streamed`, each finished part is handed to it as soon as it's done
// and the returned list is empty.
async function captureScrollStrip(tabs, tabId, hiRes, streamed) {
  const windowId = tabs[0].windowId;

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});

  // With Hi-Res, each step is re-rendered at N× instead of screenshotted.
  // Started before measuring, since attaching can resize the page.
  const hiResSession = hiRes ? await beginHiRes(tabId) : null;
  const multiplier = state.zoomMultiplier || DEFAULT_ZOOM_MULTIPLIER;

  const plan = await chrome.tabs.sendMessage(tabId, { command: 'beginScrollStrip', rect: state.captureRect });
  const region = plan.region;
  // Steps overlap by 1 CSS px: at fractional zoom/DPR the scroll position
  // snaps to device pixels and can land slightly short of the target, and the
  // overlap guarantees no gap. Duplicate rows are cropped below.
  const step = Math.floor(region.height) - 1;
  if (step < 1 || region.width < 1) {
    if (hiResSession) await endHiRes(hiResSession);
    throw new Error('Scroll capture aborted: the capture area is empty.');
  }

  let writer = null;

  try {
    let target = 0;
    let writtenPx = 0; // strip rows saved so far; strip row 0 = scroll position 0
    // Step limit per capture: a safety stop for infinite feeds that keep growing
    const maxSteps = state.maxStripTiles > 0 ? state.maxStripTiles : Infinity;
    for (let i = 0; i < maxSteps && state.isPlaying; i++) {
      let actual, maxScroll;
      do {
        // Redone after a pause, in case the page was scrolled meanwhile
        ({ actual, maxScroll } = await chrome.tabs.sendMessage(tabId, { command: 'scrollStripTo', y: target }));
        if (i > 0) {
          // Fixed headers/footers/floating buttons would otherwise repeat on every step
          await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyElements', enable: true }).catch(() => {});
        }
        await sleep(SCROLL_SETTLE_DELAY);
      } while (await waitUntilCapturable(tabId));

      // `source` holds the step's pixels; `origin*` is where the region starts
      // in it and `scale` its output px per CSS px.
      let source, scale, originX, originY, regionW, regionH;
      if (hiResSession) {
        const rendered = await renderHiRes(hiResSession, region, multiplier);
        source = rendered.canvas;
        scale = rendered.pxPerCss;
        originX = 0;
        originY = 0;
        regionW = source.width;
        regionH = source.height;
      } else {
        source = await dataUrlToBitmap(await captureTab(windowId));
        // devicePixelRatio is exact (includes page zoom); innerWidth is rounded
        // to whole CSS px, so only fall back to the measured ratio if the
        // capture doesn't match the reported DPR.
        const measured = source.width / plan.innerWidth;
        scale = Math.abs(measured - plan.devicePixelRatio) * plan.innerWidth <= 2
          ? plan.devicePixelRatio
          : measured;
        originX = Math.round(region.x * scale);
        originY = Math.round(region.y * scale);
        regionW = Math.round(region.width * scale);
        regionH = Math.floor(region.height * scale);
      }

      // Work in absolute pixel rows: this step shows strip rows
      // [tileTop, tileTop + regionH). Keep only rows not yet written.
      const tileTop = Math.round(actual * scale);
      const from = Math.max(writtenPx, tileTop);
      const sx = originX;
      const sy = originY + (from - tileTop);
      const sw = regionW;
      const sh = Math.min(tileTop + regionH - from, source.height - sy);
      const isLast = actual >= maxScroll - 0.5;
      if (sh > 0) {
        if (!writer) writer = new StripWriter(sw, streamed ? (image) => streamed.add(image) : null);
        const remaining = Math.round(maxScroll * scale) + regionH - from;
        await writer.add(source, sx, sy, sh, remaining);
        writtenPx = from + sh;
      }

      if (isLast || actual + 0.5 < target - step) break; // reached the end / scroller stuck
      target += step;
    }

    if (writer) {
      await writer.finish();
      return writer.images;
    }
    return [];
  } finally {
    await chrome.tabs.sendMessage(tabId, { command: 'endScrollStrip' }).catch(() => {});
    if (hiResSession) await endHiRes(hiResSession);
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    }
  }
}

// Draws strip tiles straight into a canvas as they arrive. When the strip
// outgrows canvas limits it is split into consecutive _partN images that line
// up edge to edge with no overlap.
class StripWriter {
  constructor(width, onPart) {
    this.width = width;
    this.onPart = onPart; // receives each part when set, instead of keeping it in `images`
    this.images = [];
    this.parts = 0;
    this.canvas = null;
    this.ctx = null;
    this.y = 0;
    this.partLimit = Math.max(1, Math.min(MAX_STRIP_HEIGHT, Math.floor(MAX_STRIP_AREA / width)));
  }

  async add(bitmap, sx, sy, sh, remainingEstimate) {
    if (this.canvas && this.y + sh > this.canvas.height) {
      await this.flush(false);
    }
    if (!this.canvas) {
      // Size to the expected remaining height plus one tile of slack for
      // rounding; flush() trims any excess, and a new part starts only if the
      // page genuinely grows past it (lazy loading).
      const height = Math.min(this.partLimit, remainingEstimate + sh);
      this.canvas = new OffscreenCanvas(this.width, height);
      this.ctx = this.canvas.getContext('2d');
      this.y = 0;
    }
    this.ctx.drawImage(bitmap, sx, sy, this.width, sh, 0, this.y, this.width, sh);
    this.y += sh;
  }

  async flush(isFinal) {
    if (!this.canvas || this.y === 0) return;
    let out = this.canvas;
    if (this.y < out.height) {
      out = new OffscreenCanvas(this.width, this.y);
      out.getContext('2d').drawImage(this.canvas, 0, 0);
    }
    const dataUrl = await blobToDataUrl(await out.convertToBlob({ type: 'image/png' }));
    const suffix = isFinal && this.parts === 0 ? '' : `_part${++this.parts}`;
    this.canvas = null;
    this.ctx = null;
    this.y = 0;
    if (this.onPart) {
      await this.onPart({ dataUrl, suffix });
    } else {
      this.images.push({ dataUrl, suffix });
    }
  }

  async finish() {
    await this.flush(true);
  }
}

// ── Hi-Res rendering ───────────────────────────────────────────────────
// Re-renders part of the visible page at N× resolution through the DevTools
// protocol. Unlike page zoom this never changes the layout, window size or
// what the user sees -- the renderer simply rasterizes the clip at a higher
// scale. Large outputs are rendered tile by tile and stitched, since the
// renderer has its own per-screenshot size limits. Used on its own (Hi-Res)
// and for each step of a Long capture with Hi-Res on.

// Attaches the debugger if needed. A fresh attach slides in Chrome's "is
// debugging this browser" bar, which shrinks the page: the layout is pinned
// to its pre-attach size so captures cover exactly what a normal capture
// would (incl. fixed footers), then given time to repaint -- earlier
// screenshots return stale tiles.
async function beginHiRes(tabId) {
  const session = { target: { tabId }, attachedHere: false, overridden: false };
  const tabBefore = await chrome.tabs.get(tabId);
  try {
    await chrome.debugger.attach(session.target, '1.3');
    session.attachedHere = true;
  } catch (err) {
    // Already attached (macro playback / area selection) -- reuse that session
  }
  if (session.attachedHere) {
    // tab width/height are unzoomed px, which is what the override expects
    await chrome.debugger.sendCommand(session.target, 'Emulation.setDeviceMetricsOverride', {
      width: tabBefore.width,
      height: tabBefore.height,
      deviceScaleFactor: 0,
      mobile: false
    });
    session.overridden = true;
    await sleep(ZOOM_ATTACH_SETTLE_DELAY);
  }
  return session;
}

async function endHiRes(session) {
  if (session.overridden) {
    await chrome.debugger.sendCommand(session.target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  if (session.attachedHere) {
    await chrome.debugger.detach(session.target).catch(() => {});
  }
}

// Renders a viewport-relative CSS rect (null = whole viewport) at
// `multiplier`× the normal capture resolution. Returns the canvas and its
// output px per CSS px.
async function renderHiRes(session, cssRect, multiplier) {
  const metrics = await chrome.debugger.sendCommand(session.target, 'Page.getLayoutMetrics');
  const vv = metrics.cssVisualViewport;
  // Screenshot clips are measured in zoomed px (CSS px x browser zoom), and
  // each clip unit becomes `deviceScale` output px at clip.scale = 1.
  const zoom = vv.zoom || 1;
  const deviceScale = (metrics.visualViewport && metrics.visualViewport.clientWidth / (vv.clientWidth * zoom)) || 1;

  // clientWidth/Height exclude scrollbars
  const viewportRegion = { x: 0, y: 0, width: vv.clientWidth, height: vv.clientHeight };
  const cssRegion = cssRect ? intersectRect(viewportRegion, cssRect) : viewportRegion;
  if (cssRegion.width < 1 || cssRegion.height < 1) {
    throw new Error('Hi-Res capture aborted: the capture area is empty.');
  }
  const region = {
    x: (vv.pageX + cssRegion.x) * zoom,
    y: (vv.pageY + cssRegion.y) * zoom,
    width: cssRegion.width * zoom,
    height: cssRegion.height * zoom
  };

  // Capped so the stitched image stays within canvas limits
  const maxScale = Math.min(
    MAX_ZOOM_DIM / region.width,
    MAX_ZOOM_DIM / region.height,
    Math.sqrt(MAX_ZOOM_AREA / (region.width * region.height))
  ) / deviceScale;
  if (multiplier > maxScale) {
    console.warn(`Cheezing: Hi-Res ${multiplier}x exceeds canvas limits for this area, using ${maxScale.toFixed(2)}x`);
    multiplier = Math.max(1, maxScale);
  }
  const scale = multiplier * deviceScale; // output px per clip unit
  const canvas = new OffscreenCanvas(Math.round(region.width * scale), Math.round(region.height * scale));
  const ctx = canvas.getContext('2d');

  // Tile in clip units, placed by rounding absolute positions so tiles meet exactly
  const tileSize = Math.max(1, Math.floor(ZOOM_TILE_PX / scale));
  for (let ty = 0; ty < region.height; ty += tileSize) {
    const th = Math.min(tileSize, region.height - ty);
    for (let tx = 0; tx < region.width; tx += tileSize) {
      const tw = Math.min(tileSize, region.width - tx);
      const shot = await chrome.debugger.sendCommand(session.target, 'Page.captureScreenshot', {
        format: 'png',
        // clip is in document coordinates (region already includes the scroll offset)
        clip: { x: region.x + tx, y: region.y + ty, width: tw, height: th, scale: multiplier }
      });
      const bitmap = await dataUrlToBitmap('data:image/png;base64,' + shot.data);
      const dx = Math.round(tx * scale);
      const dy = Math.round(ty * scale);
      const dw = Math.round((tx + tw) * scale) - dx;
      const dh = Math.round((ty + th) * scale) - dy;
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
    }
  }
  return { canvas, pxPerCss: scale * zoom };
}

async function captureHiRes(tabs, tabId) {
  const session = await beginHiRes(tabId);
  try {
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});
      await sleep(100);
    }
    await waitUntilCapturable(tabId);
    const { canvas } = await renderHiRes(session, state.captureRect, state.zoomMultiplier || DEFAULT_ZOOM_MULTIPLIER);
    const dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
    return [{ dataUrl }];
  } finally {
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    }
    await endHiRes(session);
  }
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

async function saveCapture(dataUrl, prefix, { number, suffix = '' }) {
  const numbered = number.toString().padStart(3, '0');
  const filename = `${prefix ? `${prefix}_` : ''}${numbered}${suffix}.png`;
  const filePath = currentSubfolder ? `${currentSubfolder}/${filename}` : filename;

  await chrome.downloads.download({
    url: dataUrl,
    filename: filePath,
    saveAs: false
  });

  if (state.createPdf) {
    const { width, height } = await getImageDimensions(dataUrl);
    const blob = await (await fetch(dataUrl)).blob();
    await pdfStore.addPage({ blob, width, height });
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dataUrlToBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

async function blobToDataUrl(blob) {
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  return new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
  });
}

async function cropImage(dataUrl, rect) {
  const bitmap = await dataUrlToBitmap(dataUrl);

  const dpr = rect.devicePixelRatio || 1;
  const targetX = Math.round(rect.x * dpr);
  const targetY = Math.round(rect.y * dpr);
  const targetWidth = Math.round(rect.width * dpr);
  const targetHeight = Math.round(rect.height * dpr);

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(bitmap,
    targetX, targetY, targetWidth, targetHeight,
    0, 0, targetWidth, targetHeight
  );

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(croppedBlob);
}

async function takeSingleCapture(prefix) {
  state.isPlaying = true;
  broadcastState();

  currentSubfolder = await getNextRunSubfolder();
  await pdfStore.clearPages().catch(() => {});

  // No prefix: files are just numbered, the dated run subfolder already says when
  sessionPrefix = prefix || '';
  state.prefix = sessionPrefix;

  const tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (tabs.length > 0) {
    resetRunCounters();
    try {
      await performCapture(tabs, tabs[0].id, sessionPrefix);
    } catch (err) {
      console.error('Cheezing: capture failed:', err);
    }
  }

  await endPlayback();
}

async function startPlayback(prefix) {
  state.isPlaying = true;
  state.isRecording = false; // Ensure recording is off
  
  currentSubfolder = await getNextRunSubfolder();
  await pdfStore.clearPages().catch(() => {});

  // No prefix: files are just numbered, the dated run subfolder already says when
  sessionPrefix = prefix || '';
  state.prefix = sessionPrefix;
  
  broadcastState();

  const tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (tabs.length === 0) {
    endPlayback();
    return;
  }
  
  const tabId = tabs[0].id;
  const target = { tabId: tabId };

  try {
    await chrome.debugger.attach(target, '1.3');
    // Let the "is debugging this browser" bar finish resizing the page so the
    // first capture matches the size of the ones that follow
    await sleep(ZOOM_ATTACH_SETTLE_DELAY);
  } catch (err) {
    console.log('Debugger attach skipped/failed (likely already attached):', err);
  }
  await startNetworkTracking(target);
  // Macro clicks must reach the page, not the area box's grips
  await chrome.tabs.sendMessage(tabId, { command: 'setRectLocked', locked: true }).catch(() => {});

  resetRunCounters();
  broadcastState();

  let actionsRan = false;
  while (state.isPlaying) {
    // Capture BEFORE all actions
    if (state.captureFirst) {
      if (actionsRan) await waitForPageSettle(tabId);
      if (!state.isPlaying) break;
      try {
        await performCapture(tabs, tabId, sessionPrefix);
      } catch (err) {
        console.error('Cheezing: capture failed:', err);
      }
      if (checkAutoStop()) break;
    }

    for (let i = 0; i < state.actions.length; i++) {
      if (!state.isPlaying) break;
      const action = state.actions[i];

      await sleep(action.delay);
      if (!state.isPlaying) break;

      if (action.type === 'click') {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: action.x,
          y: action.y,
          button: 'left',
          clickCount: 1
        }).catch(() => {});

        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: action.x,
          y: action.y,
          button: 'left',
          clickCount: 1
        }).catch(() => {});
      } else if (action.type === 'keydown') {
        await dispatchKeyAction(target, action);
      }
    }

    if (!state.isPlaying) break;
    actionsRan = state.actions.length > 0;

    // Capture AFTER all actions, once the page has settled
    if (!state.captureFirst) {
      await waitForPageSettle(tabId);
      if (!state.isPlaying) break;
      try {
        await performCapture(tabs, tabId, sessionPrefix);
      } catch (err) {
        console.error('Cheezing: capture failed:', err);
      }
      if (checkAutoStop()) break;
    }
  }

  networkTabId = null;
  await chrome.tabs.sendMessage(tabId, { command: 'setRectLocked', locked: false }).catch(() => {});
  await chrome.debugger.detach(target).catch(() => {});
  await endPlayback();
}

async function dispatchKeyAction(target, action) {
  const modifiers = action.modifiers || 0;
  const isCtrlOrCmd = (modifiers & 2) !== 0 || (modifiers & 4) !== 0;
  const isPrintable = action.key && action.key.length === 1 && !isCtrlOrCmd;

  if (isPrintable) {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: modifiers,
      text: action.key,
      unmodifiedText: action.key,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'char',
      modifiers: modifiers,
      text: action.key,
      unmodifiedText: action.key,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

  } else if (action.key === 'Enter') {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: modifiers,
      text: '\r',
      unmodifiedText: '\r',
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'char',
      modifiers: modifiers,
      text: '\r',
      unmodifiedText: '\r',
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

  } else {
    // Non-printable or shortcut key (e.g. Backspace, Tab, Arrows, Esc, or Ctrl+A/Ctrl+C)
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});
  }
}

async function endPlayback() {
  state.isPlaying = false;
  broadcastState();

  try {
    if (state.createPdf) {
      const keys = await pdfStore.pageKeys();
      if (keys.length > 0) await generateAndDownloadPdf(keys, sessionPrefix, currentSubfolder);
    }
  } catch (err) {
    console.error('PDF generation failed:', err);
  } finally {
    await pdfStore.clearPages().catch(() => {});
  }
}

async function getImageDimensions(dataUrl) {
  // Extract dimensions from PNG header (fast, no canvas needed)
  // PNG: 8-byte sig + 4-byte len + "IHDR" + 4-byte W + 4-byte H
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64.substring(0, 64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // IHDR starts at offset 12 (after 8 sig + 4 len + 4 type)
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { width: width >>> 0, height: height >>> 0 };
}

// ── PDF ────────────────────────────────────────────────────────────────
// The run's images are kept in IndexedDB as they're saved (see pdf-store.js)
// and written into the PDF one page at a time, so neither the images nor the
// PDF ever sit in memory as a whole. Each page holds its image losslessly:
// the exact pixels, deflate-compressed like the PNG itself.
async function generateAndDownloadPdf(pageKeys, prefix, subfolder) {
  const parts = [];   // Blob parts: text, and each image's compressed data
  const offsets = []; // byte offset of each object, by object number
  let offset = 0;
  const encoder = new TextEncoder();
  const write = (part) => {
    if (typeof part === 'string') part = encoder.encode(part);
    parts.push(part);
    offset += part instanceof Blob ? part.size : part.byteLength;
  };
  const beginObject = (n) => {
    offsets[n] = offset;
    write(`${n} 0 obj\n`);
  };

  // Objects 1 and 2 are the catalog and page tree (written last, once every
  // page is known); each page then takes three: image, drawing, page.
  write(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4, binary marker
  const pageRefs = [];
  for (const [i, key] of pageKeys.entries()) {
    const page = await pdfStore.getPage(key);
    if (!page) continue;
    const image = await deflateImagePixels(page.blob);
    const imageObj = 3 + i * 3;
    const contentObj = imageObj + 1;
    const pageObj = imageObj + 2;

    beginObject(imageObj);
    write(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.size} >>\nstream\n`);
    write(image.data);
    write('\nendstream\nendobj\n');

    // A page exactly the size of the image (1pt = 1px), scaled down only when
    // a long strip exceeds the PDF page size limit -- the pixels stay as they are
    const fit = Math.min(1, PDF_MAX_PAGE_DIM / Math.max(image.width, image.height));
    const width = pdfNumber(image.width * fit);
    const height = pdfNumber(image.height * fit);
    const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    beginObject(contentObj);
    write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    beginObject(pageObj);
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    pageRefs.push(`${pageObj} 0 R`);
  }
  if (pageRefs.length === 0) return;

  beginObject(1);
  write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObject(2);
  write(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>\nendobj\n`);

  const xrefOffset = offset;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < offsets.length; n++) {
    // Skipped (missing) pages leave unused numbers, listed as free
    xref += offsets[n] === undefined
      ? '0000000000 65535 f \n'
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  write(xref);
  write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const filename = `${prefix || subfolder || 'capture'}.pdf`;
  await downloadPdf(new Blob(parts, { type: 'application/pdf' }), subfolder ? `${subfolder}/${filename}` : filename);
}

function pdfNumber(n) {
  return String(Math.round(n * 1000) / 1000);
}

// The image's exact RGB pixels, deflate-compressed, converted a band of rows
// at a time so only the decoded image and one band are in memory.
// Screenshots are opaque; any transparency would show on white, as in a viewer.
async function deflateImagePixels(blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const bandHeight = Math.max(1, Math.min(height, Math.floor(PDF_BAND_PIXELS / width)));
  const ctx = new OffscreenCanvas(width, bandHeight).getContext('2d', { willReadFrequently: true });
  const compressor = new CompressionStream('deflate'); // zlib format, which PDF's FlateDecode expects
  const data = new Response(compressor.readable).blob();
  const writer = compressor.writable.getWriter();
  try {
    for (let y = 0; y < height; y += bandHeight) {
      const rows = Math.min(bandHeight, height - y);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, rows);
      ctx.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
      const rgba = ctx.getImageData(0, 0, width, rows).data;
      const rgb = new Uint8Array(width * rows * 3);
      for (let s = 0, d = 0; s < rgba.length; s += 4, d += 3) {
        rgb[d] = rgba[s];
        rgb[d + 1] = rgba[s + 1];
        rgb[d + 2] = rgba[s + 2];
      }
      await writer.write(rgb);
    }
    await writer.close();
  } finally {
    bitmap.close();
  }
  return { width, height, data: await data };
}

// The service worker can't make a blob: URL, so the offscreen page does,
// reading the PDF from IndexedDB. It stays open until the file is saved.
async function downloadPdf(blob, filePath) {
  await pdfStore.setOutput(blob);
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Download the PDF built from the captures'
      });
    }
    const { url } = await chrome.runtime.sendMessage({ command: 'getPdfUrl' });
    if (!url) throw new Error('the offscreen page could not read the PDF');
    const downloadId = await chrome.downloads.download({ url, filename: filePath, saveAs: false });
    await waitForDownload(downloadId);
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
    await pdfStore.clearOutput().catch(() => {});
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    const done = (s) => s === 'complete' || s === 'interrupted';
    const onChanged = (delta) => {
      if (delta.id === downloadId && delta.state && done(delta.state.current)) finish();
    };
    const finish = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // It may have finished before the listener was added
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (!item || done(item.state)) finish();
    }, finish);
  });
}

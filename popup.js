let currentSettings = {
  language: 'en',
  theme: 'dark'
};

function t(key) {
  const lang = currentSettings.language || 'en';
  return (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || key;
}

document.addEventListener('DOMContentLoaded', () => {
  const btnRecord   = document.getElementById('btnRecord');
  const btnPlay     = document.getElementById('btnPlay');
  const areaBtns    = document.querySelectorAll('#areaRatioGroup .area-btn');
  const statusDisplay = document.getElementById('status');
  const actionCount = document.getElementById('actionCount');
  const areaStatus  = document.getElementById('areaStatus');
  const prefixInput = document.getElementById('prefixInput');
  const captureFirstCheckbox = document.getElementById('captureFirstCheckbox');
  const createPdfCheckbox    = document.getElementById('createPdfCheckbox');
  const skipDuplicatesCheckbox = document.getElementById('skipDuplicatesCheckbox');
  const autoStopCheckbox     = document.getElementById('autoStopCheckbox');
  const maxCapturesInput     = document.getElementById('maxCapturesInput');
  const maxStripTilesInput   = document.getElementById('maxStripTilesInput');
  const captureModeGroup     = document.getElementById('captureModeGroup');
  const modeStatus           = document.getElementById('modeStatus');
  const zoomMultiplierGroup  = document.getElementById('zoomMultiplierGroup');
  const btnSave     = document.getElementById('btnSave');
  const btnDelete   = document.getElementById('btnDelete');
  const btnRename   = document.getElementById('btnRename');
  const btnCancelRename = document.getElementById('btnCancelRename');
  const saveNameInput = document.getElementById('saveNameInput');
  const savedRecordingsSelect = document.getElementById('savedRecordingsSelect');
  const recordingsRow = document.getElementById('recordingsRow');

  const macroEnabledToggle = document.getElementById('macroEnabledToggle');
  const macroPanel  = document.getElementById('macroPanel');
  const macroToggleRow = document.getElementById('macroToggleRow');
  const macroBadge  = document.getElementById('macroBadge');
  const recordSection = document.getElementById('recordSection');
  const saveSection = document.getElementById('saveSection');

  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnBackToMain   = document.getElementById('btnBackToMain');
  const headerTitleMain = document.getElementById('headerTitleMain');
  const headerTitleSettings = document.getElementById('headerTitleSettings');
  const appVersion      = document.getElementById('appVersion');
  const mainView        = document.getElementById('mainView');
  const settingsView    = document.getElementById('settingsView');

  // Set version from manifest
  if (appVersion) {
    const version = chrome.runtime.getManifest()?.version || '1.0.0';
    appVersion.textContent = `Cheezing v${version}`;
  }

  let currentState = {};
  let isRenaming = false;

  // ── Apply Settings ────────────────────────────────────
  function applyLanguage(lang) {
    currentSettings.language = lang;
    chrome.storage.local.set({ settings: currentSettings });

    // Update static elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key && I18N[lang] && I18N[lang][key]) {
        el.textContent = I18N[lang][key];
      }
    });

    // Update inputs with data-i18n-placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key && I18N[lang] && I18N[lang][key]) {
        el.placeholder = I18N[lang][key];
      }
    });

    // Update elements with data-i18n-title
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key && I18N[lang] && I18N[lang][key]) {
        el.title = I18N[lang][key];
      }
    });

    // Update segmented buttons for language
    document.querySelectorAll('.segment-btn[data-lang]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    // Refresh dynamic UI elements
    if (currentState && Object.keys(currentState).length > 0) {
      updateUI(currentState);
    }
  }

  function applyTheme(theme) {
    currentSettings.theme = theme;
    chrome.storage.local.set({ settings: currentSettings });

    if (theme === 'light') {
      document.body.classList.add('theme-light');
    } else {
      document.body.classList.remove('theme-light');
    }

    // Update segmented buttons for theme
    document.querySelectorAll('.segment-btn[data-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

  // Load saved settings
  chrome.storage.local.get(['settings'], (result) => {
    if (result && result.settings) {
      if (result.settings.language) currentSettings.language = result.settings.language;
      if (result.settings.theme) currentSettings.theme = result.settings.theme;
    }
    applyTheme(currentSettings.theme);
    applyLanguage(currentSettings.language);
  });

  // Settings view navigation
  function setSettingsView(open) {
    if (open) {
      mainView.classList.remove('active');
      settingsView.classList.add('active');
      headerTitleMain.style.display = 'none';
      headerTitleSettings.style.display = 'flex';
      btnOpenSettings.style.display = 'none';
      btnBackToMain.style.display = 'flex';
    } else {
      settingsView.classList.remove('active');
      mainView.classList.add('active');
      headerTitleMain.style.display = 'flex';
      headerTitleSettings.style.display = 'none';
      btnOpenSettings.style.display = 'flex';
      btnBackToMain.style.display = 'none';
    }
  }

  btnOpenSettings.addEventListener('click', () => setSettingsView(true));
  btnBackToMain.addEventListener('click', () => setSettingsView(false));

  // Settings option listeners
  document.querySelectorAll('.segment-btn[data-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyLanguage(btn.dataset.lang);
    });
  });

  document.querySelectorAll('.segment-btn[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
    });
  });

  // ── Macro toggle ──────────────────────────────────────
  function setMacroOpen(open) {
    macroEnabledToggle.checked = open;
    macroPanel.classList.toggle('open', open);
    chrome.runtime.sendMessage({ command: 'updateMacroEnabled', macroEnabled: open }, (response) => {
      if (response) updateUI(response);
    });
  }

  // Fix: stop propagation from the toggle switch label so it doesn't double-fire
  macroToggleRow.addEventListener('click', (e) => {
    if (e.target.closest('.toggle-switch')) return; // native label handles the checkbox
    macroEnabledToggle.checked = !macroEnabledToggle.checked;
    setMacroOpen(macroEnabledToggle.checked);
  });

  macroEnabledToggle.addEventListener('change', () => {
    setMacroOpen(macroEnabledToggle.checked);
  });

  // ── Macro panel: show/hide sections ──────────────────
  function isNewRecordingSelected() {
    return !currentState.activeRecordingName;
  }

  // Run button doubles as Record/Stop Recording while macro is on and
  // a new (unsaved) recording is selected.
  function isRunButtonRecordMode() {
    return (currentState.macroEnabled || false) && isNewRecordingSelected();
  }

  function refreshMacroPanelSections() {
    const isNew = isNewRecordingSelected();

    // Record section (action counter) only visible in New mode.
    // The Record/Stop button itself lives on the main Run button instead.
    recordSection.style.display = isNew ? 'flex' : 'none';
    btnRecord.style.display = 'none';

    if (isRenaming) {
      recordingsRow.style.display = 'none';
      saveSection.style.display = 'flex';
      btnCancelRename.style.display = 'inline-flex';
      return;
    }

    recordingsRow.style.display = 'flex';
    saveSection.style.display = 'none';
    btnCancelRename.style.display = 'none';

    // Rename/delete buttons only when a saved recording is selected
    btnRename.style.display = isNew ? 'none' : 'inline-flex';
    btnDelete.style.display = isNew ? 'none' : 'inline-flex';
  }

  // ── Area buttons ──────────────────────────────────────
  function setActiveAreaBtn(ratio) {
    areaBtns.forEach(b => b.classList.toggle('active', b.dataset.ratio === ratio));
  }

  areaBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.ratio;
      setActiveAreaBtn(val);
      if (val === 'full') {
        chrome.runtime.sendMessage({ command: 'clearArea' }, (response) => {
          if (response) updateUI(response);
        });
      } else {
        // Start drawing right away; close the popup so the page can be dragged on
        const ratio = val === 'free' ? null : parseFloat(val);
        chrome.runtime.sendMessage({ command: 'startSelectingArea', ratio }, () => window.close());
      }
    });
  });

  // ── Capture mode: Long and Hi-Res toggle independently ─
  captureModeGroup.querySelectorAll('.area-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      const value = !btn.classList.contains('active');
      chrome.runtime.sendMessage({ command: 'updateOption', key, value }, (response) => {
        if (response) updateUI(response);
      });
    });
  });

  zoomMultiplierGroup.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = parseInt(btn.dataset.multiplier, 10);
      chrome.runtime.sendMessage({ command: 'updateOption', key: 'zoomMultiplier', value }, (response) => {
        if (response) updateUI(response);
      });
    });
  });

  // ── Recordings select — auto-load on change ───────────
  savedRecordingsSelect.addEventListener('change', () => {
    const name = savedRecordingsSelect.value;
    if (name) {
      chrome.runtime.sendMessage({ command: 'loadRecording', name }, (response) => {
        if (response) updateUI(response);
      });
    } else {
      // "New Recording" selected — clear current actions
      chrome.runtime.sendMessage({ command: 'clearActions' }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  // ── UI update ─────────────────────────────────────────
  function updateUI(state) {
    currentState = state;

    actionCount.textContent = (state.actions && state.actions.length) || 0;

    if (document.activeElement !== prefixInput) {
      prefixInput.value = state.prefix || '';
    }
    if (document.activeElement !== captureFirstCheckbox) {
      captureFirstCheckbox.checked = state.captureFirst || false;
    }
    if (document.activeElement !== createPdfCheckbox) {
      createPdfCheckbox.checked = (state.createPdf !== false); // default true
    }
    if (document.activeElement !== skipDuplicatesCheckbox) {
      skipDuplicatesCheckbox.checked = state.skipDuplicates !== false;
    }
    if (document.activeElement !== autoStopCheckbox) {
      autoStopCheckbox.checked = state.autoStopUnchanged !== false;
    }
    if (document.activeElement !== maxCapturesInput) {
      maxCapturesInput.value = state.maxCaptures || 0;
    }
    if (document.activeElement !== maxStripTilesInput) {
      maxStripTilesInput.value = state.maxStripTiles ?? 2000;
    }

    // Capture mode, e.g. "Screen", "Long", "Hi-Res 4x", "Long + Hi-Res 4x"
    const zoomMultiplier = state.zoomMultiplier || 4;
    captureModeGroup.querySelectorAll('.area-btn').forEach((btn) => {
      btn.classList.toggle('active', !!state[btn.dataset.toggle]);
    });
    const modeParts = [];
    if (state.longCapture) modeParts.push(t('modeScroll'));
    if (state.hiRes) modeParts.push(`${t('modeZoom')} ${zoomMultiplier}x`);
    modeStatus.textContent = modeParts.length ? modeParts.join(' + ') : t('modeSingle');

    zoomMultiplierGroup.querySelectorAll('.segment-btn').forEach((btn) => {
      btn.classList.toggle('active', parseInt(btn.dataset.multiplier, 10) === zoomMultiplier);
    });

    // Macro enabled
    const macroOn = state.macroEnabled || false;
    macroEnabledToggle.checked = macroOn;
    macroPanel.classList.toggle('open', macroOn);

    // Badge
    if (macroOn && state.actions && state.actions.length > 0) {
      macroBadge.style.display = 'inline';
      macroBadge.textContent = state.actions.length;
    } else {
      macroBadge.style.display = 'none';
    }

    // Rebuild recordings dropdown, selection follows the active recording
    if (state.savedRecordings && document.activeElement !== savedRecordingsSelect) {
      const activeName = state.activeRecordingName || '';
      savedRecordingsSelect.innerHTML = `<option value="">${t('newRecording')}</option>`;
      for (const name of Object.keys(state.savedRecordings)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        if (name === activeName) option.selected = true;
        savedRecordingsSelect.appendChild(option);
      }
      savedRecordingsSelect.value = activeName;
    }

    // Macro panel section visibility
    refreshMacroPanelSections();

    // Capture area
    if (state.captureRect) {
      const activeRatio = state.captureRatio ? String(state.captureRatio) : 'free';
      setActiveAreaBtn(activeRatio);
      areaStatus.textContent = `${Math.round(state.captureRect.width)}×${Math.round(state.captureRect.height)}`;
    } else {
      setActiveAreaBtn('full');
      areaStatus.textContent = t('fullPage');
    }

    // Global state modes
    if (state.isSelectingArea) {
      statusDisplay.textContent = t('statusDraw');
      statusDisplay.className = 'status recording';
      statusDisplay.classList.remove('hidden');
      btnRecord.disabled = true;
      btnPlay.disabled = true;
      areaBtns.forEach(b => b.disabled = true);

    } else if (state.isRecording) {
      // No status label — the Stop button and action counter already make this clear
      statusDisplay.className = 'status hidden';
      btnRecord.disabled = false;
      // Run button doubles as the Stop Recording control
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> <span class="btn-play-text">${t('stopBtn')}</span>`;
      btnPlay.className = 'btn danger';
      btnPlay.disabled = false;

    } else if (state.isPlaying) {
      let statusText = t(state.isPaused ? 'statusPaused' : 'statusPlaying');
      if (!state.isPaused) {
        statusText += ' ' + t('countSaved').replace('{n}', state.runSaved || 0);
        if (state.runSkipped > 0) statusText += ' · ' + t('countSkipped').replace('{n}', state.runSkipped);
      }
      statusDisplay.textContent = statusText;
      statusDisplay.className = state.isPaused ? 'status paused' : 'status playing';
      statusDisplay.classList.remove('hidden');
      btnRecord.disabled = true;
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> <span class="btn-play-text">${t('stopBtn')}</span>`;
      btnPlay.className = 'btn danger';
      btnPlay.disabled = false;

    } else if (isRunButtonRecordMode()) {
      // Idle, macro on, new recording selected — Run acts as Record
      statusDisplay.className = 'status hidden';
      btnRecord.disabled = false;
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg> <span class="btn-play-text">${t('recordBtn')}</span>`;
      btnPlay.className = 'btn primary';
      btnPlay.disabled = false;
      areaBtns.forEach(b => b.disabled = false);

    } else {
      // Idle
      statusDisplay.className = 'status hidden';
      btnRecord.disabled = false;
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> <span class="btn-play-text">${t('runBtn')}</span>`;
      btnPlay.className = 'btn success';
      btnPlay.disabled = false;
      areaBtns.forEach(b => b.disabled = false);
    }
  }

  function fetchState() {
    chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
      if (response) updateUI(response);
    });
  }

  // ── Button listeners ──────────────────────────────────
  btnRecord.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'toggleRecording' }, (response) => {
      if (response) updateUI(response);
    });
  });

  btnPlay.addEventListener('click', () => {
    if (currentState && currentState.isRecording) {
      chrome.runtime.sendMessage({ command: 'toggleRecording' }, (response) => {
        if (response) updateUI(response);
      });
    } else if (currentState && currentState.isPlaying) {
      chrome.runtime.sendMessage({ command: 'stopPlayback' }, (response) => {
        if (response) updateUI(response);
      });
    } else if (isRunButtonRecordMode()) {
      chrome.runtime.sendMessage({ command: 'toggleRecording' }, (response) => {
        if (response) updateUI(response);
      });
    } else {
      const prefix = prefixInput.value.trim();
      chrome.runtime.sendMessage({ command: 'startPlayback', prefix }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  prefixInput.addEventListener('input', () => {
    chrome.runtime.sendMessage({ command: 'updatePrefix', prefix: prefixInput.value });
  });

  captureFirstCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateCaptureFirst', captureFirst: captureFirstCheckbox.checked });
  });

  skipDuplicatesCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateOption', key: 'skipDuplicates', value: skipDuplicatesCheckbox.checked });
  });

  autoStopCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateOption', key: 'autoStopUnchanged', value: autoStopCheckbox.checked });
  });

  maxCapturesInput.addEventListener('change', () => {
    const value = Math.max(0, parseInt(maxCapturesInput.value, 10) || 0);
    maxCapturesInput.value = value;
    chrome.runtime.sendMessage({ command: 'updateOption', key: 'maxCaptures', value });
  });

  maxStripTilesInput.addEventListener('change', () => {
    const value = Math.max(0, parseInt(maxStripTilesInput.value, 10) || 0);
    maxStripTilesInput.value = value;
    chrome.runtime.sendMessage({ command: 'updateOption', key: 'maxStripTiles', value });
  });

  createPdfCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateCreatePdf', createPdf: createPdfCheckbox.checked });
  });

  btnRename.addEventListener('click', () => {
    const name = currentState.activeRecordingName || savedRecordingsSelect.value;
    if (!name) return;
    isRenaming = true;
    saveNameInput.value = name;
    refreshMacroPanelSections();
    saveNameInput.focus();
    saveNameInput.select();
  });

  btnCancelRename.addEventListener('click', () => {
    isRenaming = false;
    saveNameInput.value = '';
    refreshMacroPanelSections();
  });

  saveNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnSave.click();
    } else if (e.key === 'Escape') {
      btnCancelRename.click();
    }
  });

  btnSave.addEventListener('click', () => {
    const newName = saveNameInput.value.trim();
    const oldName = currentState.activeRecordingName || savedRecordingsSelect.value;
    if (!newName || !oldName) return;
    chrome.runtime.sendMessage({ command: 'renameRecording', oldName, newName }, (response) => {
      if (response) {
        isRenaming = false;
        saveNameInput.value = '';
        updateUI(response);
      }
    });
  });

  btnDelete.addEventListener('click', () => {
    const name = savedRecordingsSelect.value;
    if (!name) return;
    chrome.runtime.sendMessage({ command: 'deleteRecording', name }, (response) => {
      if (response) {
        savedRecordingsSelect.value = '';
        updateUI(response);
      }
    });
  });

  // Background state updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state);
    }
  });

  fetchState();
});

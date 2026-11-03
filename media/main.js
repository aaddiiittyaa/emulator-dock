// @ts-check
(function () {
  // @ts-ignore - provided by VS Code
  const vscode = acquireVsCodeApi();

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const stage = $('stage');
  const screenWrap = $('screenWrap');
  const canvas = /** @type {HTMLCanvasElement} */ ($('screen'));
  const screenOff = $('screenOff');
  const overlay = $('overlay');
  const navbar = $('navbar');
  const deviceSelect = /** @type {HTMLSelectElement} */ ($('device'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false, desynchronized: true }));

  const fsEnter = $('fsEnter');
  const fsExit = $('fsExit');
  const SPECIAL_KEYS = new Set([
    'Backspace', 'Delete', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  ]);

  /** @type {any} */
  let state = { status: 'idle', devices: [] };
  let isMac = navigator.platform.toLowerCase().includes('mac');
  let connected = false;
  let hasFrame = false;
  let shownKey = '';
  const saved = vscode.getState() || {};
  let fullscreen = !!saved.fullscreen;
  let persistedPid = saved.pid;

  function persist() {
    vscode.setState({ pid: persistedPid, fullscreen });
  }

  /** Space between the screen and the panel edge; none in fullscreen. */
  function padding() {
    return fullscreen ? 0 : 12;
  }

  // ---- Rendering -----------------------------------------------------------------------

  /** @type {ImageData | undefined} */
  let imageData;
  /** @type {Uint32Array | undefined} */
  let pixels;
  /** @type {any} */
  let pendingFrame;
  let renderScheduled = false;
  let frameRotation = 'PORTRAIT';

  function onFrame(/** @type {any} */ frame) {
    pendingFrame = frame;
    if (!renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(render);
    }
  }

  function render() {
    renderScheduled = false;
    const frame = pendingFrame;
    pendingFrame = undefined;
    if (!frame) {
      return;
    }
    const { width, height } = frame;
    /** @type {Uint8Array} */
    const src = frame.data;
    if (canvas.width !== width || canvas.height !== height || !imageData) {
      canvas.width = width;
      canvas.height = height;
      imageData = ctx.createImageData(width, height);
      pixels = new Uint32Array(imageData.data.buffer);
    }
    const px = /** @type {Uint32Array} */ (pixels);
    const n = width * height;
    // RGB888 -> RGBA (little-endian ABGR words).
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      px[i] = 0xff000000 | (src[j + 2] << 16) | (src[j + 1] << 8) | src[j];
    }
    ctx.putImageData(imageData, 0, 0);
    if (typeof state.cornerRatio !== 'number') {
      estimateCorner(src, width, height);
    }
    frameRotation = frame.rotation;
    screenOff.hidden = true;
    showScreen();
    layoutCanvas();
    vscode.postMessage({ type: 'frameAck' });
  }

  function showScreen() {
    if (!hasFrame) {
      hasFrame = true;
      renderOverlay();
    }
    screenWrap.hidden = false;
  }

  function onScreenOff() {
    if (!connected) {
      return;
    }
    if (!hasFrame) {
      // Nothing drawn yet: show a dark phone-shaped placeholder behind the message.
      canvas.width = 540;
      canvas.height = 1200;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      imageData = undefined;
    }
    showScreen();
    layoutCanvas();
    screenOff.hidden = false;
  }

  // ---- Screen corners -------------------------------------------------------------------
  // Android paints the display's rounded corners black into every frame. Clipping the canvas
  // to the same radius makes those black wedges disappear. The exact radius comes from the
  // device (state.cornerRatio); until then it is estimated from the black run along the
  // diagonal of the top corners, which for a circular corner is r * (1 - 1/sqrt 2).
  let estimatedCorner = Infinity;

  function estimateCorner(/** @type {Uint8Array} */ src, /** @type {number} */ w, /** @type {number} */ h) {
    const short = Math.min(w, h);
    const limit = Math.floor(short * 0.15);
    const blackRun = (/** @type {number} */ x0, /** @type {number} */ dx) => {
      let d = 0;
      for (; d < limit; d++) {
        const j = (d * w + x0 + dx * d) * 3;
        if (src[j] + src[j + 1] + src[j + 2] > 40) {
          break;
        }
      }
      return d;
    };
    const run = Math.min(blackRun(0, 1), blackRun(w - 1, -1));
    if (run >= limit) {
      return; // Dark content at the corner: can't tell where the mask ends.
    }
    // The last dark pixel is usually the mask's anti-aliased edge, not the mask itself.
    const ratio = Math.max(0, run - 1) / (1 - Math.SQRT1_2) / short;
    if (ratio < estimatedCorner) {
      estimatedCorner = ratio;
    }
  }

  /** Corner radius as a fraction of the screen's short side. */
  function cornerRatio() {
    if (typeof state.cornerRatio === 'number') {
      return state.cornerRatio;
    }
    if (Number.isFinite(estimatedCorner)) {
      return estimatedCorner;
    }
    return state.cornerRatio === null ? 0 : 0.08;
  }

  function layoutCanvas() {
    if (!canvas.width || !canvas.height) {
      return;
    }
    const pad = padding();
    const availW = Math.max(1, stage.clientWidth - pad * 2);
    const availH = Math.max(1, stage.clientHeight - pad * 2);
    const scale = Math.min(availW / canvas.width, availH / canvas.height);
    const w = Math.floor(canvas.width * scale);
    const h = Math.floor(canvas.height * scale);
    if (canvas.style.width !== `${w}px` || canvas.style.height !== `${h}px`) {
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ratio = cornerRatio();
    // +1px swallows the anti-aliased edge of the device's own corner mask.
    const radius = ratio > 0 ? `${(ratio * Math.min(w, h) + 1).toFixed(1)}px` : '0px';
    if (canvas.style.borderRadius !== radius) {
      canvas.style.borderRadius = radius;
    }
  }

  /** Ask the extension for frames sized to the panel in physical pixels. */
  let viewportTimer = 0;
  let lastViewport = '';
  function reportViewport() {
    clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(() => {
      const dpr = state.quality === 'performance' ? 1 : window.devicePixelRatio || 1;
      const width = Math.round(Math.max(0, stage.clientWidth - padding() * 2) * dpr);
      const height = Math.round(Math.max(0, stage.clientHeight - padding() * 2) * dpr);
      const key = `${width}x${height}`;
      if (key !== lastViewport) {
        lastViewport = key;
        vscode.postMessage({ type: 'viewport', width, height });
      }
    }, 120);
  }

  new ResizeObserver(() => {
    layoutCanvas();
    reportViewport();
  }).observe(stage);

  // ---- Fullscreen ------------------------------------------------------------------------
  // Hides the toolbar and navigation bar so the device screen fills the whole panel. The exit
  // button fades in while the mouse moves; the view/editor title bar also has a toggle.

  let exitTimer = 0;
  function revealExit() {
    document.body.classList.add('show-exit');
    clearTimeout(exitTimer);
    exitTimer = window.setTimeout(() => document.body.classList.remove('show-exit'), 2000);
  }

  function setFullscreen(/** @type {boolean} */ on) {
    fullscreen = on;
    document.body.classList.toggle('fullscreen', on);
    persist();
    layoutCanvas();
    reportViewport();
    if (on) {
      revealExit();
    }
    if (connected) {
      canvas.focus();
    }
  }

  fsEnter.addEventListener('click', () => setFullscreen(true));
  fsExit.addEventListener('click', () => setFullscreen(false));
  fsExit.addEventListener('mouseenter', () => clearTimeout(exitTimer));
  fsExit.addEventListener('mouseleave', revealExit);
  stage.addEventListener('pointermove', (e) => {
    if (fullscreen && e.buttons === 0) {
      revealExit();
    }
  });
  document.body.classList.toggle('fullscreen', fullscreen);

  // ---- Pointer input -----------------------------------------------------------------

  function normalized(/** @type {MouseEvent} */ e) {
    const rect = canvas.getBoundingClientRect();
    return {
      nx: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      ny: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  /** @type {{ id: number, multi: boolean } | undefined} */
  let activePointer;
  /** @type {{ nx: number, ny: number } | undefined} */
  let queuedMove;
  let moveScheduled = false;

  function sendPress(/** @type {{nx:number, ny:number}} */ p, /** @type {boolean} */ down) {
    if (activePointer?.multi) {
      // Pinch/zoom: a second finger mirrored around the screen center.
      const pressure = down ? 1024 : 0;
      vscode.postMessage({
        type: 'touch',
        rotation: frameRotation,
        points: [
          { id: 1, nx: p.nx, ny: p.ny, pressure },
          { id: 2, nx: 1 - p.nx, ny: 1 - p.ny, pressure },
        ],
      });
    } else {
      vscode.postMessage({ type: 'pointer', nx: p.nx, ny: p.ny, buttons: down ? 1 : 0, rotation: frameRotation });
    }
  }

  function flushMove() {
    moveScheduled = false;
    if (queuedMove && activePointer) {
      sendPress(queuedMove, true);
    }
    queuedMove = undefined;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !connected) {
      return;
    }
    e.preventDefault();
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    activePointer = { id: e.pointerId, multi: e.altKey };
    sendPress(normalized(e), true);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointer || e.pointerId !== activePointer.id) {
      return;
    }
    queuedMove = normalized(e);
    if (!moveScheduled) {
      moveScheduled = true;
      requestAnimationFrame(flushMove);
    }
  });

  function endPointer(/** @type {PointerEvent} */ e) {
    if (!activePointer || e.pointerId !== activePointer.id) {
      return;
    }
    if (queuedMove) {
      sendPress(queuedMove, true);
      queuedMove = undefined;
    }
    sendPress(normalized(e), false);
    activePointer = undefined;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Mouse wheel / trackpad scrolling. 120 units = one wheel notch.
  let wheelDx = 0;
  let wheelDy = 0;
  let wheelScheduled = false;
  let lastHover = '';
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!connected) {
        return;
      }
      e.preventDefault();
      const p = normalized(e);
      const hover = `${p.nx.toFixed(3)},${p.ny.toFixed(3)}`;
      if (hover !== lastHover && !activePointer) {
        // Position the pointer first so the scroll lands on the view under the cursor.
        lastHover = hover;
        vscode.postMessage({ type: 'pointer', nx: p.nx, ny: p.ny, buttons: 0, rotation: frameRotation });
      }
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1.2;
      wheelDx -= e.deltaX * unit;
      wheelDy -= e.deltaY * unit;
      if (!wheelScheduled) {
        wheelScheduled = true;
        requestAnimationFrame(() => {
          wheelScheduled = false;
          const dx = Math.trunc(wheelDx);
          const dy = Math.trunc(wheelDy);
          wheelDx -= dx;
          wheelDy -= dy;
          if (dx || dy) {
            vscode.postMessage({ type: 'wheel', dx, dy });
          }
        });
      }
    },
    { passive: false },
  );

  // ---- Keyboard ------------------------------------------------------------------------

  let lastClipboardAction = 0;
  function clipboard(/** @type {'paste' | 'copy' | 'cut'} */ type) {
    const now = Date.now();
    // The keydown and the browser's clipboard event both fire for one shortcut.
    if (now - lastClipboardAction < 400) {
      return;
    }
    lastClipboardAction = now;
    vscode.postMessage({ type });
  }

  canvas.addEventListener('keydown', (e) => {
    if (!connected || e.isComposing) {
      return;
    }
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (primary || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'c' || k === 'x') {
        e.preventDefault();
        clipboard(k === 'v' ? 'paste' : k === 'c' ? 'copy' : 'cut');
      } else if (k === 'a' || k === 'z' || k === 'y') {
        e.preventDefault();
        vscode.postMessage({ type: 'combo', letter: k });
      }
      // Anything else (Cmd+P, Ctrl+`...) stays with VS Code.
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      vscode.postMessage({ type: 'text', text: e.key });
    } else if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      vscode.postMessage({ type: 'key', key: e.key, eventType: 'keydown' });
    }
  });

  canvas.addEventListener('keyup', (e) => {
    if (connected && SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      vscode.postMessage({ type: 'key', key: e.key, eventType: 'keyup' });
    }
  });

  for (const type of /** @type {const} */ (['paste', 'copy', 'cut'])) {
    document.addEventListener(type, (e) => {
      if (connected && document.activeElement === canvas) {
        e.preventDefault();
        clipboard(type);
      }
    });
  }

  // ---- Toolbar & buttons -------------------------------------------------------------

  // Hardware buttons: press-and-hold aware (holding Power opens the power menu).
  document.querySelectorAll('[data-button]').forEach((el) => {
    const btn = /** @type {HTMLButtonElement} */ (el);
    const name = btn.dataset.button;
    let held = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      held = true;
      btn.setPointerCapture(e.pointerId);
      vscode.postMessage({ type: 'button', name, phase: 'down' });
    });
    const release = () => {
      if (held) {
        held = false;
        vscode.postMessage({ type: 'button', name, phase: 'up' });
      }
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('click', (e) => {
      // Keyboard activation (Enter/Space) has no pointer events.
      if (e.detail === 0) {
        vscode.postMessage({ type: 'button', name, phase: 'press' });
      }
    });
  });

  document.querySelectorAll('[data-rotate]').forEach((el) => {
    const btn = /** @type {HTMLButtonElement} */ (el);
    btn.addEventListener('click', () => vscode.postMessage({ type: 'rotate', direction: Number(btn.dataset.rotate) }));
  });

  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const commandEl = /** @type {HTMLElement | null} */ (target.closest('[data-command]'));
    if (commandEl) {
      vscode.postMessage({ type: 'command', name: commandEl.dataset.command });
      return;
    }
    const selectEl = /** @type {HTMLElement | null} */ (target.closest('[data-select]'));
    if (selectEl) {
      vscode.postMessage({ type: 'select', key: selectEl.dataset.select });
    }
  });

  deviceSelect.addEventListener('change', () => {
    if (deviceSelect.value) {
      vscode.postMessage({ type: 'select', key: deviceSelect.value });
    }
  });

  // ---- State -----------------------------------------------------------------------------

  /** @param {string} text */
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  const PHONE_ICON =
    '<svg class="hero" viewBox="0 0 48 48" aria-hidden="true"><rect x="13" y="4" width="22" height="40" rx="4"/><path d="M21 38h6"/></svg>';

  function renderDeviceSelect() {
    const running = state.devices.filter((/** @type {any} */ d) => d.state === 'running');
    const others = state.devices.filter((/** @type {any} */ d) => d.state !== 'running');
    let html = '';
    if (!state.devices.some((/** @type {any} */ d) => d.key === state.selectedKey)) {
      html += `<option value="" selected disabled>${state.devices.length ? 'Select a device…' : 'No devices'}</option>`;
    }
    if (running.length) {
      html += '<optgroup label="Running">';
      for (const d of running) {
        html += `<option value="${esc(d.key)}"${d.key === state.selectedKey ? ' selected' : ''}>${esc(d.label)}${d.serial ? ` (${esc(d.serial)})` : ''}</option>`;
      }
      html += '</optgroup>';
    }
    if (others.length) {
      html += '<optgroup label="Launch">';
      for (const d of others) {
        html += `<option value="${esc(d.key)}"${d.state === 'launching' ? ' disabled' : ''}>${esc(d.label)}${d.state === 'launching' ? ' (starting…)' : ''}</option>`;
      }
      html += '</optgroup>';
    }
    deviceSelect.innerHTML = html;
    deviceSelect.disabled = state.devices.length === 0;
  }

  function renderOverlay() {
    const s = state.status;
    if (s === 'connected') {
      overlay.hidden = hasFrame;
      overlay.innerHTML = hasFrame
        ? ''
        : '<div class="card"><div class="spinner" role="progressbar" aria-label="Loading"></div><p class="desc">Waiting for the display…</p></div>';
      return;
    }
    overlay.hidden = false;
    screenWrap.hidden = true;
    let html = '';
    if (s === 'noSdk') {
      html = `${PHONE_ICON}
        <p class="title">Android SDK not found</p>
        <p class="desc">Install the Android SDK (with the Emulator package), or point the extension at an existing one.</p>
        <div class="row"><button class="btn" data-command="openSettings">Set SDK Path…</button>
        <button class="btn secondary" data-command="retry">Retry</button></div>`;
    } else if (s === 'launching' || s === 'connecting') {
      const label =
        s === 'launching'
          ? `Starting ${esc(state.message)}…`
          : !state.message
            ? 'Looking for emulators…'
            : state.message.startsWith('Stopping')
              ? esc(state.message)
              : `Connecting to ${esc(state.message)}…`;
      html = `<div class="spinner" role="progressbar" aria-label="Loading"></div>
        <p class="title">${label}</p>
        ${s === 'launching' ? '<p class="desc">A cold boot can take a minute. The screen appears here as soon as the device starts drawing.</p>' : ''}`;
    } else {
      const running = state.devices.filter((/** @type {any} */ d) => d.state === 'running');
      const avds = state.devices.filter((/** @type {any} */ d) => d.state !== 'running');
      const isError = s === 'error';
      html = `${PHONE_ICON}
        <p class="title">${isError ? 'Connection problem' : running.length ? 'Choose a device' : 'No emulator running'}</p>
        ${state.message ? `<p class="desc${isError ? ' error' : ''}">${esc(state.message)}</p>` : ''}`;
      if (running.length || avds.length) {
        html += '<ul class="avd-list">';
        for (const d of running) {
          html += `<li><span class="avd-name"><span class="dot running" aria-hidden="true"></span>${esc(d.label)}</span>
            <button class="btn small" data-select="${esc(d.key)}">Show</button></li>`;
        }
        for (const d of avds) {
          const launching = d.state === 'launching';
          html += `<li><span class="avd-name"><span class="dot" aria-hidden="true"></span>${esc(d.label)}</span>
            <button class="btn small${launching ? ' secondary' : ''}" data-select="${esc(d.key)}"${launching ? ' disabled' : ''}>${launching ? 'Starting…' : 'Launch'}</button></li>`;
        }
        html += '</ul>';
      } else {
        html += `<p class="desc">No virtual devices found. Create one in Android Studio's Device Manager, or run <code>avdmanager create avd</code>.</p>`;
      }
      html += `<div class="row">${isError ? '<button class="btn" data-command="retry">Retry</button>' : ''}
        <button class="btn secondary" data-command="${isError ? 'showLogs' : 'refresh'}">${isError ? 'Show Logs' : 'Refresh'}</button></div>`;
    }
    overlay.innerHTML = `<div class="card">${html}</div>`;
  }

  function applyState(/** @type {any} */ next) {
    const wasConnected = connected;
    const qualityChanged = next.quality !== state.quality;
    state = next;
    isMac = next.platform === 'darwin';
    connected = next.status === 'connected';
    const key = connected ? next.selectedKey || '' : '';
    if (key !== shownKey) {
      // Different device (or none): drop the old picture.
      shownKey = key;
      hasFrame = false;
      screenWrap.hidden = true;
      screenOff.hidden = true;
    }
    renderDeviceSelect();
    renderOverlay();
    navbar.hidden = !connected;
    document.querySelectorAll('[data-needs-device]').forEach((el) => {
      /** @type {HTMLButtonElement} */ (el).disabled = !connected;
    });
    if (connected && (!wasConnected || qualityChanged)) {
      // Frames resume once the extension knows the panel size.
      lastViewport = '';
      reportViewport();
    }
    if (!connected) {
      screenWrap.hidden = true;
      activePointer = undefined;
    }
    const selected = state.devices.find((/** @type {any} */ d) => d.key === state.selectedKey);
    persistedPid = selected?.pid;
    persist();
    layoutCanvas();
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m?.type) {
      case 'frame':
        if (connected) {
          onFrame(m);
        } else {
          vscode.postMessage({ type: 'frameAck' });
        }
        break;
      case 'screenOff':
        onScreenOff();
        break;
      case 'state':
        applyState(m);
        break;
      case 'toggleFullscreen':
        setFullscreen(!fullscreen);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  reportViewport();
})();

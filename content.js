(function() {
  if (window.__autoCaptureInitialized) return;
  window.__autoCaptureInitialized = true;

  let isRecording = false;
  let captureRectDiv = null;
  let rectRatio = null;      // locked width/height ratio of the area, or null for free
  let rectLocked = false;    // set by the background while a macro plays back

  // Fetch initial state in case we were just injected
  chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
    if (response) {
      isRecording = response.isRecording;
      if (isRecording) {
        console.log('Cheezing: Initialized in recording state');
      }
      rectRatio = typeof response.captureRatio === 'number' ? response.captureRatio : null;
      rectLocked = !!response.isPlaying;
      if (response.captureRect) {
        drawPersistentRect(response.captureRect);
      } else if (response.captureElement) {
        showElementOutline(response.captureElement, null);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === 'setRecordingState') {
      isRecording = message.isRecording;
      if (isRecording) {
        hookAllDocuments();
        console.log('Cheezing: Recording started');
      } else {
        console.log('Cheezing: Recording stopped');
      }
      updateRectInteractivity();
      sendResponse({ success: true });
    } else if (message.command === 'setRectLocked') {
      rectLocked = message.locked;
      updateRectInteractivity();
      sendResponse({ success: true });
    } else if (message.command === 'startSelectingArea') {
      startSelection(message.ratio);
      sendResponse({ success: true });
    } else if (message.command === 'startPickingElement') {
      startElementPicker(message.purpose || 'capture');
      sendResponse({ success: true });
    } else if (message.command === 'clearArea') {
      removeRectBox();
      clearElementOutline();
      sendResponse({ success: true });
    } else if (message.command === 'hideRect') {
      if (captureRectDiv) captureRectDiv.style.display = 'none';
      if (elementOutline) elementOutline.hidden = true;
      sendResponse({ success: true });
    } else if (message.command === 'showRect') {
      if (captureRectDiv) captureRectDiv.style.display = 'block';
      if (elementOutline) elementOutline.hidden = false;
      sendResponse({ success: true });
    } else if (message.command === 'locateClickTarget') {
      sendResponse(locateClickTarget(message.target, message.hint));
    } else if (message.command === 'findPickedElement') {
      sendResponse(describePickedElement(message.element));
    } else if (message.command === 'collectElementImages') {
      collectElementImages(message.element).then(sendResponse, () => sendResponse({ images: [] }));
      return true; // answered asynchronously
    } else if (message.command === 'suppressStickyElements') {
      suppressStickyElements(message.enable);
      sendResponse({ success: true });
    } else if (message.command === 'getPageActivity') {
      sendResponse(getPageActivity());
    } else if (message.command === 'setLeaveGuard') {
      if (message.enable) {
        window.addEventListener('beforeunload', confirmLeave);
      } else {
        window.removeEventListener('beforeunload', confirmLeave);
      }
      sendResponse({ success: true });
    } else if (message.command === 'beginScrollStrip') {
      sendResponse(message.element
        ? beginElementStrip(message.element, message.long)
        : beginScrollStrip(message.rect));
    } else if (message.command === 'scrollStripTo') {
      sendResponse(scrollStripTo(message.y));
    } else if (message.command === 'stripPosition') {
      sendResponse(stripPosition());
    } else if (message.command === 'endScrollStrip') {
      endScrollStrip();
      sendResponse({ success: true });
    }
  });

  // ── Same-origin frames ──────────────────────────────────────────────
  // Some sites (e.g. Naver blogs) show the whole page inside a same-origin
  // iframe that scrolls on its own. The script runs in the top frame only,
  // so it reaches into those frames directly. Cross-origin frames stay opaque.
  function frameDocument(frame) {
    try {
      return frame.contentDocument;
    } catch (err) {
      return null;
    }
  }

  // Calls fn for the top document and every same-origin frame document in it
  function forEachDocument(fn, doc = document) {
    fn(doc);
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      const child = frameDocument(frame);
      if (child) forEachDocument(fn, child);
    }
  }

  function viewOf(node) {
    const doc = node.ownerDocument || node;
    return doc.defaultView || window;
  }

  // Top-left of a frame window's viewport, in top-frame viewport px
  function frameOffset(win) {
    let x = 0;
    let y = 0;
    while (win.document !== document && win.frameElement) {
      const frame = win.frameElement;
      const r = frame.getBoundingClientRect();
      const cs = viewOf(frame).getComputedStyle(frame);
      x += r.left + frame.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      y += r.top + frame.clientTop + (parseFloat(cs.paddingTop) || 0);
      win = viewOf(frame);
    }
    return { x, y };
  }

  function offsetRegion(r, o) {
    return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
  }

  // ── Page activity (for waiting until the page settles) ───────────────
  // Started on first request; the page counts as just-changed at that point
  // so it must then stay quiet for the full window. Frame documents are
  // picked up as they appear (e.g. after an iframe navigates), and count as
  // just-changed too.
  let lastMutationAt = 0;
  const observedDocuments = new WeakSet();

  function getPageActivity() {
    let fontsLoading = false;
    forEachDocument((doc) => {
      if (!observedDocuments.has(doc)) {
        observedDocuments.add(doc);
        lastMutationAt = Date.now();
        new MutationObserver(() => { lastMutationAt = Date.now(); })
          .observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      if (doc.fonts && doc.fonts.status === 'loading') fontsLoading = true;
    });
    return {
      msSinceMutation: Date.now() - lastMutationAt,
      pendingImages: countPendingImagesInView(),
      fontsLoading
    };
  }

  function countPendingImagesInView() {
    let pending = 0;
    forEachDocument((doc) => {
      const win = viewOf(doc);
      for (const img of doc.images) {
        if (img.complete) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth) pending++;
      }
    });
    return pending;
  }

  // Shows Chrome's "Leave site?" dialog while a capture is in progress
  function confirmLeave(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  // el -> original inline visibility. Kept as a map so repeated enable calls
  // (one per tile) add newly-appearing elements without recording our own
  // 'hidden' as the value to restore.
  const suppressedStickyElements = new Map();

  // Hides every fixed element and every sticky element that is currently
  // stuck, so nothing repeats down a scroll strip. Covers each document from
  // the top down to the one being scrolled, but never an element holding the
  // scroller itself (a fixed panel, or the iframe the page lives in).
  function suppressStickyElements(enable) {
    if (!enable) {
      for (const [el, origVisibility] of suppressedStickyElements) {
        el.style.visibility = origVisibility;
      }
      suppressedStickyElements.clear();
      return;
    }
    const scroller = stripScroller || { win: window, el: null };
    const keep = scrollerChain(scroller);
    if (stripElement) keep.nodes.push(stripElement); // e.g. a fixed dialog picked as the element
    for (const doc of keep.documents) {
      for (const el of doc.querySelectorAll('*')) {
        if (suppressedStickyElements.has(el) || isOwnOverlay(el)) continue;
        if (keep.nodes.some((node) => el.contains(node))) continue;
        suppressStickyElement(el);
      }
    }
  }

  // The documents from the top down to the scroller's, and the nodes in them
  // that contain the scroller (iframe elements, and the scrolled element).
  function scrollerChain(scroller) {
    const documents = [];
    const nodes = scroller.el ? [scroller.el] : [];
    let win = scroller.win;
    for (;;) {
      documents.unshift(win.document);
      if (win.document === document || !win.frameElement) break;
      nodes.push(win.frameElement);
      win = viewOf(win.frameElement);
    }
    return { documents, nodes };
  }

  function suppressStickyElement(el) {
    const style = viewOf(el).getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    if (pos === 'fixed' || isStuck(el, style, rect)) {
      suppressedStickyElements.set(el, el.style.visibility);
      el.style.visibility = 'hidden';
    }
  }

  // A sticky element in normal flow is regular page content and must stay
  // visible; only hide it while it is pinned to its scroll container's edge.
  function isStuck(el, style, rect) {
    const scroller = findScrollParent(el.parentElement);
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: viewOf(el).innerHeight };
    const top = parseFloat(style.top);
    const bottom = parseFloat(style.bottom);
    if (!isNaN(top) && Math.abs(rect.top - (box.top + top)) < 2) return true;
    if (!isNaN(bottom) && Math.abs(box.bottom - bottom - rect.bottom) < 2) return true;
    return false;
  }

  function isScrollable(el) {
    if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return false;
    const oy = viewOf(el).getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  }

  function findScrollParent(el) {
    while (el && el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Scroll strip ────────────────────────────────────────────────────
  // The strip is built by scrolling one "scroller" and capturing a fixed
  // viewport region each step. A scroller is { win, el }: an inner scrollable
  // element `el` (chat log, table, side pane...) in window `win`, or with
  // el = null, the document of `win` itself -- the page, or a same-origin
  // frame the page lives in. Positions are reported back as actually
  // reached, so the background can crop away any overlap exactly.
  let stripScroller = null;
  let stripOrigin = null;   // scroll positions to restore afterwards
  let stripRegion = null;   // the captured viewport region, in top-frame px
  let stripElement = null;  // Element capture: the element the strip covers

  // Without a selected area, an inner scroller is used only if it covers at
  // least this share of the viewport, so a small scroll box that happens to
  // sit in the middle of the page isn't taken for the page.
  const MIN_FULL_PAGE_SCROLLER_SHARE = 0.5;

  // A window's viewport in its own px; clientWidth/Height exclude scrollbars,
  // so they never end up in the strip
  function windowRegion(win = window) {
    const doc = win.document.documentElement;
    return { x: 0, y: 0, width: doc.clientWidth, height: doc.clientHeight };
  }

  function elementRegion(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + el.clientLeft,
      y: r.top + el.clientTop,
      width: el.clientWidth,
      height: el.clientHeight
    };
  }

  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  // The visible part of a window's viewport, in top-frame px
  function visibleWindowRegion(win) {
    let region = offsetRegion(windowRegion(win), frameOffset(win));
    while (win.document !== document && win.frameElement) {
      win = viewOf(win.frameElement);
      region = intersect(region, offsetRegion(windowRegion(win), frameOffset(win)));
    }
    return region;
  }

  // The scroller's visible area, in top-frame px
  function scrollerRegion(s) {
    const view = visibleWindowRegion(s.win);
    if (!s.el) return view;
    return intersect(view, offsetRegion(elementRegion(s.el), frameOffset(s.win)));
  }

  function scrollTop(s) {
    return s.el ? s.el.scrollTop : s.win.scrollY;
  }

  function maxScrollTop(s) {
    if (s.el) return s.el.scrollHeight - s.el.clientHeight;
    const doc = s.win.document;
    const body = doc.body ? doc.body.scrollHeight : 0;
    return Math.max(doc.documentElement.scrollHeight, body) - doc.documentElement.clientHeight;
  }

  function scrollLeft(s) {
    return s.el ? s.el.scrollLeft : s.win.scrollX;
  }

  function scrollerTo(s, top, left = scrollLeft(s)) {
    (s.el || s.win).scrollTo({ top, left, behavior: 'instant' });
  }

  // The innermost scroller under a top-frame point: descends into same-origin
  // frames, then climbs back out to the first element or frame document that
  // can scroll. Returns null if only the top page itself is left.
  function findScrollerAt(x, y) {
    let win = window;
    let hit = document.elementFromPoint(x, y);
    while (hit && (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME')) {
      const doc = frameDocument(hit);
      if (!doc || !doc.defaultView) break;
      win = doc.defaultView;
      const o = frameOffset(win);
      hit = doc.elementFromPoint(x - o.x, y - o.y);
    }
    for (;;) {
      const el = hit && findScrollParent(hit);
      if (el) return { win, el };
      if (win.document === document || !win.frameElement) return null;
      if (maxScrollTop({ win, el: null }) > 1) return { win, el: null };
      hit = win.frameElement;
      win = viewOf(hit);
    }
  }

  function beginScrollStrip(rect) {
    const page = { win: window, el: null };
    const view = windowRegion();
    const area = rect ? intersect(view, rect) : view;
    let scroller = null;

    // With an area, scroll whatever sits under it. Without one, scroll the
    // page -- unless it can't scroll, as when it lives in a big iframe.
    if (rect || maxScrollTop(page) <= 1) {
      if (captureRectDiv) captureRectDiv.style.display = 'none';
      scroller = findScrollerAt(area.x + area.width / 2, area.y + area.height / 2);
      if (scroller && !rect) {
        const r = scrollerRegion(scroller);
        if (r.width * r.height < MIN_FULL_PAGE_SCROLLER_SHARE * view.width * view.height) scroller = null;
      }
    }
    stripScroller = scroller || page;

    let region = scroller ? scrollerRegion(scroller) : view;
    if (rect) region = intersect(region, rect);

    stripOrigin = [savedScrollPosition(stripScroller)];
    stripRegion = region;
    stripElement = null;

    return {
      region,
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      scroller: !stripScroller.el && stripScroller.win.document === document
        ? 'window'
        : stripScroller.el ? 'element' : 'frame'
    };
  }

  // Element capture: the strip covers one element instead of a whole
  // scroller. Its nearest scroller (an inner panel, the page, or the frame
  // the page lives in) is scrolled so the element passes through the
  // scroller's visible area, and the strip's rows are the element's own rows,
  // measured live each step -- so content loading in above it can't shift
  // the result. With Long on and a scrollable element (a chat log, a
  // feed...), its own contents are scrolled through instead.
  function beginElementStrip(ref, long) {
    const el = resolveElementRef(ref);
    if (!el) return { notFound: true };
    if (captureRectDiv) captureRectDiv.style.display = 'none';
    if (elementOutline) elementOutline.hidden = true;

    stripOrigin = scrollPositionsAround(el);
    el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });

    let region;
    if (long && isScrollable(el)) {
      stripScroller = { win: viewOf(el), el };
      stripElement = null;
      region = scrollerRegion(stripScroller);
    } else {
      stripScroller = scrollerFor(el);
      stripElement = el;
      // The scroller's full visible height, narrowed to the element's columns
      const view = scrollerRegion(stripScroller);
      const box = elementBox(el);
      const x = Math.max(view.x, box.x);
      const right = Math.min(view.x + view.width, box.x + box.width);
      region = { x, y: view.y, width: Math.max(0, right - x), height: view.height };
    }
    stripRegion = region;

    return {
      region,
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      element: !!stripElement
    };
  }

  // Scrolls so that strip row `y` sits at the top of the captured region:
  // for a scroller that's its scroll position, for an element its own row.
  function scrollStripTo(y) {
    const s = stripScroller || { win: window, el: null };
    if (stripElement) {
      const box = elementBox(stripElement);
      scrollerTo(s, scrollTop(s) + box.y + y - stripRegion.y);
    } else {
      scrollerTo(s, y);
    }
    return stripPosition();
  }

  // Where the strip is now: `top` is the strip row at the top of the region
  // (negative while the element starts lower down), `end` the strip's
  // length so far, `atEnd` whether there's nothing further to scroll to.
  function stripPosition() {
    const s = stripScroller || { win: window, el: null };
    const actual = scrollTop(s);
    const maxScroll = maxScrollTop(s);
    if (stripElement) {
      const box = elementBox(stripElement);
      const top = stripRegion.y - box.y;
      return {
        top,
        end: box.height,
        maxScroll,
        atEnd: top + stripRegion.height >= box.height - 0.5 || actual >= maxScroll - 0.5
      };
    }
    return { top: actual, end: maxScroll + stripRegion.height, maxScroll, atEnd: actual >= maxScroll - 0.5 };
  }

  function endScrollStrip() {
    suppressStickyElements(false);
    if (stripOrigin) {
      // Innermost first, as they were saved
      for (const { scroller, top, left } of stripOrigin) scrollerTo(scroller, top, left);
    }
    if (elementOutline) elementOutline.hidden = false;
    stripScroller = null;
    stripOrigin = null;
    stripRegion = null;
    stripElement = null;
  }

  function savedScrollPosition(s) {
    return { scroller: s, top: scrollTop(s), left: scrollLeft(s) };
  }

  // `node` and every scroller holding it, up through frames to the top
  // page, so a scrollIntoView (or scrolling the element itself) can be
  // undone exactly
  function scrollPositionsAround(node) {
    const saved = [];
    for (;;) {
      const win = viewOf(node);
      for (let el = node; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
          if (el !== win.document.body && el !== win.document.documentElement) {
            saved.push(savedScrollPosition({ win, el }));
          }
        }
      }
      saved.push(savedScrollPosition({ win, el: null }));
      if (win.document === document || !win.frameElement) return saved;
      node = win.frameElement;
    }
  }

  // The nearest scroller that moves `el`: a scrollable ancestor, else its
  // document -- or, for a frame document that can't scroll (sized to its
  // content), whatever scrolls the frame in the page around it.
  function scrollerFor(el) {
    let node = el;
    for (;;) {
      const win = viewOf(node);
      const parent = findScrollParent(node.parentElement);
      if (parent) return { win, el: parent };
      if (win.document === document || !win.frameElement) return { win, el: null };
      if (maxScrollTop({ win, el: null }) > 1) return { win, el: null };
      node = win.frameElement;
    }
  }

  // An element's border box, in top-frame px
  function elementBox(el) {
    const r = el.getBoundingClientRect();
    return offsetRegion({ x: r.left, y: r.top, width: r.width, height: r.height }, frameOffset(viewOf(el)));
  }

  // ── Picked elements ─────────────────────────────────────────────────
  // A picked element is remembered as a CSS path (plus the path to each
  // same-origin frame it sits in), not as a node: it's looked up again for
  // every capture, so it's found after the page re-renders, reloads, or a
  // macro navigates to a page with the same layout.
  function resolveElementRef(ref) {
    if (!ref || !ref.selector) return null;
    try {
      let doc = document;
      for (const frameSelector of ref.frames || []) {
        const frame = doc.querySelector(frameSelector);
        doc = frame && frameDocument(frame);
        if (!doc) return null;
      }
      return doc.querySelector(ref.selector);
    } catch (err) {
      return null; // not a valid selector
    }
  }

  function buildElementRef(el, countImages = true) {
    const frames = [];
    let win = viewOf(el);
    while (win.document !== document && win.frameElement) {
      frames.unshift(cssPath(win.frameElement));
      win = viewOf(win.frameElement);
    }
    const r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      frames,
      label: describeElement(el),
      width: Math.round(r.width),
      height: Math.round(r.height),
      imageCount: countImages ? findElementImages(el).length : 0
    };
  }

  // Shortest path up to an ancestor with a stable unique id, else from body,
  // using :nth-of-type only where a tag repeats among its siblings
  function cssPath(el) {
    const doc = el.ownerDocument;
    const parts = [];
    for (let node = el; node && node !== doc.documentElement; node = node.parentElement) {
      if (isStableId(node.id) && doc.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  // Generated ids (React's ":r1:", "ember123", hashes) change between
  // page loads, so they can't be used to find the element again
  function isStableId(id) {
    return !!id && !/[:\s]|\d{3,}|^\d/.test(id) && !/[0-9a-f]{8,}/i.test(id);
  }

  const GENERIC_CLASS = /^(btn|button|icon|link|item|wrapper|container|inner|outer|row|col|box|clearfix)$/i;

  // e.g. "div#content", "article.post-body", "button.pager-next"
  function describeElement(el) {
    let label = el.tagName.toLowerCase();
    if (isStableId(el.id)) {
      label += '#' + el.id;
    } else if (el.classList.length) {
      // The most telling class: not a generic one like "btn", nor a state
      const classes = [...el.classList];
      const specific = classes.find((c) => !GENERIC_CLASS.test(c) && !STATE_CLASS.test(c));
      label += '.' + (specific || classes[0]);
    }
    return label.length > 32 ? label.slice(0, 31) + '…' : label;
  }

  // For waiting until the picked element is on the page and done loading
  function describePickedElement(ref) {
    const el = resolveElementRef(ref);
    if (!el) return { found: false };
    const box = elementBox(el);
    let pendingImages = 0;
    const win = viewOf(el);
    for (const img of el.querySelectorAll('img')) {
      if (img.complete) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth) pendingImages++;
    }
    return {
      found: true,
      width: box.width,
      height: box.height,
      pendingImages,
      msSinceMutation: getPageActivity().msSinceMutation
    };
  }

  // ── Images in a picked element ──────────────────────────────────────
  // An element with images in it is saved as the image files themselves,
  // from their URLs, at the best resolution the page offers. Counted are
  // <img>s and CSS background images at least MIN_IMAGE_PX on each side, so
  // icons, avatars and tracking pixels are left out.
  const MIN_IMAGE_PX = 48;
  const LAZY_SRC_ATTRS = ['data-lazy-src', 'data-original', 'data-src', 'data-lazy', 'data-url', 'data-full', 'data-large'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
  const MIN_INLINE_IMAGE_CHARS = 2000; // shorter data: URLs are lazy-load placeholders
  const PRIME_STEP_DELAY = 200;        // ms per step when scrolling lazy images in
  const PRIME_MAX_STEPS = 100;

  // [{ node, url }] in page order, each URL once
  function findElementImages(root) {
    const found = [];
    const seen = new Set();
    const add = (node, url) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      found.push({ node, url });
    };
    for (const node of elementsIn(root)) {
      const r = node.getBoundingClientRect();
      const bigEnough = r.width >= MIN_IMAGE_PX && r.height >= MIN_IMAGE_PX;
      if (node.tagName === 'IMG') {
        // A lazy image not loaded yet may have no size, but its URL is known
        const notLoadedYet = r.width === 0 || r.height === 0;
        if (bigEnough || (notLoadedYet && hasLazySource(node))) add(node, bestImageUrl(node));
      } else if (bigEnough) {
        const bg = viewOf(node).getComputedStyle(node).backgroundImage;
        if (bg && bg !== 'none') {
          for (const m of bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) add(node, usableUrl(m[2], node));
        }
      }
    }
    return found;
  }

  // root and everything under it, including inside open shadow roots
  // (web components, e.g. Reddit's)
  function elementsIn(root) {
    const out = [];
    const visit = (el) => {
      out.push(el);
      if (el.shadowRoot) for (const child of el.shadowRoot.children) visit(child);
      for (const child of el.children) visit(child);
    };
    visit(root);
    return out;
  }

  function hasLazySource(img) {
    return [...LAZY_SRC_ATTRS, ...LAZY_SRCSET_ATTRS].some((a) => img.hasAttribute(a));
  }

  // The largest srcset candidate (of the img or its <picture>), else a lazy
  // loader's real URL, else what's showing
  function bestImageUrl(img) {
    const sets = [img.getAttribute('srcset'), ...LAZY_SRCSET_ATTRS.map((a) => img.getAttribute(a))];
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        sets.push(source.getAttribute('srcset'), ...LAZY_SRCSET_ATTRS.map((a) => source.getAttribute(a)));
      }
    }
    let best = null;
    let bestScore = 0;
    const baseWidth = img.naturalWidth || img.getBoundingClientRect().width || 1;
    for (const set of sets) {
      for (const { url, w, x } of parseSrcset(set)) {
        const score = w || (x || 1) * baseWidth;
        const usable = usableUrl(url, img);
        if (usable && score > bestScore) {
          best = usable;
          bestScore = score;
        }
      }
    }
    if (best) return best;
    for (const attr of LAZY_SRC_ATTRS) {
      const url = usableUrl(img.getAttribute(attr), img);
      if (url) return url;
    }
    return usableUrl(img.currentSrc, img) || usableUrl(img.getAttribute('src'), img);
  }

  // "a.jpg 800w, b.jpg 1600w" or "a.jpg, b.jpg 2x". Parsed as the HTML spec
  // does: a URL runs to the next whitespace (so it may contain commas), and
  // trailing commas on it end the candidate.
  function parseSrcset(set) {
    const out = [];
    if (!set) return out;
    let i = 0;
    while (i < set.length) {
      while (i < set.length && /[\s,]/.test(set[i])) i++;
      let start = i;
      while (i < set.length && !/\s/.test(set[i])) i++;
      let url = set.slice(start, i);
      if (!url) break;
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        while (i < set.length && set[i] !== ',') i++;
        descriptor = set.slice(start, i).trim();
        i++;
      }
      const m = descriptor.match(/^(\d+(?:\.\d+)?)([wx])/);
      out.push({ url, w: m && m[2] === 'w' ? parseFloat(m[1]) : 0, x: m && m[2] === 'x' ? parseFloat(m[1]) : 0 });
    }
    return out;
  }

  function usableUrl(raw, node) {
    if (!raw) return null;
    raw = raw.trim();
    if (raw.startsWith('data:')) return raw.length >= MIN_INLINE_IMAGE_CHARS ? raw : null;
    try {
      const url = new URL(raw, node.baseURI);
      return /^(https?|blob):$/.test(url.protocol) ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  // Scrolls lazy images in, then lists the element's images. Page-only
  // blob: URLs are read here, since the extension can't open them.
  async function collectElementImages(ref) {
    const el = resolveElementRef(ref);
    if (!el) return { images: [] };
    await primeLazyImages(el);
    const images = [];
    for (const { node, url } of findElementImages(el)) {
      let fetchUrl = url;
      if (url.startsWith('blob:')) {
        fetchUrl = await fetch(url).then((r) => r.blob()).then(blobToDataUrl).catch(() => null);
      }
      // `ref` lets the background screenshot the image instead if its URL
      // fails; `link` is a full-size file the image links to, if any
      images.push({ url: fetchUrl, link: linkedImageUrl(node), ref: buildImageRef(node) });
    }
    return { images };
  }

  // A link around the image straight to an image file (what a lightbox opens)
  function linkedImageUrl(node) {
    const a = node.closest('a[href]');
    if (!a) return null;
    const url = usableUrl(a.getAttribute('href'), a);
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
    return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(new URL(url).pathname) ? url : null;
  }

  function buildImageRef(node) {
    return buildElementRef(node, false);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Many sites only set an image's real URL once it scrolls into view, so
  // an element taller than its scroller is scrolled through once first
  async function primeLazyImages(el) {
    const scroller = scrollerFor(el);
    const view = scrollerRegion(scroller);
    if (elementBox(el).height <= view.height) return;
    const saved = scrollPositionsAround(el);
    try {
      el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
      for (let i = 0; i < PRIME_MAX_STEPS; i++) {
        await sleep(PRIME_STEP_DELAY);
        const box = elementBox(el);
        if (box.y + box.height <= view.y + view.height) break; // bottom is in view
        const before = scrollTop(scroller);
        scrollerTo(scroller, before + view.height);
        if (scrollTop(scroller) <= before + 0.5) break; // can't scroll further
      }
      await sleep(PRIME_STEP_DELAY);
    } finally {
      for (const { scroller: s, top, left } of saved) scrollerTo(s, top, left);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Click targets (macro clicks by element) ─────────────────────────
  // A macro click remembers the element it hit: its CSS path, plus its
  // text (or label) or classes as a fingerprint. The path alone isn't
  // enough -- in pagination "Next" is the 6th link on one page and the 7th
  // on another -- so the path is used only when the fingerprint agrees,
  // and otherwise the matching element nearest the recorded spot is used.
  const CLICKABLE = 'a[href], button, input, select, textarea, label, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]';
  const MAX_NAME_LENGTH = 60;
  const STATE_CLASS = /active|selected|current|disabled|hover|focus|^on$|^is-|^has-/i;

  // The control a click landed in (an icon inside a button -> the button)
  function clickableOf(el) {
    return el.closest(CLICKABLE) || el;
  }

  function buildClickTarget(el, point) {
    const ref = buildElementRef(el, false);
    const name = accessibleName(el);
    const target = {
      selector: ref.selector,
      frames: ref.frames,
      tag: el.tagName.toLowerCase(),
      name,
      cls: classKey(el),
      label: name ? `${el.tagName.toLowerCase()} "${name.length > 24 ? name.slice(0, 23) + '…' : name}"` : ref.label
    };
    const box = elementBox(el);
    if (point && box.width > 0 && box.height > 0) {
      // Where in the element the click was, as fractions of its size
      target.fx = Math.min(1, Math.max(0, (point.x - box.x) / box.width));
      target.fy = Math.min(1, Math.max(0, (point.y - box.y) / box.height));
    }
    return target;
  }

  // Short visible name: aria-label, text, value, title or an image's alt.
  // Long text (a whole card) is no fingerprint, so it's left empty.
  function accessibleName(el) {
    const img = el.querySelector && el.querySelector('img[alt]');
    const raw = el.getAttribute('aria-label') || el.textContent ||
      (el.tagName === 'INPUT' ? el.value : '') || el.getAttribute('title') || (img ? img.alt : '') || '';
    const name = raw.replace(/\s+/g, ' ').trim();
    return name.length > MAX_NAME_LENGTH ? '' : name;
  }

  // The element's classes minus state ones (active, disabled...), sorted
  function classKey(el) {
    return [...el.classList].filter((c) => !STATE_CLASS.test(c)).sort().join(' ');
  }

  function isShown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && viewOf(el).getComputedStyle(el).visibility !== 'hidden';
  }

  function isDisabled(el) {
    if (el.disabled || el.closest('[disabled], [aria-disabled="true"]')) return true;
    return [...el.classList].some((c) => /(^|[-_])disabled$/i.test(c));
  }

  function findClickTarget(target, hint) {
    let doc = document;
    try {
      for (const frameSelector of target.frames || []) {
        const frame = doc.querySelector(frameSelector);
        doc = frame && frameDocument(frame);
        if (!doc) return null;
      }
    } catch (err) {
      return null;
    }
    const matches = (el) => target.name ? accessibleName(el) === target.name
      : target.cls ? classKey(el) === target.cls
      : true;

    let bySelector = null;
    try {
      bySelector = doc.querySelector(target.selector);
    } catch (err) { /* not a valid selector */ }
    if (bySelector && isShown(bySelector) && matches(bySelector)) return bySelector;
    if (!target.name && !target.cls) return null;

    // Path points elsewhere now: the matching element nearest the recorded spot
    let best = null;
    let bestDistance = Infinity;
    for (const el of doc.querySelectorAll(target.tag || '*')) {
      if (!matches(el) || !isShown(el)) continue;
      const b = elementBox(el);
      const d = hint ? Math.hypot(b.x + b.width / 2 - hint.x, b.y + b.height / 2 - hint.y) : 0;
      if (d < bestDistance) {
        best = el;
        bestDistance = d;
      }
    }
    return best;
  }

  // Where to click the target now, in top-frame px, scrolling it into view
  // first if needed
  function locateClickTarget(target, hint) {
    const el = findClickTarget(target, hint);
    if (!el) return { found: false };
    const view = windowRegion();
    let box = elementBox(el);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx < 0 || cy < 0 || cx > view.width || cy > view.height) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      box = elementBox(el);
    }
    const fx = typeof target.fx === 'number' ? target.fx : 0.5;
    const fy = typeof target.fy === 'number' ? target.fy : 0.5;
    return {
      found: true,
      disabled: isDisabled(el),
      x: box.x + box.width * fx,
      y: box.y + box.height * fy
    };
  }

  // ── Element picker ──────────────────────────────────────────────────
  // Hover highlights the element under the mouse (in same-origin frames
  // too), click picks it. ↑ widens the pick to the parent, ↓ steps back
  // down, Esc cancels. The page doesn't see the clicks while picking.
  let picker = null;

  // purpose 'capture' picks the capture element; 'click' picks an element
  // for a macro step to click
  function startElementPicker(purpose = 'capture') {
    if (picker) return;
    // Hide the current area while picking; restored if cancelled
    if (captureRectDiv) captureRectDiv.style.display = 'none';
    if (elementOutline) elementOutline.hidden = true;

    const box = buildOverlayBox('#1e88e5', 'rgba(30, 136, 229, 0.15)', 'solid');
    box.root.style.display = 'none';
    const hint = document.createElement('div');
    hint.dataset.cheezingOverlay = 'hint';
    Object.assign(hint.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '10000000',
      padding: '6px 12px',
      borderRadius: '6px',
      background: 'rgba(20, 20, 20, 0.85)',
      color: '#fff',
      font: '600 12px/1.4 sans-serif',
      pointerEvents: 'none',
      whiteSpace: 'nowrap'
    });
    const forClick = purpose === 'click';
    hint.textContent = (forClick ? 'Click the element the macro should click' : 'Click an element to capture') +
      ' · ↑ larger · ↓ smaller · Esc to cancel';
    chrome.storage.local.get('settings', ({ settings }) => {
      if (settings && settings.language === 'ko') {
        hint.textContent = (forClick ? '매크로가 클릭할 요소를 클릭' : '캡처할 요소를 클릭') +
          ' · ↑ 더 크게 · ↓ 더 작게 · Esc 취소';
      }
    });
    document.documentElement.appendChild(box.root);
    document.documentElement.appendChild(hint);

    picker = { box, hint, purpose, hovered: null, current: null, trail: [], docs: [], raf: 0 };

    const blockEvent = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      let el = e.target;
      if (!el || el.nodeType !== 1 || isOwnOverlay(el)) return;
      if (el === el.ownerDocument.documentElement) el = el.ownerDocument.body || el;
      if (el === picker.hovered) return;
      picker.hovered = el;
      picker.trail = [];
      picker.current = el;
    };
    const onClick = (e) => {
      blockEvent(e);
      if (picker.current) pick(picker.current);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        blockEvent(e);
        finishPicker();
        if (captureRectDiv && currentRect) captureRectDiv.style.display = 'block';
        if (elementOutline) elementOutline.hidden = false;
        chrome.runtime.sendMessage({ command: 'areaSelectionCancelled' });
      } else if (e.key === 'ArrowUp' && picker.current) {
        blockEvent(e);
        const parent = pickerParent(picker.current);
        if (parent) {
          picker.trail.push(picker.current);
          picker.current = parent;
        }
      } else if (e.key === 'ArrowDown' && picker.trail.length) {
        blockEvent(e);
        picker.current = picker.trail.pop();
      } else if (e.key === 'Enter' && picker.current) {
        blockEvent(e);
        pick(picker.current);
      }
    };
    const listeners = [
      ['mousemove', onMove], ['click', onClick], ['keydown', onKeyDown],
      ['mousedown', blockEvent], ['mouseup', blockEvent], ['pointerdown', blockEvent],
      ['pointerup', blockEvent], ['dblclick', blockEvent], ['contextmenu', blockEvent]
    ];
    forEachDocument((doc) => {
      for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);
      const style = doc.createElement('style');
      style.textContent = '* { cursor: crosshair !important; }';
      (doc.head || doc.documentElement).appendChild(style);
      picker.docs.push({ doc, style });
    });
    picker.listeners = listeners;

    // Follows the highlighted element as the page scrolls or changes
    let countedFor = null;
    let imageNote = '';
    const tick = () => {
      if (!picker) return;
      const el = picker.current;
      if (el && el.isConnected) {
        if (countedFor !== el) {
          countedFor = el;
          imageNote = forClick ? '' : imageCountNote(findElementImages(el).length);
        }
        const r = el.getBoundingClientRect();
        placeOverlayBox(box, elementBox(el), `${describeElement(el)}  ${Math.round(r.width)}×${Math.round(r.height)}${imageNote}`);
      } else {
        box.root.style.display = 'none';
      }
      picker.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  let isKorean = false;
  chrome.storage.local.get('settings', ({ settings }) => {
    isKorean = !!settings && settings.language === 'ko';
  });

  function imageCountNote(n) {
    if (!n) return '';
    if (isKorean) return `  · 이미지 ${n}개`;
    return `  · ${n} image${n === 1 ? '' : 's'}`;
  }

  // The element one level out, crossing from a frame's body to the frame
  function pickerParent(el) {
    const doc = el.ownerDocument;
    const parent = el.parentElement;
    if (parent && parent !== doc.documentElement) return parent;
    const win = viewOf(el);
    if (win.document !== document && win.frameElement) return win.frameElement;
    return null;
  }

  function pick(el) {
    if (picker.purpose === 'click') {
      el = clickableOf(el);
      finishPicker();
      if (captureRectDiv && currentRect) captureRectDiv.style.display = 'block';
      if (elementOutline) elementOutline.hidden = false;
      const box = elementBox(el);
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      chrome.runtime.sendMessage({
        command: 'elementSelected',
        purpose: 'click',
        element: { target: buildClickTarget(el, center), x: center.x, y: center.y }
      });
      return;
    }
    const ref = buildElementRef(el);
    finishPicker();
    // The element replaces a drawn area
    removeRectBox();
    rectRatio = null;
    chrome.runtime.sendMessage({ command: 'elementSelected', element: ref });
    showElementOutline(ref, el);
  }

  function finishPicker() {
    if (!picker) return;
    cancelAnimationFrame(picker.raf);
    for (const { doc, style } of picker.docs) {
      for (const [type, fn] of picker.listeners) doc.removeEventListener(type, fn, true);
      style.remove();
    }
    picker.box.root.remove();
    picker.hint.remove();
    picker = null;
  }

  // ── Picked element outline ──────────────────────────────────────────
  // Shown around the picked element and kept on it as the page scrolls,
  // resizes or re-renders. Like the area box it ignores the mouse, except
  // for its close button, which clears the pick.
  let elementOutline = null;
  const OUTLINE_LOOKUP_INTERVAL = 500; // ms between lookups while the element is missing

  function showElementOutline(ref, el) {
    clearElementOutline();
    const box = buildOverlayBox('red', 'rgba(255, 0, 0, 0.08)', 'dashed');
    const closeBtn = buildCloseButton();
    box.root.appendChild(closeBtn);
    box.root.style.display = 'none';
    document.documentElement.appendChild(box.root);
    elementOutline = { ref, el, box, closeBtn, hidden: false, lookedUpAt: 0, raf: 0 };
    updateRectInteractivity();

    const tick = () => {
      const o = elementOutline;
      if (!o) return;
      if ((!o.el || !o.el.isConnected) && Date.now() - o.lookedUpAt >= OUTLINE_LOOKUP_INTERVAL) {
        o.el = resolveElementRef(o.ref);
        o.lookedUpAt = Date.now();
      }
      if (!o.hidden && o.el && o.el.isConnected) {
        placeOverlayBox(o.box, elementBox(o.el), o.ref.label + imageCountNote(o.ref.imageCount));
      } else {
        o.box.root.style.display = 'none';
      }
      o.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function clearElementOutline() {
    if (!elementOutline) return;
    cancelAnimationFrame(elementOutline.raf);
    elementOutline.box.root.remove();
    elementOutline = null;
  }

  function buildOverlayBox(color, fill, borderStyle) {
    const root = document.createElement('div');
    root.dataset.cheezingOverlay = 'box';
    Object.assign(root.style, {
      position: 'fixed',
      border: `2px ${borderStyle} ${color}`,
      backgroundColor: fill,
      pointerEvents: 'none',
      zIndex: '9999999',
      boxSizing: 'border-box'
    });
    const tag = document.createElement('div');
    Object.assign(tag.style, {
      position: 'absolute',
      left: '-2px',
      bottom: '100%',
      marginBottom: '4px',
      padding: '2px 6px',
      background: color,
      color: '#fff',
      font: '600 11px/1.4 sans-serif',
      borderRadius: '3px',
      whiteSpace: 'pre',
      pointerEvents: 'none'
    });
    root.appendChild(tag);
    return { root, tag };
  }

  function placeOverlayBox(box, r, label) {
    Object.assign(box.root.style, {
      display: 'block',
      left: r.x + 'px',
      top: r.y + 'px',
      width: r.width + 'px',
      height: r.height + 'px'
    });
    if (box.tag.textContent !== label) box.tag.textContent = label;
    // Inside the top edge when there's no room above it
    const inside = r.y < 24;
    box.tag.style.bottom = inside ? 'auto' : '100%';
    box.tag.style.top = inside ? '2px' : 'auto';
    box.tag.style.left = inside ? '2px' : '-2px';
  }

  function isOwnOverlay(el) {
    if (el === captureRectDiv) return true;
    const own = el.closest && el.closest('[data-cheezing-overlay]');
    return !!own && own.ownerDocument === document;
  }

  // ── Recording ───────────────────────────────────────────────────────
  // Listens in the top document and every same-origin frame document, and
  // hooks frames again whenever one (re)loads. Clicks are recorded in
  // top-frame px, which is where playback dispatches them.
  const hookedDocuments = new WeakSet();

  function hookAllDocuments() {
    forEachDocument(hookDocument);
  }

  function hookDocument(doc) {
    if (hookedDocuments.has(doc)) return;
    hookedDocuments.add(doc);
    doc.addEventListener('mousedown', (e) => recordMouseDown(e, doc), true); // capture phase: intercept as early as possible
    doc.addEventListener('keydown', recordKeyDown, true);
    // load doesn't bubble, but capture-phase listeners still see it
    doc.addEventListener('load', (e) => {
      if (e.target.tagName === 'IFRAME' || e.target.tagName === 'FRAME') hookAllDocuments();
    }, true);
  }

  function recordMouseDown(e, doc) {
    if (!isRecording) return;
    const o = frameOffset(viewOf(doc));
    const x = e.clientX + o.x;
    const y = e.clientY + o.y;
    let target = null;
    if (e.target && e.target.nodeType === 1) {
      try {
        target = buildClickTarget(clickableOf(e.target), { x, y });
      } catch (err) {
        target = null; // coordinates alone still replay
      }
    }

    // The click's position, and the element clicked so playback can find it
    // again wherever it has moved
    chrome.runtime.sendMessage({
      command: 'recordAction',
      action: { type: 'click', x, y, target, timestamp: Date.now() }
    });
  }

  function recordKeyDown(e) {
    if (!isRecording) return;

    // Skip standalone modifier keys to avoid cluttering recorded actions
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      return;
    }

    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

    chrome.runtime.sendMessage({
      command: 'recordAction',
      action: {
        type: 'keydown',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode || e.which || 0,
        modifiers: modifiers,
        timestamp: Date.now()
      }
    });
  }

  hookAllDocuments();


// ── Capture area box ──────────────────────────────────────────────────
// The box itself ignores the mouse so the page under it stays usable; only
// its border strips (drag to move) and handles (drag to resize) respond.
// They are switched off while recording or playing back a macro, so macro
// clicks always reach the page.
const EDGE_GRAB = 8;        // px width of the draggable border strips
const HANDLE_SIZE = 10;     // px
const MIN_AREA_SIZE = 10;   // px, smallest width/height when resizing
const HANDLES = {           // [moves left, top, right, bottom edge]
  nw: [1, 1, 0, 0], n: [0, 1, 0, 0], ne: [0, 1, 1, 0], e: [0, 0, 1, 0],
  se: [0, 0, 1, 1], s: [0, 0, 0, 1], sw: [1, 0, 0, 1], w: [1, 0, 0, 0]
};
let currentRect = null;
let sizeTag = null;

function drawPersistentRect(rect) {
  if (!captureRectDiv) buildRectBox();
  currentRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  layoutRectBox();
  captureRectDiv.style.display = 'block';
  updateRectInteractivity();
}

function buildRectBox() {
  captureRectDiv = document.createElement('div');
  Object.assign(captureRectDiv.style, {
    position: 'fixed',
    border: '2px dashed red',
    backgroundColor: 'rgba(255, 0, 0, 0.1)',
    pointerEvents: 'none',
    zIndex: '9999999',
    boxSizing: 'border-box'
  });

  // Border strips: drag to move
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const strip = document.createElement('div');
    strip.dataset.cheezingGrip = 'move';
    const horizontal = side === 'top' || side === 'bottom';
    Object.assign(strip.style, {
      position: 'absolute',
      cursor: 'move',
      [side]: `-${EDGE_GRAB / 2}px`,
      [horizontal ? 'left' : 'top']: '0',
      [horizontal ? 'width' : 'height']: '100%',
      [horizontal ? 'height' : 'width']: `${EDGE_GRAB}px`
    });
    strip.addEventListener('mousedown', (e) => startRectDrag(e, 'move'));
    captureRectDiv.appendChild(strip);
  }

  // Handles: drag to resize
  for (const name of Object.keys(HANDLES)) {
    const handle = document.createElement('div');
    handle.dataset.cheezingGrip = name;
    const [l, t, r, b] = HANDLES[name];
    Object.assign(handle.style, {
      position: 'absolute',
      width: `${HANDLE_SIZE}px`,
      height: `${HANDLE_SIZE}px`,
      background: '#fff',
      border: '2px solid red',
      boxSizing: 'border-box',
      cursor: `${name}-resize`,
      left: l ? `-${HANDLE_SIZE / 2}px` : r ? `calc(100% - ${HANDLE_SIZE / 2}px)` : `calc(50% - ${HANDLE_SIZE / 2}px)`,
      top: t ? `-${HANDLE_SIZE / 2}px` : b ? `calc(100% - ${HANDLE_SIZE / 2}px)` : `calc(50% - ${HANDLE_SIZE / 2}px)`
    });
    handle.addEventListener('mousedown', (e) => startRectDrag(e, name));
    captureRectDiv.appendChild(handle);
  }

  captureRectDiv.appendChild(buildCloseButton());

  // Size readout shown while dragging
  sizeTag = document.createElement('div');
  Object.assign(sizeTag.style, {
    position: 'absolute',
    left: '0',
    bottom: '100%',
    marginBottom: '6px',
    padding: '2px 6px',
    background: 'red',
    color: '#fff',
    font: '600 11px/1.4 sans-serif',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
    display: 'none'
  });
  captureRectDiv.appendChild(sizeTag);

  document.body.appendChild(captureRectDiv);
}

// Close button above the top-right corner: clears the area (or picked element)
function buildCloseButton() {
  const closeBtn = document.createElement('div');
  closeBtn.dataset.cheezingGrip = 'close';
  closeBtn.textContent = '×';
  chrome.storage.local.get('settings', ({ settings }) => {
    closeBtn.title = settings && settings.language === 'ko' ? '영역 지우기' : 'Clear area';
  });
  Object.assign(closeBtn.style, {
    position: 'absolute',
    right: '-2px',
    bottom: '100%',
    marginBottom: '6px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: 'red',
    color: '#fff',
    font: '700 14px/18px sans-serif',
    textAlign: 'center',
    cursor: 'pointer',
    userSelect: 'none'
  });
  closeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ command: 'clearArea' });
  });
  return closeBtn;
}

function removeRectBox() {
  if (!captureRectDiv) return;
  captureRectDiv.remove();
  captureRectDiv = null;
  currentRect = null;
}

function layoutRectBox() {
  const r = currentRect;
  Object.assign(captureRectDiv.style, {
    left: r.x + 'px',
    top: r.y + 'px',
    width: r.width + 'px',
    height: r.height + 'px'
  });
  sizeTag.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
}

function updateRectInteractivity() {
  const editable = !isRecording && !rectLocked;
  if (elementOutline) {
    elementOutline.closeBtn.style.pointerEvents = editable ? 'auto' : 'none';
    elementOutline.closeBtn.style.display = editable ? 'block' : 'none';
  }
  if (!captureRectDiv) return;
  for (const grip of captureRectDiv.querySelectorAll('[data-cheezing-grip]')) {
    const name = grip.dataset.cheezingGrip;
    // With a locked ratio only the corners resize (they keep the ratio)
    const sideHandle = name.length === 1;
    const visible = editable && !(sideHandle && rectRatio);
    grip.style.pointerEvents = visible ? 'auto' : 'none';
    if (name !== 'move') grip.style.display = visible ? 'block' : 'none';
  }
}

function startRectDrag(e, grip) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const start = { ...currentRect };
  const startX = e.clientX;
  const startY = e.clientY;
  const doc = document.documentElement;
  const maxW = doc.clientWidth;
  const maxH = doc.clientHeight;
  sizeTag.style.display = 'block';

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (grip === 'move') {
      currentRect.x = clamp(start.x + dx, 0, maxW - start.width);
      currentRect.y = clamp(start.y + dy, 0, maxH - start.height);
    } else {
      currentRect = resizeRect(start, HANDLES[grip], dx, dy, maxW, maxH);
    }
    layoutRectBox();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    sizeTag.style.display = 'none';
    chrome.runtime.sendMessage({
      command: 'areaUpdated',
      rect: { ...currentRect, devicePixelRatio: window.devicePixelRatio || 1 }
    });
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

function resizeRect(start, [l, t, r, b], dx, dy, maxW, maxH) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (l) left = clamp(left + dx, 0, right - MIN_AREA_SIZE);
  if (r) right = clamp(right + dx, left + MIN_AREA_SIZE, maxW);
  if (t) top = clamp(top + dy, 0, bottom - MIN_AREA_SIZE);
  if (b) bottom = clamp(bottom + dy, top + MIN_AREA_SIZE, maxH);

  if (rectRatio) {
    // Corner drag with a locked ratio: follow whichever direction moved more,
    // anchored at the opposite corner, then shrink to fit the screen.
    let w = right - left;
    let h = bottom - top;
    if (w / start.width >= h / start.height) h = w / rectRatio; else w = h * rectRatio;
    const anchorX = l ? start.x + start.width : start.x;
    const anchorY = t ? start.y + start.height : start.y;
    const roomW = l ? anchorX : maxW - anchorX;
    const roomH = t ? anchorY : maxH - anchorY;
    const fit = Math.min(1, roomW / w, roomH / h);
    w *= fit;
    h *= fit;
    left = l ? anchorX - w : anchorX;
    top = t ? anchorY - h : anchorY;
    right = left + w;
    bottom = top + h;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

const MIN_SELECTION_SIZE = 5; // px; smaller drags count as a click, i.e. cancel

function startSelection(ratio) {
  // Hide the current area while drawing, so its grips can't catch the drag
  if (captureRectDiv) captureRectDiv.style.display = 'none';
  if (elementOutline) elementOutline.hidden = true;
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.3)';
  overlay.style.zIndex = '9999998';
  overlay.style.cursor = 'crosshair';
  
  const selection = document.createElement('div');
  selection.style.position = 'absolute';
  selection.style.border = '2px dashed #fff';
  selection.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
  overlay.appendChild(selection);
  document.body.appendChild(overlay);

  let startX, startY;
  let isDragging = false;

  const onMouseDown = (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selection.style.left = startX + 'px';
    selection.style.top = startY + 'px';
    selection.style.width = '0px';
    selection.style.height = '0px';
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    let width = Math.abs(currentX - startX);
    let height = Math.abs(currentY - startY);
    
    if (ratio) {
      if (width / height > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
    }
    
    const x = currentX < startX ? startX - width : startX;
    const y = currentY < startY ? startY - height : startY;
    
    selection.style.left = x + 'px';
    selection.style.top = y + 'px';
    selection.style.width = width + 'px';
    selection.style.height = height + 'px';
  };

  // Removes the overlay and all of its listeners
  const finish = () => {
    overlay.remove();
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  // Esc (or a click without dragging) cancels and keeps the previous area
  const cancel = () => {
    finish();
    if (captureRectDiv && currentRect) captureRectDiv.style.display = 'block';
    if (elementOutline) elementOutline.hidden = false;
    chrome.runtime.sendMessage({ command: 'areaSelectionCancelled' });
  };

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    let width = Math.abs(currentX - startX);
    let height = Math.abs(currentY - startY);
    
    if (ratio) {
      if (width / height > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
    }
    
    const x = currentX < startX ? startX - width : startX;
    const y = currentY < startY ? startY - height : startY;

    if (width < MIN_SELECTION_SIZE || height < MIN_SELECTION_SIZE) {
      cancel();
      return;
    }
    finish();
    clearElementOutline(); // the area replaces a picked element
    rectRatio = ratio || null;

    const rect = { 
      x, 
      y, 
      width, 
      height,
      devicePixelRatio: window.devicePixelRatio || 1
    };
    
    // Send to background
    chrome.runtime.sendMessage({
      command: 'areaSelected',
      rect: rect
    });
    
    drawPersistentRect(rect);
  };

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown, true);
}
})();


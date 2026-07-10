(function installReaderCacheFirstMain() {
  const APPLY_MESSAGE = 'EHPLUS_READER_CACHE_FIRST_APPLY';
  const NL_RETRY_MESSAGE = 'EHPLUS_READER_CACHE_FIRST_NL_RETRY';
  const STATE_KEY = '__EHPLUS_READER_CACHE_FIRST__';
  const ENABLED_STORAGE_KEY = 'EHPLUS_READER_CACHE_FIRST_ENABLED_V2';
  const ORIGINAL_SRC_ATTR = 'data-ehplus-cache-first-original-src';
  const ORIGINAL_SRCSET_ATTR = 'data-ehplus-cache-first-original-srcset';
  const HTTP_URL_PATTERN = /^https?:/i;
  const LOCAL_URL_PATTERN = /^(data:|blob:|chrome-extension:)/i;
  const HARD_RESTORE_TIMEOUT_MS = 32000;
  const NL_RETRY_MAX_ATTEMPTS = 3;
  let placeholderUrl = '';

  function localPlaceholderUrl() {
    if (placeholderUrl) return placeholderUrl;
    const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1361" viewBox="0 0 960 1361" role="img" aria-label="正在读取本地缓存">
  <rect width="960" height="1361" fill="#101418"/>
  <rect x="1" y="1" width="958" height="1359" fill="none" stroke="#2d3842" stroke-width="2"/>
  <g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" text-anchor="middle">
    <text x="480" y="672" fill="#d8e1ea" font-size="42" font-weight="600"><tspan>正在读取本地缓存</tspan><tspan>…</tspan><tspan opacity="0">…<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.32;0.33;1" dur="1.6s" repeatCount="indefinite"/></tspan><tspan opacity="0">…<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.65;0.66;1" dur="1.6s" repeatCount="indefinite"/></tspan></text>
    <circle cx="432" cy="740" r="5" fill="#6aa7ff"><animate attributeName="opacity" values="1;.35;.35;1" dur="1.6s" repeatCount="indefinite"/></circle>
    <circle cx="480" cy="740" r="5" fill="#6aa7ff"><animate attributeName="opacity" values=".35;1;.35;.35" dur="1.6s" repeatCount="indefinite"/></circle>
    <circle cx="528" cy="740" r="5" fill="#6aa7ff"><animate attributeName="opacity" values=".35;.35;1;.35" dur="1.6s" repeatCount="indefinite"/></circle>
  </g>
</svg>`;
    placeholderUrl = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;
    return placeholderUrl;
  }

  // 第三方翻页插件检测已废止（规划 2026-07-06）：不再探测 Super-preloader /
  // Pagetual / AutoPagerize / Infy Scroll 的 DOM 痕迹，只识别 EH＋ 内置自动翻页
  // 自己插入的 data-ehplus-autopager 标记（插入页根节点与分隔条都会带该属性）。
  const OWN_AUTOPAGER_SELECTOR = '[data-ehplus-autopager]';

  const NL_WRAPPER_FLAG = '__ehplusGuardedNlWrapper';
  const initialPageKey = parsePageKey(location.href);
  if (!initialPageKey || window[STATE_KEY]?.installed) return;
  const state = {
    installed: true,
    pageKey: initialPageKey,
    installedAt: Date.now(),
    held: false,
    settled: false,
    cachedUrl: '',
    restoreReason: '',
    originalSrc: '',
    originalSrcset: '',
    observer: null,
    nlRetryingImages: new WeakSet(),
    nlRetryTriedByImage: new WeakMap(),
    wrappedNlFunctions: new WeakMap()
  };
  window[STATE_KEY] = state;
  state.refreshPageKey = refreshPageKey;

  installNlRetryUrlGuard();
  installNlRetryRewrapWatcher();
  installCurrentPageNlRetryHandlers();
  normalizeCurrentNlUrl('install');
  stripCurrentReaderInlineRetryHandlers();
  if (!isReaderCacheFirstEnabled()) {
    installRetryHandlerStripObserver();
    setDisabledStatus(initialPageKey);
    return;
  }

  state.hardRestoreTimer = setTimeout(() => {
    if (!state.settled) restoreOriginal('main-hard-timeout');
  }, HARD_RESTORE_TIMEOUT_MS);

  setStatus('installed');
  if (isNlRetryPageUrl(location.href) || document.documentElement?.dataset?.ehplusCacheFirstMainNlRetryOriginal === '1') {
    state.settled = true;
    clearTimeout(state.hardRestoreTimer);
    installRetryHandlerStripObserver();
    setStatus('nl-retry-bypass', { reason: 'nl-retry' });
    return;
  }
  patchImageSetters();
  scanAndHold('initial');

  if (typeof MutationObserver === 'function') {
    state.observer = new MutationObserver(() => {
      refreshPageKey('mutation');
      stripCurrentReaderInlineRetryHandlers();
      keepCachedImageApplied('mutation');
      scanAndHold('mutation');
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'src', 'srcset']
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    refreshPageKey('message');
    if (message?.type !== APPLY_MESSAGE || message.pageKey !== state.pageKey) return;

    if (message.result === 'hit' && LOCAL_URL_PATTERN.test(message.url || '') && !isOwnAutoPagerActive()) {
      state.cachedUrl = message.url;
      applyCachedUrl(message.url);
      return;
    }

    restoreOriginal(message.reason || message.result || 'restore');
  }, true);

  function parsePageKey(url) {
    try {
      const parsed = new URL(url, location.href);
      const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
      return match ? `${match[1]}:${Number(match[2])}` : null;
    } catch {
      return null;
    }
  }

  function isNlRetryPageUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return /^\/s\/[^/]+\/\d+-\d+\/?$/.test(parsed.pathname) && parsed.searchParams.has('nl');
    } catch {
      return false;
    }
  }

  function isReaderCacheFirstEnabled() {
    try {
      return localStorage.getItem(ENABLED_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setDisabledStatus(key) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusCacheFirstMain = '1';
    html.dataset.ehplusCacheFirstPageKey = key;
    html.dataset.ehplusCacheFirstState = 'disabled';
    html.dataset.ehplusCacheFirstReason = 'setting-disabled';
    html.dataset.ehplusCacheFirstUpdatedAt = String(Date.now());
  }

  function setStatus(status, details = {}) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusCacheFirstMain = '1';
    html.dataset.ehplusCacheFirstMainNlGuard = '1';
    html.dataset.ehplusCacheFirstPageKey = state.pageKey;
    html.dataset.ehplusCacheFirstState = status;
    html.dataset.ehplusCacheFirstUpdatedAt = String(Date.now());
    if (details.reason) html.dataset.ehplusCacheFirstReason = details.reason;
    if (details.source) html.dataset.ehplusCacheFirstSource = details.source;
    if (details.originalSrc) html.dataset.ehplusCacheFirstOriginalSrc = details.originalSrc.slice(0, 240);
  }

  function wrapNlRetryFunction(fn) {
    if (fn?.[NL_WRAPPER_FLAG] === true) return fn;
    if (state.wrappedNlFunctions.has(fn)) return state.wrappedNlFunctions.get(fn);
    function ehplusGuardedNlRetry(token) {
      const handled = navigateToNormalizedNlRetry(token);
      if (handled) return false;
      return fn.apply(this, arguments);
    }
    try {
      ehplusGuardedNlRetry[NL_WRAPPER_FLAG] = true;
    } catch {
      // Marking is best-effort; the WeakMap below still dedupes.
    }
    state.wrappedNlFunctions.set(fn, ehplusGuardedNlRetry);
    return ehplusGuardedNlRetry;
  }

  function installNlRetryUrlGuard() {
    try {
      const existingDescriptor = Object.getOwnPropertyDescriptor(window, 'nl');
      if (existingDescriptor && existingDescriptor.configurable === false) {
        ensureNlRetryFunctionWrapped('install');
        return;
      }

      let currentValue = typeof window.nl === 'function' ? wrapNlRetryFunction(window.nl) : window.nl;

      Object.defineProperty(window, 'nl', {
        configurable: true,
        enumerable: existingDescriptor?.enumerable ?? true,
        get() {
          return currentValue;
        },
        set(value) {
          currentValue = typeof value === 'function' ? wrapNlRetryFunction(value) : value;
          markNlGuard('function-set');
        }
      });
      markNlGuard('installed');
    } catch {
      markNlGuard('install-failed');
    }
  }

  // The site defines `function nl(a) {...}` at the top level of a classic
  // script; that declaration replaces the accessor property above with a
  // plain data property without calling the setter. Once that happens the
  // property stays writable, so re-wrap it by plain assignment.
  function ensureNlRetryFunctionWrapped(source) {
    try {
      const current = window.nl;
      if (typeof current !== 'function' || current[NL_WRAPPER_FLAG] === true) return false;
      const descriptor = Object.getOwnPropertyDescriptor(window, 'nl');
      if (descriptor && !descriptor.get && !descriptor.set && descriptor.writable === false) {
        markNlGuard('rewrap-unwritable');
        return false;
      }
      window.nl = wrapNlRetryFunction(current);
      markNlGuard(`rewrapped-${source}`);
      return true;
    } catch {
      markNlGuard('rewrap-failed');
      return false;
    }
  }

  function installNlRetryRewrapWatcher() {
    const stopAt = Date.now() + 30000;
    const timer = setInterval(() => {
      if (ensureNlRetryFunctionWrapped('watch') || Date.now() > stopAt) clearInterval(timer);
    }, 100);
    document.addEventListener('DOMContentLoaded', () => ensureNlRetryFunctionWrapped('domcontentloaded'), { once: true });
    window.addEventListener('load', () => ensureNlRetryFunctionWrapped('load'), { once: true });
  }

  function navigateToNormalizedNlRetry(token) {
    const value = String(token ?? '').trim();
    if (!value) return false;
    try {
      const stampedImg = findImageByNlToken(value);
      if (stampedImg && !isMainImage(stampedImg)) {
        markNlGuard('suppressed-inserted-token');
        bindNlRetryImage(stampedImg, getImageNlRetryPageUrl(stampedImg), value);
        retryNlReplacementImage(stampedImg, value, getImageNlRetryPageUrl(stampedImg));
        return true;
      }
      const html = document.documentElement;
      if (html?.dataset) {
        html.dataset.ehplusCacheFirstMainNlRetryOriginal = '1';
        html.dataset.ehplusCacheFirstMainNlRetryToken = value.slice(0, 80);
      }
      normalizeCurrentNlUrl('nl-call');
      startNlRetryFromToken(value);
      markNlGuard('suppressed-token');
      return true;
    } catch {
      markNlGuard('suppress-failed');
      return false;
    }
  }

  function findImageByNlToken(token) {
    if (!token) return null;
    for (const img of document.querySelectorAll('img[data-ehplus-cache-first-nl-retry-token], img[data-ehplus-reader-nl-retry-token]')) {
      if (getImageNlRetryToken(img) === token) return img;
    }
    return null;
  }

  function isRetryEligibleImage(img) {
    return img?.tagName === 'IMG'
      && (img.id === 'img' || Boolean(getImageNlRetryToken(img)));
  }

  function normalizeCurrentNlUrl(source) {
    try {
      const parsed = new URL(location.href);
      const values = parsed.searchParams.getAll('nl');
      if (values.length < 1) return false;
      const lastValue = values[values.length - 1];
      const html = document.documentElement;
      if (html?.dataset) {
        html.dataset.ehplusCacheFirstMainNlRetryOriginal = '1';
        html.dataset.ehplusCacheFirstMainNlRetryToken = lastValue.slice(0, 80);
      }
      parsed.searchParams.delete('nl');
      const nextUrl = parsed.href;
      if (nextUrl !== location.href) {
        history.replaceState(history.state, document.title, nextUrl);
        markNlGuard(`cleaned-${source}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  function markNlGuard(status) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusCacheFirstMainNlGuard = '1';
    html.dataset.ehplusCacheFirstMainNlGuardStatus = status;
    html.dataset.ehplusCacheFirstMainNlGuardUpdatedAt = String(Date.now());
  }

  function installRetryHandlerStripObserver() {
    if (typeof MutationObserver !== 'function') return;
    state.observer = new MutationObserver(() => {
      stripCurrentReaderInlineRetryHandlers();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'onerror', 'onclick']
    });
  }

  function installCurrentPageNlRetryHandlers() {
    if (state.nlRetryHandlersInstalled) return;
    state.nlRetryHandlersInstalled = true;
    window.addEventListener('error', (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !isRetryEligibleImage(img)) return;
      const token = getImageNlRetryToken(img) || (isMainImage(img) ? getLoadfailNlRetryToken(document) : '');
      if (!token) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      bindNlRetryImage(img, getImageNlRetryPageUrl(img), token);
      retryNlReplacementImage(img, token, getImageNlRetryPageUrl(img));
    }, true);

    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const trigger = target?.closest?.('[onclick*="nl("], [data-ehplus-cache-first-nl-retry-token], #loadfail');
        const token = trigger ? getElementNlRetryToken(trigger) : '';
        if (!trigger || !token) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        bindNlRetryTrigger(trigger, document, location.href, token);
        startNlRetryFromToken(token);
      }, true);
    }
  }

  function isOwnAutoPagerActive() {
    return Boolean(document.querySelector(OWN_AUTOPAGER_SELECTOR));
  }

  function isMainImage(img) {
    return img?.tagName === 'IMG' && img.id === 'img';
  }

  function extractNlRetryToken(value) {
    if (!value) return '';
    const match = String(value).match(/nl\(['"]([^'"]+)['"]\)/);
    return match ? match[1] : '';
  }

  function getElementNlRetryToken(element) {
    return element?.dataset?.ehplusCacheFirstNlRetryToken
      || extractNlRetryToken(element?.getAttribute?.('onclick'));
  }

  function getImageNlRetryToken(img) {
    return img?.dataset?.ehplusCacheFirstNlRetryToken
      || img?.dataset?.ehplusReaderNlRetryToken
      || extractNlRetryToken(img?.getAttribute?.('onerror'));
  }

  function getLoadfailNlRetryToken(root) {
    const loadfail = root?.querySelector?.('#loadfail');
    return getElementNlRetryToken(loadfail);
  }

  function getImageNlRetryPageUrl(img) {
    return img?.dataset?.ehplusCacheFirstNlRetryPageUrl
      || img?.dataset?.ehplusReaderNlRetryPageUrl
      || cleanNlRetryUrl(location.href);
  }

  function cleanNlRetryUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.searchParams.delete('nl');
      return parsed.href;
    } catch {
      return location.href;
    }
  }

  function addNlRetryParamToUrl(url, token) {
    const parsed = new URL(url, location.href);
    parsed.searchParams.set('nl', token);
    return parsed.href;
  }

  function toAbsoluteUrl(url, baseUrl) {
    if (!url) return '';
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return String(url);
    }
  }

  function markNlRetryStatus(status, details = {}) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusCacheFirstMainNlRetryStatus = status;
    html.dataset.ehplusCacheFirstMainNlRetryUpdatedAt = String(Date.now());
    if (details.token) html.dataset.ehplusCacheFirstMainNlRetryToken = String(details.token).slice(0, 80);
    if (details.url) html.dataset.ehplusCacheFirstMainNlRetryUrl = String(details.url).slice(0, 240);
    if (details.src) html.dataset.ehplusCacheFirstMainNlRetrySrc = String(details.src).slice(0, 240);
    if (details.reason) html.dataset.ehplusCacheFirstMainNlRetryReason = details.reason;
  }

  function notifyNlRetryBypass(token, retryUrl = '') {
    state.settled = true;
    clearTimeout(state.hardRestoreTimer);
    try {
      window.postMessage({
        type: NL_RETRY_MESSAGE,
        pageKey: state.pageKey,
        token: String(token || '').slice(0, 80),
        retryUrl: String(retryUrl || '').slice(0, 240),
        reason: 'nl-retry'
      }, location.origin);
    } catch {
      // Best-effort bridge to isolated world; URL cleanup still happens locally.
    }
  }

  function bindNlRetryImage(img, pageUrl = location.href, explicitToken = '') {
    const stampedToken = getImageNlRetryToken(img);
    const token = explicitToken || stampedToken || (isMainImage(img) ? getLoadfailNlRetryToken(document) : '');
    if (!img || !isRetryEligibleImage(img) || !token || !img.dataset) return false;
    const stampedPageUrl = img.dataset.ehplusCacheFirstNlRetryPageUrl || img.dataset.ehplusReaderNlRetryPageUrl || '';
    const effectivePageUrl = !isMainImage(img) && stampedPageUrl ? stampedPageUrl : pageUrl;
    img.dataset.ehplusCacheFirstNlRetryToken = token;
    img.dataset.ehplusCacheFirstNlRetryPageUrl = cleanNlRetryUrl(effectivePageUrl);
    img.removeAttribute('onerror');
    if ('onerror' in img) img.onerror = null;

    if (img.dataset.ehplusCacheFirstNlRetryBound !== '1' && typeof img.addEventListener === 'function') {
      img.dataset.ehplusCacheFirstNlRetryBound = '1';
      img.addEventListener('error', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        retryNlReplacementImage(img, getImageNlRetryToken(img), getImageNlRetryPageUrl(img));
      }, true);
      img.addEventListener('load', () => {
        if (img.complete && img.naturalWidth && img.naturalHeight) {
          img.dataset.ehplusCacheFirstNlRetryLoaded = '1';
          markNlRetryStatus('loaded', { token: getImageNlRetryToken(img), src: img.currentSrc || img.src });
        }
      }, true);
    }
    scheduleNlRetryFailureCheck(img, 250);
    return true;
  }

  function bindNlRetryTrigger(node, root = document, pageUrl = location.href, explicitToken = '') {
    const token = explicitToken || getElementNlRetryToken(node);
    if (!node || !token) return false;
    const img = findImageByNlToken(token)
      || root?.querySelector?.('#img')
      || document.querySelector('#img');
    if (img) bindNlRetryImage(img, pageUrl, token);
    if (!node.dataset) return true;
    node.dataset.ehplusCacheFirstNlRetryToken = token;
    node.dataset.ehplusCacheFirstNlRetryPageUrl = cleanNlRetryUrl(pageUrl);
    node.removeAttribute('onclick');
    if ('onclick' in node) node.onclick = null;
    if (node.dataset.ehplusCacheFirstNlRetryBound !== '1' && typeof node.addEventListener === 'function') {
      node.dataset.ehplusCacheFirstNlRetryBound = '1';
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        startNlRetryFromToken(node.dataset.ehplusCacheFirstNlRetryToken);
      }, true);
    }
    return true;
  }

  function startNlRetryFromToken(token) {
    if (!token) return false;
    const img = findImageByNlToken(token) || document.querySelector('#img');
    if (!img) return false;
    const pageUrl = isMainImage(img) ? location.href : getImageNlRetryPageUrl(img);
    bindNlRetryImage(img, pageUrl, token);
    retryNlReplacementImage(img, token, getImageNlRetryPageUrl(img));
    return true;
  }

  function getNlRetryTriedUrls(img) {
    let tried = state.nlRetryTriedByImage.get(img);
    if (!tried) {
      tried = new Set();
      state.nlRetryTriedByImage.set(img, tried);
    }
    return tried;
  }

  function scheduleNlRetryFailureCheck(img, delay) {
    if (!img?.dataset?.ehplusCacheFirstNlRetryToken) return;
    clearTimeout(Number(img.dataset.ehplusCacheFirstNlRetryTimer || 0));
    const timer = setTimeout(() => {
      delete img.dataset.ehplusCacheFirstNlRetryTimer;
      if (img.complete && !img.naturalWidth && !img.naturalHeight) {
        retryNlReplacementImage(img, getImageNlRetryToken(img), getImageNlRetryPageUrl(img));
      }
    }, delay);
    img.dataset.ehplusCacheFirstNlRetryTimer = String(timer);
  }

  async function retryNlReplacementImage(img, token, pageUrl) {
    if (!img || !isRetryEligibleImage(img) || !token || state.nlRetryingImages.has(img)) return false;
    const cleanPageUrl = cleanNlRetryUrl(pageUrl || location.href);
    let retryUrl = '';
    try {
      retryUrl = addNlRetryParamToUrl(cleanPageUrl, token);
    } catch {
      markNlRetryStatus('retry-url-failed', { token, reason: 'bad-url' });
      return false;
    }
    if (isMainImage(img)) notifyNlRetryBypass(token, retryUrl);

    const tried = getNlRetryTriedUrls(img);
    if (tried.has(retryUrl) || tried.size >= NL_RETRY_MAX_ATTEMPTS) {
      markNlRetryStatus('stopped', { token, url: retryUrl, reason: tried.has(retryUrl) ? 'duplicate-url' : 'max-attempts' });
      return false;
    }

    tried.add(retryUrl);
    state.nlRetryingImages.add(img);
    markNlRetryStatus('fetch-start', { token, url: retryUrl });
    try {
      const response = await fetch(retryUrl, {
        credentials: 'include',
        referrer: cleanPageUrl
      });
      if (!response?.ok) {
        markNlRetryStatus('fetch-failed', { token, url: retryUrl, reason: `http-${response?.status || 0}` });
        return false;
      }
      const html = await response.text();
      const data = parseNlRetryPage(html, retryUrl);
      if (!data.src && !data.token) {
        markNlRetryStatus('no-replacement', { token, url: retryUrl });
        return false;
      }
      img.dataset.ehplusCacheFirstNlRetryPageUrl = retryUrl;
      if (data.token) img.dataset.ehplusCacheFirstNlRetryToken = data.token;
      if (data.src) {
        img.removeAttribute('onerror');
        img.removeAttribute('srcset');
        if ('onerror' in img) img.onerror = null;
        img.dataset.ehplusCacheFirstNlRetryLoaded = '0';
        if ((img.currentSrc || img.src) === data.src) img.removeAttribute('src');
        img.src = data.src;
        markNlRetryStatus('src-replaced', { token: data.token || token, url: retryUrl, src: data.src });
        scheduleNlRetryFailureCheck(img, 1200);
      } else {
        markNlRetryStatus('token-updated', { token: data.token, url: retryUrl });
      }
      return true;
    } catch {
      markNlRetryStatus('fetch-error', { token, url: retryUrl });
      return false;
    } finally {
      state.nlRetryingImages.delete(img);
    }
  }

  function parseNlRetryPage(html, pageUrl) {
    const result = { src: '', token: '' };
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const img = doc.querySelector('#img');
      const loadfail = doc.querySelector('#loadfail');
      result.src = toAbsoluteUrl(img?.getAttribute('src') || '', pageUrl);
      result.token = getElementNlRetryToken(loadfail) || extractNlRetryToken(img?.getAttribute('onerror'));
      return result;
    } catch {
      const imgTag = String(html || '').match(/<img\b[^>]*\bid=["']img["'][^>]*>/i)?.[0] || '';
      const srcMatch = imgTag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      result.src = toAbsoluteUrl(srcMatch?.[1] || '', pageUrl);
      result.token = extractNlRetryToken(String(html || ''));
      return result;
    }
  }

  function rememberOriginal(img, value, kind) {
    if (!HTTP_URL_PATTERN.test(value || '')) return;
    if (kind === 'srcset') {
      if (!state.originalSrcset) state.originalSrcset = value;
      img.setAttribute(ORIGINAL_SRCSET_ATTR, state.originalSrcset);
      return;
    }
    if (!state.originalSrc) state.originalSrc = value;
    img.setAttribute(ORIGINAL_SRC_ATTR, state.originalSrc);
  }

  function refreshPageKey(source) {
    const nextPageKey = parsePageKey(location.href);
    if (!nextPageKey || nextPageKey === state.pageKey) return nextPageKey;

    state.pageKey = nextPageKey;
    state.held = false;
    state.settled = false;
    state.cachedUrl = '';
    state.restoreReason = '';
    state.originalSrc = '';
    state.originalSrcset = '';
    clearTimeout(state.hardRestoreTimer);
    state.hardRestoreTimer = setTimeout(() => {
      if (!state.settled) restoreOriginal('main-hard-timeout');
    }, HARD_RESTORE_TIMEOUT_MS);

    const img = document.querySelector('#img');
    if (img?.dataset) {
      delete img.dataset.ehplusCacheHit;
      delete img.dataset.ehplusCachePageKey;
      delete img.dataset.ehplusCacheScope;
      delete img.dataset.ehplusCacheFirstPending;
      img.removeAttribute(ORIGINAL_SRC_ATTR);
      img.removeAttribute(ORIGINAL_SRCSET_ATTR);
    }

    setStatus('page-key-reset', { source });
    return nextPageKey;
  }

  function holdImage(img, source) {
    refreshPageKey(source);
    if (!isMainImage(img) || state.settled || isOwnAutoPagerActive()) return false;

    const srcset = img.getAttribute('srcset') || '';
    const src = img.getAttribute('src') || img.src || img.currentSrc || '';
    const hasHttpSrcset = HTTP_URL_PATTERN.test(srcset);
    const hasHttpSrc = HTTP_URL_PATTERN.test(src);
    if (img.dataset.ehplusCacheFirstPending === 'true' && !hasHttpSrcset && !hasHttpSrc) {
      return true;
    }
    if (!hasHttpSrcset && !hasHttpSrc) return false;

    stripCurrentReaderInlineRetryHandlers(img);
    rememberOriginal(img, srcset, 'srcset');
    rememberOriginal(img, src, 'src');

    if (srcset) img.removeAttribute('srcset');
    if (hasHttpSrc) img.src = localPlaceholderUrl();
    img.dataset.ehplusCacheFirstPending = 'true';
    state.held = true;
    setStatus('image-held', { source, originalSrc: state.originalSrc });
    if (state.cachedUrl) applyCachedUrl(state.cachedUrl);
    return true;
  }

  function keepCachedUrlIfSettled(img, value, kind, source) {
    refreshPageKey(source);
    if (!isMainImage(img) || !state.settled || !state.cachedUrl || isOwnAutoPagerActive()) return false;
    if (!HTTP_URL_PATTERN.test(value || '')) return false;

    stripCurrentReaderInlineRetryHandlers(img);
    rememberOriginal(img, value, kind);
    if (kind === 'src') {
      const currentSrc = img.getAttribute('src') || img.src || '';
      if (currentSrc !== state.cachedUrl) {
        img.src = state.cachedUrl;
      }
    }
    setStatus('cached-url-kept', { source, originalSrc: state.originalSrc });
    return true;
  }

  function scanAndHold(source) {
    if (state.settled) return;
    const img = document.querySelector('#img');
    if (img) holdImage(img, source);
  }

  function keepCachedImageApplied(source) {
    if (!state.settled || !state.cachedUrl || isOwnAutoPagerActive()) return false;
    const img = document.querySelector('#img');
    if (!img) return false;
    const currentSrc = img.getAttribute('src') || img.src || img.currentSrc || '';
    const currentSrcset = img.getAttribute('srcset') || '';
    const needsCachedSrc = currentSrc !== state.cachedUrl;
    const needsSrcsetClear = Boolean(currentSrcset);
    const needsDataset = img.dataset.ehplusCacheHit !== 'true' || img.dataset.ehplusCachePageKey !== state.pageKey;
    if (!needsCachedSrc && !needsSrcsetClear && !needsDataset) return false;

    rememberOriginal(img, currentSrcset, 'srcset');
    rememberOriginal(img, currentSrc, 'src');
    if (needsSrcsetClear) img.removeAttribute('srcset');
    delete img.dataset.ehplusCacheFirstPending;
    img.dataset.ehplusCacheHit = 'true';
    img.dataset.ehplusCachePageKey = state.pageKey;
    img.dataset.ehplusCacheScope = 'reader-cache-first-main';
    if (needsCachedSrc) img.src = state.cachedUrl;
    setStatus('cached-url-kept', { source, originalSrc: state.originalSrc });
    return true;
  }

  function applyCachedUrl(url) {
    const img = document.querySelector('#img');
    if (!img) {
      setStatus('hit-wait-image');
      return;
    }
    state.settled = true;
    clearTimeout(state.hardRestoreTimer);
    stripCurrentReaderInlineRetryHandlers(img);
    img.removeAttribute(ORIGINAL_SRC_ATTR);
    img.removeAttribute(ORIGINAL_SRCSET_ATTR);
    delete img.dataset.ehplusCacheFirstPending;
    img.dataset.ehplusCacheHit = 'true';
    img.dataset.ehplusCachePageKey = state.pageKey;
    img.dataset.ehplusCacheScope = 'reader-cache-first-main';
    img.src = url;
    setStatus('hit');
  }

  function restoreOriginal(reason) {
    const img = document.querySelector('#img');
    state.restoreReason = reason;
    state.settled = true;
    clearTimeout(state.hardRestoreTimer);
    if (!img) {
      setStatus('restore-no-image', { reason });
      return;
    }

    const srcset = state.originalSrcset || img.getAttribute(ORIGINAL_SRCSET_ATTR) || '';
    const src = state.originalSrc || img.getAttribute(ORIGINAL_SRC_ATTR) || '';
    delete img.dataset.ehplusCacheFirstPending;
    stripCurrentReaderInlineRetryHandlers(img);
    if (srcset) img.setAttribute('srcset', srcset);
    if (src) img.src = src;
    img.removeAttribute(ORIGINAL_SRC_ATTR);
    img.removeAttribute(ORIGINAL_SRCSET_ATTR);
    setStatus('restore', { reason, originalSrc: src });
  }

  function patchImageSetters() {
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const srcsetDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
    const originalSetAttribute = Element.prototype.setAttribute;

    if (srcDescriptor?.set && srcDescriptor?.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDescriptor.enumerable,
        get: srcDescriptor.get,
        set(value) {
          const stringValue = String(value ?? '');
          if (keepCachedUrlIfSettled(this, stringValue, 'src', 'src-setter')) return;
          if (isMainImage(this) && !state.settled && HTTP_URL_PATTERN.test(stringValue) && !isOwnAutoPagerActive()) {
            stripCurrentReaderInlineRetryHandlers(this);
            rememberOriginal(this, stringValue, 'src');
            this.dataset.ehplusCacheFirstPending = 'true';
            srcDescriptor.set.call(this, localPlaceholderUrl());
            state.held = true;
            setStatus('src-held', { source: 'setter', originalSrc: state.originalSrc });
            return;
          }
          srcDescriptor.set.call(this, value);
        }
      });
    }

    if (srcsetDescriptor?.set && srcsetDescriptor?.get) {
      Object.defineProperty(HTMLImageElement.prototype, 'srcset', {
        configurable: true,
        enumerable: srcsetDescriptor.enumerable,
        get: srcsetDescriptor.get,
        set(value) {
          const stringValue = String(value ?? '');
          if (keepCachedUrlIfSettled(this, stringValue, 'srcset', 'srcset-setter')) return;
          if (isMainImage(this) && !state.settled && HTTP_URL_PATTERN.test(stringValue) && !isOwnAutoPagerActive()) {
            stripCurrentReaderInlineRetryHandlers(this);
            rememberOriginal(this, stringValue, 'srcset');
            this.dataset.ehplusCacheFirstPending = 'true';
            state.held = true;
            setStatus('srcset-held', { source: 'setter' });
            return;
          }
          srcsetDescriptor.set.call(this, value);
        }
      });
    }

    Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
      const lowerName = String(name || '').toLowerCase();
      const stringValue = String(value ?? '');
      if (lowerName === 'src' && keepCachedUrlIfSettled(this, stringValue, 'src', 'setAttribute')) {
        return undefined;
      }
      if (lowerName === 'srcset' && keepCachedUrlIfSettled(this, stringValue, 'srcset', 'setAttribute')) {
        return undefined;
      }
      refreshPageKey('setAttribute');
      if (isMainImage(this) && !state.settled && !isOwnAutoPagerActive()) {
        if (lowerName === 'src' && HTTP_URL_PATTERN.test(stringValue)) {
          stripCurrentReaderInlineRetryHandlers(this);
          rememberOriginal(this, stringValue, 'src');
          this.dataset.ehplusCacheFirstPending = 'true';
          srcDescriptor?.set?.call(this, localPlaceholderUrl());
          state.held = true;
          setStatus('src-held', { source: 'setAttribute', originalSrc: state.originalSrc });
          return undefined;
        }
        if (lowerName === 'src' && this.dataset.ehplusCacheFirstPending === 'true') {
          return undefined;
        }
        if (lowerName === 'srcset' && HTTP_URL_PATTERN.test(stringValue)) {
          stripCurrentReaderInlineRetryHandlers(this);
          rememberOriginal(this, stringValue, 'srcset');
          this.dataset.ehplusCacheFirstPending = 'true';
          state.held = true;
          setStatus('srcset-held', { source: 'setAttribute' });
          return undefined;
        }
      }
      return originalSetAttribute.call(this, name, value);
    };
  }

  function stripCurrentReaderInlineRetryHandlers(img = document.querySelector('#img')) {
    if (img) stripInlineImageRetryHandler(img);
    const loadfail = document.querySelector('#loadfail');
    if (loadfail) stripInlineLoadfailRetryHandler(loadfail);
  }

  function stripInlineImageRetryHandler(img) {
    if (!img) return;
    bindNlRetryImage(img, location.href);
    img.removeAttribute('onerror');
    if ('onerror' in img) img.onerror = null;
  }

  function stripInlineLoadfailRetryHandler(node) {
    if (!node) return;
    bindNlRetryTrigger(node, document, location.href);
    node.removeAttribute('onclick');
    if ('onclick' in node) node.onclick = null;
  }
})();

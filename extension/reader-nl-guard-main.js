(function installReaderNlGuardMain() {
  const MESSAGE = 'EHPLUS_READER_CACHE_FIRST_NL_RETRY';
  const STATE_KEY = '__EHPLUS_READER_NL_GUARD__';
  const NL_WRAPPER_FLAG = '__ehplusGuardedNlWrapper';
  const MAX_ATTEMPTS = 3;
  const READER_PATH_PATTERN = /^\/s\/[^/]+\/\d+-\d+\/?$/;

  if (!isReaderPage(location.href) || window[STATE_KEY]?.installed) return;

  const state = {
    installed: true,
    retryingImages: new WeakSet(),
    triedUrlsByImage: new WeakMap(),
    wrappedNlFunctions: new WeakMap()
  };
  window[STATE_KEY] = state;

  installNlFunctionGuard();
  installNlFunctionRewrapWatcher();
  installCaptureHandlers();
  normalizeCurrentNlUrl('install');
  stripCurrentRetryHandlers();
  installRetryHandlerObserver();
  setTimeout(stripCurrentRetryHandlers, 0);
  setTimeout(stripCurrentRetryHandlers, 250);

  function isReaderPage(url) {
    try {
      const parsed = new URL(url, location.href);
      return READER_PATH_PATTERN.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function pageKeyFromUrl(url = location.href) {
    try {
      const match = new URL(url, location.href).pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
      return match ? `${match[1]}:${Number(match[2])}` : '';
    } catch {
      return '';
    }
  }

  function wrapNlFunction(fn) {
    if (fn?.[NL_WRAPPER_FLAG] === true) return fn;
    if (state.wrappedNlFunctions.has(fn)) return state.wrappedNlFunctions.get(fn);
    function guardedNl(token) {
      if (startNlRetryFromToken(token)) return false;
      return fn.apply(this, arguments);
    }
    try {
      guardedNl[NL_WRAPPER_FLAG] = true;
    } catch {
      // Marking is best-effort; the WeakMap below still dedupes.
    }
    state.wrappedNlFunctions.set(fn, guardedNl);
    return guardedNl;
  }

  function installNlFunctionGuard() {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'nl');
      if (descriptor && descriptor.configurable === false) {
        ensureNlFunctionWrapped('install');
        return;
      }

      let currentValue = typeof window.nl === 'function' ? wrapNlFunction(window.nl) : window.nl;
      Object.defineProperty(window, 'nl', {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return currentValue;
        },
        set(value) {
          currentValue = typeof value === 'function' ? wrapNlFunction(value) : value;
          markGuard('function-set');
        }
      });
      markGuard('installed');
    } catch {
      markGuard('install-failed');
    }
  }

  // A top-level `function nl(a) {...}` declaration in a classic site script
  // replaces the accessor above with a plain data property without invoking
  // the setter (CreateGlobalFunctionBinding). Re-wrap by assignment once the
  // raw site function shows up; the redefined property stays writable.
  function ensureNlFunctionWrapped(source) {
    try {
      const current = window.nl;
      if (typeof current !== 'function' || current[NL_WRAPPER_FLAG] === true) return false;
      const descriptor = Object.getOwnPropertyDescriptor(window, 'nl');
      if (descriptor && !descriptor.get && !descriptor.set && descriptor.writable === false) {
        markGuard('rewrap-unwritable');
        return false;
      }
      window.nl = wrapNlFunction(current);
      markGuard(`rewrapped-${source}`);
      return true;
    } catch {
      markGuard('rewrap-failed');
      return false;
    }
  }

  function installNlFunctionRewrapWatcher() {
    const stopAt = Date.now() + 30000;
    const timer = setInterval(() => {
      if (ensureNlFunctionWrapped('watch') || Date.now() > stopAt) clearInterval(timer);
    }, 100);
    document.addEventListener('DOMContentLoaded', () => ensureNlFunctionWrapped('domcontentloaded'), { once: true });
    window.addEventListener('load', () => ensureNlFunctionWrapped('load'), { once: true });
  }

  function installCaptureHandlers() {
    window.addEventListener('error', (event) => {
      const img = event.target;
      if (!isRetryEligibleImage(img)) return;
      const token = getImageNlRetryToken(img) || (isMainImage(img) ? getLoadfailNlRetryToken(document) : '');
      if (!token) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      bindNlRetryImage(img, location.href, token);
      retryNlReplacementImage(img, token, getImageNlRetryPageUrl(img));
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const trigger = target?.closest?.('[onclick*="nl("], [data-ehplus-reader-nl-retry-token], [data-ehplus-cache-first-nl-retry-token], #loadfail');
      const token = trigger ? getElementNlRetryToken(trigger) : '';
      if (!trigger || !token) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      bindNlRetryTrigger(trigger, document, location.href, token);
      startNlRetryFromToken(token);
    }, true);
  }

  function installRetryHandlerObserver() {
    if (typeof MutationObserver !== 'function' || !document.documentElement) return;
    new MutationObserver(stripCurrentRetryHandlers).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'onerror', 'onclick']
    });
  }

  function stripCurrentRetryHandlers() {
    const img = document.querySelector('#img');
    if (img) bindNlRetryImage(img, location.href);
    const loadfail = document.querySelector('#loadfail');
    if (loadfail) bindNlRetryTrigger(loadfail, document, location.href);
  }

  function normalizeCurrentNlUrl(source) {
    try {
      const parsed = new URL(location.href);
      const values = parsed.searchParams.getAll('nl');
      if (values.length < 1) return false;
      const token = values[values.length - 1];
      markOriginalNlRetry(token);
      parsed.searchParams.delete('nl');
      if (parsed.href !== location.href) {
        history.replaceState(history.state, document.title, parsed.href);
        markGuard(`cleaned-${source}`);
      }
      startNlRetryFromToken(token);
      return true;
    } catch {
      return false;
    }
  }

  function startNlRetryFromToken(token) {
    const value = String(token ?? '').trim();
    if (!value) return false;

    const stampedImg = findImageByNlToken(value);
    if (stampedImg && !isMainImage(stampedImg)) {
      markGuard('suppressed-inserted-token');
      bindNlRetryImage(stampedImg, getImageNlRetryPageUrl(stampedImg), value);
      retryNlReplacementImage(stampedImg, value, getImageNlRetryPageUrl(stampedImg));
      return true;
    }

    normalizeCurrentNlUrl('nl-call');
    markOriginalNlRetry(value);
    markGuard('suppressed-token');
    const img = document.querySelector('#img');
    if (!img) {
      markRetry('wait-image', { token: value });
      return true;
    }
    bindNlRetryImage(img, location.href, value);
    retryNlReplacementImage(img, value, getImageNlRetryPageUrl(img));
    return true;
  }

  function findImageByNlToken(token) {
    if (!token) return null;
    for (const img of document.querySelectorAll('img[data-ehplus-reader-nl-retry-token], img[data-ehplus-cache-first-nl-retry-token]')) {
      if (getImageNlRetryToken(img) === token) return img;
    }
    return null;
  }

  function isRetryEligibleImage(img) {
    return img?.tagName === 'IMG'
      && (img.id === 'img' || Boolean(getImageNlRetryToken(img)));
  }

  function extractNlRetryToken(value) {
    if (!value) return '';
    const match = String(value).match(/nl\(['"]([^'"]+)['"]\)/);
    return match ? match[1] : '';
  }

  function getElementNlRetryToken(element) {
    return element?.dataset?.ehplusReaderNlRetryToken
      || element?.dataset?.ehplusCacheFirstNlRetryToken
      || extractNlRetryToken(element?.getAttribute?.('onclick'));
  }

  function getImageNlRetryToken(img) {
    return img?.dataset?.ehplusReaderNlRetryToken
      || img?.dataset?.ehplusCacheFirstNlRetryToken
      || extractNlRetryToken(img?.getAttribute?.('onerror'));
  }

  function getLoadfailNlRetryToken(root) {
    return getElementNlRetryToken(root?.querySelector?.('#loadfail'));
  }

  function getImageNlRetryPageUrl(img) {
    return img?.dataset?.ehplusReaderNlRetryPageUrl
      || img?.dataset?.ehplusCacheFirstNlRetryPageUrl
      || cleanNlRetryUrl(location.href);
  }

  function bindNlRetryImage(img, pageUrl = location.href, explicitToken = '') {
    const stampedToken = getImageNlRetryToken(img);
    const token = explicitToken || stampedToken || (isMainImage(img) ? getLoadfailNlRetryToken(document) : '');
    if (!isRetryEligibleImage(img) || !token || !img.dataset) return false;
    const stampedPageUrl = img.dataset.ehplusReaderNlRetryPageUrl || img.dataset.ehplusCacheFirstNlRetryPageUrl || '';
    const effectivePageUrl = !isMainImage(img) && stampedPageUrl ? stampedPageUrl : pageUrl;
    img.dataset.ehplusReaderNlRetryToken = token;
    img.dataset.ehplusCacheFirstNlRetryToken = token;
    img.dataset.ehplusReaderNlRetryPageUrl = cleanNlRetryUrl(effectivePageUrl);
    img.dataset.ehplusCacheFirstNlRetryPageUrl = cleanNlRetryUrl(effectivePageUrl);
    img.removeAttribute('onerror');
    if ('onerror' in img) img.onerror = null;
    scheduleFailureCheck(img, 250);
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
    node.dataset.ehplusReaderNlRetryToken = token;
    node.dataset.ehplusCacheFirstNlRetryToken = token;
    node.dataset.ehplusReaderNlRetryPageUrl = cleanNlRetryUrl(pageUrl);
    node.dataset.ehplusCacheFirstNlRetryPageUrl = cleanNlRetryUrl(pageUrl);
    node.removeAttribute('onclick');
    if ('onclick' in node) node.onclick = null;
    return true;
  }

  function isMainImage(img) {
    return img?.tagName === 'IMG' && img.id === 'img';
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

  function getTriedUrls(img) {
    let tried = state.triedUrlsByImage.get(img);
    if (!tried) {
      tried = new Set();
      state.triedUrlsByImage.set(img, tried);
    }
    return tried;
  }

  function scheduleFailureCheck(img, delay) {
    if (!img?.dataset?.ehplusReaderNlRetryToken) return;
    clearTimeout(Number(img.dataset.ehplusReaderNlRetryTimer || 0));
    const timer = setTimeout(() => {
      delete img.dataset.ehplusReaderNlRetryTimer;
      if (img.complete && !img.naturalWidth && !img.naturalHeight) {
        retryNlReplacementImage(img, getImageNlRetryToken(img), getImageNlRetryPageUrl(img));
      }
    }, delay);
    img.dataset.ehplusReaderNlRetryTimer = String(timer);
  }

  async function retryNlReplacementImage(img, token, pageUrl) {
    if (!isRetryEligibleImage(img) || !token || state.retryingImages.has(img)) return false;
    const cleanPageUrl = cleanNlRetryUrl(pageUrl || location.href);
    let retryUrl = '';
    try {
      retryUrl = addNlRetryParamToUrl(cleanPageUrl, token);
    } catch {
      markRetry('retry-url-failed', { token, reason: 'bad-url' });
      return false;
    }
    if (isMainImage(img)) notifyNlRetryBypass(token, retryUrl);

    const tried = getTriedUrls(img);
    if (tried.has(retryUrl) || tried.size >= MAX_ATTEMPTS) {
      markRetry('stopped', { token, url: retryUrl, reason: tried.has(retryUrl) ? 'duplicate-url' : 'max-attempts' });
      return false;
    }

    tried.add(retryUrl);
    state.retryingImages.add(img);
    markRetry('fetch-start', { token, url: retryUrl });
    try {
      const response = await fetch(retryUrl, {
        credentials: 'include',
        referrer: cleanPageUrl
      });
      if (!response?.ok) {
        markRetry('fetch-failed', { token, url: retryUrl, reason: `http-${response?.status || 0}` });
        return false;
      }
      const data = parseNlRetryPage(await response.text(), retryUrl);
      if (!data.src && !data.token) {
        markRetry('no-replacement', { token, url: retryUrl });
        return false;
      }
      img.dataset.ehplusReaderNlRetryPageUrl = retryUrl;
      img.dataset.ehplusCacheFirstNlRetryPageUrl = retryUrl;
      if (data.token) {
        img.dataset.ehplusReaderNlRetryToken = data.token;
        img.dataset.ehplusCacheFirstNlRetryToken = data.token;
      }
      if (data.src) {
        img.removeAttribute('onerror');
        img.removeAttribute('srcset');
        if ('onerror' in img) img.onerror = null;
        img.dataset.ehplusReaderNlRetryLoaded = '0';
        if ((img.currentSrc || img.src) === data.src) img.removeAttribute('src');
        img.src = data.src;
        markRetry('src-replaced', { token: data.token || token, url: retryUrl, src: data.src });
        scheduleFailureCheck(img, 1200);
      } else {
        markRetry('token-updated', { token: data.token, url: retryUrl });
      }
      return true;
    } catch {
      markRetry('fetch-error', { token, url: retryUrl });
      return false;
    } finally {
      state.retryingImages.delete(img);
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

  function notifyNlRetryBypass(token, retryUrl = '') {
    try {
      window.postMessage({
        type: MESSAGE,
        pageKey: pageKeyFromUrl(),
        token: String(token || '').slice(0, 80),
        retryUrl: String(retryUrl || '').slice(0, 240),
        reason: 'nl-retry'
      }, location.origin);
    } catch {
      // Best-effort bridge; the guard still prevents top-level nl navigation.
    }
  }

  function markOriginalNlRetry(token) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusCacheFirstMainNlRetryOriginal = '1';
    html.dataset.ehplusCacheFirstMainNlRetryToken = String(token || '').slice(0, 80);
  }

  function markGuard(status) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusReaderNlGuard = '1';
    html.dataset.ehplusReaderNlGuardStatus = status;
    html.dataset.ehplusReaderNlGuardUpdatedAt = String(Date.now());
    html.dataset.ehplusCacheFirstMainNlGuard = '1';
    html.dataset.ehplusCacheFirstMainNlGuardStatus = status;
    html.dataset.ehplusCacheFirstMainNlGuardUpdatedAt = html.dataset.ehplusReaderNlGuardUpdatedAt;
  }

  function markRetry(status, details = {}) {
    const html = document.documentElement;
    if (!html?.dataset) return;
    html.dataset.ehplusReaderNlRetryStatus = status;
    html.dataset.ehplusReaderNlRetryUpdatedAt = String(Date.now());
    html.dataset.ehplusCacheFirstMainNlRetryStatus = status;
    html.dataset.ehplusCacheFirstMainNlRetryUpdatedAt = html.dataset.ehplusReaderNlRetryUpdatedAt;
    if (details.token) html.dataset.ehplusCacheFirstMainNlRetryToken = String(details.token).slice(0, 80);
    if (details.url) html.dataset.ehplusCacheFirstMainNlRetryUrl = String(details.url).slice(0, 240);
    if (details.src) html.dataset.ehplusCacheFirstMainNlRetrySrc = String(details.src).slice(0, 240);
    if (details.reason) html.dataset.ehplusCacheFirstMainNlRetryReason = details.reason;
  }
})();

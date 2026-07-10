function bootstrapEHPlus() {
  bootstrapEHPlusAsync().catch((error) => {
    console.error('[EH＋] bootstrap failed', error);
  });
}

async function bootstrapEHPlusAsync() {
  const pageOrigin = location.origin;
  const bridgeOriginPattern = /^https?:\/\/(?:e-hentai|exhentai)\.org$/;
  const pageSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const runtime = {
    owner: 'extension',
    extensionVersion: chrome.runtime.getManifest().version,
    state: 'active',
    pageSessionId,
    nonce: Math.random().toString(36).slice(2),
    updatedAt: Date.now(),
    heartbeatAt: Date.now()
  };

  window.__EHPLUS_RUNTIME__ = runtime;
  runtime.takeoverState = 'extension-owner';
  mirrorRuntimeToDataset(runtime);
  cleanupEmbeddedRuntimeStateLogs().catch(() => {});
  readServiceWorkerProbeForDebug().catch(() => {});

  if (bridgeOriginPattern.test(pageOrigin)) {
    window.addEventListener('message', async (event) => {
      if (event.source !== window || event.origin !== pageOrigin) return;
      const request = event.data;
      if (request?.type === LOCAL_READER_CACHE_FIRST_NL_RETRY_TYPE) {
        handleLocalReaderCacheFirstNlRetryMessage(request);
        return;
      }
      if (request?.type !== 'EHPLUS_COOPERATIVE_CACHE_QUERY') return;

      const requestId = typeof request.requestId === 'string'
        ? request.requestId.slice(0, 120)
        : Math.random().toString(36).slice(2);
      try {
        const response = await chrome.runtime.sendMessage({
          ...request,
          type: 'EHPLUS_COOPERATIVE_CACHE_QUERY',
          requestedBy: request.requestedBy || 'page-bridge'
        });
        window.postMessage({
          ...response,
          type: 'EHPLUS_COOPERATIVE_CACHE_RESPONSE',
          requestId,
          bridge: 'page'
        }, pageOrigin);
      } catch (error) {
        window.postMessage({
          ok: false,
          type: 'EHPLUS_COOPERATIVE_CACHE_RESPONSE',
          source: 'EH＋',
          requestId,
          bridge: 'page',
          hit: false,
          reason: 'bridge-error',
          error: error?.message || String(error)
        }, pageOrigin);
      }
    });

    scheduleLocalCacheConsumer();
    chrome.runtime.sendMessage({
      type: 'EHPLUS_PAGE_SESSION_STARTED',
      pageSessionId,
      url: location.href,
      ownAutoPagerDomActive: hasBuiltInAutoPagerDom(),
      ...currentPageTitles(),
      observedAt: Date.now()
    }).catch(() => {});
    schedulePageTitleReport(pageSessionId);

    installExternalImageCacheFillReporter(pageSessionId);
    installPageImageActivityGate(pageSessionId);
    installPageNetworkActivityQueryResponder(pageSessionId);
    installBuiltInAutoPager(pageSessionId);
  }

  schedulePanelInit();

  setInterval(() => {
    runtime.heartbeatAt = Date.now();
    runtime.updatedAt = runtime.heartbeatAt;
    window.__EHPLUS_RUNTIME__ = runtime;
    mirrorRuntimeToDataset(runtime);
  }, 2000);
}

// isolated world 的 window.__EHPLUS_RUNTIME__ 对页面不可见，
// 通过 dataset 镜像 + runtime-owner-main.js 在 MAIN world 重建（规划 §5）。
function mirrorRuntimeToDataset(runtime) {
  const data = document.documentElement?.dataset;
  if (!data) return;
  data.ehplusExtension = '1';
  data.ehplusExtensionVersion = runtime.extensionVersion;
  data.ehplusRuntimeOwner = runtime.owner;
  data.ehplusRuntimeState = runtime.state;
  data.ehplusRuntimeTakeoverState = runtime.takeoverState ?? '';
  data.ehplusPageSessionId = runtime.pageSessionId;
  data.ehplusRuntimeNonce = runtime.nonce;
  data.ehplusRuntimeUpdatedAt = String(runtime.updatedAt);
  data.ehplusRuntimeHeartbeatAt = String(runtime.heartbeatAt);
}

function currentPageTitles() {
  return {
    title: document.getElementById('gn')?.textContent?.trim() ?? '',
    originalTitle: document.getElementById('gj')?.textContent?.trim() ?? ''
  };
}

// /g/ 画廊页可见的元数据，用于浏览历史卡片（分类/上传者/评分/页数/封面）。
function currentGalleryMeta() {
  if (!/^\/g\/\d+\//.test(location.pathname)) return null;

  const category = document.querySelector('#gdc .cs')?.textContent?.trim()
    ?? document.getElementById('gdc')?.textContent?.trim()
    ?? '';

  const uploader = document.querySelector('#gdn a')?.textContent?.trim() ?? '';

  const ratingText = document.getElementById('rating_label')?.textContent ?? '';
  const ratingMatch = ratingText.match(/([\d.]+)/);
  const rating = ratingMatch ? Number(ratingMatch[1]) : null;

  let pages = null;
  for (const cell of document.querySelectorAll('#gdd td.gdt2')) {
    const match = cell.textContent?.match(/^\s*([\d,]+)\s+pages?\s*$/i);
    if (match) {
      pages = Number(match[1].replace(/,/g, ''));
      break;
    }
  }

  const thumbStyle = document.querySelector('#gd1 > div')?.getAttribute('style') ?? '';
  const thumbMatch = thumbStyle.match(/url\((['"]?)(https?:[^'")]+)\1\)/i);
  const thumbUrl = thumbMatch ? thumbMatch[2] : '';

  const meta = { category, uploader, rating, pages, thumbUrl };
  return Object.values(meta).some((value) => value !== '' && value !== null) ? meta : null;
}

function schedulePageTitleReport(pageSessionId) {
  const report = () => {
    const titles = currentPageTitles();
    const galleryMeta = currentGalleryMeta();
    if (!titles.title && !titles.originalTitle && !galleryMeta) return;
    chrome.runtime.sendMessage({
      type: 'EHPLUS_PAGE_TITLES_OBSERVED',
      pageSessionId,
      url: location.href,
      ...titles,
      galleryMeta,
      observedAt: Date.now()
    }).catch(() => {});
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report, { once: true });
  } else {
    report();
  }
  setTimeout(report, 750);
  // 页面会话的后台任务约在 750ms 后写入浏览历史，再补一次上报确保历史拿到标题与元数据。
  setTimeout(report, 1800);
}

const STATE_KEY = 'ehplus_live_state';
const LOGS_KEY = 'ehplus_live_logs';
const SERVICE_WORKER_PROBE_KEY = 'ehplus_service_worker_probe';
const PANEL_STATE_MESSAGE_TIMEOUT_MS = 1500;
const PANEL_STATE_MESSAGE_RETRY_COUNT = 3;
const PANEL_STATE_MESSAGE_RETRY_DELAY_MS = 300;
const PANEL_LIVE_REFRESH_INTERVAL_MS = 1500;
const PAGE_IMAGE_ACTIVITY_TYPE = 'EHPLUS_PAGE_IMAGE_ACTIVITY';
const PAGE_NETWORK_ACTIVITY_QUERY_TYPE = 'EHPLUS_PAGE_NETWORK_ACTIVITY_QUERY';
const COOPERATIVE_CACHE_QUERY_TYPE = 'EHPLUS_COOPERATIVE_CACHE_QUERY';
const INTERNAL_CACHE_QUERY_TYPE = 'EHPLUS_INTERNAL_CACHE_QUERY';
const OWN_AUTOPAGER_STATUS_TYPE = 'EHPLUS_REPORT_OWN_AUTOPAGER_STATUS';
const EXTERNAL_IMAGE_CACHE_FILL_TYPE = 'EHPLUS_EXTERNAL_IMAGE_CACHE_FILL';
const LOCAL_CACHE_CONSUMER_REQUESTED_BY = 'EH＋-content';
const LOCAL_CACHE_GALLERY_LIMIT = 48;
const LOCAL_READER_CACHE_FIRST_SOFT_TIMEOUT_MS = 5000;
const LOCAL_READER_CACHE_FIRST_HARD_TIMEOUT_MS = 20000;
const LOCAL_READER_CACHE_FIRST_RELEASE_TIMEOUT_MS = 5000;
const LOCAL_READER_CACHE_FIRST_QUERY_TIMEOUT_MS = 3500;
const LOCAL_READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS = 1500;
const LOCAL_READER_CACHE_FIRST_PAGEKEY_WATCH_MS = 250;
const LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_COUNT = 5;
const LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_DELAY_MS = 1200;
const LOCAL_READER_CACHE_FIRST_HTTP_URL_PATTERN = /^https?:/i;
const LOCAL_READER_CACHE_FIRST_IMG_SELECTOR = '#img';
const LOCAL_READER_CACHE_FIRST_LEGACY_ENABLED_STORAGE_KEY = 'EHPLUS_READER_CACHE_FIRST_ENABLED';
const LOCAL_READER_CACHE_FIRST_ENABLED_STORAGE_KEY = 'EHPLUS_READER_CACHE_FIRST_ENABLED_V2';
const EXTERNAL_IMAGE_CACHE_FILL_LIMIT = 64;
const LOCAL_READER_CACHE_FIRST_MAIN_APPLY_TYPE = 'EHPLUS_READER_CACHE_FIRST_APPLY';
const LOCAL_READER_CACHE_FIRST_NL_RETRY_TYPE = 'EHPLUS_READER_CACHE_FIRST_NL_RETRY';
const LOCAL_READER_CACHE_FIRST_BLOCK_TYPE = 'EHPLUS_READER_CACHE_FIRST_BLOCK';
const LOCAL_READER_CACHE_FIRST_TIMING_TYPE = 'EHPLUS_READER_CACHE_FIRST_TIMING';
const LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR = 'data-ehplus-cache-first-original-src';
const LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR = 'data-ehplus-cache-first-original-srcset';
const LOCAL_READER_CACHE_FIRST_PLACEHOLDER_PATH = 'images/cache-first-placeholder.svg';
const BUILT_IN_AUTOPAGER_ICON_PATHS = {
  top: 'images/autopager/to_top.png',
  bottom: 'images/autopager/to_bottom.png',
  pre: 'images/autopager/up.png',
  preDisabled: 'images/autopager/up_gray.png',
  next: 'images/autopager/donw.png',
  nextDisabled: 'images/autopager/down_gray.png'
};
let externalImageCacheFillTimer = 0;
let builtInAutoPagerController = null;
let localReaderCacheFirstState = null;
let localReaderCacheFirstNetworkBlockMessageId = 0;
let localReaderCacheFirstUrlWatcherInstalled = false;
let localReaderCacheFirstObservedPageKey = null;

function installPageImageActivityGate(pageSessionId) {
  const state = {
    pageSessionId,
    reportedSignature: '',
    scheduled: 0,
    observedImages: new WeakSet()
  };

  const scheduleScan = (reason = 'scan') => {
    clearTimeout(state.scheduled);
    state.scheduled = setTimeout(() => reportPageImageActivity(state, reason), 120);
  };

  scheduleScan('initial-scan');
  document.querySelectorAll('img').forEach((img) => observePageImageActivityImage(state, img, scheduleScan));

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node?.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches?.('img')) observePageImageActivityImage(state, node, scheduleScan);
            node.querySelectorAll?.('img').forEach((img) => observePageImageActivityImage(state, img, scheduleScan));
          });
        } else if (mutation.type === 'attributes' && mutation.target?.matches?.('img')) {
          observePageImageActivityImage(state, mutation.target, scheduleScan);
        }
      }
      scheduleScan('dom-change');
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'loading']
    });
  }
}

function observePageImageActivityImage(state, img, scheduleScan) {
  if (!img || state.observedImages.has(img)) return;
  state.observedImages.add(img);
  img.addEventListener('load', () => scheduleScan('image-load'), true);
  img.addEventListener('error', () => scheduleScan('image-error'), true);
}

function installPageNetworkActivityQueryResponder(pageSessionId) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== PAGE_NETWORK_ACTIVITY_QUERY_TYPE) return false;
    answerPageNetworkActivityQuery(pageSessionId, message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          busy: false,
          error: error?.message || String(error),
          pageSessionId,
          url: location.href,
          observedAt: Date.now()
        });
      });
    return true;
  });
}

async function answerPageNetworkActivityQuery(pageSessionId, message) {
  const pendingImages = collectPendingPageImages();
  const busy = pendingImages.length > 0;
  if (!busy) {
    await reportExternalImageCacheFill(pageSessionId).catch(() => {});
  }
  return {
    ok: true,
    busy,
    pendingRequestCount: pendingImages.length,
    pendingImageCount: pendingImages.length,
    observations: collectReaderImageObservations(),
    pageSessionId,
    pageSessionMatched: !message?.pageSessionId || message.pageSessionId === pageSessionId,
    url: location.href,
    observedAt: Date.now()
  };
}

// 页面图片观测（规划 §953 预加载队列去重）：SW 预加载队列据此把
// 页面已加载的页改为只解析续接、正在加载的页降级到队尾。
const READER_IMAGE_OBSERVATION_LIMIT = 60;

function collectReaderImageObservations() {
  const currentPage = parseReaderPage(location.href);
  if (!currentPage) return [];

  const observations = [];
  const seen = new Set();
  for (const candidate of collectExternalImageCandidates(currentPage, collectReaderPageUrlsByKey())) {
    if (observations.length >= READER_IMAGE_OBSERVATION_LIMIT) break;
    if (!candidate.pageKey || seen.has(candidate.pageKey)) continue;
    const img = candidate.img;
    const url = pageImageActivityUrl(img);
    let state = '';
    if (img.complete === false && url) {
      state = 'loading';
    } else if (img.complete === true && img.naturalWidth > 0) {
      state = 'loaded';
    }
    if (!state) continue;
    seen.add(candidate.pageKey);
    observations.push({
      state,
      pageKey: candidate.pageKey,
      imageUrl: url || undefined
    });
  }
  return observations;
}

async function reportPageImageActivity(state, reason = 'scan') {
  const pendingImages = collectPendingPageImages();
  const busy = pendingImages.length > 0;
  const detection = {
    detected: busy,
    mode: busy ? 'page-image-requests-active' : 'normal',
    shouldYieldNextPageRequests: busy,
    confidence: busy ? 1 : 0,
    pendingImageCount: pendingImages.length,
    matches: busy
      ? [{ id: 'page-image-requests-active', name: 'Page image requests', confidence: 1 }]
      : [],
    reason
  };

  document.documentElement.dataset.ehplusPageImageRequests = busy ? 'active' : 'idle';

  const signature = `${detection.detected}:${pendingImages.length}`;
  if (signature === state.reportedSignature) return;
  state.reportedSignature = signature;

  if (!busy) {
    await reportExternalImageCacheFill(state.pageSessionId).catch(() => {});
  }

  await chrome.runtime.sendMessage({
    type: PAGE_IMAGE_ACTIVITY_TYPE,
    detection,
    pageSessionId: state.pageSessionId,
    url: location.href,
    observedAt: Date.now()
  }).catch(() => {
    state.reportedSignature = '';
  });

  if (busy) {
    scheduleExternalImageCacheFillReport(state.pageSessionId);
  }
}

function collectPendingPageImages() {
  return Array.from(document.querySelectorAll('img'))
    .filter((img) => pageImageActivityUrl(img))
    .filter((img) => img.complete === false);
}

function pageImageActivityUrl(img) {
  const url = img?.currentSrc || img?.src || img?.getAttribute?.('src') || '';
  if (!url) return '';
  try {
    const parsed = new URL(url, location.href);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function isLikelyReaderImageUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url, location.href);
    return parsed.hostname.endsWith('.hath.network')
      || parsed.pathname.includes('/fullimg.php');
  } catch {
    return false;
  }
}

function installBuiltInAutoPager(pageSessionId) {
  if (!isExtensionRuntime() || !isBuiltInAutoPagerSupportedPage(location.href)) return;
  const run = () => {
    readBackendPanelState()
      .catch(() => readStoredPanelState())
      .then((state) => syncBuiltInAutoPagerFromState(state, pageSessionId))
      .catch(() => reportBuiltInAutoPagerStatus({
        pageSessionId,
        enabled: false,
        continuing: false,
        status: 'disabled',
        reason: 'state-unavailable'
      }));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    setTimeout(run, 0);
  }
}

function hasBuiltInAutoPagerDom() {
  return document.documentElement?.dataset?.ehplusOwnAutoPager === '1'
    || Boolean(document.querySelector('[data-ehplus-autopager-page-index], img[id^="sp-exhentai-img-"]'));
}

// 内置自动翻页启动时，isolated 侧 cache-first 主动让位：结束未决的当前页
// 查询，并确认 /s/ 页的 DNR 网络门已释放，再允许拼接流程发起图片请求；
// 否则拼接页图片会被门规则重定向成"正在读取本地缓存"占位图并永久卡住。
async function yieldLocalReaderCacheFirstToBuiltInAutoPager() {
  const pageKey = parseReaderPageKey(location.href);
  if (!pageKey) return;
  const state = localReaderCacheFirstState;
  if (state && !state.settled && state.pageKey === pageKey) {
    settleLocalReaderCacheFirst(state, 'auto-pager');
  }
  await waitForLocalReaderCacheFirstNetworkBlockRelease(pageKey, 'auto-pager');
}

// Aplus 预构建的片段游离在文档外，其中图片加载失败时 error 事件不会经过
// window，MAIN world 的 nl 重试守卫收不到；插入后对已失败的拼接图补发一次
// error 事件，交给守卫按图片自带的 nl token 换源重试。
function retryFailedBuiltInAutoPagerImages(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('img[id^="sp-exhentai-img-"]').forEach((img) => {
    if (!img.complete || img.naturalWidth > 0) return;
    if (!(img.dataset.ehplusCacheFirstNlRetryToken || img.dataset.ehplusReaderNlRetryToken)) return;
    img.dispatchEvent(new Event('error'));
  });
}

function isBuiltInAutoPagerSupportedPage(url) {
  return isReaderPageUrl(url) || isGalleryPageUrl(url);
}

function syncBuiltInAutoPagerFromState(state, pageSessionId = window.__EHPLUS_RUNTIME__?.pageSessionId ?? '') {
  if (!isExtensionRuntime() || !isBuiltInAutoPagerSupportedPage(location.href)) return;
  const settings = state?.settings ?? {};
  if (settings.autoPagerEnabled !== true) {
    if (builtInAutoPagerController) {
      builtInAutoPagerController.stop('setting-disabled');
      builtInAutoPagerController = null;
    } else {
      reportBuiltInAutoPagerStatus({
        pageSessionId,
        enabled: false,
        continuing: false,
        status: 'disabled',
        reason: 'setting-disabled'
      });
    }
    return;
  }

  if (builtInAutoPagerController) {
    builtInAutoPagerController.updateSettings(settings);
    return;
  }

  builtInAutoPagerController = isReaderPageUrl(location.href)
    ? createBuiltInAutoPagerController(pageSessionId, settings)
    : createBuiltInGalleryAutoPagerController(pageSessionId, settings);
  builtInAutoPagerController.start();
}

function createBuiltInAutoPagerController(pageSessionId, settings) {
  // EH/EX 最后一页的 #next 会指回当前页自身，必须按 gid:pageNo 去重，
  // 否则拉到底后会无限拼接最后一页（与 /g/ 控制器的 seenPageUrls 同理）。
  const seenPageKeys = new Set([parseReaderPageKey(location.href)].filter(Boolean));
  const resolveNextUrl = (candidate) => {
    const pageKey = parseReaderPageKey(candidate);
    if (!pageKey || seenPageKeys.has(pageKey)) return '';
    return candidate;
  };

  const state = {
    pageSessionId,
    settings: normalizeBuiltInAutoPagerSettings(settings),
    appendedPages: 0,
    working: false,
    stopped: false,
    status: 'idle',
    nextUrl: resolveNextUrl(readerNextUrlFromDocument(document, location.href)),
    insertAfter: document.querySelector('#i3') ?? document.querySelector('#img')?.parentElement ?? document.body,
    scheduled: 0,
    prepared: null,
    cacheFirstYield: null
  };

  const shouldContinue = () => {
    return !state.stopped
      && Boolean(state.nextUrl)
      && state.appendedPages < state.settings.maxPages;
  };

  const report = (status = state.status, reason = '') => {
    reportBuiltInAutoPagerStatus({
      pageSessionId: state.pageSessionId,
      enabled: true,
      continuing: shouldContinue(),
      status,
      reason,
      nextUrl: state.nextUrl,
      appendedPages: state.appendedPages,
      maxPages: state.settings.maxPages
    });
  };

  const scheduleCheck = () => {
    clearTimeout(state.scheduled);
    state.scheduled = setTimeout(() => {
      if (state.working || !shouldContinue()) {
        report(state.status);
        return;
      }
      const remaining = Math.max(0, document.documentElement.scrollHeight - (window.scrollY + window.innerHeight));
      if (remaining <= window.innerHeight * state.settings.remain) {
        appendNextPages('scroll').catch(() => {});
      }
    }, 120);
  };

  const appendNextPages = async (reason) => {
    if (state.working || !shouldContinue()) {
      report(state.status, reason);
      return;
    }

    state.working = true;
    state.status = 'fetching';
    report('fetching', reason);
    // 滚动触发与“立即翻页”共用同一批量页数：每次触发都按设置的
    // 立即翻页页数拼接，而不是固定 1~2 页。
    const targetPages = Math.min(
      state.settings.maxPages,
      reason === 'immediate'
        ? state.settings.immediatePages
        : state.appendedPages + Math.max(1, state.settings.immediatePages)
    );

    try {
      await state.cacheFirstYield;
      if (state.stopped) return;
      do {
        await appendOneNextPage(reason);
      } while (shouldContinue() && state.appendedPages < targetPages);
    } catch (error) {
      state.stopped = true;
      state.status = 'error';
      report('error', error?.message || String(error));
      return;
    } finally {
      state.working = false;
    }

    if (state.appendedPages >= state.settings.maxPages) {
      state.stopped = true;
      state.status = 'maxpage';
    } else if (!state.nextUrl) {
      state.stopped = true;
      state.status = 'done';
    } else {
      state.status = 'ready';
      if (state.settings.aplus) {
        prepareNextPage(state.nextUrl);
      }
    }
    report(state.status, reason);
    scheduleExternalImageCacheFillReport(state.pageSessionId);
    scheduleCheck();
  };

  // Super-preloader 拼接速度模型：Aplus 开启时提前抓取并构建好下一页
  // （含本地缓存查询），滚动到阈值时直接插入已就绪的片段，不再现场 fetch。
  const fetchAndPrepare = async (pageUrl) => {
    const response = await fetch(pageUrl, {
      credentials: 'include',
      cache: 'force-cache'
    });
    if (!response.ok) throw new Error(`fetch-${response.status}`);
    const html = await response.text();
    const pageDoc = new DOMParser().parseFromString(html, 'text/html');
    const page = parseReaderPage(pageUrl);
    const fragment = buildBuiltInAutoPagerFragment(pageDoc, html, pageUrl, {
      page,
      pageIndex: state.appendedPages + 1,
      separator: state.settings.separator
    });
    if (!fragment) throw new Error('missing-reader-fragment');

    await applyBuiltInAutoPagerCache(fragment, page);
    return {
      fragment,
      nextUrl: readerNextUrlFromDocument(pageDoc, pageUrl, html)
    };
  };

  const prepareNextPage = (pageUrl) => {
    if (!pageUrl || state.stopped) return;
    if (state.prepared?.pageUrl === pageUrl) return;
    const promise = fetchAndPrepare(pageUrl);
    promise.catch(() => {});
    state.prepared = { pageUrl, promise };
  };

  const appendOneNextPage = async (reason) => {
    const currentNextUrl = state.nextUrl;
    if (!currentNextUrl) return;

    let prepared = null;
    if (state.prepared?.pageUrl === currentNextUrl) {
      try {
        prepared = await state.prepared.promise;
      } catch {
        prepared = null;
      }
      state.prepared = null;
    }
    if (!prepared) prepared = await fetchAndPrepare(currentNextUrl);

    state.insertAfter.after(prepared.fragment);
    state.insertAfter = document.querySelector(`[data-ehplus-autopager-page-index="${state.appendedPages + 1}"]`)
      ?? state.insertAfter.nextElementSibling
      ?? state.insertAfter;
    state.appendedPages += 1;
    const insertedPageKey = parseReaderPageKey(currentNextUrl);
    if (insertedPageKey) seenPageKeys.add(insertedPageKey);
    state.nextUrl = resolveNextUrl(prepared.nextUrl);
    document.documentElement.dataset.ehplusOwnAutoPager = '1';
    retryFailedBuiltInAutoPagerImages(state.insertAfter);
    // 预构建的分隔条在插入前算过邻页箭头，插入后重算一次灰/亮状态。
    requestAnimationFrame(refreshBuiltInAutoPagerSeparatorIcons);
    report('inserted', reason);
  };

  const onScroll = () => scheduleCheck();

  return {
    start() {
      document.documentElement.dataset.ehplusOwnAutoPager = '1';
      // 先等 cache-first 让位并释放 DNR 网络门，再预取/拼接，
      // 否则最早拼入的页面图片会被门规则重定向成占位图。
      state.cacheFirstYield = yieldLocalReaderCacheFirstToBuiltInAutoPager().catch(() => {});
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      state.status = state.nextUrl ? 'ready' : 'done';
      report(state.status, 'start');
      state.cacheFirstYield.then(() => {
        if (state.stopped) return;
        // Super-preloader Aplus 在启动时就预取第一个下一页，翻到底部即插即用。
        if (state.settings.aplus) {
          prepareNextPage(state.nextUrl);
        }
        if (state.settings.immediateEnabled && state.settings.immediatePages > 0) {
          appendNextPages('immediate').catch(() => {});
        } else {
          scheduleCheck();
        }
      });
    },
    updateSettings(nextSettings) {
      state.settings = normalizeBuiltInAutoPagerSettings(nextSettings);
      if (state.appendedPages >= state.settings.maxPages) {
        state.stopped = true;
        state.status = 'maxpage';
      }
      report(state.status, 'settings-updated');
      scheduleCheck();
    },
    stop(reason) {
      state.stopped = true;
      clearTimeout(state.scheduled);
      window.removeEventListener('scroll', onScroll, { passive: true });
      window.removeEventListener('resize', onScroll, { passive: true });
      reportBuiltInAutoPagerStatus({
        pageSessionId: state.pageSessionId,
        enabled: false,
        continuing: false,
        status: 'disabled',
        reason,
        nextUrl: state.nextUrl,
        appendedPages: state.appendedPages,
        maxPages: state.settings.maxPages
      });
    }
  };
}

// /g/ 画廊页自动翻页：按与 /s/ 相同的滚动/立即/Aplus 模型抓取下一分页的
// 画廊 HTML，把缩略图项拼接进 #gdt；与 /s/ 阅读页控制器互不共享 DOM 逻辑。
function createBuiltInGalleryAutoPagerController(pageSessionId, settings) {
  const state = {
    pageSessionId,
    settings: normalizeBuiltInAutoPagerSettings(settings),
    appendedPages: 0,
    working: false,
    stopped: false,
    status: 'idle',
    nextUrl: galleryNextUrlFromDocument(document, location.href),
    container: document.querySelector('#gdt'),
    seenPageUrls: new Set([normalizeGalleryPagingUrl(location.href, location.href)]),
    scheduled: 0,
    prepared: null
  };

  const shouldContinue = () => {
    return !state.stopped
      && Boolean(state.container)
      && Boolean(state.nextUrl)
      && state.appendedPages < state.settings.maxPages;
  };

  const report = (status = state.status, reason = '') => {
    reportBuiltInAutoPagerStatus({
      pageSessionId: state.pageSessionId,
      enabled: true,
      continuing: shouldContinue(),
      status,
      reason,
      nextUrl: state.nextUrl,
      appendedPages: state.appendedPages,
      maxPages: state.settings.maxPages
    });
  };

  const scheduleCheck = () => {
    clearTimeout(state.scheduled);
    state.scheduled = setTimeout(() => {
      if (state.working || !shouldContinue()) {
        report(state.status);
        return;
      }
      const remaining = Math.max(0, document.documentElement.scrollHeight - (window.scrollY + window.innerHeight));
      if (remaining <= window.innerHeight * state.settings.remain) {
        appendNextPages('scroll').catch(() => {});
      }
    }, 120);
  };

  const appendNextPages = async (reason) => {
    if (state.working || !shouldContinue()) {
      report(state.status, reason);
      return;
    }

    state.working = true;
    state.status = 'fetching';
    report('fetching', reason);
    // 与 /s/ 控制器一致：滚动触发也按设置的立即翻页页数批量拼接。
    const targetPages = Math.min(
      state.settings.maxPages,
      reason === 'immediate'
        ? state.settings.immediatePages
        : state.appendedPages + Math.max(1, state.settings.immediatePages)
    );

    try {
      do {
        await appendOneNextPage(reason);
      } while (shouldContinue() && state.appendedPages < targetPages);
    } catch (error) {
      state.stopped = true;
      state.status = 'error';
      report('error', error?.message || String(error));
      return;
    } finally {
      state.working = false;
    }

    if (state.appendedPages >= state.settings.maxPages) {
      state.stopped = true;
      state.status = 'maxpage';
    } else if (!state.nextUrl) {
      state.stopped = true;
      state.status = 'done';
    } else {
      state.status = 'ready';
      if (state.settings.aplus) {
        prepareNextPage(state.nextUrl);
      }
    }
    report(state.status, reason);
    scheduleCheck();
  };

  const fetchAndPrepare = async (pageUrl) => {
    const response = await fetch(pageUrl, {
      credentials: 'include',
      cache: 'force-cache'
    });
    if (!response.ok) throw new Error(`fetch-${response.status}`);
    const html = await response.text();
    const pageDoc = new DOMParser().parseFromString(html, 'text/html');
    const fragment = buildGalleryAutoPagerFragment(pageDoc, pageUrl, {
      pageIndex: state.appendedPages + 1,
      pageNo: galleryPagingPageNo(pageUrl),
      separator: state.settings.separator
    });
    if (!fragment) throw new Error('missing-gallery-fragment');

    await applyGalleryAutoPagerCache(fragment);
    return {
      fragment,
      nextUrl: galleryNextUrlFromDocument(pageDoc, pageUrl)
    };
  };

  const prepareNextPage = (pageUrl) => {
    if (!pageUrl || state.stopped) return;
    if (state.prepared?.pageUrl === pageUrl) return;
    const promise = fetchAndPrepare(pageUrl);
    promise.catch(() => {});
    state.prepared = { pageUrl, promise };
  };

  const appendOneNextPage = async (reason) => {
    const currentNextUrl = state.nextUrl;
    if (!currentNextUrl || !state.container) return;

    let prepared = null;
    if (state.prepared?.pageUrl === currentNextUrl) {
      try {
        prepared = await state.prepared.promise;
      } catch {
        prepared = null;
      }
      state.prepared = null;
    }
    if (!prepared) prepared = await fetchAndPrepare(currentNextUrl);

    insertGalleryAutoPagerFragment(state.container, prepared.fragment);
    state.appendedPages += 1;
    state.seenPageUrls.add(normalizeGalleryPagingUrl(currentNextUrl, location.href));
    const nextUrl = prepared.nextUrl;
    state.nextUrl = nextUrl && !state.seenPageUrls.has(normalizeGalleryPagingUrl(nextUrl, location.href)) ? nextUrl : '';
    document.documentElement.dataset.ehplusOwnAutoPager = '1';
    requestAnimationFrame(refreshBuiltInAutoPagerSeparatorIcons);
    report('inserted', reason);
  };

  const onScroll = () => scheduleCheck();

  return {
    start() {
      if (!state.container) {
        state.stopped = true;
        state.status = 'error';
        report('error', 'missing-gallery-container');
        return;
      }
      document.documentElement.dataset.ehplusOwnAutoPager = '1';
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      state.status = state.nextUrl ? 'ready' : 'done';
      report(state.status, 'start');
      if (state.settings.aplus) {
        prepareNextPage(state.nextUrl);
      }
      if (state.settings.immediateEnabled && state.settings.immediatePages > 0) {
        appendNextPages('immediate').catch(() => {});
      } else {
        scheduleCheck();
      }
    },
    updateSettings(nextSettings) {
      state.settings = normalizeBuiltInAutoPagerSettings(nextSettings);
      if (state.appendedPages >= state.settings.maxPages) {
        state.stopped = true;
        state.status = 'maxpage';
      }
      report(state.status, 'settings-updated');
      scheduleCheck();
    },
    stop(reason) {
      state.stopped = true;
      clearTimeout(state.scheduled);
      window.removeEventListener('scroll', onScroll, { passive: true });
      window.removeEventListener('resize', onScroll, { passive: true });
      reportBuiltInAutoPagerStatus({
        pageSessionId: state.pageSessionId,
        enabled: false,
        continuing: false,
        status: 'disabled',
        reason,
        nextUrl: state.nextUrl,
        appendedPages: state.appendedPages,
        maxPages: state.settings.maxPages
      });
    }
  };
}

// 画廊分页 URL：必须是同一画廊 /g/<gid>/<token>/，只允许 ?p= 页码差异。
function normalizeGalleryPagingUrl(value, baseUrl) {
  if (!value || value === '#') return '';
  try {
    const parsed = new URL(value, baseUrl || location.href);
    const current = new URL(baseUrl || location.href);
    const match = parsed.pathname.match(/^\/g\/(\d+)\/([^/?#]+)\/?$/);
    const currentMatch = current.pathname.match(/^\/g\/(\d+)\/([^/?#]+)\/?$/);
    if (!match || !currentMatch || match[1] !== currentMatch[1]) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function galleryPagingPageNo(url) {
  try {
    const parsed = new URL(url, location.href);
    const p = Number(parsed.searchParams.get('p') ?? 0);
    return Number.isSafeInteger(p) && p >= 0 ? p + 1 : 1;
  } catch {
    return 1;
  }
}

// 下一画廊分页：优先取当前页码 td.ptds 的下一个 td 中的链接，
// 兜底取分页表最后一个 td 的链接（最后一页时该 td 没有 <a>，返回空）。
function galleryNextUrlFromDocument(doc, baseUrl) {
  const pager = doc?.querySelector?.('table.ptt') ?? doc?.querySelector?.('table.ptb');
  if (!pager) return '';

  const current = pager.querySelector('td.ptds');
  const candidate = current?.nextElementSibling?.querySelector?.('a[href]')
    ?? pager.querySelector('td:last-child a[href]');
  const normalized = normalizeGalleryPagingUrl(candidate?.getAttribute('href') ?? '', baseUrl);
  if (!normalized) return '';
  if (normalized === normalizeGalleryPagingUrl(baseUrl, baseUrl)) return '';
  return normalized;
}

function buildGalleryAutoPagerFragment(pageDoc, pageUrl, options = {}) {
  const source = pageDoc.querySelector('#gdt');
  if (!source) return null;

  const items = Array.from(source.children).filter((item) => !item.matches('.c'));
  if (items.length === 0) return null;

  const fragment = document.createDocumentFragment();
  if (options.separator) {
    const separator = buildBuiltInAutoPagerSeparator(pageUrl, options.pageNo ?? options.pageIndex);
    // #gdt 可能是 grid/flex/float 布局，分隔条需要独占一整行。
    separator.style.gridColumn = '1 / -1';
    separator.style.flexBasis = '100%';
    separator.style.width = '100%';
    separator.style.clear = 'both';
    fragment.appendChild(separator);
  }

  for (const item of items) {
    const clone = item.cloneNode(true);
    if (clone instanceof HTMLElement) {
      clone.dataset.ehplusAutopager = 'true';
      clone.dataset.ehplusAutopagerPageIndex = String(options.pageIndex);
    }
    fragment.appendChild(clone);
  }
  return fragment;
}

// 旧版画廊布局在 #gdt 末尾带 <div class="c"> 清除浮动，新项要插到它前面。
function insertGalleryAutoPagerFragment(container, fragment) {
  const clear = container.querySelector(':scope > .c');
  if (clear) {
    container.insertBefore(fragment, clear);
  } else {
    container.appendChild(fragment);
  }
}

// 拼接页缩略图的本地缓存替换：与 applyLocalGalleryCache 相同的规则，
// 但只扫描本片段，使用内部快速查询（不计入命中率统计）。
async function applyGalleryAutoPagerCache(fragment) {
  if (!isReaderCacheFirstEnabled()) return;

  const links = Array.from(fragment.querySelectorAll('a[href*="/s/"]'));
  const seen = new Set();
  let queried = 0;

  for (const link of links) {
    if (queried >= LOCAL_CACHE_GALLERY_LIMIT) break;
    const pageKey = parseReaderPageKey(link.href);
    const img = link.querySelector('img');
    if (!pageKey || !img || img.dataset.ehplusCacheHit === 'true' || seen.has(pageKey)) continue;

    seen.add(pageKey);
    queried += 1;
    const response = await queryInternalPageCache(pageKey, link.href);
    if (!isUsableCacheHit(response)) continue;

    applyCachedImage(img, response.delivery.url, {
      pageKey,
      scope: 'gallery'
    });
  }
}

function normalizeBuiltInAutoPagerSettings(settings = {}) {
  return {
    remain: positiveNumber(settings.autoPagerRemain, 1),
    maxPages: positiveInteger(settings.autoPagerMaxPages, 99),
    immediateEnabled: settings.autoPagerImmediateEnabled === true,
    immediatePages: nonNegativeInteger(settings.autoPagerImmediatePages, 2),
    separator: settings.autoPagerSeparatorEnabled !== false,
    aplus: settings.autoPagerAplus !== false
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function readerNextUrlFromDocument(doc, baseUrl, html = '') {
  const href = doc?.querySelector?.('#next[href]')?.getAttribute('href') ?? '';
  const normalizedHref = normalizeReaderUrl(href, baseUrl);
  if (normalizedHref) return normalizedHref;

  const match = String(html || doc?.documentElement?.innerHTML || '').match(/\bnexturl\s*=\s*["']([^"']+)["']/i);
  return normalizeReaderUrl(match?.[1] ?? '', baseUrl);
}

function normalizeReaderUrl(value, baseUrl) {
  if (!value || value === '#') return '';
  try {
    const parsed = new URL(value, baseUrl || location.href);
    return isReaderPageUrl(parsed.href) ? parsed.href : '';
  } catch {
    return '';
  }
}

function buildBuiltInAutoPagerFragment(pageDoc, html, pageUrl, options = {}) {
  const source = pageDoc.querySelector('#i3') ?? pageDoc.querySelector('#img')?.parentElement ?? pageDoc.querySelector('#img');
  if (!source) return null;

  const fragment = document.createDocumentFragment();
  if (options.separator) {
    fragment.appendChild(buildBuiltInAutoPagerSeparator(pageUrl, options.page?.pageNo ?? options.pageIndex));
  }

  const root = source.cloneNode(true);
  root.dataset.ehplusAutopager = 'true';
  root.dataset.ehplusAutopagerPageIndex = String(options.pageIndex);
  root.dataset.ehplusReaderPageUrl = pageUrl;
  if (options.page?.pageKey) root.dataset.ehplusReaderPageKey = options.page.pageKey;
  renameBuiltInAutoPagerIds(root, options.pageIndex);
  preserveBuiltInAutoPagerReaderLinks(root, pageDoc, html, pageUrl);
  stampBuiltInAutoPagerNlRetryTokens(root, pageDoc, pageUrl);
  sanitizeBuiltInAutoPagerInlineHandlers(root);
  fragment.appendChild(root);
  return fragment;
}

// Keep each inserted page's own nl retry token and page URL on the inserted
// reader image before inline handlers are stripped, so the MAIN-world nl
// guard can retry a failed inserted image in place against its own page
// instead of navigating or reusing the current page's token.
function stampBuiltInAutoPagerNlRetryTokens(root, pageDoc, pageUrl) {
  const img = root.querySelector('img[data-ehplus-original-id="img"], img[id^="sp-exhentai-img-"]');
  if (!img?.dataset) return;

  const loadfail = root.querySelector('[data-ehplus-original-id="loadfail"], [id^="sp-exhentai-loadfail-"]');
  const token = extractBuiltInAutoPagerNlToken(img.getAttribute('onerror'))
    || extractBuiltInAutoPagerNlToken(loadfail?.getAttribute?.('onclick'))
    || extractBuiltInAutoPagerNlToken(pageDoc?.querySelector?.('#loadfail')?.getAttribute?.('onclick'));
  if (!token) return;

  const cleanPageUrl = stripNlParamFromUrl(pageUrl);
  img.dataset.ehplusReaderNlRetryToken = token;
  img.dataset.ehplusCacheFirstNlRetryToken = token;
  img.dataset.ehplusReaderNlRetryPageUrl = cleanPageUrl;
  img.dataset.ehplusCacheFirstNlRetryPageUrl = cleanPageUrl;
  if (loadfail?.dataset) {
    loadfail.dataset.ehplusReaderNlRetryToken = token;
    loadfail.dataset.ehplusCacheFirstNlRetryToken = token;
    loadfail.dataset.ehplusReaderNlRetryPageUrl = cleanPageUrl;
    loadfail.dataset.ehplusCacheFirstNlRetryPageUrl = cleanPageUrl;
  }
}

function extractBuiltInAutoPagerNlToken(value) {
  const match = String(value ?? '').match(/nl\(['"]([^'"]+)['"]\)/);
  return match ? match[1] : '';
}

function stripNlParamFromUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    parsed.searchParams.delete('nl');
    return parsed.href;
  } catch {
    return String(url ?? '');
  }
}

function buildBuiltInAutoPagerSeparator(pageUrl, pageNo) {
  const separator = document.createElement('div');
  separator.className = 'sp-separator ehplus-autopager-separator';
  separator.id = `sp-separator-${pageNo}`;
  separator.dataset.ehplusAutopager = 'true';
  separator.dataset.ehplusAutopagerSeparator = 'true';
  separator.dataset.ehplusAutopagerPageNo = String(pageNo);
  separator.addEventListener('click', handleBuiltInAutoPagerSeparatorClick, false);

  const link = document.createElement('a');
  link.className = 'sp-sp-nextlink';
  link.href = pageUrl;
  link.target = '_blank';
  link.title = pageUrl;
  link.innerHTML = builtInAutoPagerSeparatorText(pageNo);
  separator.appendChild(link);

  separator.appendChild(buildBuiltInAutoPagerSeparatorIcon('top', {
    className: 'sp-sp-gotop',
    alt: '去到顶部',
    title: '去到顶部'
  }));
  separator.appendChild(buildBuiltInAutoPagerSeparatorIcon('pre', {
    className: 'sp-sp-gopre',
    alt: '上滚一页',
    title: '上滚一页',
    disabled: !builtInAutoPagerNeighborSeparator(pageNo, -1)
  }));
  separator.appendChild(buildBuiltInAutoPagerSeparatorIcon('next', {
    className: 'sp-sp-gonext',
    alt: '下滚一页',
    title: '下滚一页',
    disabled: !builtInAutoPagerNeighborSeparator(pageNo, 1)
  }));
  separator.appendChild(buildBuiltInAutoPagerSeparatorIcon('bottom', {
    className: 'sp-sp-gobottom',
    alt: '去到底部',
    title: '去到底部'
  }));

  const info = document.createElement('span');
  info.className = 'sp-span-someinfo';
  separator.appendChild(info);

  requestAnimationFrame(refreshBuiltInAutoPagerSeparatorIcons);
  return separator;
}

function builtInAutoPagerSeparatorText(pageNo) {
  const escapedPageNo = escapeHtmlText(pageNo);
  return `<b>第 ${escapedPageNo} 页</b> [ 实际：第 ${escapedPageNo} 页 ]`;
}

function buildBuiltInAutoPagerSeparatorIcon(kind, options = {}) {
  const img = document.createElement('img');
  img.src = builtInAutoPagerSeparatorIconUrl(kind, options.disabled === true);
  img.className = options.className;
  img.alt = options.alt;
  img.title = options.title;
  img.dataset.ehplusAutopagerIcon = kind;
  return img;
}

function builtInAutoPagerSeparatorIconUrl(kind, disabled = false) {
  const key = disabled
    ? `${kind}Disabled`
    : kind;
  const path = BUILT_IN_AUTOPAGER_ICON_PATHS[key] ?? BUILT_IN_AUTOPAGER_ICON_PATHS.next;
  return chrome.runtime.getURL(path);
}

function handleBuiltInAutoPagerSeparatorClick(event) {
  const separator = event.currentTarget;
  const target = event.target;
  if (!(separator instanceof HTMLElement) || !(target instanceof Element)) return;
  if (target.closest('a')) return;

  event.preventDefault();
  event.stopPropagation();

  const pageNo = Number(separator.dataset.ehplusAutopagerPageNo);
  if (!Number.isSafeInteger(pageNo)) return;

  if (target.classList.contains('sp-sp-gotop')) {
    scrollBuiltInAutoPagerTo(0);
    return;
  }
  if (target.classList.contains('sp-sp-gobottom')) {
    scrollBuiltInAutoPagerTo(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    return;
  }
  if (target.classList.contains('sp-sp-gopre')) {
    scrollBuiltInAutoPagerToNeighbor(separator, pageNo, -1);
    return;
  }
  if (target.classList.contains('sp-sp-gonext')) {
    scrollBuiltInAutoPagerToNeighbor(separator, pageNo, 1);
  }
}

function scrollBuiltInAutoPagerToNeighbor(currentSeparator, pageNo, direction) {
  const neighbor = builtInAutoPagerNeighborSeparator(pageNo, direction);
  if (!neighbor) return;
  const currentTop = currentSeparator.getBoundingClientRect().top;
  const neighborTop = neighbor.getBoundingClientRect().top;
  scrollBuiltInAutoPagerTo(window.scrollY + (neighborTop - currentTop));
}

function scrollBuiltInAutoPagerTo(top) {
  window.scrollTo({
    left: window.scrollX,
    top: Math.max(0, top),
    behavior: 'smooth'
  });
}

function refreshBuiltInAutoPagerSeparatorIcons() {
  document.querySelectorAll('[data-ehplus-autopager-separator="true"]').forEach((separator) => {
    const pageNo = Number(separator.dataset.ehplusAutopagerPageNo);
    if (!Number.isSafeInteger(pageNo)) return;
    const pre = separator.querySelector('.sp-sp-gopre');
    const next = separator.querySelector('.sp-sp-gonext');
    if (pre) pre.src = builtInAutoPagerSeparatorIconUrl('pre', !builtInAutoPagerNeighborSeparator(pageNo, -1));
    if (next) next.src = builtInAutoPagerSeparatorIconUrl('next', !builtInAutoPagerNeighborSeparator(pageNo, 1));
  });
}

function builtInAutoPagerNeighborSeparator(pageNo, direction) {
  return document.getElementById(`sp-separator-${pageNo + direction}`);
}

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renameBuiltInAutoPagerIds(root, pageIndex) {
  const nodes = [root, ...root.querySelectorAll('[id]')];
  nodes.forEach((node, index) => {
    const originalId = node.id;
    if (!originalId) return;
    node.dataset.ehplusOriginalId = originalId;
    if (originalId === 'img') {
      node.id = `sp-exhentai-img-${pageIndex}-${index}`;
      return;
    }
    if (originalId === 'loadfail') {
      node.id = `sp-exhentai-loadfail-${pageIndex}-${index}`;
      return;
    }
    node.id = `ehplus-autopager-${pageIndex}-${index}-${originalId}`;
  });
}

function preserveBuiltInAutoPagerReaderLinks(root, pageDoc, html, pageUrl) {
  const nextUrl = readerNextUrlFromDocument(pageDoc, pageUrl, html);
  const prev = root.querySelector('#prev, [data-ehplus-original-id="prev"]');
  const next = root.querySelector('#next, [data-ehplus-original-id="next"]');
  if (prev) prev.href = pageUrl;
  if (next && nextUrl) next.href = nextUrl;
}

function sanitizeBuiltInAutoPagerInlineHandlers(root) {
  const nodes = [root, ...root.querySelectorAll('[onerror], [onclick], img, [data-ehplus-original-id="img"], [data-ehplus-original-id="loadfail"]')];
  nodes.forEach((node) => {
    if (!(node instanceof Element)) return;
    const originalId = node.getAttribute('data-ehplus-original-id') ?? '';
    const isReaderImage = node.matches('img[id^="sp-exhentai-img-"], img[data-ehplus-original-id="img"]')
      || (node.tagName === 'IMG' && originalId === 'img');
    if (isReaderImage) {
      stripInlineImageRetryHandler(node);
    }

    const isLoadfail = originalId === 'loadfail'
      || node.id?.startsWith('sp-exhentai-loadfail-') === true;
    if (isLoadfail) {
      stripInlineLoadfailRetryHandler(node);
    }
  });
}

async function applyBuiltInAutoPagerCache(fragment, page) {
  const img = fragment.querySelector('img[id^="sp-exhentai-img-"]') ?? fragment.querySelector('img[src]');
  if (!img || !page?.pageKey) return;
  // 拼接页是独立的一次图片访问：读取尝试与命中都计入统计。
  const response = await queryInternalPageCache(page.pageKey, page.url, { countStats: true });
  if (!isUsableCacheHit(response)) return;
  applyCachedImage(img, response.delivery.url, {
    pageKey: page.pageKey,
    scope: 'autopager'
  });
}

async function queryInternalPageCache(pageKey, pageUrl, options = {}) {
  return promiseWithTimeout(chrome.runtime.sendMessage({
    type: INTERNAL_CACHE_QUERY_TYPE,
    pageKey,
    pageUrl,
    responseMode: 'url',
    countStats: options.countStats === true
  }), LOCAL_READER_CACHE_FIRST_QUERY_TIMEOUT_MS, buildRuntimeQueryTimeoutResponse(pageKey, pageUrl, Date.now(), LOCAL_READER_CACHE_FIRST_QUERY_TIMEOUT_MS));
}

function reportBuiltInAutoPagerStatus(details) {
  if (!isExtensionRuntime()) return;
  chrome.runtime.sendMessage({
    type: OWN_AUTOPAGER_STATUS_TYPE,
    pageSessionId: details.pageSessionId ?? window.__EHPLUS_RUNTIME__?.pageSessionId ?? '',
    enabled: details.enabled !== false,
    continuing: details.continuing === true,
    status: details.status ?? 'idle',
    reason: details.reason ?? '',
    url: location.href,
    nextUrl: details.nextUrl ?? '',
    appendedPages: details.appendedPages ?? 0,
    maxPages: details.maxPages ?? 0,
    observedAt: Date.now()
  }).catch(() => {});
}

function installExternalImageCacheFillReporter(pageSessionId) {
  setTimeout(() => scheduleExternalImageCacheFillReport(pageSessionId), 350);
  setTimeout(() => scheduleExternalImageCacheFillReport(pageSessionId), 1200);

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(() => {
    scheduleExternalImageCacheFillReport(pageSessionId);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'id']
  });
}

function scheduleExternalImageCacheFillReport(pageSessionId) {
  clearTimeout(externalImageCacheFillTimer);
  externalImageCacheFillTimer = setTimeout(() => {
    reportExternalImageCacheFill(pageSessionId).catch(() => {});
  }, 250);
}

async function reportExternalImageCacheFill(pageSessionId) {
  const items = collectExternalImageCacheFillItems();
  if (items.length === 0) return;

  const response = await chrome.runtime.sendMessage({
    type: EXTERNAL_IMAGE_CACHE_FILL_TYPE,
    pageSessionId,
    url: location.href,
    observedAt: Date.now(),
    items
  });

  if (response?.ok) {
    for (const item of items) {
      const img = document.querySelector(`[data-ehplus-external-cache-fill-id="${cssEscape(item.imageId)}"]`);
      if (img) img.dataset.ehplusExternalCacheFillQueued = 'true';
    }
  }
}

function collectExternalImageCacheFillItems() {
  const currentPage = parseReaderPage(location.href);
  if (!currentPage) return [];

  const pageUrlByKey = collectReaderPageUrlsByKey();
  const candidates = collectExternalImageCandidates(currentPage, pageUrlByKey);
  const items = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (items.length >= EXTERNAL_IMAGE_CACHE_FILL_LIMIT) break;
    const imageUrl = usableImageUrl(candidate.img);
    if (!imageUrl || candidate.img.dataset.ehplusExternalCacheFillQueued === 'true') continue;
    // 规划 §953：解析不出 gid:pageNo 的 H@H 图片也上报，由后台按
    // URL key 写入临时缓存；去重键退化为图片 URL。
    const dedupeKey = candidate.pageKey || `url:${imageUrl}`;
    if (seen.has(dedupeKey)) continue;

    const imageId = externalImageCacheFillImageId(candidate.img);
    candidate.img.dataset.ehplusExternalCacheFillId = imageId;
    seen.add(dedupeKey);
    items.push({
      pageKey: candidate.pageKey ?? '',
      pageUrl: candidate.pageUrl ?? (candidate.pageKey ? pageUrlByKey.get(candidate.pageKey) : '') ?? '',
      imageUrl,
      url: imageUrl,
      source: candidate.source,
      imageId,
      width: candidate.img.naturalWidth || 0,
      height: candidate.img.naturalHeight || 0
    });
  }

  return items;
}

function collectExternalImageCandidates(currentPage, pageUrlByKey) {
  const candidates = [];
  const seenImages = new WeakSet();
  const mainImage = document.querySelector('#img');
  if (mainImage) {
    seenImages.add(mainImage);
    candidates.push({
      img: mainImage,
      pageKey: currentPage.pageKey,
      pageUrl: location.href,
      source: 'reader-dom'
    });
  }

  document.querySelectorAll('img[id^="sp-exhentai-img-"]').forEach((img) => {
    seenImages.add(img);
    const pageNo = superPreloaderImagePageNo(img.id, currentPage.pageNo);
    const pageKey = pageNo ? `${currentPage.gid}:${pageNo}` : nearestReaderPageKey(img);
    candidates.push({
      img,
      pageKey: pageKey ?? null,
      pageUrl: (pageKey ? pageUrlByKey.get(pageKey) : '') ?? nearestReaderPageUrl(img) ?? '',
      source: 'auto-pager-dom'
    });
  });

  // 无法映射 gid:pageNo 的 H@H 图片保留为 keyless 候选，走临时补存路径
  //（规划 §953），不再直接丢弃。
  document.querySelectorAll('img[src], img[srcset]').forEach((img) => {
    if (seenImages.has(img)) return;
    const imageUrl = usableImageUrl(img);
    if (!imageUrl || !isLikelyReaderImageUrl(imageUrl)) return;
    const pageKey = nearestReaderPageKey(img);
    candidates.push({
      img,
      pageKey: pageKey ?? null,
      pageUrl: (pageKey ? pageUrlByKey.get(pageKey) : '') ?? nearestReaderPageUrl(img) ?? '',
      source: 'page-image-dom'
    });
  });

  return candidates;
}

function collectReaderPageUrlsByKey() {
  const map = new Map();
  document.querySelectorAll('a[href*="/s/"]').forEach((link) => {
    const page = parseReaderPage(link.href);
    if (page && !map.has(page.pageKey)) map.set(page.pageKey, page.url);
  });
  return map;
}

function parseReaderPage(url) {
  try {
    const parsed = new URL(url, location.href);
    const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
    if (!match) return null;
    const pageNo = Number(match[2]);
    if (!Number.isSafeInteger(pageNo) || pageNo < 1) return null;
    return {
      gid: match[1],
      pageNo,
      pageKey: `${match[1]}:${pageNo}`,
      url: parsed.href
    };
  } catch {
    return null;
  }
}

function superPreloaderImagePageNo(id, currentPageNo) {
  const match = String(id ?? '').match(/^sp-exhentai-img-(\d+)(?:-|$)/);
  if (!match) return null;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return currentPageNo + offset;
}

function nearestReaderPageKey(node) {
  const dataKey = node.closest?.('[data-ehplus-reader-page-key]')?.dataset?.ehplusReaderPageKey
    ?? node.dataset?.ehplusReaderPageKey
    ?? '';
  if (/^\d+:\d+$/.test(dataKey)) return dataKey;
  const pageUrl = nearestReaderPageUrl(node);
  return pageUrl ? parseReaderPage(pageUrl)?.pageKey ?? null : null;
}

function nearestReaderPageUrl(node) {
  const dataUrl = node.closest?.('[data-ehplus-reader-page-url]')?.dataset?.ehplusReaderPageUrl
    ?? node.dataset?.ehplusReaderPageUrl
    ?? '';
  if (dataUrl) return dataUrl;
  const link = node.closest?.('a[href*="/s/"]') ?? node.parentElement?.querySelector?.('a[href*="/s/"]');
  return link?.href ?? '';
}

function usableImageUrl(img) {
  const url = img?.currentSrc || img?.src || '';
  if (!url || img.complete === false || (img.naturalWidth ?? 0) <= 0) return null;
  try {
    const parsed = new URL(url, location.href);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function externalImageCacheFillImageId(img) {
  if (img.dataset.ehplusExternalCacheFillId) return img.dataset.ehplusExternalCacheFillId;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function isReaderPageUrl(url) {
  return parseReaderPageKey(url) !== null;
}

function parseReaderPageKey(url) {
  try {
    const parsed = new URL(url, location.href);
    const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
    if (!match) return null;
    return `${match[1]}:${Number(match[2])}`;
  } catch {
    return null;
  }
}

function isReaderNlRetryPageUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    return /^\/s\/[^/]+\/\d+-\d+\/?$/.test(parsed.pathname) && parsed.searchParams.has('nl');
  } catch {
    return false;
  }
}

function isReaderNlRetryBypassPage(url = location.href) {
  return isReaderNlRetryPageUrl(url)
    || document.documentElement?.dataset?.ehplusCacheFirstMainNlRetryOriginal === '1';
}

function isGalleryPageUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    return /^\/g\/\d+\/[^/?#]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function scheduleLocalCacheConsumer() {
  if (!isExtensionRuntime()) return;
  installLocalReaderCacheFirstUrlWatcher();
  installLocalReaderCacheFirstController();

  const run = () => {
    applyLocalCacheToCurrentPage().catch(() => {});
  };
  setTimeout(run, 0);
  setTimeout(run, 350);
  adoptReaderCacheFirstSettingFromStorage();
}

// 首屏兜底：cache-first 的页面侧开关 hint 存在 localStorage 里，新浏览器环境或
// 清过站点数据时 document_start 读不到，导致设置已开启但首屏被静默跳过。
// hint 从未写过（null，区别于显式 '0'）时，异步读一次 chrome.storage.local 的
// 真实设置；确认开启则补写 hint（后续导航恢复 document_start 抢占），并对当前页
// 做一次晚到的本地缓存应用：命中直接替换图片地址，未命中不做任何事。此路径
// 不补装 DNR 网络闸门，也不进入占位持有流程（规划 §953 不得重装闸门）。
function adoptReaderCacheFirstSettingFromStorage() {
  let hintMissing = false;
  try {
    hintMissing = localStorage.getItem(LOCAL_READER_CACHE_FIRST_ENABLED_STORAGE_KEY) === null;
  } catch {
    hintMissing = false;
  }
  if (!hintMissing) return;
  chrome.storage.local.get(STATE_KEY)
    .then((stored) => {
      const settings = stored?.[STATE_KEY]?.settings;
      if (settings?.readerCacheFirstEnabled !== true) return;
      syncReaderCacheFirstSetting(settings);
      setLocalReaderCacheFirstStatus('late-adopt', {
        pageKey: parseReaderPageKey(location.href) ?? '',
        reason: 'storage-hint-adopted'
      });
      applyLocalCacheToCurrentPage().catch(() => {});
    })
    .catch(() => {});
}

function installLocalReaderCacheFirstUrlWatcher() {
  if (localReaderCacheFirstUrlWatcherInstalled) return;
  localReaderCacheFirstUrlWatcherInstalled = true;
  localReaderCacheFirstObservedPageKey = parseReaderPageKey(location.href);

  const check = () => handleLocalReaderCacheFirstPageKeyChange();
  window.addEventListener('popstate', check, true);
  window.addEventListener('hashchange', check, true);
  setInterval(check, LOCAL_READER_CACHE_FIRST_PAGEKEY_WATCH_MS);

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'id']
    });
  }
}

function handleLocalReaderCacheFirstPageKeyChange() {
  if (!isExtensionRuntime()) return;
  const pageKey = parseReaderPageKey(location.href);
  if (pageKey === localReaderCacheFirstObservedPageKey
    && (!localReaderCacheFirstState || localReaderCacheFirstState.pageKey === pageKey)) {
    return;
  }

  if (localReaderCacheFirstState && localReaderCacheFirstState.pageKey !== pageKey) {
    cancelLocalReaderCacheFirstState(localReaderCacheFirstState, 'page-key-changed');
  }

  localReaderCacheFirstObservedPageKey = pageKey;
  if (!pageKey) return;

  clearStaleLocalReaderCacheFirstImageMarkers(pageKey);
  installLocalReaderCacheFirstController();
  applyLocalCacheToCurrentPage().catch(() => {});
}

function installLocalReaderCacheFirstController() {
  if (!isExtensionRuntime()) return;
  const pageKey = parseReaderPageKey(location.href);
  if (!pageKey) return;
  if (localReaderCacheFirstState) {
    if (localReaderCacheFirstState.pageKey === pageKey) return;
    cancelLocalReaderCacheFirstState(localReaderCacheFirstState, 'page-key-changed');
  }
  localReaderCacheFirstObservedPageKey = pageKey;
  if (!isReaderCacheFirstEnabled()) {
    setLocalReaderCacheFirstStatus('disabled', { pageKey, reason: 'setting-disabled' });
    releaseLocalReaderCacheFirstNetworkBlock(pageKey, 'setting-disabled');
    postLocalReaderCacheFirstMainDecision({
      pageKey,
      result: 'restore',
      reason: 'setting-disabled'
    });
    return;
  }
  if (isReaderNlRetryBypassPage(location.href)) {
    setLocalReaderCacheFirstStatus('nl-retry-bypass', { pageKey, reason: 'nl-retry' });
    scheduleLocalReaderCacheFirstNetworkBlockRelease(pageKey, 'nl-retry');
    return;
  }
  if (isAutoPagerCompatibilityActive()) {
    setLocalReaderCacheFirstStatus('auto-pager', { pageKey, reason: 'install-yield' });
    releaseLocalReaderCacheFirstNetworkBlock(pageKey, 'auto-pager');
    postLocalReaderCacheFirstMainDecision({
      pageKey,
      result: 'restore',
      reason: 'auto-pager'
    });
    return;
  }

  const state = {
    pageKey,
    pageUrl: location.href,
    settled: false,
    timer: 0,
    hardTimer: 0,
    observer: null,
    cachedUrl: null,
    query: null,
    image: null,
    originalSrc: '',
    originalSrcset: '',
    queryStartedAt: 0,
    queryFinishedAt: 0,
    queryElapsedMs: 0,
    queryResult: '',
    queryFallbackReason: '',
    finishedAt: 0,
    finalReason: '',
    timingReported: false
  };
  localReaderCacheFirstState = state;
  setLocalReaderCacheFirstStatus('query-start', { pageKey });
  ensureLocalReaderCacheFirstNetworkBlock(pageKey);

  state.queryStartedAt = Date.now();
  setLocalReaderCacheFirstQueryDebug('send-start', {
    pageKey,
    startedAt: state.queryStartedAt
  });
  // 主图查询只补计命中：这次访问本身已由页面会话计入图片访问。
  state.query = queryLocalPageCache(pageKey, location.href, { fastResponse: true, statsScope: 'hit-only' })
    .then((response) => {
      state.queryFinishedAt = Date.now();
      state.queryElapsedMs = state.queryFinishedAt - state.queryStartedAt;
      state.response = response;
      const usableHit = isUsableCacheHit(response);
      state.queryResult = usableHit ? 'response-hit' : 'response-miss';
      state.queryFallbackReason = localReaderCacheFirstFallbackReason(response);
      setLocalReaderCacheFirstQueryDebug('send-resolve', {
        pageKey,
        startedAt: state.queryStartedAt,
        elapsedMs: state.queryElapsedMs,
        response,
        result: state.queryResult
      });
      setLocalReaderCacheFirstQueryDebug(state.queryResult, {
        pageKey,
        startedAt: state.queryStartedAt,
        elapsedMs: state.queryElapsedMs,
        response
      });
      return usableHit ? response.delivery.url : null;
    })
    .catch((error) => {
      state.queryFinishedAt = Date.now();
      state.queryElapsedMs = state.queryFinishedAt - state.queryStartedAt;
      state.queryResult = 'send-error';
      state.error = runtimeLastErrorMessage() || error?.message || String(error);
      setLocalReaderCacheFirstQueryDebug('send-error', {
        pageKey,
        startedAt: state.queryStartedAt,
        elapsedMs: state.queryElapsedMs,
        error: state.error
      });
      return null;
    })
    .then((url) => {
      state.cachedUrl = url;
      if (url) {
        tryLocalReaderCacheFirstImage(state);
        settleLocalReaderCacheFirst(state, 'hit');
      } else {
        settleLocalReaderCacheFirst(state, state.error ? 'error' : state.queryFallbackReason || 'miss');
      }
      return url;
    });

  state.timer = setTimeout(() => {
    if (state.settled) return;
    setLocalReaderCacheFirstStatus('timeout-waiting', {
      pageKey: state.pageKey,
      originalSrc: state.originalSrc,
      queryElapsedMs: Date.now() - state.queryStartedAt,
      queryResult: state.queryResult || 'pending'
    });
    setLocalReaderCacheFirstNetworkBlockDebug('kept-for-timeout-waiting', {
      pageKey: state.pageKey,
      reason: 'query-pending'
    });
  }, LOCAL_READER_CACHE_FIRST_SOFT_TIMEOUT_MS);

  state.hardTimer = setTimeout(() => {
    settleLocalReaderCacheFirst(state, 'timeout');
  }, LOCAL_READER_CACHE_FIRST_HARD_TIMEOUT_MS);

  tryLocalReaderCacheFirstImage(state);

  if (typeof MutationObserver === 'function') {
    state.observer = new MutationObserver(() => {
      if (isAutoPagerCompatibilityActive()) {
        settleLocalReaderCacheFirst(state, 'auto-pager');
        return;
      }
      tryLocalReaderCacheFirstImage(state);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'id']
    });
  }
}

function handleLocalReaderCacheFirstNlRetryMessage(message) {
  if (!isExtensionRuntime()) return;
  const pageKey = parseReaderPageKey(location.href);
  if (!pageKey) return;
  if (message?.pageKey && message.pageKey !== pageKey) return;
  if (localReaderCacheFirstState && localReaderCacheFirstState.pageKey === pageKey) {
    cancelLocalReaderCacheFirstStateForNlRetry(localReaderCacheFirstState);
  } else {
    scheduleLocalReaderCacheFirstNetworkBlockRelease(pageKey, 'nl-retry');
  }
  setLocalReaderCacheFirstStatus('nl-retry-bypass', {
    pageKey,
    reason: 'nl-retry'
  });
  const html = document.documentElement;
  if (html?.dataset) {
    html.dataset.ehplusCacheFirstMainNlRetryOriginal = '1';
    if (message?.token) html.dataset.ehplusCacheFirstMainNlRetryToken = String(message.token).slice(0, 80);
    if (message?.retryUrl) html.dataset.ehplusCacheFirstMainNlRetryUrl = String(message.retryUrl).slice(0, 240);
  }
}

function tryLocalReaderCacheFirstImage(state) {
  if (!state || state.settled || state.image || isAutoPagerCompatibilityActive()) return;
  if (parseReaderPageKey(location.href) !== state.pageKey) return;

  const img = document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR);
  if (!img) return;
  if (img.dataset.ehplusCacheHit === 'true') {
    if (img.dataset.ehplusCachePageKey === state.pageKey) return;
    clearStaleLocalReaderCacheFirstImageMarkers(state.pageKey);
  }

  state.image = img;
  state.originalSrc = img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR)
    || img.getAttribute('src')
    || img.src
    || img.currentSrc
    || '';
  state.originalSrcset = img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR)
    || img.getAttribute('srcset')
    || '';
  const hasHttpSrc = LOCAL_READER_CACHE_FIRST_HTTP_URL_PATTERN.test(state.originalSrc);
  const hasHttpSrcset = LOCAL_READER_CACHE_FIRST_HTTP_URL_PATTERN.test(state.originalSrcset);
  if (!hasHttpSrc && !hasHttpSrcset) {
    state.image = null;
    return;
  }

  stripCurrentReaderInlineRetryHandlers(img);
  if (hasHttpSrcset) {
    img.setAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR, state.originalSrcset);
    img.removeAttribute('srcset');
  }
  if (hasHttpSrc) {
    img.setAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR, state.originalSrc);
    const placeholderUrl = localReaderCacheFirstPlaceholderUrl();
    if (placeholderUrl) {
      img.src = placeholderUrl;
    } else {
      img.removeAttribute('src');
    }
  }
  img.dataset.ehplusCacheFirstPending = 'true';
  setLocalReaderCacheFirstStatus('image-held', {
    pageKey: state.pageKey,
    originalSrc: state.originalSrc
  });

  if (state.cachedUrl) {
    settleLocalReaderCacheFirst(state, 'hit');
  }
}

function settleLocalReaderCacheFirst(state, reason) {
  if (!state || state.settled) return;
  if (reason === 'hit' && !state.cachedUrl) return;
  if (parseReaderPageKey(location.href) !== state.pageKey) {
    cancelLocalReaderCacheFirstState(state, 'page-key-changed');
    return;
  }

  state.settled = true;
  state.finishedAt = Date.now();
  state.finalReason = reason;
  clearTimeout(state.timer);
  clearTimeout(state.hardTimer);
  state.observer?.disconnect();
  setLocalReaderCacheFirstStatus(reason, {
    pageKey: state.pageKey,
    originalSrc: state.originalSrc,
    error: state.error,
    queryElapsedMs: state.queryElapsedMs,
    queryResult: state.queryResult
  });

  const img = state.image ?? document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR);
  const activeAutoPager = isAutoPagerCompatibilityActive();
  if (reason === 'hit' && state.cachedUrl && !activeAutoPager) {
    setLocalReaderCacheFirstNetworkBlockDebug('kept-for-hit', {
      pageKey: state.pageKey,
      reason: 'hit'
    });
    postLocalReaderCacheFirstMainDecision({
      pageKey: state.pageKey,
      result: 'hit',
      url: state.cachedUrl
    });
      if (img) {
        delete img.dataset.ehplusCacheFirstPending;
        trackLocalReaderCacheFirstImageLoad(img, state, 'cache');
        applyCachedImage(img, state.cachedUrl, {
          pageKey: state.pageKey,
          scope: 'reader-cache-first',
        originalSrc: state.originalSrc,
        originalSrcset: state.originalSrcset
      });
    }
  } else {
    const fallbackReason = activeAutoPager ? 'auto-pager' : reason;
    waitForLocalReaderCacheFirstNetworkBlockRelease(state.pageKey, fallbackReason)
      .finally(() => {
        postLocalReaderCacheFirstMainDecision({
          pageKey: state.pageKey,
          result: 'restore',
          reason: fallbackReason
        });
        if (parseReaderPageKey(location.href) !== state.pageKey) return;
        if (img) {
          delete img.dataset.ehplusCacheFirstPending;
          trackLocalReaderCacheFirstImageLoad(img, state, 'fallback');
          restoreLocalReaderOriginalImage(img, state);
        }
      });
  }

  if (localReaderCacheFirstState === state) {
    localReaderCacheFirstState = null;
  }

  scheduleLocalReaderCacheFirstTimingReport(state);
}

function cancelLocalReaderCacheFirstState(state, reason) {
  if (!state || state.settled) return;
  state.settled = true;
  state.finishedAt = Date.now();
  state.finalReason = reason;
  clearTimeout(state.timer);
  clearTimeout(state.hardTimer);
  state.observer?.disconnect();
  releaseLocalReaderCacheFirstNetworkBlock(state.pageKey, reason);
  postLocalReaderCacheFirstMainDecision({
    pageKey: state.pageKey,
    result: 'restore',
    reason
  });
  if (localReaderCacheFirstState === state) {
    localReaderCacheFirstState = null;
  }
  clearStaleLocalReaderCacheFirstImageMarkers(parseReaderPageKey(location.href));
  setLocalReaderCacheFirstStatus(reason, {
    pageKey: state.pageKey,
    originalSrc: state.originalSrc,
    queryElapsedMs: state.queryStartedAt ? Date.now() - state.queryStartedAt : state.queryElapsedMs,
    queryResult: state.queryResult || 'cancelled'
  });
  scheduleLocalReaderCacheFirstTimingReport(state);
}

function cancelLocalReaderCacheFirstStateForNlRetry(state) {
  if (!state || state.settled) return;
  state.settled = true;
  state.finishedAt = Date.now();
  state.finalReason = 'nl-retry';
  clearTimeout(state.timer);
  clearTimeout(state.hardTimer);
  state.observer?.disconnect();
  scheduleLocalReaderCacheFirstNetworkBlockRelease(state.pageKey, 'nl-retry');
  if (localReaderCacheFirstState === state) {
    localReaderCacheFirstState = null;
  }
  const img = state.image ?? document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR);
  if (img?.dataset) {
    delete img.dataset.ehplusCacheFirstPending;
  }
  setLocalReaderCacheFirstStatus('nl-retry-bypass', {
    pageKey: state.pageKey,
    originalSrc: state.originalSrc,
    queryElapsedMs: state.queryStartedAt ? Date.now() - state.queryStartedAt : state.queryElapsedMs,
    queryResult: state.queryResult || 'nl-retry'
  });
  scheduleLocalReaderCacheFirstTimingReport(state);
}

function clearStaleLocalReaderCacheFirstImageMarkers(currentPageKey) {
  const img = document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR);
  if (!img?.dataset) return;
  const imagePageKey = img.dataset.ehplusCachePageKey || '';
  const shouldClearCacheHit = imagePageKey && imagePageKey !== currentPageKey;
  if (shouldClearCacheHit) {
    delete img.dataset.ehplusCacheHit;
    delete img.dataset.ehplusCachePageKey;
    delete img.dataset.ehplusCacheScope;
  }
  delete img.dataset.ehplusCacheFirstPending;
  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR);
  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR);
}

function waitForLocalReaderCacheFirstNetworkBlockRelease(pageKey, reason) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        setLocalReaderCacheFirstNetworkBlockDebug('release-timeout-restore', {
          pageKey,
          reason
        });
        resolve({ ok: false, timeout: true });
      }
    }, LOCAL_READER_CACHE_FIRST_RELEASE_TIMEOUT_MS);

    releaseLocalReaderCacheFirstNetworkBlock(pageKey, reason)
      .then((response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: runtimeLastErrorMessage() || error?.message || String(error) });
      });
  });
}

function localReaderCacheFirstFallbackReason(response) {
  if (response?.reason === 'runtime-timeout') return 'timeout';
  if (response?.reason === 'query-timeout') return 'timeout';
  return '';
}

function setLocalReaderCacheFirstStatus(status, details = {}) {
  const html = document.documentElement;
  if (!html?.dataset) return;
  html.dataset.ehplusCacheFirstController = '1';
  html.dataset.ehplusCacheFirstPageKey = details.pageKey || parseReaderPageKey(location.href) || '';
  html.dataset.ehplusCacheFirstControllerState = status;
  html.dataset.ehplusCacheFirstControllerUpdatedAt = String(Date.now());
  if (details.reason) html.dataset.ehplusCacheFirstControllerReason = details.reason;
  if (details.error) html.dataset.ehplusCacheFirstControllerError = String(details.error).slice(0, 240);
  if (details.originalSrc) html.dataset.ehplusCacheFirstControllerOriginalSrc = String(details.originalSrc).slice(0, 240);
  if (details.queryElapsedMs != null) html.dataset.ehplusCacheFirstControllerQueryElapsedMs = String(details.queryElapsedMs);
  if (details.queryResult) html.dataset.ehplusCacheFirstControllerQueryResult = String(details.queryResult).slice(0, 80);
}

function setLocalReaderCacheFirstQueryDebug(status, details = {}) {
  const html = document.documentElement;
  if (!html?.dataset) return;
  const response = details.response;
  const error = details.error || runtimeLastErrorMessage();
  html.dataset.ehplusCacheFirstControllerQueryState = status;
  html.dataset.ehplusCacheFirstControllerQueryUpdatedAt = String(Date.now());
  html.dataset.ehplusCacheFirstControllerQueryPageKey = details.pageKey || parseReaderPageKey(location.href) || '';
  if (details.startedAt) html.dataset.ehplusCacheFirstControllerQueryStartedAt = String(details.startedAt);
  if (details.elapsedMs != null) html.dataset.ehplusCacheFirstControllerQueryElapsedMs = String(details.elapsedMs);
  if (details.result) html.dataset.ehplusCacheFirstControllerQueryResult = String(details.result).slice(0, 80);
  if (error) html.dataset.ehplusCacheFirstControllerError = String(error).slice(0, 240);
  if (response) {
    html.dataset.ehplusCacheFirstControllerResponseOk = String(response.ok === true);
    html.dataset.ehplusCacheFirstControllerResponseHit = String(response.hit === true);
    html.dataset.ehplusCacheFirstControllerResponseReason = String(response.reason ?? '').slice(0, 120);
    html.dataset.ehplusCacheFirstControllerResponseDeliveryKind = String(response.delivery?.kind ?? '').slice(0, 80);
    html.dataset.ehplusCacheFirstControllerResponseHasUrl = String(Boolean(response.delivery?.url));
    html.dataset.ehplusCacheFirstControllerResponseFast = String(response.fastResponse === true);
    applyLocalReaderCacheFirstResponseTimingDebug(html, response.timing);
  }
}

function applyLocalReaderCacheFirstResponseTimingDebug(html, timing = null) {
  if (!timing) return;
  html.dataset.ehplusCacheFirstControllerResponseTimingUnit = String(timing.unit || 'ms');
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseStoreOpenMs', timing.storeOpenMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseIndexReadMs', timing.indexReadMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponsePageIndexReadMs', timing.pageIndexReadMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseResourceIndexReadMs', timing.resourceIndexReadMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseHitSelectMs', timing.hitSelectMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseImageLoadMs', timing.imageLoadMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseTotalMs', timing.totalMs);
  setDatasetNumber(html, 'ehplusCacheFirstControllerResponseIndexRecordsFound', timing.indexRecordsFound);
  if (timing.indexReadOk != null) html.dataset.ehplusCacheFirstControllerResponseIndexReadOk = String(timing.indexReadOk === true);
  if (timing.imageLoadOk != null) html.dataset.ehplusCacheFirstControllerResponseImageLoadOk = String(timing.imageLoadOk === true);
  if (timing.indexReadError) html.dataset.ehplusCacheFirstControllerResponseIndexReadError = String(timing.indexReadError).slice(0, 180);
}

function setDatasetNumber(html, key, value) {
  if (Number.isFinite(Number(value))) {
    html.dataset[key] = String(Math.max(0, Math.round(Number(value))));
  }
}

function promiseWithTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), timeoutMs);
    })
  ]);
}

function trackLocalReaderCacheFirstImageLoad(img, state, kind) {
  if (!img || !state) return;
  const html = document.documentElement;
  const startedAt = Date.now();
  const isFallback = kind === 'fallback';
  const startedKey = isFallback
    ? 'ehplusCacheFirstControllerFallbackRequestStartedAt'
    : 'ehplusCacheFirstControllerImageLoadStartedAt';
  const elapsedKey = isFallback
    ? 'ehplusCacheFirstControllerFallbackRequestMs'
    : 'ehplusCacheFirstControllerImageLoadMs';
  const resultKey = isFallback
    ? 'ehplusCacheFirstControllerFallbackRequestResult'
    : 'ehplusCacheFirstControllerImageLoadResult';
  const kindKey = isFallback
    ? 'ehplusCacheFirstControllerFallbackRequestKind'
    : 'ehplusCacheFirstControllerImageLoadKind';

  html.dataset[startedKey] = String(startedAt);
  html.dataset[kindKey] = kind;
  const finish = (result) => {
    html.dataset[elapsedKey] = String(Math.max(0, Date.now() - startedAt));
    html.dataset[resultKey] = result;
    reportLocalReaderCacheFirstTiming(state);
  };
  img.addEventListener('load', () => finish('load'), { once: true });
  img.addEventListener('error', () => finish('error'), { once: true });
}

function scheduleLocalReaderCacheFirstTimingReport(state) {
  setTimeout(() => reportLocalReaderCacheFirstTiming(state), 3000);
}

function reportLocalReaderCacheFirstTiming(state) {
  if (!state || state.timingReported || !isExtensionRuntime()) return;
  const html = document.documentElement;
  const data = html?.dataset ?? {};
  if (shouldDelayLocalReaderCacheFirstTimingReport(state, data)) {
    setTimeout(() => reportLocalReaderCacheFirstTiming(state), 1000);
    return;
  }
  state.timingReported = true;
  const timing = {
    unit: 'ms',
    queryElapsedMs: numberOrNull(data.ehplusCacheFirstControllerQueryElapsedMs),
    storeOpenMs: numberOrNull(data.ehplusCacheFirstControllerResponseStoreOpenMs),
    indexReadMs: numberOrNull(data.ehplusCacheFirstControllerResponseIndexReadMs),
    pageIndexReadMs: numberOrNull(data.ehplusCacheFirstControllerResponsePageIndexReadMs),
    resourceIndexReadMs: numberOrNull(data.ehplusCacheFirstControllerResponseResourceIndexReadMs),
    hitSelectMs: numberOrNull(data.ehplusCacheFirstControllerResponseHitSelectMs),
    responseImageLoadMs: numberOrNull(data.ehplusCacheFirstControllerResponseImageLoadMs),
    responseTotalMs: numberOrNull(data.ehplusCacheFirstControllerResponseTotalMs),
    pageImageLoadMs: numberOrNull(data.ehplusCacheFirstControllerImageLoadMs),
    fallbackRequestMs: numberOrNull(data.ehplusCacheFirstControllerFallbackRequestMs)
  };
  const message = {
    type: LOCAL_READER_CACHE_FIRST_TIMING_TYPE,
    pageKey: state.pageKey,
    pageUrl: state.pageUrl,
    result: state.finalReason || data.ehplusCacheFirstControllerState || '',
    reason: data.ehplusCacheFirstControllerReason || data.ehplusCacheFirstNetworkBlockReason || '',
    queryResult: state.queryResult || data.ehplusCacheFirstControllerQueryResult || '',
    responseReason: data.ehplusCacheFirstControllerResponseReason || '',
    responseHit: data.ehplusCacheFirstControllerResponseHit === 'true',
    responseHasUrl: data.ehplusCacheFirstControllerResponseHasUrl === 'true',
    deliveryKind: data.ehplusCacheFirstControllerResponseDeliveryKind || '',
    networkBlock: data.ehplusCacheFirstNetworkBlock || '',
    indexReadOk: data.ehplusCacheFirstControllerResponseIndexReadOk === 'true',
    imageLoadOk: data.ehplusCacheFirstControllerResponseImageLoadOk === 'true',
    indexReadError: data.ehplusCacheFirstControllerResponseIndexReadError || '',
    imageLoadResult: data.ehplusCacheFirstControllerImageLoadResult || '',
    fallbackRequestResult: data.ehplusCacheFirstControllerFallbackRequestResult || '',
    originalSrc: state.originalSrc,
    finalSrc: document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR)?.currentSrc || '',
    startedAt: state.queryStartedAt,
    finishedAt: state.finishedAt || Date.now(),
    timing
  };
  promiseWithTimeout(
    chrome.runtime.sendMessage(message),
    LOCAL_READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS,
    { ok: false, logged: false, error: 'timing-message-timeout' }
  ).then((response) => {
    if (response?.logged === true) return;
    writeLocalReaderCacheFirstTimingLogFallback(message, response?.error || 'timing-message-no-log');
  }).catch((error) => {
    writeLocalReaderCacheFirstTimingLogFallback(message, runtimeLastErrorMessage() || error?.message || String(error));
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shouldDelayLocalReaderCacheFirstTimingReport(state, data) {
  const result = state.finalReason || data.ehplusCacheFirstControllerState || '';
  if (result === 'hit') return false;
  if (data.ehplusCacheFirstControllerFallbackRequestResult) return false;

  const finishedAt = Number(state.finishedAt);
  if (!Number.isFinite(finishedAt)) return false;
  const maxWaitMs = LOCAL_READER_CACHE_FIRST_RELEASE_TIMEOUT_MS + LOCAL_READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS + 10000;
  return Date.now() - finishedAt < maxWaitMs;
}

function writeLocalReaderCacheFirstTimingLogFallback(message, fallbackReason) {
  if (!chrome?.storage?.local) return;
  chrome.storage.local.get([STATE_KEY, LOGS_KEY]).then((stored) => {
    const current = stored?.[STATE_KEY];
    if (!current || typeof current !== 'object') return;
    const settings = current.settings ?? {};
    if (settings.loggingEnabled === false) return;
    const logs = Array.isArray(stored?.[LOGS_KEY])
      ? stored[LOGS_KEY]
      : Array.isArray(current.logs)
        ? current.logs
        : [];
    const nextLogs = [buildLocalReaderCacheFirstTimingLog(message, fallbackReason), ...logs].slice(0, 120);
    const next = {
      ...current,
      storage: {
        ...(current.storage ?? {}),
        logBytes: estimateLocalReaderLogBytes(nextLogs),
        logCount: nextLogs.length
      }
    };
    return writeLocalReaderSplitStateAndLogs(next, nextLogs);
  }).catch(() => {});
}

async function cleanupEmbeddedRuntimeStateLogs() {
  if (!chrome?.storage?.local) return;
  const stored = await chrome.storage.local.get([STATE_KEY, LOGS_KEY]);
  const current = stored?.[STATE_KEY];
  if (!current || typeof current !== 'object' || !Array.isArray(current.logs)) return;

  const existingLogs = Array.isArray(stored?.[LOGS_KEY]) ? stored[LOGS_KEY] : null;
  const nextLogs = existingLogs ?? current.logs;
  const next = {
    ...current,
    storage: {
      ...(current.storage ?? {}),
      logBytes: estimateLocalReaderLogBytes(nextLogs),
      logCount: nextLogs.length
    }
  };
  delete next.logs;
  sanitizeLocalReaderStateForFallbackWrite(next);
  await chrome.storage.local.set({
    [STATE_KEY]: next,
    ...(existingLogs ? {} : { [LOGS_KEY]: nextLogs })
  });
}

async function readServiceWorkerProbeForDebug() {
  if (!chrome?.storage?.local) return;
  const stored = await chrome.storage.local.get(SERVICE_WORKER_PROBE_KEY);
  const probe = stored?.[SERVICE_WORKER_PROBE_KEY];
  const dataset = document.documentElement.dataset;
  if (!probe || typeof probe !== 'object') {
    dataset.ehplusServiceWorkerProbe = 'missing';
    return;
  }

  const at = Number(probe.at);
  dataset.ehplusServiceWorkerProbe = 'present';
  dataset.ehplusServiceWorkerProbeStage = String(probe.stage ?? '');
  dataset.ehplusServiceWorkerProbeVersion = String(probe.version ?? '');
  dataset.ehplusServiceWorkerProbeAt = Number.isFinite(at) ? String(at) : '';
  dataset.ehplusServiceWorkerProbeAgeMs = Number.isFinite(at) ? String(Date.now() - at) : '';
}

function writeLocalReaderSplitStateAndLogs(state, logs) {
  const next = sanitizeLocalReaderStateForFallbackWrite({
    ...state
  });
  delete next.logs;
  return chrome.storage.local.set({ [STATE_KEY]: next, [LOGS_KEY]: Array.isArray(logs) ? logs : [] });
}

function sanitizeLocalReaderStateForFallbackWrite(state) {
  const tabs = state?.accountRefresh?.activeTabs;
  if (!Array.isArray(tabs)) return state;
  state.accountRefresh = {
    ...state.accountRefresh,
    activeTabs: tabs.slice(0, 80).map((tab) => ({
      id: tab?.id ?? null,
      url: summarizeLocalReaderTabUrl(tab?.url)
    }))
  };
  return state;
}

function summarizeLocalReaderTabUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 240);
  }
}

function buildLocalReaderCacheFirstTimingLog(message, fallbackReason) {
  return {
    at: Date.now(),
    level: message.result === 'hit' ? 'info' : 'debug',
    event: 'reader-cache-first.timing',
    action: 'record-reader-cache-first-timing',
    message: message.result === 'hit' ? 'reader cache-first 命中耗时已记录' : 'reader cache-first 回退耗时已记录',
    requestId: `content-timing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    simulated: false,
    source: 'content-script',
    page: {
      tabId: null,
      frameId: null,
      url: location.href,
      origin: location.origin
    },
    context: {
      pageKey: String(message.pageKey ?? '').slice(0, 80),
      pageUrl: String(message.pageUrl ?? '').slice(0, 240),
      result: String(message.result ?? '').slice(0, 80),
      reason: String(message.reason ?? '').slice(0, 120),
      queryResult: String(message.queryResult ?? '').slice(0, 80),
      responseReason: String(message.responseReason ?? '').slice(0, 120),
      responseHit: message.responseHit === true,
      responseHasUrl: message.responseHasUrl === true,
      deliveryKind: String(message.deliveryKind ?? '').slice(0, 80),
      networkBlock: String(message.networkBlock ?? '').slice(0, 80),
      fallbackWriter: 'content-script',
      fallbackReason: String(fallbackReason ?? '').slice(0, 120)
    },
    result: {
      ok: true,
      timing: normalizeLocalReaderTimingPayload(message.timing),
      startedAt: numberOrNull(message.startedAt),
      finishedAt: numberOrNull(message.finishedAt),
      durationMs: localReaderDurationMs(message.startedAt, message.finishedAt),
      indexReadOk: message.indexReadOk === true,
      imageLoadOk: message.imageLoadOk === true,
      indexReadError: String(message.indexReadError ?? '').slice(0, 180),
      imageLoadResult: String(message.imageLoadResult ?? '').slice(0, 80),
      fallbackRequestResult: String(message.fallbackRequestResult ?? '').slice(0, 80),
      originalSrc: String(message.originalSrc ?? '').slice(0, 240),
      finalSrc: String(message.finalSrc ?? '').slice(0, 240)
    },
    error: null
  };
}

function normalizeLocalReaderTimingPayload(timing = {}) {
  return {
    unit: 'ms',
    queryElapsedMs: numberOrNull(timing.queryElapsedMs),
    storeOpenMs: numberOrNull(timing.storeOpenMs),
    indexReadMs: numberOrNull(timing.indexReadMs),
    pageIndexReadMs: numberOrNull(timing.pageIndexReadMs),
    resourceIndexReadMs: numberOrNull(timing.resourceIndexReadMs),
    hitSelectMs: numberOrNull(timing.hitSelectMs),
    responseImageLoadMs: numberOrNull(timing.responseImageLoadMs),
    responseTotalMs: numberOrNull(timing.responseTotalMs),
    pageImageLoadMs: numberOrNull(timing.pageImageLoadMs),
    fallbackRequestMs: numberOrNull(timing.fallbackRequestMs)
  };
}

function localReaderDurationMs(startedAt, finishedAt) {
  const started = numberOrNull(startedAt);
  const finished = numberOrNull(finishedAt);
  if (started == null || finished == null || finished < started) return null;
  return Math.max(0, Math.round(finished - started));
}

function estimateLocalReaderLogBytes(logs) {
  return new Blob([JSON.stringify(logs)]).size;
}

function setLocalReaderCacheFirstNetworkBlockDebug(status, details = {}) {
  const html = document.documentElement;
  if (!html?.dataset) return;
  html.dataset.ehplusCacheFirstNetworkBlock = status;
  html.dataset.ehplusCacheFirstNetworkBlockUpdatedAt = String(Date.now());
  html.dataset.ehplusCacheFirstNetworkBlockPageKey = details.pageKey || parseReaderPageKey(location.href) || '';
  if (details.messageId != null) html.dataset.ehplusCacheFirstNetworkBlockMessageId = String(details.messageId);
  if (details.reason) html.dataset.ehplusCacheFirstNetworkBlockReason = String(details.reason).slice(0, 80);
  if (details.error) html.dataset.ehplusCacheFirstNetworkBlockError = String(details.error).slice(0, 180);
}

function runtimeLastErrorMessage() {
  try {
    return typeof chrome !== 'undefined' ? chrome.runtime?.lastError?.message || '' : '';
  } catch {
    return '';
  }
}

function postLocalReaderCacheFirstMainDecision(message) {
  window.postMessage({
    type: LOCAL_READER_CACHE_FIRST_MAIN_APPLY_TYPE,
    pageKey: message.pageKey,
    result: message.result,
    reason: message.reason,
    url: message.url || ''
  }, location.origin);
}

function ensureLocalReaderCacheFirstNetworkBlock(pageKey) {
  return sendLocalReaderCacheFirstNetworkBlockMessage('ensure', pageKey);
}

function releaseLocalReaderCacheFirstNetworkBlock(pageKey, reason) {
  return sendLocalReaderCacheFirstNetworkBlockMessage('release', pageKey, reason);
}

function scheduleLocalReaderCacheFirstNetworkBlockRelease(pageKey, reason, attempt = 1) {
  releaseLocalReaderCacheFirstNetworkBlock(pageKey, reason)
    .then((response) => {
      if (response?.ok || attempt >= LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_COUNT) return;
      setTimeout(() => {
        scheduleLocalReaderCacheFirstNetworkBlockRelease(pageKey, reason, attempt + 1);
      }, LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_DELAY_MS);
    })
    .catch(() => {
      if (attempt >= LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_COUNT) return;
      setTimeout(() => {
        scheduleLocalReaderCacheFirstNetworkBlockRelease(pageKey, reason, attempt + 1);
      }, LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_DELAY_MS);
    });
}

function sendLocalReaderCacheFirstNetworkBlockMessage(action, pageKey, reason = '') {
  if (!isExtensionRuntime()) return Promise.resolve({ ok: true, skipped: true });
  const messageId = ++localReaderCacheFirstNetworkBlockMessageId;
  setLocalReaderCacheFirstNetworkBlockDebug(`${action}-start`, { pageKey, reason, messageId });
  const isLatestMessage = () => {
    return document.documentElement?.dataset?.ehplusCacheFirstNetworkBlockMessageId === String(messageId);
  };
  try {
    return promiseWithTimeout(chrome.runtime.sendMessage({
      type: LOCAL_READER_CACHE_FIRST_BLOCK_TYPE,
      action,
      pageKey,
      reason,
      url: location.href,
      at: Date.now()
    }), LOCAL_READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS, {
      ok: false,
      error: `${action}-message-timeout`
    }).then((response) => {
      if (isLatestMessage()) {
        setLocalReaderCacheFirstNetworkBlockDebug(response?.ok ? `${action}-ok` : `${action}-failed`, {
          pageKey,
          reason: response?.reason || reason,
          error: response?.error,
          messageId
        });
      }
      return response;
    }).catch((error) => {
      if (isLatestMessage()) {
        setLocalReaderCacheFirstNetworkBlockDebug(`${action}-error`, {
          pageKey,
          reason,
          error: runtimeLastErrorMessage() || error?.message || String(error),
          messageId
        });
      }
      return { ok: false, error: runtimeLastErrorMessage() || error?.message || String(error) };
    });
  } catch (error) {
    if (isLatestMessage()) {
      setLocalReaderCacheFirstNetworkBlockDebug(`${action}-error`, {
        pageKey,
        reason,
        error: runtimeLastErrorMessage() || error?.message || String(error),
        messageId
      });
    }
    return Promise.resolve({ ok: false, error: runtimeLastErrorMessage() || error?.message || String(error) });
  }
}

function restoreLocalReaderOriginalImage(img, state) {
  const originalSrc = img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR) || state?.originalSrc || '';
  const originalSrcset = img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR) || state?.originalSrcset || '';

  stripCurrentReaderInlineRetryHandlers(img);
  if (originalSrcset) {
    img.setAttribute('srcset', originalSrcset);
  }
  if (originalSrc) {
    img.src = originalSrc;
  }

  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR);
  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR);
}

function stripCurrentReaderInlineRetryHandlers(img = document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR)) {
  if (img) stripInlineImageRetryHandler(img);
  const loadfail = document.querySelector('#loadfail');
  if (loadfail) stripInlineLoadfailRetryHandler(loadfail);
}

function stripInlineImageRetryHandler(img) {
  if (!img) return;
  img.removeAttribute('onerror');
  if ('onerror' in img) img.onerror = null;
}

function stripInlineLoadfailRetryHandler(node) {
  if (!node) return;
  node.removeAttribute('onclick');
  if ('onclick' in node) node.onclick = null;
}

function localReaderCacheFirstPlaceholderUrl() {
  try {
    return chrome.runtime.getURL(LOCAL_READER_CACHE_FIRST_PLACEHOLDER_PATH);
  } catch {
    return '';
  }
}

async function applyLocalCacheToCurrentPage() {
  if (!isExtensionRuntime()) return;
  if (!isReaderCacheFirstEnabled()) return;

  const pageKey = parseReaderPageKey(location.href);
  if (pageKey) {
    // /s/ 阅读页：内置自动翻页激活时让位（DNR 网络门协调）。
    if (isAutoPagerCompatibilityActive()) return;
    await applyLocalReaderCache(pageKey);
    return;
  }

  // /g/ 画廊页：缩略图替换与内置画廊自动翻页不冲突，拼接页由
  // applyGalleryAutoPagerCache 自行处理，这里只负责初始页面。
  if (isGalleryPageUrl(location.href)) {
    await applyLocalGalleryCache();
  }
}

async function applyLocalReaderCache(pageKey) {
  const img = document.querySelector('#img');
  if (!img || img.dataset.ehplusCacheHit === 'true' || img.dataset.ehplusCacheFirstPending === 'true' || isAutoPagerCompatibilityActive()) return;

  // 纯投递查询：统计（访问/命中）由页面会话与 cache-first 主图查询负责，避免同一次访问重复计数。
  const response = await queryLocalPageCache(pageKey, location.href, { countStats: false, fastResponse: true });
  if (!isUsableCacheHit(response) || isAutoPagerCompatibilityActive()) return;

  applyCachedImage(img, response.delivery.url, {
    pageKey,
    scope: 'reader'
  });
}

async function applyLocalGalleryCache() {
  const links = Array.from(document.querySelectorAll('a[href*="/s/"]'));
  const seen = new Set();
  let queried = 0;

  for (const link of links) {
    if (queried >= LOCAL_CACHE_GALLERY_LIMIT) break;

    const pageKey = parseReaderPageKey(link.href);
    const img = link.querySelector('img');
    if (!pageKey || !img || img.dataset.ehplusCacheHit === 'true' || seen.has(pageKey)) continue;

    seen.add(pageKey);
    queried += 1;
    // 缩略图替换走快速内存路径，不触发全量缓存重扫，也不计入命中率统计。
    const response = await queryLocalPageCache(pageKey, link.href, { countStats: false, fastResponse: true });
    if (!isUsableCacheHit(response)) continue;

    applyCachedImage(img, response.delivery.url, {
      pageKey,
      scope: 'gallery'
    });
  }
}

async function queryLocalPageCache(pageKey, pageUrl, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.fastResponse === true
    ? LOCAL_READER_CACHE_FIRST_QUERY_TIMEOUT_MS
    : LOCAL_READER_CACHE_FIRST_HARD_TIMEOUT_MS;
  return promiseWithTimeout(chrome.runtime.sendMessage({
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey,
    pageUrl,
    responseMode: 'url',
    requestedBy: LOCAL_CACHE_CONSUMER_REQUESTED_BY,
    countStats: options.countStats !== false,
    statsScope: options.statsScope ?? '',
    fastResponse: options.fastResponse === true
  }), timeoutMs, buildRuntimeQueryTimeoutResponse(pageKey, pageUrl, startedAt, timeoutMs));
}

function buildRuntimeQueryTimeoutResponse(pageKey, pageUrl, startedAt, timeoutMs) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  return {
    ok: false,
    hit: false,
    reason: 'runtime-timeout',
    pageKey,
    pageUrl,
    countsAsCacheHit: false,
    timing: {
      unit: 'ms',
      source: 'content-timeout',
      storeOpenMs: null,
      pageIndexReadMs: null,
      resourceIndexReadMs: null,
      indexReadMs: elapsedMs || timeoutMs,
      indexReadOk: false,
      indexReadError: 'runtime-timeout',
      indexRecordsFound: null,
      hitSelectMs: null,
      imageLoadMs: null,
      imageLoadOk: false,
      totalMs: elapsedMs || timeoutMs
    }
  };
}

function isUsableCacheHit(response) {
  const url = response?.delivery?.url;
  return response?.hit === true
    && typeof url === 'string'
    && /^(data:|blob:|chrome-extension:)/.test(url);
}

function applyCachedImage(img, url, context) {
  img.dataset.ehplusOriginalSrc = context.originalSrc || img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR) || img.getAttribute('src') || img.src || img.currentSrc || '';
  const originalSrcset = img.getAttribute('srcset');
  const cacheFirstSrcset = context.originalSrcset || img.getAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR) || '';
  if (originalSrcset || cacheFirstSrcset) {
    img.dataset.ehplusOriginalSrcset = originalSrcset || cacheFirstSrcset;
    img.removeAttribute('srcset');
  }
  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR);
  img.removeAttribute(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRCSET_ATTR);
  img.dataset.ehplusCacheHit = 'true';
  img.dataset.ehplusCachePageKey = context.pageKey;
  img.dataset.ehplusCacheScope = context.scope;
  img.src = url;
}

// 与 MAIN world（reader-cache-first-main.js 的 isOwnAutoPagerActive）对齐：
// 只识别 EH＋ 内置自动翻页自己的 DOM 痕迹，内置翻页激活时 isolated 侧的
// DNR 网络门与缓存查询同样让位（规划 2026-07-06 双 world 协调）。
function isAutoPagerCompatibilityActive() {
  return hasBuiltInAutoPagerDom();
}

function syncReaderCacheFirstSetting(settings) {
  if (!isExtensionRuntime()) return;
  const enabled = settings?.readerCacheFirstEnabled === true;
  try {
    localStorage.setItem(LOCAL_READER_CACHE_FIRST_LEGACY_ENABLED_STORAGE_KEY, '0');
    localStorage.setItem(
      LOCAL_READER_CACHE_FIRST_ENABLED_STORAGE_KEY,
      enabled ? '1' : '0'
    );
  } catch {
    // Best-effort page-side hint for the MAIN-world holder.
  }
  const pageKey = parseReaderPageKey(location.href);
  if (!pageKey) return;
  if (!enabled) {
    releaseLocalReaderCacheFirstNetworkBlock(pageKey, 'setting-disabled');
  }
}

function isReaderCacheFirstEnabled() {
  try {
    return localStorage.getItem(LOCAL_READER_CACHE_FIRST_ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const DEFAULT_CELL_COLORS = {
  loading: '#d8b34c',
  idle: '#7d7d7d',
  prefetch: '#4aa3ff',
  hit: '#4cd07d',
  error: '#ff6d6d',
  paused: '#b382ff',
  cached: '#4cd07d',
  meta: '#4aa3ff',
  queued: '#8f8f8f',
  miss: '#4a4a4a'
};

const CELL_COLOR_KEYS = [
  'loading',
  'idle',
  'prefetch',
  'hit',
  'error',
  'paused',
  'cached',
  'meta',
  'queued',
  'miss'
];

const ACCOUNT_STATUS_FIELD_KEYS = ['quota', 'resetCost', 'credits', 'gp', 'hath', 'updatedAt'];
const DEFAULT_ACCOUNT_STATUS_FIELDS = {
  quota: true,
  resetCost: false,
  credits: true,
  gp: true,
  hath: true,
  updatedAt: false
};
const STATS_DISPLAY_FIELD_KEYS = ['readerReads', 'readerHits', 'readerHitRate', 'galleryReads', 'galleryCache'];
const DEFAULT_STATS_DISPLAY_FIELDS = {
  readerReads: false,
  readerHits: false,
  readerHitRate: false,
  galleryReads: false,
  galleryCache: false
};
const LOG_DISPLAY_FIELD_KEYS = ['logUsage', 'logRows'];
const DEFAULT_LOG_DISPLAY_FIELDS = {
  logUsage: true,
  logRows: true
};

const I18N = {
  'zh-CN': {
    title: 'EH＋',
    show: '展开',
    hide: '收起',
    settings: '设置',
    collapseSettings: '收起',
    enabled: '启用预加载',
    depth: '深度',
    offset: '偏移',
    blob: '图片缓存',
    readerCacheFirst: '优先取本地缓存',
    loading: '加载中...',
    readerCacheFirstHitStatus: '已命中缓存 {target}',
    runtimeFallbackStatus: '后台暂不可用，显示本地状态',
    runtimeFallbackDetail: '后台状态读取失败：{reason}',
    detailEmpty: '仅索引 0 | 已缓存 0 | 图片 -',
    tabStorage: '存储',
    tabImage: '图片',
    tabAutoPager: '自动翻页',
    tabLogs: '日志',
    tabAccount: '账号',
    tabDawn: '签到',
    tabStats: '统计',
    tabCleanup: '清理',
    tabMigration: '迁移',
    tabLanguage: '语言',
    tabColors: '颜色',
    tabAbout: '关于',
    storageMode: '存储位置',
    indexeddb: '浏览器默认存储',
    directory: '自定义存储地址',
    storageAddress: '地址',
    browserStorageAddress: '{origin} / IndexedDB / Blob',
    directoryNotSelected: '未选择',
    chooseDirectory: '选择目录',
    browserStoragePathRule: '默认存储不能直接跳转硬盘目录。Chrome 打开 chrome://version，Edge 打开 edge://version，复制 Profile Path 后查看这些候选目录：<Profile Path>\\IndexedDB\\https_e-hentai.org_0.indexeddb.leveldb、<Profile Path>\\IndexedDB\\https_exhentai.org_0.indexeddb.leveldb、<Profile Path>\\blob_storage\\、<Profile Path>\\Service Worker\\CacheStorage\\、<Profile Path>\\Local Storage\\leveldb\\。',
    browserStoragePathRuleStatus: '点击地址可查看默认存储路径拼接规则',
    browserStorageRiskTip: '浏览器默认存储通常可长期保存，但可能被以下操作清理：用户手动清理浏览数据、清理 Cookie 和其他网站数据、清理 e-hentai.org / exhentai.org 的站点数据、浏览器在磁盘压力或配额压力下回收默认存储、浏览器 profile 损坏/重置/同步/迁移异常、第三方清理工具清理浏览器缓存/站点数据、隐私软件或安全软件清理浏览器数据。需要更可控的文件缓存时，请使用自定义存储地址。',
    directorySelected: '目录已选择',
    directorySelectCancelled: '已取消选择目录',
    directoryAuthorizationOpened: '目录授权窗口已打开，请在窗口内确认选择',
    directoryMigrationAccepted: '已开始迁移旧目录数据',
    directoryMigrationSkipped: '已切换目录，未迁移旧目录数据',
    migrateDirectoryConfirm: '是否将 {from} 迁移到 {to}？',
    preloadEnabled: '启用预加载',
    preloadAhead: '预加载页数',
    globalConcurrency: '全局并发',
    pageOffset: '页码偏移',
    imageBlob: '图片缓存',
    externalImageCacheFill: '外部图片补存',
    preloadEnabledTip: '控制是否启用页面预加载。关闭后状态点会显示暂停，预加载不会继续排队。',
    preloadAheadTip: '以当前页面为基准向后预加载的页数，每个页面单独计算。数值越大，理论上能提前准备更多页面，但也会增加缓存和请求压力。后台始终生效，勾选只影响 UI 显示。',
    globalConcurrencyTip: '所有页面共享的最大并发加载数，默认 5。多开页面时优先调度当前聚焦页面；切换页面只重排尚未发送请求的队列，已发送请求不会中断。后台始终生效，勾选只影响 UI 显示。',
    panelDisplayToggleTip: '勾选后在面板上显示 当前值/设置值。',
    pageOffsetTip: '用于当前页码和预加载矩阵的页码偏移。',
    imageBlobTip: '控制是否缓存图片本体。开启后会缓存图片 Blob；关闭后只保留仅索引记录和统计。',
    readerCacheFirstTip: '页面打开/刷新时，优先检索本地缓存，命中则取消请求，从本地加载。如果勾选，则走这个逻辑；如果取消勾选，则不拦截图片请求，只做缓存写入。',
    externalImageCacheFillTip: '观察到其他插件或页面已经加载图片后，低优先级尝试用浏览器 HTTP 缓存补存到本地图片缓存；不拦截、不改写其他插件请求。',
    autoPagerEnabled: '启用自动翻页',
    autoPagerRemain: '剩余高度倍数',
    autoPagerMaxPages: '最多翻页',
    autoPagerImmediateEnabled: '立即翻页',
    autoPagerImmediatePages: '立即翻页页数',
    autoPagerSeparatorEnabled: '显示分隔符',
    autoPagerAplus: '翻页后提前准备下一页',
    autoPagerEnabledTip: '开启后，EH＋在 /s/ 阅读页按 Super-preloader 的 EH/EX 规则自动拼接下一页；在 /g/ 画廊页自动拼接下一分页的缩略图。',
    autoPagerRemainTip: '页面剩余高度小于视窗高度的这个倍数时触发翻页。',
    autoPagerMaxPagesTip: '当前页面最多自动拼接的后续页数。',
    autoPagerImmediateTip: '页面加载后立即自动拼接指定页数。',
    autoPagerAplusTip: '每次拼接后提前查询下一页本地缓存。',
    highReadProtect: '常看图片保护',
    highReadProtectTip: '开启后，访问次数超过阈值的图片会被标记为受保护图片。按天数清理或自动清理时默认跳过这些图片；只有清理时明确包含受保护图片，或执行全部图片/全部缓存清理，才会一起清理。',
    highReadThreshold: '访问次数',
    highReadGalleryProtect: '常看画廊 /g/ 保护',
    highReadGalleryProtectTip: '开启后，访问次数超过阈值的 /g/ 画廊会被标记为受保护画廊。按天数清理或自动清理时默认跳过这些画廊；只有清理时明确包含受保护画廊，或执行全部清理，才会一起清理。',
    highReadGalleryThreshold: '画廊访问次数',
    imageProtectionLoading: '受保护图片统计加载中...',
    loggingEnabled: '记录日志',
    logDebugEnabled: 'Debug 文本日志',
    logDebugTip: '开启后，最近 24 小时保留文本请求响应全文，包括 HTML；不保存图片或 Blob 内容。关闭后会清除日志里的全文文本，只保留普通摘要。',
    logFieldSelect: '上方显示字段',
    logRetentionDays: '保留天数',
    logLimitValue: '大小上限',
    storageLimitValue: '分配存储空间',
    unit: '单位',
    logHelp: '日志记录事件、动作、请求 ID、来源、页面上下文、输入摘要、结果和错误堆栈。',
    accountFieldSelect: '上方显示字段',
    refreshAccount: '刷新账号',
    resetQuota: '重置限额',
    resetQuotaWithCost: '重置 {cost} GP',
    confirm: '确认',
    cancel: '取消',
    confirmReset: '确认重置？',
    quotaTip: '重置页面显示的是官方预估/标称 GP 花费。实际扣除可能因官方换算、余额抵扣或站点规则不同而变化。当 GP 不足时，官方可能会自动消耗 Credits 进行兑换。本插件会在提交前后分别读取 Credits、Hath、GP，并用差值计算实际消耗。',
    quotaTipText: '实际消耗以提交前后余额差值显示。',
    dawnEnabled: '页面打开自动签到',
    dawnEnabledTip: '开启后，当你打开或刷新 E-Hentai / ExHentai 的 /g/ 画廊页或 /s/ 阅读页时，如果已经到 UTC 03:00 后且今天还没有检查过，会自动请求 news.php 签到。需要有页面打开。',
    backgroundDawn: '后台自动签到',
    backgroundDawnTip: '开启后，扩展后台会用 chrome.alarms 在 UTC 03:00 后自动请求 news.php 签到；不需要打开 /g/ 或 /s/ 页面，但需要浏览器和扩展后台可运行。',
    dawnIntro: '每天 UTC 00:00（北京时间 08:00）后，访问 news.php 或 EH/EX 画廊页会触发 Dawn of a New Day 奖励事件，可能获得 EXP、Credits、GP、Hath 等奖励；奖励受 Stars、Awards、有效评论等账号条件影响，可能为 0。本功能只是自动访问官方页面并显示返回结果，自动签到在 UTC 03:00 后触发。',
    runDawn: '手动立即签到',
    statsFieldSelect: '上方显示字段',
    historyLimit: '浏览历史上限',
    historyLimitTip: '浏览历史最多保留的条数，默认 100。超过上限时按最近观看时间删除最旧的历史记录；调整上限不影响图片缓存、经常观看计数或命中率统计。',
    openHistory: '打开浏览历史',
    openHistoryFailed: '无法打开浏览历史页面',
    cacheBlockedReason: '新图片缓存已暂停：{reason}',
    all: '全部',
    gallery: '画廊页 /g/',
    reader: '阅读页 /s/',
    scope: '范围',
    mode: '模式',
    images: '图片',
    logs: '日志',
    other: '其他',
    cleanupAll: '全部清理',
    cleanupOlder: '清理 N 天之前',
    days: '天数',
    cleanupDaysTip: '0天表示不按照时间清理缓存。',
    includeProtected: '包含受保护图片',
    includeProtectedGalleries: '包含受保护画廊',
    cleanupPreview: '预估清理',
    cleanupConfirm: '确认清理',
    noPreview: '尚未预估',
    deleteOldCache: '成功后删除旧缓存',
    startMigration: '开始迁移',
    retryMigration: '重试迁移',
    cancelMigration: '取消迁移',
    migrationProgress: '迁移进度',
    migrationProgressValue: '{done} / {total}（跳过 {skipped}）',
    migrationStarted: '迁移已开始，可随时取消',
    migrationCancelPending: '正在取消迁移…',
    migrationCancelled: '迁移已取消，重试可从断点续迁',
    migrationNotRunning: '当前没有正在进行的迁移',
    migrationFailed: '迁移存在失败条目，旧缓存已保留',
    migrationCancelling: '取消中',
    migrationCancelledState: '已取消',
    migrationHelp: '迁移会读取旧 IndexedDB/Blob、写入授权目录、逐条校验索引与文件大小；已迁移条目重试时自动跳过（断点续迁）。失败、取消或中断都不会删除旧缓存。',
    uiLanguage: '界面语言',
    languageHelp: '语言设置会统一应用到浮窗、设置抽屉、状态和 popup；默认语言为中文。',
    colorHelp: '点击圆点或调色盘选择颜色，也可以输入 ff、0ff、00e5ff 或 #00e5ff。确认后才生效；取消或点击其他区域会撤销本次修改。',
    applyNow: '修改后立即生效',
    syncNow: '保存设置',
    statusReady: '就绪',
    statusPaused: '预加载已暂停',
    meta: '仅索引',
    cachedCount: '已缓存',
    globalConcurrencyShort: '并发',
    preloadQueueShort: '预加载',
    totalUsage: '总占用',
    logCount: '日志',
    entries: '条',
    storageTotal: '总占用',
    protectedImages: '受保护图片',
    protectedGalleries: '受保护画廊',
    migrationCache: '迁移缓存',
    items: '项',
    imageCountUnit: '张',
    currentLogUsage: '当前日志占用',
    logRows: '日志条数',
    retention: '保留时间',
    limit: '大小上限',
    imageQuota: '图片限额',
    resetNominal: '重置限额 Cost',
    resetFreeDisabled: '重置花费为 0 GP，无需重置',
    updatedAt: '更新时间',
    normal: '正常',
    high: '偏高',
    overLimit: '超出限额',
    none: '无',
    lastDawnAt: '最后签到时间',
    lastDawnResult: '最后签到结果',
    reward: '奖励',
    officialReset: '官方刷新',
    autoDawn: '自动签到',
    backgroundDawnSuccessCount: '累计后台自动签到次数',
    readerReads: '/s/ 图片访问',
    readerHits: '/s/ 缓存命中',
    readerHitRate: '/s/ 命中率',
    galleryReads: '/g/ 画廊访问',
    galleryCache: '/g/ 资源缓存',
    disabled: '未启用',
    state: '状态',
    oldDirectory: '旧目录',
    oldCacheCount: '旧缓存数量',
    oldCacheSize: '旧缓存大小',
    targetDirectory: '新目录',
    migrated: '已迁移',
    failed: '失败',
    deletedOldCache: '删除旧缓存',
    lastRun: '最后运行',
    requestCount: '请求数',
    version: '版本',
    mode: '模式',
    takeoverState: '接管状态',
    autoPager: '自动翻页',
    preloadMode: '预加载模式',
    detected: '已检测',
    notDetected: '未检测',
    yes: '是',
    no: '否',
    idle: '待迁移',
    running: '迁移中',
    completed: '已完成',
    invalidDays: '请输入非负整数天数',
    zeroDayKeep: '0天表示不按照时间清理缓存。',
    zeroDayInclude: '0天表示不按照时间清理缓存。',
    applying: '正在应用...',
    applied: '设置已生效',
    applyFailed: '应用失败',
    synced: '手动同步完成',
    accountRefreshPending: '账号刷新中...',
    accountRefreshed: '账号状态已刷新',
    accountRefreshFailed: '账号刷新失败：{message}',
    dawnPending: '签到请求中...',
    dawnDone: '签到结果：{message}',
    dawnFailed: '签到失败：{message}',
    quotaPreparePending: '正在读取限额状态...',
    quotaConfirmNeeded: '请确认限额重置',
    quotaPrepareFailed: '限额状态读取失败：{message}',
    quotaResetPending: '正在重置限额...',
    quotaResetDone: '限额重置完成',
    quotaResetFailed: '限额重置失败：{message}',
    quotaCancelled: '已取消重置',
    cleanupDone: '清理完成',
    migrationSynced: '迁移设置已同步',
    migrationDone: '迁移完成',
    liveLoading: '正在加载第 {n} 页…',
    liveLoadedCache: '第 {n} 页已用本地缓存',
    liveLoaded: '第 {n} 页加载完成',
    liveFailed: '第 {n} 页加载失败，换源重试中…',
    liveRetryOk: '第 {n} 页换源重试成功',
    liveRetryFail: '第 {n} 页换源后仍失败',
    stateRefreshed: '状态已刷新',
    openOfficial: '打开官方页面：{url}',
    noTargetUrl: '暂无跳转地址',
    confirmCost: '确认花费 {cost} GP？',
    resetCost: '重置消耗：{cost} GP',
    actualCost: '实际消耗：',
    remaining: '目前剩余：',
    cleanupWill: '将清理：',
    cleanupWillBefore: '将清理{time}之前的数据：',
    cleanupRelease: '预计释放：{value}',
    skippedProtected: '跳过受保护图片：{count} 项',
    skippedProtectedGalleries: '跳过受保护画廊：{count} 项',
    cleanupDoneTitle: '清理完成：',
    successSkippedFailed: '{label} 成功 {success}，跳过 {skipped}，失败 {failed}',
    successFailed: '{label} 成功 {success}，失败 {failed}',
    releaseSpace: '释放空间 {value}',
    cellError: '错误',
    cellCached: '已缓存',
    cellMeta: '仅索引',
    cellMetaTip: '已记录页面索引，但尚未缓存图片本体。',
    cellQueued: '排队',
    cellMiss: '未命中',
    cellLoading: '加载中',
    cellIdle: '空闲',
    cellPrefetch: '待加载',
    cellPrefetchTip: '预加载窗口内的预留位置，尚未记录索引，也尚未缓存图片本体。',
    cellHit: '命中',
    cellPaused: '暂停',
    cellExactTitle: 'P{page}（实际第 {actualPage} 页）：{state}',
    cellTitle: 'P{page}：{state}',
    dawnNotRun: '尚未签到',
    dawnSuccess: '签到成功',
    dawnSuccessWithReward: '签到成功：{reward}',
    dawnCheckedOn: '{date}已签到',
    dawnAlreadyClaimed: '今日已签到',
    resetSuccess: '已成功重置限额',
    aboutTitle: '关于 EH＋',
    currentVersion: '当前版本',
    githubSource: '项目地址',
    updateBadge: '有新版本',
    openGithub: '打开 GitHub',
    checkUpdate: '检查更新',
    checkingUpdate: '正在查询',
    downloadUpdate: '下载新版',
    updateNotConfigured: '尚未配置项目 GitHub Release 地址，无法检查真实版本。配置真实仓库和 Release API 后会直接查询 GitHub Releases。',
    updateAvailable: '发现新版本：{version}',
    updateLatest: '当前已是最新版本。',
    updateFailed: '检查更新失败：{message}',
    latestVersion: '最新版本',
    downloadUrl: '下载地址',
    uniqueSourceNotice: '唯一官方来源是项目 GitHub 仓库。这里会打开真实项目地址。',
    freeNotice: '本项目免费开源。',
    resaleNotice: '其他任何地方付费获取，均为第三方将开源项目贩卖的个人行为，与本项目无关。',
    githubIconLabel: 'GitHub',
    downloadStarted: '已开始下载 GitHub Release 文件',
    downloadBlocked: '下载地址不是允许的 GitHub Release 地址'
  },
  'en-US': {
    title: 'EH＋',
    show: 'Expand',
    hide: 'Collapse',
    settings: 'Settings',
    collapseSettings: 'Close',
    enabled: 'Preload',
    depth: 'Depth',
    offset: 'Offset',
    blob: 'Blob',
    loading: 'Loading...',
    runtimeFallbackStatus: 'Background unavailable, showing local state',
    runtimeFallbackDetail: 'Background state read failed: {reason}',
    detailEmpty: 'Index only 0 | Cached 0 | Img -',
    tabStorage: 'Storage',
    tabImage: 'Images',
    tabAutoPager: 'Auto pager',
    tabLogs: 'Logs',
    tabAccount: 'Account',
    tabDawn: 'Dawn',
    tabStats: 'Stats',
    tabCleanup: 'Cleanup',
    tabMigration: 'Migration',
    tabLanguage: 'Language',
    tabColors: 'Colors',
    tabAbout: 'About',
    storageMode: 'Storage location',
    indexeddb: 'Browser default storage',
    directory: 'Custom storage address',
    storageAddress: 'Address',
    browserStorageAddress: '{origin} / IndexedDB / Blob',
    directoryNotSelected: 'Not selected',
    chooseDirectory: 'Choose directory',
    browserStoragePathRule: 'Default storage cannot jump directly to a disk folder. In Chrome open chrome://version; in Edge open edge://version; copy Profile Path, then check these candidate folders: <Profile Path>\\IndexedDB\\https_e-hentai.org_0.indexeddb.leveldb, <Profile Path>\\IndexedDB\\https_exhentai.org_0.indexeddb.leveldb, <Profile Path>\\blob_storage\\, <Profile Path>\\Service Worker\\CacheStorage\\, <Profile Path>\\Local Storage\\leveldb\\.',
    browserStoragePathRuleStatus: 'Click the address to see the default-storage path rule',
    browserStorageRiskTip: 'Browser default storage can usually persist, but may be cleared by manual browsing-data cleanup, cookie/site-data cleanup, e-hentai.org / exhentai.org site-data cleanup, browser quota/disk-pressure eviction, profile reset/sync/migration issues, third-party cleaner tools, or privacy/security software. For more controllable file cache, use a custom storage address.',
    directorySelected: 'Directory selected',
    directorySelectCancelled: 'Directory selection cancelled',
    directoryAuthorizationOpened: 'Directory authorization window opened. Confirm the directory there.',
    directoryMigrationAccepted: 'Started migration from the old directory',
    directoryMigrationSkipped: 'Directory switched without migrating old data',
    migrateDirectoryConfirm: 'Migrate {from} to {to}?',
    preloadEnabled: 'Enable preload',
    preloadAhead: 'Preload pages',
    globalConcurrency: 'Global concurrency',
    pageOffset: 'Page offset',
    imageBlob: 'Image Blob',
    readerCacheFirst: 'Prefer local cache',
    readerCacheFirstHitStatus: 'Local cache hit {target}',
    externalImageCacheFill: 'External image cache-fill',
    preloadEnabledTip: 'Controls whether page preloading is enabled. When off, the status dot shows paused and preload work no longer queues.',
    preloadAheadTip: 'How many pages to preload ahead of the current page, counted per page. Higher values prepare more pages but can increase cache and request pressure. Always active in the background; the checkbox only affects the panel display.',
    globalConcurrencyTip: 'Maximum shared concurrent loads across all pages. Default is 5. When multiple pages are open, the focused page is prioritized; switching pages only reorders queued requests, and already-sent requests continue. Always active in the background; the checkbox only affects the panel display.',
    panelDisplayToggleTip: 'When checked, show current/configured value on the panel.',
    pageOffsetTip: 'Page-number offset used by the current page and preload matrix.',
    imageBlobTip: 'Controls whether image bodies are cached. When enabled, image Blob data is cached; when disabled, only index-only records and statistics are kept.',
    readerCacheFirstTip: 'When a page opens or refreshes, check local cache before the image request. On hit, cancel the request and load locally. When enabled, this cache-first path runs; when disabled, image requests are not intercepted and the extension only observes and stores cache.',
    externalImageCacheFillTip: 'After another plugin or the page has loaded an image, try a low-priority HTTP-cache-first fill into the local image cache. This does not intercept or rewrite other plugin requests.',
    autoPagerEnabled: 'Enable auto pager',
    autoPagerRemain: 'Remaining-height ratio',
    autoPagerMaxPages: 'Max pages',
    autoPagerImmediateEnabled: 'Immediate pages',
    autoPagerImmediatePages: 'Immediate page count',
    autoPagerSeparatorEnabled: 'Show separator',
    autoPagerAplus: 'Prepare next page after append',
    autoPagerEnabledTip: 'When enabled, EH＋ appends the next /s/ reader page using Super-preloader EH/EX rules, and appends the next thumbnail page on /g/ gallery pages.',
    autoPagerRemainTip: 'Append when the remaining page height is below this multiple of the viewport height.',
    autoPagerMaxPagesTip: 'Maximum appended pages for the current page.',
    autoPagerImmediateTip: 'Append this many pages immediately after the reader page loads.',
    autoPagerAplusTip: 'After each append, query local cache for the next page in advance.',
    highReadProtect: 'Frequent image protect',
    highReadProtectTip: 'When enabled, images whose read count exceeds the threshold are marked as protected. Day-based cleanup and automatic cleanup skip them by default. They are removed only when protected images are explicitly included, or when cleaning all images/all cache.',
    highReadThreshold: 'Read count',
    highReadGalleryProtect: 'Frequent gallery /g/ protect',
    highReadGalleryProtectTip: 'When enabled, /g/ galleries whose read count exceeds the threshold are marked as protected. Day-based cleanup and automatic cleanup skip them by default. They are removed only when protected galleries are explicitly included, or when cleaning all cache.',
    highReadGalleryThreshold: 'Gallery read count',
    imageProtectionLoading: 'Loading protected-image stats...',
    loggingEnabled: 'Log events',
    logDebugEnabled: 'Debug text log',
    logDebugTip: 'When enabled, text request response bodies including full HTML are kept for the latest 24 hours. Image and Blob contents are not saved. Turning it off removes full text from logs and keeps normal summaries.',
    logFieldSelect: 'Top display fields',
    logRetentionDays: 'Retention days',
    logLimitValue: 'Size limit',
    storageLimitValue: 'Allocated storage',
    unit: 'Unit',
    logHelp: 'Logs include event, action, request ID, source, page context, input summary, result, and error stack.',
    accountFieldSelect: 'Top display fields',
    refreshAccount: 'Refresh account',
    resetQuota: 'Reset quota',
    resetQuotaWithCost: 'Reset {cost} GP',
    confirm: 'Confirm',
    cancel: 'Cancel',
    confirmReset: 'Confirm reset?',
    quotaTip: 'The reset page shows the official nominal GP cost. Actual deductions may differ because of official conversion, balance fallback, or site rules. This extension reads Credits, Hath, and GP before and after submission and calculates the real delta.',
    quotaTipText: 'Actual cost is shown from balance deltas.',
    dawnEnabled: 'Page-open auto check',
    dawnEnabledTip: 'When enabled, opening or refreshing an E-Hentai / ExHentai /g/ gallery page or /s/ reader page automatically checks news.php after UTC 03:00 if today has not been checked yet. A page must be open.',
    backgroundDawn: 'Background auto check',
    backgroundDawnTip: 'When enabled, the extension background uses chrome.alarms to check news.php after UTC 03:00 without needing an open /g/ or /s/ page. The browser and extension background must be running.',
    dawnIntro: 'After UTC 00:00 each day (08:00 Beijing time), visiting news.php or an EH/EX gallery page triggers the Dawn of a New Day event, which may grant EXP, Credits, GP, or Hath. Rewards depend on account conditions such as Stars, Awards, and valid comments, and may be 0. This feature only visits the official page automatically and shows the returned result; auto check runs after UTC 03:00.',
    runDawn: 'Check now',
    statsFieldSelect: 'Top display fields',
    historyLimit: 'History limit',
    historyLimitTip: 'Maximum number of browsing history entries, default 100. When exceeded, the oldest entries by last visited time are removed; changing the limit never touches image cache, frequent-view counters, or hit-rate stats.',
    openHistory: 'Open browsing history',
    openHistoryFailed: 'Failed to open the browsing history page',
    cacheBlockedReason: 'New image caching paused: {reason}',
    all: 'All',
    gallery: 'Gallery /g/',
    reader: 'Reader /s/',
    scope: 'Scope',
    mode: 'Mode',
    images: 'Images',
    logs: 'Logs',
    other: 'Other',
    cleanupAll: 'Clean all',
    cleanupOlder: 'Older than N days',
    days: 'Days',
    cleanupDaysTip: '0 days means time-based cache cleanup is disabled.',
    includeProtected: 'Include protected images',
    includeProtectedGalleries: 'Include protected galleries',
    cleanupPreview: 'Preview cleanup',
    cleanupConfirm: 'Confirm cleanup',
    noPreview: 'No preview yet',
    deleteOldCache: 'Delete old cache after success',
    startMigration: 'Start migration',
    retryMigration: 'Retry migration',
    cancelMigration: 'Cancel migration',
    migrationProgress: 'Progress',
    migrationProgressValue: '{done} / {total} ({skipped} skipped)',
    migrationStarted: 'Migration started; you can cancel anytime',
    migrationCancelPending: 'Cancelling migration…',
    migrationCancelled: 'Migration cancelled; retry resumes from where it stopped',
    migrationNotRunning: 'No migration is currently running',
    migrationFailed: 'Some entries failed to migrate; old cache kept',
    migrationCancelling: 'Cancelling',
    migrationCancelledState: 'Cancelled',
    migrationHelp: 'Migration reads old IndexedDB/Blob data, writes an authorized directory, and verifies index and file size per entry. Already-migrated entries are skipped on retry (resume). Failed, cancelled, or interrupted runs never delete old cache.',
    uiLanguage: 'UI language',
    languageHelp: 'Language applies to the floating panel, settings drawer, status text, and popup. Chinese is the default.',
    colorHelp: 'Click a dot or color picker to choose a color, or enter ff, 0ff, 00e5ff, or #00e5ff. Changes apply only after Confirm; Cancel or clicking elsewhere discards them.',
    applyNow: 'Changes apply immediately',
    syncNow: 'Save settings',
    statusReady: 'Ready',
    statusPaused: 'Preload paused',
    meta: 'Index only',
    cachedCount: 'Cached',
    globalConcurrencyShort: 'Concurrency',
    preloadQueueShort: 'Preload',
    totalUsage: 'Total',
    logCount: 'Logs',
    entries: 'entries',
    storageTotal: 'Total',
    protectedImages: 'Protected images',
    protectedGalleries: 'Protected galleries',
    migrationCache: 'Migration cache',
    items: 'items',
    imageCountUnit: 'images',
    currentLogUsage: 'Current log usage',
    logRows: 'Log rows',
    retention: 'Retention',
    limit: 'Limit',
    imageQuota: 'Image quota',
    resetNominal: 'Reset cost',
    resetFreeDisabled: 'Reset costs 0 GP; nothing to reset',
    updatedAt: 'Updated',
    normal: 'Normal',
    high: 'High',
    overLimit: 'Over limit',
    none: 'None',
    lastDawnAt: 'Last check time',
    lastDawnResult: 'Last result',
    reward: 'Reward',
    officialReset: 'Official reset',
    autoDawn: 'Auto check',
    backgroundDawnSuccessCount: 'Total background auto successes',
    readerReads: '/s/ image reads',
    readerHits: '/s/ cache hits',
    readerHitRate: '/s/ hit rate',
    galleryReads: '/g/ gallery reads',
    galleryCache: '/g/ resource cache',
    disabled: 'Disabled',
    state: 'State',
    oldDirectory: 'Old directory',
    oldCacheCount: 'Old cache count',
    oldCacheSize: 'Old cache size',
    targetDirectory: 'New directory',
    migrated: 'Migrated',
    failed: 'Failed',
    deletedOldCache: 'Deleted old cache',
    lastRun: 'Last run',
    requestCount: 'Requests',
    version: 'Version',
    mode: 'Mode',
    takeoverState: 'Takeover state',
    autoPager: 'Auto-pager',
    preloadMode: 'Preload mode',
    detected: 'Detected',
    notDetected: 'Not detected',
    yes: 'Yes',
    no: 'No',
    idle: 'Idle',
    running: 'Running',
    completed: 'Completed',
    invalidDays: 'Enter a non-negative integer day count',
    zeroDayKeep: '0 days means time-based cache cleanup is disabled.',
    zeroDayInclude: '0 days means time-based cache cleanup is disabled.',
    applying: 'Applying...',
    applied: 'Settings applied',
    applyFailed: 'Apply failed',
    synced: 'Manual sync complete',
    accountRefreshPending: 'Refreshing account...',
    accountRefreshed: 'Account status refreshed',
    accountRefreshFailed: 'Account refresh failed: {message}',
    dawnPending: 'Checking Dawn...',
    dawnDone: 'Dawn result: {message}',
    dawnFailed: 'Dawn check failed: {message}',
    quotaPreparePending: 'Reading quota status...',
    quotaConfirmNeeded: 'Confirm quota reset',
    quotaPrepareFailed: 'Quota status read failed: {message}',
    quotaResetPending: 'Resetting quota...',
    quotaResetDone: 'Quota reset complete',
    quotaResetFailed: 'Quota reset failed: {message}',
    quotaCancelled: 'Reset cancelled',
    cleanupDone: 'Cleanup complete',
    migrationSynced: 'Migration settings synced',
    migrationDone: 'Migration complete',
    liveLoading: 'Loading page {n}…',
    liveLoadedCache: 'Page {n} served from local cache',
    liveLoaded: 'Page {n} loaded',
    liveFailed: 'Page {n} failed, retrying with a new source…',
    liveRetryOk: 'Page {n} retry succeeded',
    liveRetryFail: 'Page {n} still failing after retry',
    stateRefreshed: 'State refreshed',
    openOfficial: 'Open official page: {url}',
    noTargetUrl: 'No target URL',
    confirmCost: 'Confirm spending {cost} GP?',
    resetCost: 'Reset cost: {cost} GP',
    actualCost: 'Actual cost:',
    remaining: 'Remaining:',
    cleanupWill: 'Will clean:',
    cleanupWillBefore: 'Will clean data before {time}:',
    cleanupRelease: 'Estimated release: {value}',
    skippedProtected: 'Skipped protected images: {count} items',
    skippedProtectedGalleries: 'Skipped protected galleries: {count} items',
    cleanupDoneTitle: 'Cleanup complete:',
    successSkippedFailed: '{label} success {success}, skipped {skipped}, failed {failed}',
    successFailed: '{label} success {success}, failed {failed}',
    releaseSpace: 'Released space {value}',
    cellError: 'Error',
    cellCached: 'Cached',
    cellMeta: 'Index only',
    cellMetaTip: 'The page index is recorded, but the image body is not cached yet.',
    cellQueued: 'Queued',
    cellMiss: 'Miss',
    cellLoading: 'Loading',
    cellIdle: 'Idle',
    cellPrefetch: 'Pending load',
    cellPrefetchTip: 'A reserved position in the preload window; no index is recorded and no image body is cached yet.',
    cellHit: 'Hit',
    cellPaused: 'Paused',
    cellExactTitle: 'P{page} (actual page {actualPage}): {state}',
    cellTitle: 'P{page}: {state}',
    dawnNotRun: 'Not checked yet',
    dawnSuccess: 'Check succeeded',
    dawnSuccessWithReward: 'Check succeeded: {reward}',
    dawnCheckedOn: 'Checked on {date}',
    dawnAlreadyClaimed: 'Already checked today',
    resetSuccess: 'Image limit reset succeeded',
    aboutTitle: 'About EH＋',
    currentVersion: 'Current version',
    githubSource: 'Project URL',
    updateBadge: 'New version',
    openGithub: 'Open GitHub',
    checkUpdate: 'Check updates',
    checkingUpdate: 'Checking',
    downloadUpdate: 'Download update',
    updateNotConfigured: 'The project GitHub Release URL is not configured, so real version checks cannot run yet. After a real repository and Release API are configured, updates will be queried from GitHub Releases.',
    updateAvailable: 'New version available: {version}',
    updateLatest: 'You are on the latest version.',
    updateFailed: 'Update check failed: {message}',
    latestVersion: 'Latest version',
    downloadUrl: 'Download URL',
    uniqueSourceNotice: 'The only official source is the project GitHub repository. This panel opens the real project URL.',
    freeNotice: 'This project is free and open source.',
    resaleNotice: 'Any paid copy from any other place is a third party reselling an open-source project as a personal act, unrelated to this project.',
    githubIconLabel: 'GitHub',
    downloadStarted: 'GitHub Release download started',
    downloadBlocked: 'The download URL is not an allowed GitHub Release URL'
  }
};

function schedulePanelInit() {
  const run = () => {
    initPanel().catch(() => {});
  };
  if (document.documentElement && document.body) {
    run();
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
    return;
  }
  setTimeout(run, 0);
}

async function initPanel() {
  if (document.querySelector('#ehplus-panel')) return;
  const state = buildInitialPanelFallbackState();
  const root = createPanel(state);
  root.__ehplusState = state;
  document.documentElement.appendChild(root);
  restorePanelPosition(root, state.floatingPanel);
  clampPanelPosition(root);
  bindPanelDrag(root);
  bindStorageAddressActions(root);
  bindPanelActions(root);
  bindPanelDocumentActions(root);
  bindPanelCacheFirstStatusObserver(root);
  bindReaderImageLiveStatus(root);
  bindRuntimeMessages(root);
  renderPanel(root, state);
  checkUpdateIfDue(root);
  hydratePanelState(root);
  bindPanelLiveRefresh(root);
}

// 面板轻量轮询：只刷新状态行/计数行/迷你统计/小球，不动抽屉控件，
// 避免打断正在编辑的设置；后台恢复后自动清除“读取失败”提示。
function bindPanelLiveRefresh(root) {
  if (root.__ehplusLiveRefreshTimer) return;
  root.__ehplusLiveRefreshTimer = setInterval(() => {
    if (!document.documentElement.contains(root)) {
      clearInterval(root.__ehplusLiveRefreshTimer);
      root.__ehplusLiveRefreshTimer = 0;
      return;
    }
    if (document.hidden || root.__ehplusLiveRefreshBusy) return;
    root.__ehplusLiveRefreshBusy = true;
    readBackendPanelState()
      .then((state) => {
        if (!document.documentElement.contains(root)) return;
        const hadFallback = Boolean(root.__ehplusState?.__ehplusPanelFallbackReason);
        root.__ehplusState = state;
        if (hadFallback) {
          renderPanel(root, state);
          return;
        }
        renderPanelDetailLine(root, state);
        if (!(root.__ehplusFlashUntil > Date.now())) {
          updatePanelStatusLine(root, state);
        }
        renderMiniStats(root, state);
        renderMatrix(root);
      })
      .catch(() => {})
      .finally(() => {
        root.__ehplusLiveRefreshBusy = false;
      });
  }, PANEL_LIVE_REFRESH_INTERVAL_MS);
}

function hydratePanelState(root) {
  readStoredPanelState()
    .then((state) => {
      if (!state || !document.documentElement.contains(root)) return;
      const fallbackState = {
        ...state,
        __ehplusPanelFallbackReason: 'state-message-pending'
      };
      root.__ehplusState = fallbackState;
      renderPanel(root, fallbackState);
    })
    .catch(() => {});

  readBackendPanelState()
    .then((state) => {
      if (!state || !document.documentElement.contains(root)) return;
      root.__ehplusState = state;
      renderPanel(root, state);
      syncBuiltInAutoPagerFromState(state, window.__EHPLUS_RUNTIME__?.pageSessionId ?? '');
      checkUpdateIfDue(root);
    })
    .catch((error) => {
      if (!document.documentElement.contains(root)) return;
      const fallbackReason = runtimeLastErrorMessage() || error?.message || String(error) || 'state-message-failed';
      const current = root.__ehplusState ?? buildInitialPanelFallbackState();
      renderPanel(root, {
        ...current,
        __ehplusPanelFallbackReason: fallbackReason
      });
    });
}

async function readBackendPanelState() {
  // 后台繁忙（多并发预加载）时单次请求可能超时，带退避重试后再报错。
  let lastError = 'state-message-failed';
  for (let attempt = 0; attempt < PANEL_STATE_MESSAGE_RETRY_COUNT; attempt += 1) {
    const timeoutMs = PANEL_STATE_MESSAGE_TIMEOUT_MS * (attempt + 1);
    const response = await promiseWithTimeout(
      chrome.runtime.sendMessage({ type: 'EHPLUS_GET_STATE' }),
      timeoutMs,
      { ok: false, error: 'state-message-timeout' }
    ).catch((error) => ({
      ok: false,
      error: runtimeLastErrorMessage() || error?.message || String(error)
    }));
    if (response?.ok === true && response.state) return response.state;
    lastError = response?.error || runtimeLastErrorMessage() || lastError;
    if (attempt < PANEL_STATE_MESSAGE_RETRY_COUNT - 1) {
      await new Promise((resolve) => setTimeout(resolve, PANEL_STATE_MESSAGE_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw new Error(lastError);
}

async function readStoredPanelState() {
  const stored = await chrome.storage.local.get(STATE_KEY)
    .then((value) => value?.[STATE_KEY])
    .catch(() => null);
  return stored && typeof stored === 'object' ? stored : null;
}

function buildInitialPanelFallbackState() {
  return {
    extensionVersion: chrome.runtime?.getManifest?.().version ?? '1.0.0',
    runtime: {
      owner: 'extension'
    },
    settings: {
      language: 'zh-CN',
      preloadEnabled: true,
      preloadAhead: 6,
      preloadQueueDisplayEnabled: false,
      globalConcurrency: 5,
      concurrencyDisplayEnabled: false,
      pageOffset: 24,
      blobCacheEnabled: true,
      readerCacheFirstEnabled: false,
      externalImageCacheFillEnabled: true,
      autoPagerEnabled: false,
      autoPagerRemain: 1,
      autoPagerMaxPages: 99,
      autoPagerImmediateEnabled: false,
      autoPagerImmediatePages: 2,
      autoPagerSeparatorEnabled: true,
      autoPagerAplus: true,
      loggingEnabled: true,
      logDebugEnabled: false,
      logRetentionDays: 30,
      logLimitValue: 100,
      logLimitUnit: 'MB',
      storageMode: 'indexeddb',
      storageLimitValue: 2,
      storageLimitUnit: 'GB',
      cleanupScope: 'all',
      cleanupMode: 'olderThanDays',
      cleanupDays: 7,
      cellColors: DEFAULT_CELL_COLORS
    },
    floatingPanel: {
      left: 12,
      top: 12,
      collapsed: false
    },
    counters: {
      requestCount: 0
    },
    storage: {
      metadataRecords: 0,
      imageRecords: 0,
      totalBytes: 0,
      imageBytes: 0,
      logBytes: 0,
      otherBytes: 0
    },
    stats: {
      readerReads: 0,
      readerHits: 0
    },
    account: {},
    dawn: {},
    migration: {},
    cleanup: {},
    about: {
      currentVersion: chrome.runtime?.getManifest?.().version ?? '1.0.0'
    },
    logs: [],
    __ehplusPanelBootstrapOnly: true
  };
}

function bindRuntimeMessages(root) {
  if (root.__ehplusRuntimeMessagesBound) return;
  root.__ehplusRuntimeMessagesBound = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'EHPLUS_DIRECTORY_SWITCH_CONFIRM') {
      handleDirectorySwitchConfirm(root, message);
      return;
    }
    if (message?.type !== 'EHPLUS_DIRECTORY_SELECTED' || !message.state) return;
    root.__ehplusState = message.state;
    renderPanel(root, message.state);
    flashStatus(root, t(root, 'directorySelected'));
  });
}

async function handleDirectorySwitchConfirm(root, message) {
  const fromLabel = message?.fromLabel ?? '';
  const toLabel = message?.toLabel ?? '';
  const confirmed = window.confirm(t(root, 'migrateDirectoryConfirm', { from: fromLabel, to: toLabel }));
  const response = await chrome.runtime.sendMessage({
    type: 'EHPLUS_DIRECTORY_SWITCH_RESPONSE',
    confirmed
  });
  if (response?.state) {
    root.__ehplusState = response.state;
    renderPanel(root, response.state);
  }
  if (response?.cancelled) {
    flashStatus(root, t(root, 'directoryMigrationSkipped'));
    return;
  }
  if (response?.ok) {
    flashStatus(root, confirmed ? t(root, 'directoryMigrationAccepted') : t(root, 'directoryMigrationSkipped'));
  } else if (response?.error) {
    flashStatus(root, responseErrorMessage(response));
  }
}

function createPanel(state) {
  const settings = state?.settings ?? {};
  const readerCacheFirstToggle = `
      <label class="ehplus-setting" data-extension-only="true" data-i18n-title="readerCacheFirstTip" title="页面打开/刷新时，优先检索本地缓存，命中则取消请求，从本地加载。如果勾选，则走这个逻辑；如果取消勾选，则不拦截图片请求，只做缓存写入。">
        <span data-i18n="readerCacheFirst">优先取本地缓存</span>
        <input type="checkbox" data-role="reader-cache-first" ${checked(settings.readerCacheFirstEnabled === true)}>
      </label>`;
  const autoPagerToggle = `
      <label class="ehplus-setting" data-extension-only="true" data-i18n-title="autoPagerEnabledTip" title="开启后，EH＋在 /s/ 阅读页按 Super-preloader 的 EH/EX 规则自动拼接下一页；在 /g/ 画廊页自动拼接下一分页的缩略图。">
        <span data-i18n="autoPagerEnabled">启用自动翻页</span>
        <input type="checkbox" data-role="auto-pager" ${checked(settings.autoPagerEnabled === true)}>
      </label>`;
  const panel = document.createElement('div');
  panel.id = 'ehplus-panel';
  panel.dataset.state = 'hit';
  panel.dataset.collapsed = String(Boolean(state?.floatingPanel?.collapsed));
  panel.innerHTML = `
    <div class="ehplus-head">
      <span class="ehplus-dot" data-role="dot"></span>
      <span class="ehplus-title" data-i18n="title">EH＋</span>
      <button type="button" class="ehplus-update-badge" data-action="title-update" data-i18n="updateBadge" hidden>有新版本</button>
      <button type="button" class="ehplus-headbtn" data-action="toggle" data-i18n="${panel.dataset.collapsed === 'true' ? 'show' : 'hide'}" aria-label="展开或收起浮窗">收起</button>
    </div>
    <div class="ehplus-settings">
      <label class="ehplus-setting">
        <span data-i18n="enabled">启用预加载</span>
        <input type="checkbox" data-role="enabled" ${checked(settings.preloadEnabled !== false)}>
      </label>
      <label class="ehplus-setting">
        <span data-i18n="blob">Blob</span>
        <input type="checkbox" data-role="blob" ${checked(settings.blobCacheEnabled !== false)}>
      </label>
${readerCacheFirstToggle}
${autoPagerToggle}
    </div>
    <div class="ehplus-line" data-role="status" data-i18n="loading">加载中...</div>
    <div class="ehplus-line" data-role="live-status" hidden></div>
    <div class="ehplus-line" data-role="detail" data-i18n="detailEmpty">仅索引 0 | 已缓存 0 | 图片 -</div>
    <div class="ehplus-mini-stats" data-role="mini-stats"></div>
    <div class="ehplus-mini-stats ehplus-account-stats" data-role="account-stats" hidden></div>
    <div class="ehplus-matrix" data-role="matrix"></div>
    <div class="ehplus-actions">
      <button type="button" class="ehplus-btn" data-action="settings" data-i18n="settings">设置</button>
    </div>
    <div class="ehplus-settings-drawer" data-role="settings-drawer" hidden>
      <div class="ehplus-tabs" role="tablist" aria-label="设置分组">
        <button type="button" data-tab="storage" data-i18n="tabStorage">存储</button>
        <button type="button" data-tab="image" data-i18n="tabImage">图片</button>
        <button type="button" data-tab="autopager" data-i18n="tabAutoPager">自动翻页</button>
        <button type="button" data-tab="logs" data-i18n="tabLogs">日志</button>
        <button type="button" data-tab="account" data-i18n="tabAccount">账号</button>
        <button type="button" data-tab="dawn" data-i18n="tabDawn">Dawn</button>
        <button type="button" data-tab="stats" data-i18n="tabStats">统计</button>
        <button type="button" data-tab="cleanup" data-i18n="tabCleanup">清理</button>
        <button type="button" data-tab="migration" data-i18n="tabMigration">迁移</button>
        <button type="button" data-tab="language" data-i18n="tabLanguage">语言</button>
        <button type="button" data-tab="colors" data-i18n="tabColors">颜色</button>
        <button type="button" data-tab="about" data-i18n="tabAbout">关于</button>
      </div>
      <div class="ehplus-tab-panel" data-panel="storage">
        <label><span><span data-i18n="storageMode">存储位置</span><span class="ehplus-risk-icon ehplus-help-icon" data-role="storage-risk-icon" data-i18n-title="browserStorageRiskTip" title="浏览器默认存储通常可长期保存，但可能被以下操作清理：用户手动清理浏览数据、清理 Cookie 和其他网站数据、清理 e-hentai.org / exhentai.org 的站点数据、浏览器在磁盘压力或配额压力下回收默认存储、浏览器 profile 损坏/重置/同步/迁移异常、第三方清理工具清理浏览器缓存/站点数据、隐私软件或安全软件清理浏览器数据。需要更可控的文件缓存时，请使用自定义存储地址。">?</span></span><select data-setting="storageMode"><option value="indexeddb" data-i18n="indexeddb">浏览器默认存储</option><option value="directory" data-i18n="directory">自定义存储地址</option></select></label>
        <label class="ehplus-inline-field"><span data-i18n="storageLimitValue">分配存储空间</span><span class="ehplus-inline-control"><input type="number" min="0" data-setting="storageLimitValue" value="${settings.storageLimitValue ?? 2}"><select data-setting="storageLimitUnit" aria-label="单位"><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option></select></span></label>
        <div class="ehplus-address-row">
          <span data-i18n="storageAddress">地址</span>
          <button type="button" class="ehplus-address-btn" data-action="open-storage-address" data-role="storage-address" title="选择目录">当前站点 / IndexedDB / Blob</button>
        </div>
        <div class="ehplus-meter" aria-hidden="true">
          <span data-role="storage-image-bar"></span>
          <span data-role="storage-log-bar"></span>
          <span data-role="storage-other-bar"></span>
        </div>
        <div class="ehplus-kv" data-role="storage-summary"></div>
        <p class="ehplus-tip ehplus-cache-blocked" data-role="cache-blocked" hidden></p>
      </div>
      <div class="ehplus-tab-panel" data-panel="image" hidden>
        <label><span><span data-i18n="preloadEnabled">启用预加载</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="preloadEnabledTip" title="控制是否启用页面预加载。关闭后状态点会显示暂停，预加载不会继续排队。">?</span></span><input type="checkbox" data-setting="preloadEnabled" ${checked(settings.preloadEnabled !== false)}></label>
        <label class="ehplus-inline-field"><span><span data-i18n="preloadAhead">预加载页数</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="preloadAheadTip" title="以当前页面为基准向后预加载的页数，每个页面单独计算。数值越大，理论上能提前准备更多页面，但也会增加缓存和请求压力。后台始终生效，勾选只影响 UI 显示。">?</span></span><span class="ehplus-inline-control"><input type="number" min="1" step="1" data-setting="preloadAhead" value="${settings.preloadAhead ?? 6}"><input type="checkbox" data-setting="preloadQueueDisplayEnabled" data-i18n-title="panelDisplayToggleTip" title="勾选后在面板上显示 当前值/设置值。" ${checked(settings.preloadQueueDisplayEnabled === true)}></span></label>
        <label class="ehplus-inline-field"><span><span data-i18n="globalConcurrency">全局并发</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="globalConcurrencyTip" title="所有页面共享的最大并发加载数，默认 5。多开页面时优先调度当前聚焦页面；切换页面只重排尚未发送请求的队列，已发送请求不会中断。后台始终生效，勾选只影响 UI 显示。">?</span></span><span class="ehplus-inline-control"><input type="number" min="1" data-setting="globalConcurrency" value="${settings.globalConcurrency ?? 5}"><input type="checkbox" data-setting="concurrencyDisplayEnabled" data-i18n-title="panelDisplayToggleTip" title="勾选后在面板上显示 当前值/设置值。" ${checked(settings.concurrencyDisplayEnabled === true)}></span></label>
        <label><span><span data-i18n="pageOffset">页码偏移</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="pageOffsetTip" title="用于当前页码和预加载矩阵的页码偏移。">?</span></span><input type="number" min="0" data-setting="pageOffset" value="${settings.pageOffset ?? 24}"></label>
        <label><span><span data-i18n="imageBlob">图片缓存</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="imageBlobTip" title="控制是否缓存图片本体。开启后会缓存图片 Blob；关闭后只保留仅索引记录和统计。">?</span></span><input type="checkbox" data-setting="blobCacheEnabled" ${checked(settings.blobCacheEnabled !== false)}></label>
        <label><span><span data-i18n="externalImageCacheFill">外部图片补存</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="externalImageCacheFillTip" title="观察到其他插件或页面已经加载图片后，低优先级尝试用浏览器 HTTP 缓存补存到本地图片缓存；不拦截、不改写其他插件请求。">?</span></span><input type="checkbox" data-setting="externalImageCacheFillEnabled" ${checked(settings.externalImageCacheFillEnabled !== false)}></label>
        <label><span><span data-i18n="highReadProtect">常看图片保护</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="highReadProtectTip" title="开启后，访问次数超过阈值的图片会被标记为受保护图片。按天数清理或自动清理时默认跳过这些图片；只有清理时明确包含受保护图片，或执行全部图片/全部缓存清理，才会一起清理。">?</span></span><input type="checkbox" data-setting="protectHighReadImages" ${checked(settings.protectHighReadImages)}></label>
        <label><span data-i18n="highReadThreshold">访问次数</span><input type="number" min="0" data-setting="highReadThreshold" value="${settings.highReadThreshold ?? 3}"></label>
        <label><span><span data-i18n="highReadGalleryProtect">常看画廊 /g/ 保护</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="highReadGalleryProtectTip" title="开启后，访问次数超过阈值的 /g/ 画廊会被标记为受保护画廊。按天数清理或自动清理时默认跳过这些画廊；只有清理时明确包含受保护画廊，或执行全部清理，才会一起清理。">?</span></span><input type="checkbox" data-setting="protectHighReadGalleries" ${checked(settings.protectHighReadGalleries)}></label>
        <label><span data-i18n="highReadGalleryThreshold">画廊访问次数</span><input type="number" min="0" data-setting="highReadGalleryThreshold" value="${settings.highReadGalleryThreshold ?? 3}"></label>
        <p data-role="image-protection" data-i18n="imageProtectionLoading">受保护图片统计加载中...</p>
      </div>
      <div class="ehplus-tab-panel" data-panel="autopager" hidden>
        <label><span><span data-i18n="autoPagerRemain">剩余高度倍数</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="autoPagerRemainTip" title="页面剩余高度小于视窗高度的这个倍数时触发翻页。">?</span></span><input type="number" min="0.1" step="0.1" data-setting="autoPagerRemain" value="${settings.autoPagerRemain ?? 1}"></label>
        <label><span><span data-i18n="autoPagerMaxPages">最多翻页</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="autoPagerMaxPagesTip" title="当前阅读页最多自动拼接的后续页数。">?</span></span><input type="number" min="1" step="1" data-setting="autoPagerMaxPages" value="${settings.autoPagerMaxPages ?? 99}"></label>
        <label><span><span data-i18n="autoPagerImmediateEnabled">立即翻页</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="autoPagerImmediateTip" title="页面加载后立即自动拼接指定页数。">?</span></span><input type="checkbox" data-setting="autoPagerImmediateEnabled" ${checked(settings.autoPagerImmediateEnabled === true)}></label>
        <label><span data-i18n="autoPagerImmediatePages">立即翻页页数</span><input type="number" min="0" step="1" data-setting="autoPagerImmediatePages" value="${settings.autoPagerImmediatePages ?? 2}"></label>
        <label><span data-i18n="autoPagerSeparatorEnabled">显示分隔符</span><input type="checkbox" data-setting="autoPagerSeparatorEnabled" ${checked(settings.autoPagerSeparatorEnabled !== false)}></label>
        <label><span><span data-i18n="autoPagerAplus">翻页后提前准备下一页</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="autoPagerAplusTip" title="每次拼接后提前查询下一页本地缓存。">?</span></span><input type="checkbox" data-setting="autoPagerAplus" ${checked(settings.autoPagerAplus !== false)}></label>
      </div>
      <div class="ehplus-tab-panel" data-panel="logs" hidden>
        <label><span data-i18n="loggingEnabled">记录日志</span><input type="checkbox" data-setting="loggingEnabled" ${checked(settings.loggingEnabled !== false)}></label>
        <label><span><span data-i18n="logDebugEnabled">Debug 文本日志</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="logDebugTip" title="开启后，最近 24 小时保留文本请求响应全文，包括 HTML；不保存图片或 Blob 内容。关闭后会清除日志里的全文文本，只保留普通摘要。">?</span></span><input type="checkbox" data-setting="logDebugEnabled" ${checked(settings.logDebugEnabled === true)}></label>
        <div class="ehplus-account-field-list" data-role="log-field-list" aria-label="上方显示字段"></div>
        <label><span data-i18n="logRetentionDays">保留天数</span><input type="number" min="0" data-setting="logRetentionDays" value="${settings.logRetentionDays ?? 30}"></label>
        <label class="ehplus-inline-field"><span data-i18n="logLimitValue">大小上限</span><span class="ehplus-inline-control"><input type="number" min="0" data-setting="logLimitValue" value="${settings.logLimitValue ?? 100}"><select data-setting="logLimitUnit" aria-label="单位"><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option></select></span></label>
        <div class="ehplus-kv" data-role="log-summary"></div>
        <p data-i18n="logHelp">日志记录事件、动作、请求 ID、来源、页面上下文、输入摘要、结果和错误堆栈。</p>
      </div>
      <div class="ehplus-tab-panel" data-panel="account" hidden>
        <div class="ehplus-account-field-list" data-role="account-field-list" aria-label="上方显示字段"></div>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn" data-action="account-refresh" data-i18n="refreshAccount">刷新账号</button>
          <button type="button" class="ehplus-btn" data-action="quota-prepare">重置限额</button>
        </div>
        <div class="ehplus-confirm" data-role="quota-confirm" hidden>
          <span data-role="quota-confirm-text" data-i18n="confirmReset">确认重置？</span>
          <button type="button" class="ehplus-btn" data-action="quota-confirm" data-i18n="confirm">确认</button>
          <button type="button" class="ehplus-btn" data-action="quota-cancel" data-i18n="cancel">取消</button>
        </div>
        <p class="ehplus-tip" data-i18n="quotaTipText" data-i18n-title="quotaTip" title="重置页面显示的是官方预估/标称 GP 花费。实际扣除可能因官方换算、余额抵扣或站点规则不同而变化。当 GP 不足时，官方可能会自动消耗 Credits 进行兑换。本插件会在提交前后分别读取 Credits、Hath、GP，并用差值计算实际消耗。">实际消耗以提交前后余额差值显示。</p>
        <div class="ehplus-result" data-role="quota-result"></div>
      </div>
      <div class="ehplus-tab-panel" data-panel="dawn" hidden>
        <p class="ehplus-tip" data-i18n="dawnIntro">每天 UTC 00:00（北京时间 08:00）后，访问 news.php 或 EH/EX 画廊页会触发 Dawn of a New Day 奖励事件，可能获得 EXP、Credits、GP、Hath 等奖励；奖励受 Stars、Awards、有效评论等账号条件影响，可能为 0。本功能只是自动访问官方页面并显示返回结果，自动签到在 UTC 03:00 后触发。</p>
        <label><span><span data-i18n="dawnEnabled">页面打开自动签到</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="dawnEnabledTip" title="开启后，当你打开或刷新 E-Hentai / ExHentai 的 /g/ 画廊页或 /s/ 阅读页时，如果已经到 UTC 03:00 后且今天还没有检查过，会自动请求 news.php 签到。需要有页面打开。">?</span></span><input type="checkbox" data-setting="dawnEnabled" ${checked(settings.dawnEnabled)}></label>
        <label data-extension-only="true"><span><span data-i18n="backgroundDawn">后台自动签到</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="backgroundDawnTip" title="开启后，扩展后台会用 chrome.alarms 在 UTC 03:00 后自动请求 news.php 签到；不需要打开 /g/ 或 /s/ 页面，但需要浏览器和扩展后台可运行。">?</span></span><input type="checkbox" data-setting="backgroundDawnEnabled" ${checked(settings.backgroundDawnEnabled)}></label>
        <div class="ehplus-kv" data-role="dawn-summary"></div>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn" data-action="dawn" data-i18n="runDawn">手动立即签到</button>
        </div>
      </div>
      <div class="ehplus-tab-panel" data-panel="stats" hidden>
        <div class="ehplus-account-field-list" data-role="stats-field-list" aria-label="上方显示字段"></div>
        <label><span><span data-i18n="historyLimit">浏览历史上限</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="historyLimitTip" title="浏览历史最多保留的条数，默认 100。超过上限时按最近观看时间删除最旧的历史记录；调整上限不影响图片缓存、经常观看计数或命中率统计。">?</span></span><input type="number" min="1" step="1" data-setting="historyLimit" value="${settings.historyLimit ?? 100}"></label>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn" data-action="open-history" data-i18n="openHistory">打开浏览历史</button>
        </div>
      </div>
      <div class="ehplus-tab-panel" data-panel="cleanup" hidden>
        <label><span data-i18n="scope">范围</span><select data-setting="cleanupScope" data-cleanup="scope"><option value="all" data-i18n="all">全部</option><option value="images" data-i18n="images">图片</option><option value="logs" data-i18n="logs">日志</option><option value="other" data-i18n="other">其他</option></select></label>
        <label><span data-i18n="mode">模式</span><select data-setting="cleanupMode" data-cleanup="mode"><option value="all" data-i18n="cleanupAll">全部清理</option><option value="olderThanDays" data-i18n="cleanupOlder">清理 N 天之前</option></select></label>
        <label><span><span data-i18n="days">天数</span><span class="ehplus-risk-icon ehplus-help-icon" data-i18n-title="cleanupDaysTip" title="0天表示不按照时间清理缓存。">?</span></span><input type="number" min="0" step="1" data-setting="cleanupDays" data-cleanup="days" value="${settings.cleanupDays ?? 7}"></label>
        <label><span data-i18n="includeProtected">包含受保护图片</span><input type="checkbox" data-setting="cleanupIncludeProtected" data-cleanup="includeProtected" ${checked(settings.cleanupIncludeProtected)}></label>
        <label><span data-i18n="includeProtectedGalleries">包含受保护画廊</span><input type="checkbox" data-setting="cleanupIncludeProtectedGalleries" data-cleanup="includeProtectedGalleries" ${checked(settings.cleanupIncludeProtectedGalleries)}></label>
        <p data-role="cleanup-warning"></p>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn" data-action="cleanup-preview" data-i18n="cleanupPreview">预估清理</button>
          <button type="button" class="ehplus-btn" data-action="cleanup-confirm" data-i18n="cleanupConfirm">确认清理</button>
        </div>
        <div class="ehplus-result" data-role="cleanup-preview" data-i18n="noPreview">尚未预估</div>
        <div class="ehplus-result" data-role="cleanup-result"></div>
      </div>
      <div class="ehplus-tab-panel" data-panel="migration" hidden>
        <label><span data-i18n="deleteOldCache">成功后删除旧缓存</span><input type="checkbox" data-setting="deleteOldCacheAfterMigration" ${checked(settings.deleteOldCacheAfterMigration)}></label>
        <div class="ehplus-kv" data-role="migration-summary"></div>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn" data-action="migration-start" data-i18n="startMigration">开始迁移</button>
          <button type="button" class="ehplus-btn" data-action="migration-retry" data-i18n="retryMigration">重试迁移</button>
          <button type="button" class="ehplus-btn" data-action="migration-cancel" data-i18n="cancelMigration" hidden>取消迁移</button>
        </div>
        <p data-i18n="migrationHelp">迁移会读取旧 IndexedDB/Blob、写入授权目录、逐条校验索引与文件大小；已迁移条目重试时自动跳过（断点续迁）。失败、取消或中断都不会删除旧缓存。</p>
      </div>
      <div class="ehplus-tab-panel" data-panel="language" hidden>
        <label><span data-i18n="uiLanguage">界面语言</span><select data-setting="language"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label>
      </div>
      <div class="ehplus-tab-panel" data-panel="colors" hidden>
        <div class="ehplus-color-list" data-role="color-list"></div>
        <p data-i18n="colorHelp">点击圆点或调色盘选择颜色，也可以输入 ff、0ff、00e5ff 或 #00e5ff。确认后才生效；取消或点击其他区域会撤销本次修改。</p>
      </div>
      <div class="ehplus-tab-panel" data-panel="about" hidden>
        <div class="ehplus-about-head">
          <span class="ehplus-github-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="18" height="18" focusable="false">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.7 5.47 7.79.4.08.55-.18.55-.39 0-.19-.01-.84-.01-1.53-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.16-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.42 7.42 0 0 1 8 4.03c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.76.54 1.53 0 1.1-.01 1.99-.01 2.26 0 .21.15.47.55.39A8.12 8.12 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"/>
            </svg>
          </span>
          <strong data-i18n="aboutTitle">关于 EH＋</strong>
        </div>
        <div class="ehplus-kv" data-role="about-summary"></div>
        <div class="ehplus-inline-actions">
          <button type="button" class="ehplus-btn ehplus-icon-btn" data-action="open-github" data-i18n-title="githubIconLabel" title="GitHub">
            <span class="ehplus-github-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
                <path fill="currentColor" d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.7 5.47 7.79.4.08.55-.18.55-.39 0-.19-.01-.84-.01-1.53-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.16-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.42 7.42 0 0 1 8 4.03c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.76.54 1.53 0 1.1-.01 1.99-.01 2.26 0 .21.15.47.55.39A8.12 8.12 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"/>
              </svg>
            </span>
          </button>
          <button type="button" class="ehplus-btn" data-action="check-update">
            <span class="ehplus-spinner" data-role="update-spinner" hidden></span>
            <span data-i18n="checkUpdate">检查更新</span>
          </button>
          <button type="button" class="ehplus-btn" data-action="download-update" data-i18n="downloadUpdate" hidden>下载新版</button>
        </div>
        <div class="ehplus-result" data-role="update-result"></div>
            <p data-i18n="uniqueSourceNotice">唯一官方来源是项目 GitHub 仓库。这里会打开真实项目地址。</p>
        <p data-i18n="freeNotice">本项目免费开源。</p>
        <p data-i18n="resaleNotice">其他任何地方付费获取，均为第三方将开源项目贩卖的个人行为，与本项目无关。</p>
      </div>
      <div class="ehplus-drawer-actions">
        <span data-role="settings-status" data-i18n="applyNow">修改后立即生效</span>
        <button type="button" class="ehplus-btn" data-action="save-settings" data-i18n="syncNow">立即同步</button>
      </div>
    </div>
    <div class="ehplus-error" data-role="error" hidden></div>
  `;
  setSelect(panel, 'storageMode', settings.storageMode ?? 'indexeddb');
  setSelect(panel, 'storageLimitUnit', settings.storageLimitUnit ?? 'GB');
  setSelect(panel, 'logLimitUnit', settings.logLimitUnit ?? 'MB');
  setSelect(panel, 'cleanupScope', settings.cleanupScope ?? 'all');
  setSelect(panel, 'cleanupMode', settings.cleanupMode ?? 'olderThanDays');
  setSelect(panel, 'language', settings.language ?? 'zh-CN');
  panel.__ehplusLanguage = settings.language ?? 'zh-CN';
  applyLanguage(panel);
  return panel;
}

function bindPanelActions(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      if (!event.target.closest('.ehplus-color-row')) {
        cancelPendingColors(root);
      }
      const confirm = root.querySelector('[data-role="quota-confirm"]');
      if (confirm && !confirm.hidden && !event.target.closest('[data-role="quota-confirm"]')) {
        hideQuotaConfirm(root);
      }
      return;
    }
    const action = button.dataset.action;
    if (!['quota-prepare', 'quota-confirm', 'quota-cancel'].includes(action) && !button.closest('[data-role="quota-confirm"]')) {
      hideQuotaConfirm(root);
    }

    if (action === 'toggle') {
      togglePanelCollapsed(root);
      return;
    }

    if (action === 'settings') {
      const drawer = root.querySelector('[data-role="settings-drawer"]');
      if (!drawer) return;
      drawer.hidden = !drawer.hidden;
      button.dataset.i18n = drawer.hidden ? 'settings' : 'collapseSettings';
      applyLanguage(root);
      clampPanelPosition(root);
      return;
    }

    if (action === 'save-settings') {
      await applyDrawerSettings(root, t(root, 'synced'));
      return;
    }

    if (action === 'open-storage-address') {
      await openStorageAddress(root);
      return;
    }

    if (action === 'account-refresh') {
      setDrawerStatus(root, t(root, 'accountRefreshPending'));
      const response = await sendAndRender(root, { type: 'EHPLUS_REFRESH_ACCOUNT' });
      if (response?.ok) {
        setDrawerStatus(root, t(root, 'accountRefreshed'));
        flashStatus(root, t(root, 'accountRefreshed'));
      } else {
        setDrawerStatus(root, t(root, 'accountRefreshFailed', { message: responseErrorMessage(response) }));
      }
      return;
    }

    if (action === 'quota-prepare') {
      setDrawerStatus(root, t(root, 'quotaPreparePending'));
      const response = await sendAndRender(root, { type: 'EHPLUS_RESET_QUOTA_PREPARE' });
      if (response?.ok) {
        showQuotaConfirm(root, response.token, response.state.account.resetCostGp, response.state.account.updatedAt);
        setDrawerStatus(root, t(root, 'quotaConfirmNeeded'));
        flashStatus(root, t(root, 'quotaConfirmNeeded'));
      } else {
        setDrawerStatus(root, t(root, 'quotaPrepareFailed', { message: responseErrorMessage(response) }));
      }
      return;
    }

    if (action === 'quota-confirm') {
      const token = root.querySelector('[data-role="quota-confirm"]')?.dataset.token;
      setDrawerStatus(root, t(root, 'quotaResetPending'));
      const response = await sendAndRender(root, { type: 'EHPLUS_RESET_QUOTA_CONFIRM', token });
      if (response?.ok) {
        hideQuotaConfirm(root);
        setDrawerStatus(root, t(root, 'quotaResetDone'));
        flashStatus(root, t(root, 'quotaResetDone'));
      } else {
        setDrawerStatus(root, t(root, 'quotaResetFailed', { message: responseErrorMessage(response) }));
      }
      return;
    }

    if (action === 'quota-cancel') {
      const token = root.querySelector('[data-role="quota-confirm"]')?.dataset.token;
      const response = await sendAndRender(root, { type: 'EHPLUS_RESET_QUOTA_CANCEL', token });
      if (response?.ok) {
        hideQuotaConfirm(root);
        flashStatus(root, t(root, 'quotaCancelled'));
      }
      return;
    }

    if (action === 'dawn') {
      setDrawerStatus(root, t(root, 'dawnPending'));
      const response = await sendAndRender(root, { type: 'EHPLUS_RUN_DAWN' });
      if (response?.ok) {
        const message = dawnResultText(root, response.state.dawn);
        setDrawerStatus(root, t(root, 'dawnDone', { message }));
        flashStatus(root, message);
      } else {
        setDrawerStatus(root, t(root, 'dawnFailed', { message: responseErrorMessage(response) }));
      }
      return;
    }

    if (action === 'cleanup-preview') {
      if (!validateCleanup(root)) return;
      const response = await sendAndRender(root, {
        type: 'EHPLUS_CLEANUP_PREVIEW',
        ...readCleanup(root)
      });
      if (response?.ok) {
        renderCleanupPreview(root, response.preview);
        root.querySelector('[data-action="cleanup-confirm"]').disabled = false;
      }
      return;
    }

    if (action === 'cleanup-confirm') {
      if (!validateCleanup(root)) return;
      const response = await sendAndRender(root, {
        type: 'EHPLUS_CLEANUP_CONFIRM',
        ...readCleanup(root)
      });
      if (response?.ok) {
        renderCleanupResult(root, response.result);
        flashStatus(root, t(root, 'cleanupDone'));
      }
      return;
    }

    if (action === 'migration-start' || action === 'migration-retry') {
      await applyDrawerSettings(root, t(root, 'migrationSynced'));
      const response = await sendAndRender(root, {
        type: 'EHPLUS_RUN_MIGRATION',
        deleteOldCacheAfterMigration: drawerChecked(root, 'deleteOldCacheAfterMigration')
      });
      // 迁移在后台执行（可取消、有进度），这里只确认已受理并开始轮询进度。
      if (response?.ok) {
        flashStatus(root, t(root, response.accepted ? 'migrationStarted' : 'migrationDone'));
        scheduleMigrationProgressPoll(root);
      }
      return;
    }

    if (action === 'migration-cancel') {
      const response = await sendAndRender(root, { type: 'EHPLUS_CANCEL_MIGRATION' });
      if (response?.ok) {
        flashStatus(root, t(root, response.accepted ? 'migrationCancelPending' : 'migrationNotRunning'));
        if (response.accepted) scheduleMigrationProgressPoll(root);
      }
      return;
    }

    if (action === 'open-history') {
      openHistoryPage(root);
      return;
    }

    if (action === 'open-github') {
      const url = root.__ehplusState?.about?.repositoryUrl;
      if (!url) {
        flashStatus(root, t(root, 'noTargetUrl'));
        return;
      }
      globalThis.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (action === 'check-update' || action === 'title-update') {
      await runUpdateAction(root, button);
      return;
    }

    if (action === 'download-update') {
      const url = button.dataset.url;
      if (!url) {
        flashStatus(root, t(root, 'downloadBlocked'));
        return;
      }
      const response = await sendAndRender(root, { type: 'EHPLUS_DOWNLOAD_UPDATE', url });
      flashStatus(root, response?.result?.ok ? t(root, 'downloadStarted') : t(root, 'downloadBlocked'));
      return;
    }

  });

  root.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-role]');
    if (!input) return;
    syncQuickSettingsToDrawer(root);
    applyDrawerSettings(root, t(root, 'applied'));
    renderMatrix(root);
  });

  root.addEventListener('input', (event) => {
    const colorText = event.target.closest('[data-color-text]');
    if (colorText) {
      previewColorText(root, colorText);
      return;
    }

    const quick = event.target.closest('input[data-role]');
    if (quick) {
      syncQuickSettingsToDrawer(root);
      queueApplyDrawerSettings(root);
      renderMatrix(root);
      return;
    }

    const accountField = event.target.closest('[data-account-field]');
    if (accountField) {
      queueApplyDrawerSettings(root);
      renderAccountStats(root, {
        ...root.__ehplusState,
        settings: {
          ...(root.__ehplusState?.settings ?? {}),
          accountStatusFields: readAccountStatusFields(root)
        }
      });
      return;
    }

    const statsField = event.target.closest('[data-stats-field]');
    if (statsField) {
      const nextState = {
        ...root.__ehplusState,
        settings: {
          ...(root.__ehplusState?.settings ?? {}),
          statsDisplayFields: readStatsDisplayFields(root)
        }
      };
      queueApplyDrawerSettings(root);
      renderMiniStats(root, nextState);
      renderStats(root, nextState);
      return;
    }

    const logField = event.target.closest('[data-log-field]');
    if (logField) {
      const nextState = {
        ...root.__ehplusState,
        settings: {
          ...(root.__ehplusState?.settings ?? {}),
          logDisplayFields: readLogDisplayFields(root)
        }
      };
      queueApplyDrawerSettings(root);
      renderMiniStats(root, nextState);
      renderLogSummary(root, nextState);
      return;
    }

    const target = event.target.closest('[data-setting]');
    if (!target) return;
    if (target.dataset.setting === 'storageMode') {
      renderStorageAddress(root, root.__ehplusState);
    }
    syncDrawerSettingsToQuick(root);
    validateCleanup(root);
    queueApplyDrawerSettings(root);
    renderMatrix(root);
  });

  root.addEventListener('change', (event) => {
    const colorPicker = event.target.closest('[data-color-picker]');
    if (colorPicker) {
      previewColorPicker(root, colorPicker);
      return;
    }

    const accountField = event.target.closest('[data-account-field]');
    if (accountField) {
      applyDrawerSettings(root, t(root, 'applied'));
      return;
    }

    const statsField = event.target.closest('[data-stats-field]');
    if (statsField) {
      applyDrawerSettings(root, t(root, 'applied'));
      return;
    }

    const logField = event.target.closest('[data-log-field]');
    if (logField) {
      applyDrawerSettings(root, t(root, 'applied'));
      return;
    }

    const target = event.target.closest('[data-setting]');
    if (!target) return;
    syncDrawerSettingsToQuick(root);
    validateCleanup(root);
      applyDrawerSettings(root, t(root, 'applied'));
    renderMatrix(root);
  });

  root.addEventListener('click', (event) => {
    const colorConfirm = event.target.closest('[data-color-confirm]');
    if (colorConfirm) {
      commitPendingColor(root, colorConfirm.dataset.colorConfirm);
      return;
    }

    const colorCancel = event.target.closest('[data-color-cancel]');
    if (colorCancel) {
      cancelPendingColor(root, colorCancel.dataset.colorCancel);
      return;
    }

    const colorButton = event.target.closest('[data-color-button]');
    if (colorButton) {
      const key = colorButton.dataset.colorButton;
      cancelPendingColors(root, key);
      root.querySelector(`[data-color-picker="${key}"]`)?.click();
      return;
    }

    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    cancelPendingColors(root);
    const target = tab.dataset.active === 'true' ? null : tab.dataset.tab;
    setActiveSettingsTab(root, target);
    clampPanelPosition(root);
  });

  const firstTab = root.querySelector('[data-tab]');
  if (firstTab) setActiveSettingsTab(root, firstTab.dataset.tab);
  validateCleanup(root);
}

function togglePanelCollapsed(root) {
  const button = root.querySelector('[data-action="toggle"]');
  const collapsed = root.dataset.collapsed === 'true';
  root.dataset.collapsed = collapsed ? 'false' : 'true';
  if (button) button.dataset.i18n = collapsed ? 'hide' : 'show';
  applyLanguage(root);
  clampPanelPosition(root);
  persistPanelPosition(root);
}

function setActiveSettingsTab(root, target) {
  root.querySelectorAll('[data-tab]').forEach((item) => {
    const active = item.dataset.tab === target;
    item.dataset.active = String(active);
    item.setAttribute('aria-expanded', String(active));
  });
  root.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== target;
  });
}

function bindPanelDocumentActions(root) {
  document.addEventListener('mousedown', (event) => {
    if (!root.isConnected || root.contains(event.target)) return;
    cancelPendingColors(root);
  });
}

function queueApplyDrawerSettings(root) {
  clearTimeout(root.__ehplusApplySettingsTimer);
  root.__ehplusApplySettingsTimer = setTimeout(() => {
    applyDrawerSettings(root, t(root, 'applied'));
  }, 250);
}

async function applyDrawerSettings(root, message) {
  setDrawerStatus(root, t(root, 'applying'));
  const response = await chrome.runtime.sendMessage({
    type: 'EHPLUS_UPDATE_SETTINGS',
    settings: readDrawerSettings(root)
  });
  if (response?.ok) {
    syncReaderCacheFirstSetting(response.state?.settings);
    syncBuiltInAutoPagerFromState(response.state, window.__EHPLUS_RUNTIME__?.pageSessionId ?? '');
    root.__ehplusState = response.state;
    renderPanel(root, response.state);
    setDrawerStatus(root, message);
    flashStatus(root, message);
    return response;
  }
  setDrawerStatus(root, t(root, 'applyFailed'));
  return response;
}

async function sendAndRender(root, message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.ok && response.state) {
    root.__ehplusState = response.state;
    renderPanel(root, response.state);
  }
  return response;
}

async function checkUpdateIfDue(root) {
  const response = await sendAndRender(root, { type: 'EHPLUS_CHECK_UPDATE_IF_DUE' });
  if (response?.ok && response.state) {
    renderUpdateBadge(root, response.state);
  }
}

async function runUpdateAction(root, button) {
  const spinner = button.querySelector('[data-role="update-spinner"]');
  const label = button.querySelector('[data-i18n="checkUpdate"]');
  button.disabled = true;
  if (spinner) spinner.hidden = false;
  if (label) label.textContent = t(root, 'checkingUpdate');
  try {
    const response = await sendAndRender(root, { type: 'EHPLUS_CHECK_UPDATE' });
    if (response?.result) flashStatus(root, updateResultText(root, response.result));
  } finally {
    button.disabled = false;
    if (spinner) spinner.hidden = true;
    if (label) label.textContent = t(root, 'checkUpdate');
    clampPanelPosition(root);
  }
}

function syncQuickSettingsToDrawer(root) {
  const pairs = [
    ['enabled', 'preloadEnabled', 'checked'],
    ['blob', 'blobCacheEnabled', 'checked']
  ];
  for (const [quickKey, drawerKey, property] of pairs) {
    const quick = root.querySelector(`[data-role="${quickKey}"]`);
    const drawer = root.querySelector(`[data-setting="${drawerKey}"]`);
    if (quick && drawer) drawer[property] = quick[property];
  }
}

function syncDrawerSettingsToQuick(root) {
  const pairs = [
    ['preloadEnabled', 'enabled', 'checked'],
    ['blobCacheEnabled', 'blob', 'checked']
  ];
  for (const [drawerKey, quickKey, property] of pairs) {
    const drawer = root.querySelector(`[data-setting="${drawerKey}"]`);
    const quick = root.querySelector(`[data-role="${quickKey}"]`);
    if (quick && drawer) quick[property] = drawer[property];
  }
}

function readDrawerSettings(root) {
  const stateSettings = root.__ehplusState?.settings ?? {};
  return {
    language: drawerValue(root, 'language'),
    storageMode: drawerValue(root, 'storageMode'),
    storageLimitValue: numberSetting(root, 'storageLimitValue'),
    storageLimitUnit: drawerValue(root, 'storageLimitUnit'),
    directoryCacheEnabled: drawerValue(root, 'storageMode') === 'directory' && Boolean(root.__ehplusDirectoryLabel),
    directoryLabel: root.__ehplusDirectoryLabel ?? '',
    deleteOldCacheAfterMigration: drawerChecked(root, 'deleteOldCacheAfterMigration'),
    preloadEnabled: drawerChecked(root, 'preloadEnabled'),
    preloadAhead: numberSetting(root, 'preloadAhead'),
    preloadQueueDisplayEnabled: drawerChecked(root, 'preloadQueueDisplayEnabled'),
    globalConcurrency: numberSetting(root, 'globalConcurrency'),
    concurrencyDisplayEnabled: drawerChecked(root, 'concurrencyDisplayEnabled'),
    pageOffset: numberSetting(root, 'pageOffset'),
    blobCacheEnabled: drawerChecked(root, 'blobCacheEnabled'),
    readerCacheFirstEnabled: quickCheckedOr(root, 'reader-cache-first', stateSettings.readerCacheFirstEnabled === true),
    externalImageCacheFillEnabled: drawerChecked(root, 'externalImageCacheFillEnabled'),
    autoPagerEnabled: quickCheckedOr(root, 'auto-pager', stateSettings.autoPagerEnabled === true),
    autoPagerRemain: numberSetting(root, 'autoPagerRemain'),
    autoPagerMaxPages: numberSetting(root, 'autoPagerMaxPages'),
    autoPagerImmediateEnabled: drawerChecked(root, 'autoPagerImmediateEnabled'),
    autoPagerImmediatePages: numberSetting(root, 'autoPagerImmediatePages'),
    autoPagerSeparatorEnabled: drawerChecked(root, 'autoPagerSeparatorEnabled'),
    autoPagerAplus: drawerChecked(root, 'autoPagerAplus'),
    protectHighReadImages: drawerChecked(root, 'protectHighReadImages'),
    highReadThreshold: numberSetting(root, 'highReadThreshold'),
    protectHighReadGalleries: drawerChecked(root, 'protectHighReadGalleries'),
    highReadGalleryThreshold: numberSetting(root, 'highReadGalleryThreshold'),
    loggingEnabled: drawerChecked(root, 'loggingEnabled'),
    logDebugEnabled: drawerChecked(root, 'logDebugEnabled'),
    logDisplayFields: readLogDisplayFields(root),
    logRetentionDays: numberSetting(root, 'logRetentionDays'),
    logLimitValue: numberSetting(root, 'logLimitValue'),
    logLimitUnit: drawerValue(root, 'logLimitUnit'),
    accountStatusFields: readAccountStatusFields(root),
    dawnEnabled: drawerChecked(root, 'dawnEnabled'),
    backgroundDawnEnabled: drawerChecked(root, 'backgroundDawnEnabled'),
    statsDisplayFields: readStatsDisplayFields(root),
    historyLimit: numberSetting(root, 'historyLimit'),
    cleanupScope: drawerValue(root, 'cleanupScope'),
    cleanupMode: drawerValue(root, 'cleanupMode'),
    cleanupDays: numberSetting(root, 'cleanupDays'),
    cleanupIncludeProtected: drawerChecked(root, 'cleanupIncludeProtected'),
    cleanupIncludeProtectedGalleries: drawerChecked(root, 'cleanupIncludeProtectedGalleries'),
    cellColors: readCellColors(root)
  };
}

function readCleanup(root) {
  return {
    scope: drawerValue(root, 'cleanupScope'),
    mode: drawerValue(root, 'cleanupMode'),
    days: numberSetting(root, 'cleanupDays'),
    includeProtected: drawerChecked(root, 'cleanupIncludeProtected'),
    includeProtectedGalleries: drawerChecked(root, 'cleanupIncludeProtectedGalleries')
  };
}

function drawerValue(root, key) {
  return root.querySelector(`[data-setting="${key}"]`)?.value;
}

function drawerChecked(root, key) {
  return Boolean(root.querySelector(`[data-setting="${key}"]`)?.checked);
}

function quickCheckedOr(root, key, fallback) {
  const node = root.querySelector(`[data-role="${key}"]`);
  return node ? Boolean(node.checked) : Boolean(fallback);
}

function numberSetting(root, key) {
  return Number(drawerValue(root, key));
}

function readAccountStatusFields(root) {
  const fields = { ...DEFAULT_ACCOUNT_STATUS_FIELDS };
  root.querySelectorAll('[data-account-field]').forEach((input) => {
    fields[input.dataset.accountField] = Boolean(input.checked);
  });
  return fields;
}

function readStatsDisplayFields(root) {
  const fields = { ...DEFAULT_STATS_DISPLAY_FIELDS };
  root.querySelectorAll('[data-stats-field]').forEach((input) => {
    fields[input.dataset.statsField] = Boolean(input.checked);
  });
  return fields;
}

function readLogDisplayFields(root) {
  const fields = { ...DEFAULT_LOG_DISPLAY_FIELDS };
  root.querySelectorAll('[data-log-field]').forEach((input) => {
    fields[input.dataset.logField] = Boolean(input.checked);
  });
  return fields;
}

function readCellColors(root) {
  return normalizedCellColors(root.__ehplusState?.settings?.cellColors);
}

function syncColorControlsFromState(root, state) {
  const colors = normalizedCellColors(state?.settings?.cellColors);
  for (const key of CELL_COLOR_KEYS) {
    const value = colors[key];
    const text = root.querySelector(`[data-color-text="${key}"]`);
    const picker = root.querySelector(`[data-color-picker="${key}"]`);
    const button = root.querySelector(`[data-color-button="${key}"]`);
    const row = root.querySelector(`[data-color-row="${key}"]`);
    if (text) text.value = value.slice(1);
    if (picker) picker.value = value;
    if (button) button.style.backgroundColor = value;
    if (row) setColorRowPending(row, false);
  }
}

function previewColorText(root, input) {
  const key = input.dataset.colorText;
  const value = parseHexColor(input.value);
  if (!value) {
    markPendingColorEdit(root, key);
    return false;
  }
  setPendingColor(root, key, value);
  return true;
}

function previewColorPicker(root, input) {
  const key = input.dataset.colorPicker;
  const value = normalizeHexColor(input.value, DEFAULT_CELL_COLORS[key]);
  setPendingColor(root, key, value);
}

function setPendingColor(root, key, value) {
  if (!CELL_COLOR_KEYS.includes(key)) return;
  cancelPendingColors(root, key);
  const row = root.querySelector(`[data-color-row="${key}"]`);
  const text = root.querySelector(`[data-color-text="${key}"]`);
  const picker = root.querySelector(`[data-color-picker="${key}"]`);
  const button = root.querySelector(`[data-color-button="${key}"]`);
  if (text) text.value = value.slice(1);
  if (picker) picker.value = value;
  if (button) button.style.backgroundColor = value;
  if (row) {
    row.dataset.pendingColor = value;
    setColorRowPending(row, true);
  }
}

function markPendingColorEdit(root, key) {
  if (!CELL_COLOR_KEYS.includes(key)) return;
  cancelPendingColors(root, key);
  const row = root.querySelector(`[data-color-row="${key}"]`);
  if (row) {
    delete row.dataset.pendingColor;
    setColorRowPending(row, true);
  }
}

async function commitPendingColor(root, key) {
  const row = root.querySelector(`[data-color-row="${key}"]`);
  const value = normalizeHexColor(row?.dataset.pendingColor, null);
  if (!value) return;
  updateLocalCellColor(root, key, value);
  setColorRowPending(row, false);
  await applyDrawerSettings(root, t(root, 'applied'));
  renderPanelColors(root, root.__ehplusState);
  renderMatrix(root);
}

function cancelPendingColors(root, keepKey = '') {
  root.querySelectorAll('[data-color-row][data-pending="true"]').forEach((row) => {
    if (row.dataset.colorRow !== keepKey) {
      cancelPendingColor(root, row.dataset.colorRow);
    }
  });
}

function cancelPendingColor(root, key) {
  if (!key) return;
  const colors = normalizedCellColors(root.__ehplusState?.settings?.cellColors);
  const value = colors[key] ?? DEFAULT_CELL_COLORS[key];
  const row = root.querySelector(`[data-color-row="${key}"]`);
  const text = root.querySelector(`[data-color-text="${key}"]`);
  const picker = root.querySelector(`[data-color-picker="${key}"]`);
  const button = root.querySelector(`[data-color-button="${key}"]`);
  if (text) text.value = value.slice(1);
  if (picker) picker.value = value;
  if (button) button.style.backgroundColor = value;
  if (row) setColorRowPending(row, false);
}

function setColorRowPending(row, pending) {
  if (!row) return;
  row.dataset.pending = String(Boolean(pending));
  if (!pending) {
    delete row.dataset.pendingColor;
  }
  row.querySelectorAll('[data-color-confirm], [data-color-cancel]').forEach((button) => {
    button.hidden = !pending;
    if (button.dataset.colorConfirm !== undefined) {
      button.disabled = pending && !row.dataset.pendingColor;
    }
  });
}

function renderStorageAddress(root, state) {
  const button = root.querySelector('[data-role="storage-address"]');
  const riskIcon = root.querySelector('[data-role="storage-risk-icon"]');
  if (!button) return;
  const settings = state?.settings ?? root.__ehplusState?.settings ?? {};
  const isDirectory = drawerValue(root, 'storageMode') === 'directory' || settings.storageMode === 'directory';
  button.dataset.mode = isDirectory ? 'directory' : 'indexeddb';
  button.textContent = isDirectory
    ? directoryAddressText(root, state)
    : browserStorageAddressText(root);
  button.title = isDirectory ? t(root, 'chooseDirectory') : t(root, 'browserStoragePathRuleStatus');
  if (riskIcon) {
    riskIcon.hidden = isDirectory;
  }
}

function browserStorageAddressText(root) {
  return t(root, 'browserStorageAddress', {
    origin: location.origin || location.hostname || 'current site'
  });
}

function directoryAddressText(root, state) {
  const settings = state?.settings ?? root.__ehplusState?.settings ?? {};
  const migration = state?.migration ?? root.__ehplusState?.migration ?? {};
  const label = normalizeDirectoryLabel(root.__ehplusDirectoryLabel || settings.directoryLabel || migration.targetDirectoryLabel || '');
  return label || t(root, 'directoryNotSelected');
}

function bindStorageAddressActions(root) {
  const button = root.querySelector('[data-role="storage-address"]');
  if (!button) return;

  button.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

function openHistoryPage(root) {
  // history.html 不在 web_accessible_resources 里，网页上下文 window.open
  // 会被 Chrome 静默屏蔽（"<扩展ID> 已被屏蔽"页，且不抛异常），
  // 必须由 service worker 用 chrome.tabs 打开。
  chrome.runtime.sendMessage({ type: 'EHPLUS_OPEN_HISTORY' })
    .then((response) => {
      if (!response?.ok) flashStatus(root, t(root, 'openHistoryFailed'));
    })
    .catch(() => {
      flashStatus(root, t(root, 'openHistoryFailed'));
    });
}

async function openStorageAddress(root) {
  const button = root.querySelector('[data-role="storage-address"]');
  if (button?.dataset.busy === 'true') return;
  if (button) button.dataset.busy = 'true';
  const mode = root.querySelector('[data-setting="storageMode"]');
  try {
    if (mode?.value === 'directory') {
      await chooseDirectory(root, { force: true });
      return;
    }

    flashStatus(root, t(root, 'browserStoragePathRule'));
  } finally {
    if (button) {
      setTimeout(() => {
        button.dataset.busy = 'false';
      }, 500);
    }
  }
}

async function chooseDirectory(root, { force }) {
  const mode = root.querySelector('[data-setting="storageMode"]');
  if (!mode) return;
  if (mode.value !== 'directory') {
    mode.value = 'directory';
  }

  const previous = normalizeDirectoryLabel(root.__ehplusDirectoryLabel || root.__ehplusState?.settings?.directoryLabel || '');
  if (!force && previous) {
    renderStorageAddress(root, root.__ehplusState);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'EHPLUS_OPEN_DIRECTORY_PICKER' });
  if (!response?.ok) {
    renderStorageAddress(root, root.__ehplusState);
    flashStatus(root, responseErrorMessage(response));
    return;
  }
  syncDrawerSettingsToQuick(root);
  flashStatus(root, t(root, 'directoryAuthorizationOpened'));
}

function hasOldDirectoryData(root) {
  const migration = root.__ehplusState?.migration ?? {};
  return (migration.oldCacheCount ?? 0) > 0 || (migration.oldCacheBytes ?? 0) > 0;
}

function normalizeDirectoryLabel(value) {
  const label = String(value ?? '').replace(/^授权目录\s*\/\s*/, '').trim();
  return label === '未授权' || label === 'Not authorized' ? '' : label;
}

function updateLocalCellColor(root, key, value) {
  root.__ehplusState = {
    ...(root.__ehplusState ?? {}),
    settings: {
      ...(root.__ehplusState?.settings ?? {}),
      cellColors: {
        ...normalizedCellColors(root.__ehplusState?.settings?.cellColors),
        [key]: value
      }
    }
  };
}

function bindPanelDrag(root) {
  const head = root.querySelector('.ehplus-head');
  if (!head) return;

  const headerToggleCooldownMs = 1000;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let lastHeaderToggleAt = 0;

  const onMove = (event) => {
    if (!dragging) return;
    const nextLeft = startLeft + event.clientX - startX;
    const nextTop = startTop + event.clientY - startY;
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    clampPanelPosition(root);
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    root.dataset.dragging = 'false';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', endDrag, true);
    persistPanelPosition(root);
  };

  head.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.detail >= 2 && isPanelHeaderToggleTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastHeaderToggleAt < headerToggleCooldownMs) return;
      lastHeaderToggleAt = now;
      togglePanelCollapsed(root);
      return;
    }
    if (event.target.closest('button')) return;
    const rect = root.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    root.dataset.dragging = 'true';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', endDrag, true);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener('resize', () => clampPanelPosition(root));
}

function isPanelHeaderToggleTarget(target) {
  return Boolean(target?.closest('.ehplus-head')) && !target.closest('button, input, select, textarea, a, label');
}

function restorePanelPosition(root, position) {
  if (typeof position?.left === 'number') root.style.left = `${position.left}px`;
  if (typeof position?.top === 'number') root.style.top = `${position.top}px`;
  root.style.right = 'auto';
  root.style.bottom = 'auto';
}

function clampPanelPosition(root) {
  const rect = root.getBoundingClientRect();
  const margin = 12;
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
  const left = Math.min(Math.max(rect.left, margin), maxLeft);
  const top = Math.min(Math.max(rect.top, margin), maxTop);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = 'auto';
  root.style.bottom = 'auto';
}

function persistPanelPosition(root) {
  const rect = root.getBoundingClientRect();
  chrome.runtime.sendMessage({
    type: 'EHPLUS_UPDATE_FLOATING_PANEL',
    panel: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      collapsed: root.dataset.collapsed === 'true'
    }
  });
}

function renderPanel(root, state) {
  root.__ehplusState = state;
  const settings = state?.settings ?? {};
  const fallbackReason = state?.__ehplusPanelFallbackReason ?? '';
  root.dataset.state = fallbackReason ? 'error' : settings.preloadEnabled === false ? 'paused' : 'hit';
  if (fallbackReason) {
    root.dataset.runtimeFallback = 'true';
  } else {
    delete root.dataset.runtimeFallback;
  }
  syncControlsFromState(root, state);
  applyLanguage(root);
  updatePanelStatusLine(root, state);
  renderPanelDetailLine(root, state);
  renderMiniStats(root, state);
  renderAccountStats(root, state);
  renderStorage(root, state);
  renderImageProtection(root, state);
  renderLogSummary(root, state);
  renderAccount(root, state);
  renderDawn(root, state);
  renderStats(root, state);
  renderMigration(root, state);
  renderAbout(root, state);
  renderUpdateBadge(root, state);
  renderRuntimeScopedControls(root, state);
  renderPanelColors(root, state);
  renderMatrix(root);
  clampPanelPosition(root);
}

function renderPanelDetailLine(root, state = root.__ehplusState) {
  const detail = root.querySelector('[data-role="detail"]');
  if (!detail) return;
  const settings = state?.settings ?? {};
  const fallbackReason = state?.__ehplusPanelFallbackReason ?? '';
  const pageCounts = currentPageCacheCounts(state);
  const detailParts = [
    `${t(root, 'meta')} ${formatNumber(root, pageCounts.indexOnly)}`,
    `${t(root, 'cachedCount')} ${formatNumber(root, pageCounts.cached)}`,
    `${t(root, 'images')} ${pageCounts.total == null ? '-' : formatNumber(root, pageCounts.total)}`
  ];
  // 并发与预加载排队后台始终生效，勾选设置只控制这里的 UI 显示。
  if (settings.concurrencyDisplayEnabled === true) {
    const active = state?.preloadLive?.activeRequests ?? 0;
    detailParts.push(`${t(root, 'globalConcurrencyShort')} ${formatNumber(root, active)}/${formatNumber(root, settings.globalConcurrency ?? 5)}`);
  }
  if (settings.preloadQueueDisplayEnabled === true) {
    const sessionId = window.__EHPLUS_RUNTIME__?.pageSessionId ?? '';
    const queued = state?.preloadLive?.sessions?.[sessionId]?.pending ?? 0;
    detailParts.push(`${t(root, 'preloadQueueShort')} ${formatNumber(root, queued)}/${formatNumber(root, settings.preloadAhead ?? 6)}`);
  }
  if (fallbackReason) {
    detailParts.push(t(root, 'runtimeFallbackDetail', { reason: String(fallbackReason).slice(0, 80) }));
  }
  detail.textContent = detailParts.join(' | ');
}

// 当前页面的缓存计数：/s/ 与 /g/ 都按当前画廊 gid 汇总缓存记录。
// total 为当前页面总图片数（/s/ 取阅读器 x / y，/g/ 取 #gdd 的 N pages），未知时为 null。
function currentPageCacheCounts(state) {
  const gid = parseReaderPage(location.href)?.gid ?? galleryGidFromUrl(location.href);
  const records = Array.isArray(state?.storage?.readerRecords) ? state.storage.readerRecords : [];
  let cached = 0;
  let indexOnly = 0;
  if (gid) {
    const pagesSeen = new Set();
    for (const record of records) {
      if (String(record?.gid ?? '') !== gid) continue;
      const pageNo = Number(record?.pageNo);
      if (!Number.isSafeInteger(pageNo) || pagesSeen.has(pageNo)) continue;
      pagesSeen.add(pageNo);
      if (record.hasImage) {
        cached += 1;
      } else {
        indexOnly += 1;
      }
    }
  }
  return {
    indexOnly,
    cached,
    total: currentPageTotalImages()
  };
}

function galleryGidFromUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const match = parsed.pathname.match(/^\/g\/(\d+)\/[^/?#]+\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function currentPageTotalImages() {
  if (isGalleryPageUrl(location.href)) {
    const pages = currentGalleryMeta()?.pages;
    return Number.isSafeInteger(pages) && pages > 0 ? pages : null;
  }
  if (isReaderPageUrl(location.href)) {
    const text = document.querySelector('.sn')?.textContent ?? '';
    const match = text.match(/\d[\d,]*\s*\/\s*([\d,]+)/);
    if (match) {
      const total = Number(match[1].replace(/,/g, ''));
      return Number.isSafeInteger(total) && total > 0 ? total : null;
    }
  }
  return null;
}

function bindPanelCacheFirstStatusObserver(root) {
  if (root.__ehplusCacheFirstStatusObserverBound) return;
  root.__ehplusCacheFirstStatusObserverBound = true;

  const schedule = () => {
    cancelAnimationFrame(root.__ehplusCacheFirstStatusFrame);
    root.__ehplusCacheFirstStatusFrame = requestAnimationFrame(() => {
      if (root.isConnected) updatePanelStatusLine(root, root.__ehplusState);
    });
  };

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: [
      'src',
      'srcset',
      'id',
      'data-ehplus-cache-hit',
      'data-ehplus-cache-page-key',
      'data-ehplus-cache-scope'
    ]
  });
  root.__ehplusCacheFirstStatusObserver = observer;
}

// 图片加载动态行（用户反馈 2026-07-07）：阅读页/内置翻页图片的加载、
// 缓存命中、失败与换源重试实时可见，与主状态行互不挤占。
const readerImageLiveStatusState = {
  installed: false,
  root: null,
  events: [],
  imageStates: new WeakMap(),
  hideTimer: 0
};

function bindReaderImageLiveStatus(root) {
  readerImageLiveStatusState.root = root;
  installReaderImageLiveStatusObserver();
}

function installReaderImageLiveStatusObserver() {
  const state = readerImageLiveStatusState;
  if (state.installed) return;
  if (!/^\/s\//.test(location.pathname)) return;
  state.installed = true;

  document.addEventListener('load', (event) => handleReaderImageLiveEvent(event.target, 'load'), true);
  document.addEventListener('error', (event) => handleReaderImageLiveEvent(event.target, 'error'), true);

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          handleReaderImageLiveEvent(mutation.target, 'src-change');
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          const images = node.matches?.('img')
            ? [node]
            : Array.from(node.querySelectorAll?.('img') ?? []);
          for (const img of images) handleReaderImageLiveEvent(img, 'inserted');
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  const primary = document.getElementById('img');
  if (primary) handleReaderImageLiveEvent(primary, 'inserted');
}

function handleReaderImageLiveEvent(target, kind) {
  if (!(target instanceof HTMLImageElement)) return;
  if (!isLiveStatusReaderImage(target)) return;
  const pageNo = readerImageLivePageNumber(target);
  if (pageNo == null) return;

  const states = readerImageLiveStatusState.imageStates;
  const entry = states.get(target) ?? { errorCount: 0, lastKey: '' };
  states.set(target, entry);

  let key = '';
  if (kind === 'inserted') {
    if (target.complete && target.naturalWidth > 0) return;
    key = 'liveLoading';
  } else if (kind === 'src-change') {
    // 失败后的 src 变化就是换源重试，“换源重试中”已在 error 时提示过。
    if (entry.errorCount > 0 || target.complete) return;
    key = 'liveLoading';
  } else if (kind === 'error') {
    entry.errorCount += 1;
    key = entry.errorCount > 1 ? 'liveRetryFail' : 'liveFailed';
  } else if (kind === 'load') {
    const url = target.currentSrc || target.src || '';
    const fromCache = target.dataset.ehplusCacheHit === 'true' || /^(data:|blob:|chrome-extension:)/.test(url);
    if (entry.errorCount > 0) {
      key = 'liveRetryOk';
      entry.errorCount = 0;
    } else {
      key = fromCache ? 'liveLoadedCache' : 'liveLoaded';
    }
  }

  if (!key) return;
  const dedupeKey = `${key}:${pageNo}`;
  if (key === 'liveLoading' && entry.lastKey === dedupeKey) return;
  entry.lastKey = dedupeKey;
  pushReaderImageLiveEvent(key, pageNo);
}

function isLiveStatusReaderImage(img) {
  return img.id === 'img'
    || img.dataset?.ehplusOriginalId === 'img'
    || /^sp-exhentai-img-/.test(img.id ?? '');
}

function readerImageLivePageNumber(img) {
  const pageKey = nearestReaderPageKey(img) ?? parseReaderPageKey(location.href);
  if (!pageKey) return null;
  const pageNo = Number(pageKey.split(':')[1]);
  return Number.isSafeInteger(pageNo) ? pageNo : null;
}

function pushReaderImageLiveEvent(key, pageNo) {
  const state = readerImageLiveStatusState;
  const root = state.root;
  if (!root || !root.isConnected) return;
  const last = state.events[state.events.length - 1];
  if (last && last.key === key && last.pageNo === pageNo) return;
  state.events.push({ key, pageNo });
  if (state.events.length > 2) state.events.shift();
  renderReaderImageLiveStatus(root);

  clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(() => {
    state.events = [];
    renderReaderImageLiveStatus(root);
  }, 8000);
}

function renderReaderImageLiveStatus(root) {
  const node = root.querySelector('[data-role="live-status"]');
  if (!node) return;
  const events = readerImageLiveStatusState.events;
  if (!events.length) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = events
    .map((event) => t(root, event.key, { n: formatNumber(root, event.pageNo) }))
    .join(' · ');
}

function updatePanelStatusLine(root, state = root.__ehplusState) {
  const status = root.querySelector('[data-role="status"]');
  if (!status) return;

  const readerCacheFirstStatus = readerCacheFirstHitStatusText(root);
  if (readerCacheFirstStatus) {
    status.textContent = readerCacheFirstStatus;
    return;
  }

  const fallbackReason = state?.__ehplusPanelFallbackReason ?? '';
  if (fallbackReason) {
    status.textContent = t(root, 'runtimeFallbackStatus');
    return;
  }

  // 缓存命中率与统计页的 /s/ 命中率重复，不再在面板上方显示。
  status.textContent = statusReadyText(root, state);
}

function statusReadyText(root, state) {
  return state?.settings?.preloadEnabled === false ? t(root, 'statusPaused') : t(root, 'statusReady');
}

function readerCacheFirstHitStatusText(root) {
  const pageKey = parseReaderPageKey(location.href);
  if (!pageKey) return '';

  const img = document.querySelector(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR);
  if (!img?.dataset) return '';

  const deliveredUrl = img.currentSrc || img.src || img.getAttribute('src') || '';
  const isLocalDelivery = /^(data:|blob:|chrome-extension:)/i.test(deliveredUrl);
  if (!isLocalDelivery) return '';
  if (img.dataset.ehplusCacheHit !== 'true') return '';
  if (img.dataset.ehplusCachePageKey && img.dataset.ehplusCachePageKey !== pageKey) return '';

  const data = document.documentElement?.dataset ?? {};
  const responseHit = data.ehplusCacheFirstControllerResponseHit === 'true';
  const mainHit = ['hit', 'cached-url-kept'].includes(data.ehplusCacheFirstState);
  if (!responseHit && !mainHit) return '';

  return t(root, 'readerCacheFirstHitStatus', {
    target: readerCacheFirstHitTarget(img, pageKey)
  });
}

function readerCacheFirstHitTarget(img, pageKey) {
  const cachedPageKey = img?.dataset?.ehplusCachePageKey;
  if (cachedPageKey) return cachedPageKey;
  const page = parseReaderPage(location.href);
  if (page?.pageKey) return page.pageKey;
  if (pageKey) return pageKey;
  return summarizeLocalReaderTabUrl(location.href);
}

function renderRuntimeScopedControls(root, state) {
  const isExtension = isExtensionRuntime(state);
  for (const item of root.querySelectorAll('[data-extension-only="true"]')) {
    item.hidden = !isExtension;
  }
}

function runtimeOwner(state) {
  return state?.runtime?.owner ?? window.__EHPLUS_RUNTIME__?.owner ?? 'extension';
}

function isExtensionRuntime(state) {
  return runtimeOwner(state) === 'extension';
}

function syncControlsFromState(root, state) {
  const settings = state?.settings ?? {};
  if (state?.__ehplusPanelBootstrapOnly !== true) {
    syncReaderCacheFirstSetting(settings);
  }
  setChecked(root, 'preloadEnabled', settings.preloadEnabled !== false);
  setValue(root, 'preloadAhead', settings.preloadAhead ?? 6);
  setChecked(root, 'preloadQueueDisplayEnabled', settings.preloadQueueDisplayEnabled === true);
  setValue(root, 'globalConcurrency', settings.globalConcurrency ?? 5);
  setChecked(root, 'concurrencyDisplayEnabled', settings.concurrencyDisplayEnabled === true);
  setValue(root, 'pageOffset', settings.pageOffset ?? 24);
  setChecked(root, 'blobCacheEnabled', settings.blobCacheEnabled !== false);
  setChecked(root, 'externalImageCacheFillEnabled', settings.externalImageCacheFillEnabled !== false);
  setValue(root, 'autoPagerRemain', settings.autoPagerRemain ?? 1);
  setValue(root, 'autoPagerMaxPages', settings.autoPagerMaxPages ?? 99);
  setChecked(root, 'autoPagerImmediateEnabled', settings.autoPagerImmediateEnabled === true);
  setValue(root, 'autoPagerImmediatePages', settings.autoPagerImmediatePages ?? 2);
  setChecked(root, 'autoPagerSeparatorEnabled', settings.autoPagerSeparatorEnabled !== false);
  setChecked(root, 'autoPagerAplus', settings.autoPagerAplus !== false);
  setChecked(root, 'loggingEnabled', settings.loggingEnabled !== false);
  setChecked(root, 'logDebugEnabled', settings.logDebugEnabled === true);
  renderLogFieldList(root, state);
  setValue(root, 'logRetentionDays', settings.logRetentionDays ?? 30);
  setValue(root, 'logLimitValue', settings.logLimitValue ?? 100);
  setSelect(root, 'logLimitUnit', settings.logLimitUnit ?? 'MB');
  setSelect(root, 'storageMode', settings.storageMode ?? 'indexeddb');
  setValue(root, 'storageLimitValue', settings.storageLimitValue ?? 2);
  setSelect(root, 'storageLimitUnit', settings.storageLimitUnit ?? 'GB');
  root.__ehplusDirectoryLabel = normalizeDirectoryLabel(settings.directoryLabel ?? state?.migration?.targetDirectoryLabel ?? '');
  renderStorageAddress(root, state);
  setSelect(root, 'cleanupScope', settings.cleanupScope ?? 'all');
  setSelect(root, 'cleanupMode', settings.cleanupMode ?? 'olderThanDays');
  setValue(root, 'cleanupDays', settings.cleanupDays ?? 7);
  setSelect(root, 'language', settings.language ?? 'zh-CN');
  setChecked(root, 'cleanupIncludeProtected', settings.cleanupIncludeProtected);
  setChecked(root, 'deleteOldCacheAfterMigration', settings.deleteOldCacheAfterMigration);
  setChecked(root, 'protectHighReadImages', settings.protectHighReadImages);
  setValue(root, 'highReadThreshold', settings.highReadThreshold ?? 3);
  setChecked(root, 'protectHighReadGalleries', settings.protectHighReadGalleries);
  setValue(root, 'highReadGalleryThreshold', settings.highReadGalleryThreshold ?? 3);
  renderAccountFieldList(root, state);
  setValue(root, 'historyLimit', settings.historyLimit ?? 100);
  setChecked(root, 'dawnEnabled', settings.dawnEnabled);
  setChecked(root, 'backgroundDawnEnabled', settings.backgroundDawnEnabled);
  setChecked(root, 'cleanupIncludeProtectedGalleries', settings.cleanupIncludeProtectedGalleries);
  renderColorList(root, state);
  syncColorControlsFromState(root, state);

  const quickMap = [
    ['enabled', settings.preloadEnabled !== false, 'checked'],
    ['blob', settings.blobCacheEnabled !== false, 'checked'],
    ['reader-cache-first', settings.readerCacheFirstEnabled === true, 'checked'],
    ['auto-pager', settings.autoPagerEnabled === true, 'checked']
  ];
  for (const [key, value, property] of quickMap) {
    const node = root.querySelector(`[data-role="${key}"]`);
    if (node) node[property] = value;
  }
}

function renderStorage(root, state) {
  const storage = state?.storage ?? {};
  const settings = state?.settings ?? {};
  const allocatedBytes = storageLimitBytes(settings);
  const total = Math.max(storage.totalBytes ?? 0, 1);
  root.querySelector('[data-role="storage-image-bar"]').style.width = `${(storage.imageBytes ?? 0) / total * 100}%`;
  root.querySelector('[data-role="storage-log-bar"]').style.width = `${(storage.logBytes ?? 0) / total * 100}%`;
  root.querySelector('[data-role="storage-other-bar"]').style.width = `${(storage.otherBytes ?? 0) / total * 100}%`;
  renderKv(root.querySelector('[data-role="storage-summary"]'), [
    [t(root, 'storageTotal'), `${formatBytes(storage.totalBytes ?? 0)} / ${formatBytes(allocatedBytes)}`],
    [t(root, 'images'), formatImageStorageSummary(root, storage)],
    [t(root, 'logs'), formatBytes(storage.logBytes ?? 0)],
    [t(root, 'other'), formatBytes(storage.otherBytes ?? 0)],
    [t(root, 'protectedImages'), `${formatNumber(root, storage.protectedImages ?? 0)} ${t(root, 'items')} · ${formatBytes(storage.protectedImageBytes ?? 0)}`],
    [t(root, 'protectedGalleries'), `${formatNumber(root, storage.protectedGalleries ?? 0)} ${t(root, 'items')} · ${formatBytes(storage.protectedGalleryBytes ?? 0)}`],
    [t(root, 'migrationCache'), `${formatNumber(root, state?.migration?.oldCacheCount ?? 0)} ${t(root, 'items')} · ${formatBytes(state?.migration?.oldCacheBytes ?? 0)}`]
  ]);
  const blockedNode = root.querySelector('[data-role="cache-blocked"]');
  if (blockedNode) {
    const reason = String(storage.cacheBlockedReason ?? '').trim();
    if (reason) {
      blockedNode.hidden = false;
      blockedNode.textContent = t(root, 'cacheBlockedReason', { reason });
    } else {
      blockedNode.hidden = true;
      blockedNode.textContent = '';
    }
  }
}

function storageLimitBytes(settings = {}) {
  const value = Number(settings.storageLimitValue);
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 2;
  if (settings.storageLimitUnit === 'KB') return safeValue * 1024;
  if (settings.storageLimitUnit === 'MB') return safeValue * 1024 * 1024;
  return safeValue * 1024 * 1024 * 1024;
}

function renderImageProtection(root, state) {
  const settings = state?.settings ?? {};
  const storage = state?.storage ?? {};
  const imageLine = settings.protectHighReadImages
    ? (languageOf(root) === 'en-US'
      ? `Images read more than ${formatNumber(root, settings.highReadThreshold ?? 3)} times are protected. Current: ${formatNumber(root, storage.protectedImages ?? 0)} ${t(root, 'items')}, ${formatBytes(storage.protectedImageBytes ?? 0)}.`
      : `访问次数超过 ${formatNumber(root, settings.highReadThreshold ?? 3)} 次的图片会受保护。当前 ${formatNumber(root, storage.protectedImages ?? 0)} 项，${formatBytes(storage.protectedImageBytes ?? 0)}。`)
    : (languageOf(root) === 'en-US'
      ? `Frequent image protection is disabled. Current protected candidates: ${formatNumber(root, storage.protectedImages ?? 0)} ${t(root, 'items')}.`
      : `常看图片保护未启用。当前可统计受保护图片候选 ${formatNumber(root, storage.protectedImages ?? 0)} 项。`);
  const galleryLine = settings.protectHighReadGalleries
    ? (languageOf(root) === 'en-US'
      ? `/g/ galleries read more than ${formatNumber(root, settings.highReadGalleryThreshold ?? 3)} times are protected. Current: ${formatNumber(root, storage.protectedGalleries ?? 0)} ${t(root, 'items')}, ${formatBytes(storage.protectedGalleryBytes ?? 0)}.`
      : `访问次数超过 ${formatNumber(root, settings.highReadGalleryThreshold ?? 3)} 次的 /g/ 画廊会受保护。当前 ${formatNumber(root, storage.protectedGalleries ?? 0)} 项，${formatBytes(storage.protectedGalleryBytes ?? 0)}。`)
    : (languageOf(root) === 'en-US'
      ? `Frequent /g/ gallery protection is disabled. Current protected candidates: ${formatNumber(root, storage.protectedGalleries ?? 0)} ${t(root, 'items')}.`
      : `常看画廊 /g/ 保护未启用。当前可统计受保护画廊候选 ${formatNumber(root, storage.protectedGalleries ?? 0)} 项。`);
  root.querySelector('[data-role="image-protection"]').textContent = `${imageLine}\n${galleryLine}`;
}

function renderLogSummary(root, state) {
  renderLogFieldList(root, state);
  root.querySelector('[data-role="log-summary"]')?.replaceChildren();
}

function renderLogFieldList(root, state) {
  const target = root.querySelector('[data-role="log-field-list"]');
  if (!target) return;
  const fields = normalizedLogDisplayFields(state?.settings?.logDisplayFields);
  const title = document.createElement('div');
  title.className = 'ehplus-account-field-title';
  title.textContent = t(root, 'logFieldSelect');
  target.replaceChildren(title, ...logFieldEntries(root, state).map(([label, value, key]) => {
    const row = document.createElement('label');
    row.className = 'ehplus-account-field';

    const text = document.createElement('span');
    text.textContent = label;

    const current = document.createElement('strong');
    current.textContent = value;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.logField = key;
    input.checked = fields[key] !== false;

    row.append(text, current, input);
    return row;
  }));
}

function renderAccount(root, state) {
  const account = state?.account ?? {};
  const quotaButton = root.querySelector('[data-action="quota-prepare"]');
  const canResetQuota = Number.isFinite(account.quotaLimit) && account.quotaLimit > 0;
  if (quotaButton) {
    quotaButton.hidden = !canResetQuota;
    // 重置花费为 0 GP 时按钮置灰不可点击（规划 §11）。
    quotaButton.disabled = account.resetCostGp === 0;
    quotaButton.title = account.resetCostGp === 0 ? t(root, 'resetFreeDisabled') : '';
    // 按钮文案带官方标称花费：`重置 930 GP`（规划 §11）。
    quotaButton.textContent = Number.isFinite(account.resetCostGp) && account.resetCostGp > 0
      ? t(root, 'resetQuotaWithCost', { cost: formatNumber(root, account.resetCostGp) })
      : t(root, 'resetQuota');
  }
  if (!canResetQuota) {
    hideQuotaConfirm(root);
  }
  // 账号状态刷新（updatedAt 变化）时收起未确认的重置确认框，
  // 恢复初始状态（规划 §11）；轮询期间账号未变则保持展开。
  const confirmBox = root.querySelector('[data-role="quota-confirm"]');
  if (confirmBox && !confirmBox.hidden
    && confirmBox.dataset.accountUpdatedAt !== String(account.updatedAt ?? 0)) {
    hideQuotaConfirm(root);
  }
  renderQuotaResult(root, account.lastReset);
}

function renderAccountFieldList(root, state) {
  const target = root.querySelector('[data-role="account-field-list"]');
  if (!target) return;
  const account = state?.account ?? {};
  const fields = normalizedAccountStatusFields(state?.settings?.accountStatusFields);
  const title = document.createElement('div');
  title.className = 'ehplus-account-field-title';
  title.textContent = t(root, 'accountFieldSelect');
  target.replaceChildren(title, ...accountFieldEntries(root, account).map(([label, value, key, tone]) => {
    const row = document.createElement('label');
    row.className = 'ehplus-account-field';

    const text = document.createElement('span');
    text.textContent = label;

    const current = document.createElement('strong');
    current.textContent = value;
    if (tone) current.classList.add(`ehplus-quota-tone-${tone}`);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.accountField = key;
    input.checked = fields[key] !== false;

    row.append(text, current, input);
    return row;
  }));
}

function renderAccountStats(root, state) {
  const target = root.querySelector('[data-role="account-stats"]');
  if (!target) return;
  const settings = state?.settings ?? {};
  const account = state?.account ?? {};
  const fields = normalizedAccountStatusFields(settings.accountStatusFields);
  const pills = accountFieldEntries(root, account)
    .filter((entry) => fields[entry[2]] !== false)
    .map(([label, value, , tone]) => miniPill(label, value, tone));
  target.hidden = false;
  target.replaceChildren(...pills);
  target.hidden = pills.length === 0;
}

function accountFieldEntries(root, account) {
  // 限额数值按后台计算的 quotaTone 着色：<50% 绿、≥50% 黄、超限红（规划 §11）。
  const quotaTone = ['green', 'yellow', 'red'].includes(account.quotaTone) ? account.quotaTone : null;
  return [
    [t(root, 'imageQuota'), `${formatNullableNumber(root, account.quotaUsed)} / ${formatNullableNumber(root, account.quotaLimit)}`, 'quota', quotaTone],
    [t(root, 'resetNominal'), `${formatNullableNumber(root, account.resetCostGp)} GP`, 'resetCost'],
    ['Credits', formatNullableNumber(root, account.credits), 'credits'],
    ['GP', formatNullableNumber(root, account.gp), 'gp'],
    ['Hath', formatNullableNumber(root, account.hath), 'hath'],
    [t(root, 'updatedAt'), formatDateTime(root, account.updatedAt), 'updatedAt']
  ];
}

function renderQuotaResult(root, reset) {
  const target = root.querySelector('[data-role="quota-result"]');
  if (!reset) {
    target.textContent = '';
    return;
  }
  const lines = [t(root, 'resetSuccess'), t(root, 'resetCost', { cost: formatNumber(root, reset.nominalGp) })];
  if (reset.showActualCost) {
    lines.push(t(root, 'actualCost'));
    for (const [key, value] of Object.entries(reset.delta)) {
      lines.push(`${balanceLabel(key)} ${formatSigned(root, value)}`);
    }
  }
  lines.push(t(root, 'remaining'));
  lines.push(`Credits ${formatNumber(root, reset.after.credits)}`);
  lines.push(`GP ${formatNumber(root, reset.after.gp)}`);
  target.textContent = lines.join('\n');
}

function renderDawn(root, state) {
  const dawn = state?.dawn ?? {};
  const rewardLines = formatDawnRewardText(root, dawn.rewards);
  const rewardText = rewardLines || (dawn.lastEventType === 'alreadyClaimed' || dawn.lastEventType === 'hvMonster' ? t(root, 'dawnAlreadyClaimed') : t(root, 'none'));
  const rows = [
    [t(root, 'lastDawnAt'), formatDateTime(root, dawn.lastRunAt)],
    [t(root, 'lastDawnResult'), dawnResultText(root, dawn)],
    [t(root, 'reward'), rewardText, 'dawn-reward'],
    [t(root, 'officialReset'), dawn.nextOfficialResetText ?? 'UTC 00:00 / Beijing 08:00'],
    [t(root, 'autoDawn'), languageOf(root) === 'en-US' ? 'After UTC 03:00' : (dawn.scheduledAfterText ?? 'UTC 03:00 后')],
    [t(root, 'backgroundDawnSuccessCount'), `${formatNumber(root, dawn.backgroundSuccessCount ?? 0)} ${languageOf(root) === 'en-US' ? 'times' : '次'}`]
  ];
  renderKv(root.querySelector('[data-role="dawn-summary"]'), rows);
}

function renderStats(root, state) {
  renderStatsFieldList(root, state);
}

function renderStatsFieldList(root, state) {
  const target = root.querySelector('[data-role="stats-field-list"]');
  if (!target) return;
  const fields = normalizedStatsDisplayFields(state?.settings?.statsDisplayFields);
  const title = document.createElement('div');
  title.className = 'ehplus-account-field-title';
  title.textContent = t(root, 'statsFieldSelect');
  target.replaceChildren(title, ...statsFieldEntries(root, state?.stats ?? {}).map(([label, value, key, detail]) => {
    const row = document.createElement('label');
    row.className = 'ehplus-account-field';

    const text = document.createElement('span');
    text.textContent = label;

    const current = document.createElement('strong');
    // 命中率等字段带 `hits / reads` 明细时按两行显示（规划 §548）。
    current.textContent = detail ? `${value}\n${detail}` : value;
    if (detail) current.classList.add('ehplus-account-field-multiline');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.statsField = key;
    input.checked = fields[key] !== false;

    row.append(text, current, input);
    return row;
  }));
}

function statsFieldEntries(root, stats) {
  const readerReads = stats.readerReads ?? 0;
  const readerHits = stats.readerHits ?? 0;
  const galleryResourceReads = stats.galleryResourceReads ?? 0;
  return [
    [t(root, 'readerReads'), formatNumber(root, readerReads), 'readerReads'],
    [t(root, 'readerHits'), formatNumber(root, readerHits), 'readerHits'],
    [
      t(root, 'readerHitRate'),
      formatPercent(readerReads ? readerHits / readerReads : 0),
      'readerHitRate',
      `${formatNumber(root, readerHits)} / ${formatNumber(root, readerReads)}`
    ],
    [t(root, 'galleryReads'), formatNumber(root, stats.galleryReads ?? 0), 'galleryReads'],
    [t(root, 'galleryCache'), formatNumber(root, galleryResourceReads), 'galleryCache']
  ];
}

function renderMigration(root, state) {
  const migration = state?.migration ?? {};
  const running = migration.status === 'running' || migration.status === 'cancelling';
  const rows = [
    [t(root, 'state'), migrationStatusText(root, migration.status)],
    [t(root, 'oldDirectory'), browserStorageAddressText(root), 'migration-address'],
    [t(root, 'targetDirectory'), directoryAddressText(root, state), 'migration-address'],
    [t(root, 'oldCacheCount'), `${formatNumber(root, migration.oldCacheCount ?? 0)} ${t(root, 'items')}`],
    [t(root, 'oldCacheSize'), formatBytes(migration.oldCacheBytes ?? 0)],
    [t(root, 'migrated'), `${formatNumber(root, migration.migratedCount ?? 0)} ${t(root, 'items')}`],
    [t(root, 'failed'), `${formatNumber(root, migration.failedCount ?? 0)} ${t(root, 'items')}`],
    [t(root, 'deletedOldCache'), migration.deletedOldCache ? (languageOf(root) === 'en-US' ? 'Yes' : '是') : (languageOf(root) === 'en-US' ? 'No' : '否')],
    [t(root, 'lastRun'), formatDateTime(root, migration.lastRunAt)]
  ];
  // 迁移进行中插入“已迁移 x / y”进度行；x 只计实际迁移条数，
  // 跳过（断点续迁命中）单独列出，完成后保留终值。
  if (running || (migration.totalCount ?? 0) > 0) {
    const progressText = t(root, 'migrationProgressValue', {
      done: formatNumber(root, migration.migratedCount ?? 0),
      total: formatNumber(root, migration.totalCount ?? 0),
      skipped: formatNumber(root, migration.skippedCount ?? 0)
    });
    rows.splice(1, 0, [t(root, 'migrationProgress'), progressText]);
  }
  renderKv(root.querySelector('[data-role="migration-summary"]'), rows);

  const cancelButton = root.querySelector('[data-action="migration-cancel"]');
  if (cancelButton) {
    cancelButton.hidden = !running;
    cancelButton.disabled = migration.status === 'cancelling';
  }
  const startButton = root.querySelector('[data-action="migration-start"]');
  if (startButton) startButton.disabled = running;
  const retryButton = root.querySelector('[data-action="migration-retry"]');
  if (retryButton) retryButton.disabled = running;
  if (running) scheduleMigrationProgressPoll(root);
}

// 迁移进行中每秒拉一次最新状态刷新进度；结束时提示终态并停止轮询。
function scheduleMigrationProgressPoll(root) {
  if (root.__ehplusMigrationPollTimer) return;
  root.__ehplusMigrationPollTimer = setInterval(() => {
    if (!document.documentElement.contains(root)) {
      clearInterval(root.__ehplusMigrationPollTimer);
      root.__ehplusMigrationPollTimer = 0;
      return;
    }
    sendAndRender(root, { type: 'EHPLUS_GET_STATE' })
      .then((response) => {
        const status = response?.state?.migration?.status;
        if (status === 'running' || status === 'cancelling') return;
        clearInterval(root.__ehplusMigrationPollTimer);
        root.__ehplusMigrationPollTimer = 0;
        if (status === 'completed') flashStatus(root, t(root, 'migrationDone'));
        else if (status === 'cancelled') flashStatus(root, t(root, 'migrationCancelled'));
        else if (status === 'failed') flashStatus(root, t(root, 'migrationFailed'));
      })
      .catch(() => {});
  }, 1000);
}

function renderAbout(root, state) {
  const about = state?.about ?? {};
  const currentVersion = about.currentVersion ?? state?.extensionVersion ?? chrome.runtime.getManifest().version;
  const repositoryUrl = githubLinkUrl(about.repositoryUrl);
  renderKv(root.querySelector('[data-role="about-summary"]'), [
    [t(root, 'currentVersion'), currentVersion],
    [t(root, 'githubSource'), repositoryUrl || about.repositoryName || t(root, 'none'), '', repositoryUrl]
  ]);

  const downloadButton = root.querySelector('[data-action="download-update"]');
  const resultNode = root.querySelector('[data-role="update-result"]');
  const result = about.lastUpdateCheck;
  if (downloadButton) {
    downloadButton.hidden = true;
    downloadButton.dataset.url = '';
  }
  if (!resultNode) return;
  if (!result) {
    resultNode.textContent = '';
    return;
  }

  const downloadUrl = githubLinkUrl(result.downloadUrl);
  const lines = [updateResultText(root, result)];
  if (result.latestVersion) {
    lines.push(`${t(root, 'latestVersion')}: ${result.latestVersion}`);
  }
  resultNode.replaceChildren(document.createTextNode(lines.join('\n')));
  if (downloadUrl) {
    resultNode.append(document.createTextNode(`\n${t(root, 'downloadUrl')}: `));
    resultNode.append(createExternalLink(downloadUrl));
  }

  if (result.updateAvailable && downloadUrl && downloadButton) {
    downloadButton.hidden = false;
    downloadButton.dataset.url = downloadUrl;
  }
}

function renderUpdateBadge(root, state) {
  const badge = root.querySelector('[data-action="title-update"]');
  if (!badge) return;
  const result = state?.about?.lastUpdateCheck;
  badge.hidden = !(result?.ok && result.updateAvailable);
  badge.title = result?.latestVersion ? t(root, 'updateAvailable', { version: result.latestVersion }) : t(root, 'updateBadge');
}

function renderColorList(root, state) {
  const target = root.querySelector('[data-role="color-list"]');
  if (!target) return;
  const colors = normalizedCellColors(state?.settings?.cellColors);
  target.replaceChildren(...CELL_COLOR_KEYS.map((key) => {
    const row = document.createElement('div');
    row.className = 'ehplus-color-row';
    row.dataset.colorRow = key;
    row.dataset.pending = 'false';

    const label = document.createElement('span');
    label.className = 'ehplus-color-label';
    const labelText = document.createElement('span');
    labelText.className = 'ehplus-color-label-text';
    labelText.textContent = translateCellState(root, key);
    label.append(labelText);
    const helpKey = {
      prefetch: 'cellPrefetchTip',
      meta: 'cellMetaTip'
    }[key];
    if (helpKey) {
      const help = document.createElement('span');
      help.className = 'ehplus-risk-icon ehplus-help-icon';
      help.dataset.i18nTitle = helpKey;
      help.title = t(root, helpKey);
      help.textContent = '?';
      label.append(help);
    }

    const controls = document.createElement('div');
    controls.className = 'ehplus-color-controls';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ehplus-color-dot';
    button.dataset.colorButton = key;
    button.style.backgroundColor = colors[key];

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.dataset.colorPicker = key;
    picker.value = colors[key];

    const text = document.createElement('input');
    text.type = 'text';
    text.inputMode = 'text';
    text.maxLength = 7;
    text.spellcheck = false;
    text.dataset.colorText = key;
    text.value = colors[key].slice(1);
    text.title = colors[key];

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'ehplus-color-action ehplus-color-confirm';
    confirm.dataset.colorConfirm = key;
    confirm.textContent = t(root, 'confirm');
    confirm.hidden = true;

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ehplus-color-action ehplus-color-cancel';
    cancel.dataset.colorCancel = key;
    cancel.textContent = t(root, 'cancel');
    cancel.hidden = true;

    controls.append(button, picker, text, confirm, cancel);
    row.append(label, controls);
    return row;
  }));
}

function renderPanelColors(root, state) {
  const colors = normalizedCellColors(state?.settings?.cellColors);
  const dot = root.querySelector('[data-role="dot"]');
  if (dot) {
    dot.style.backgroundColor = colors[root.dataset.state] ?? colors.idle;
  }
}

function renderMatrix(root) {
  const depth = Math.max(1, Math.min(64, Number(root.__ehplusState?.settings?.preloadAhead) || 6));
  const colors = normalizedCellColors(root.__ehplusState?.settings?.cellColors);
  const cellsState = matrixStates(root.__ehplusState, depth, location.href);
  const cells = [];
  for (let index = 0; index < Math.min(depth, 24); index += 1) {
    const state = cellsState[index % cellsState.length];
    const cell = document.createElement('span');
    cell.className = 'ehplus-cell';
    cell.dataset.state = state.state;
    cell.style.backgroundColor = colors[cell.dataset.state] ?? DEFAULT_CELL_COLORS[cell.dataset.state];
    cell.title = state.actualPage
      ? t(root, 'cellExactTitle', { page: index + 1, actualPage: state.actualPage, state: translateCellState(root, cell.dataset.state) })
      : t(root, 'cellTitle', { page: index + 1, state: translateCellState(root, cell.dataset.state) });
    cells.push(cell);
  }
  root.querySelector('[data-role="matrix"]').replaceChildren(...cells);
}

function matrixStates(state, depth, pageUrl = location.href) {
  const exactStates = exactReaderMatrixStates(state, depth, pageUrl);
  if (exactStates.length > 0) return exactStates;
  const storage = state?.storage ?? {};
  const imageRecords = Math.max(0, Number(storage.imageRecords) || 0);
  const metadataRecords = Math.max(0, Number(storage.metadataRecords) || 0);
  const queued = Math.max(0, Number(state?.counters?.requestCount ?? state?.counters?.simulatedRequestCount) || 0);
  const states = [];

  pushMatrixStates(states, 'cached', imageRecords);
  pushMatrixStates(states, 'meta', Math.max(0, metadataRecords - imageRecords));
  pushMatrixStates(states, 'queued', queued);

  if (states.length === 0) {
    states.push(matrixCellState(state?.settings?.preloadEnabled === false ? 'paused' : 'idle'));
  }

  while (states.length < Math.min(depth, 24)) {
    states.push(matrixCellState(state?.settings?.preloadEnabled === false ? 'paused' : 'prefetch'));
  }
  return states;
}

function pushMatrixStates(states, state, count) {
  for (let index = 0; index < Math.min(count, 24 - states.length); index += 1) {
    states.push(matrixCellState(state));
  }
}

function exactReaderMatrixStates(state, depth, pageUrl) {
  const current = parseReaderPage(pageUrl);
  const records = Array.isArray(state?.storage?.readerRecords) ? state.storage.readerRecords : [];
  if (!current || records.length === 0) return [];
  const byPage = new Map();
  records.forEach((record) => {
    if (String(record?.gid ?? '') !== current.gid) return;
    const pageNo = Number(record?.pageNo);
    if (!Number.isSafeInteger(pageNo) || pageNo < 1) return;
    byPage.set(pageNo, record);
  });
  if (byPage.size === 0) return [];
  const limit = Math.min(depth, 24);
  const states = [];
  for (let index = 0; index < limit; index += 1) {
    const actualPage = current.pageNo + index;
    const record = byPage.get(actualPage);
    states.push(matrixCellState(record ? (record.hasImage ? 'cached' : 'meta') : 'prefetch', actualPage));
  }
  return states;
}

function matrixCellState(state, actualPage = null) {
  return { state, actualPage };
}

function renderCleanupPreview(root, preview) {
  const lines = [
    cleanupPreviewTitle(root, preview),
    `${t(root, 'images')}: ${formatBytes(preview.images.bytes)}, ${formatNumber(root, preview.images.count)} ${t(root, 'items')}`,
    `${t(root, 'logs')}: ${formatBytes(preview.logs.bytes)}, ${formatNumber(root, preview.logs.count)} ${t(root, 'entries')}`,
    `${t(root, 'other')}: ${formatBytes(preview.other.bytes)}, ${formatNumber(root, preview.other.count)} ${t(root, 'items')}`,
    t(root, 'cleanupRelease', { value: formatBytes(preview.releaseBytes) })
  ];
  if (preview.images.skippedProtected) lines.push(t(root, 'skippedProtected', { count: formatNumber(root, preview.images.skippedProtected) }));
  if (preview.other.skippedProtectedGalleries) lines.push(t(root, 'skippedProtectedGalleries', { count: formatNumber(root, preview.other.skippedProtectedGalleries) }));
  if (preview.warning) lines.push(cleanupWarningText(root));
  root.querySelector('[data-role="cleanup-preview"]').textContent = lines.join('\n');
}

function cleanupPreviewTitle(root, preview) {
  if (preview.request?.mode !== 'olderThanDays' || typeof preview.cutoffAt !== 'number') {
    return t(root, 'cleanupWill');
  }

  return t(root, 'cleanupWillBefore', { time: formatCleanupDateTime(root, preview.cutoffAt) });
}

function formatCleanupDateTime(root, timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const parts = {
    year: date.getFullYear(),
    month: padDatePart(date.getMonth() + 1),
    day: padDatePart(date.getDate()),
    hour: padDatePart(date.getHours()),
    minute: padDatePart(date.getMinutes()),
    second: padDatePart(date.getSeconds())
  };

  if (languageOf(root) === 'en-US') {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}：${parts.minute}：${parts.second}`;
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function renderCleanupResult(root, result) {
  root.querySelector('[data-role="cleanup-result"]').textContent = [
    t(root, 'cleanupDoneTitle'),
    t(root, 'successSkippedFailed', { label: t(root, 'images'), success: formatNumber(root, result.images.success), skipped: formatNumber(root, result.images.skipped), failed: formatNumber(root, result.images.failed) }),
    t(root, 'successFailed', { label: t(root, 'logs'), success: formatNumber(root, result.logs.success), failed: formatNumber(root, result.logs.failed) }),
    t(root, 'successSkippedFailed', { label: t(root, 'other'), success: formatNumber(root, result.other.success), skipped: formatNumber(root, result.other.skipped), failed: formatNumber(root, result.other.failed) }),
    t(root, 'releaseSpace', { value: formatBytes(result.releaseBytes) })
  ].join('\n');
}

function validateCleanup(root) {
  const input = root.querySelector('[data-setting="cleanupDays"]');
  const warning = root.querySelector('[data-role="cleanup-warning"]');
  const confirm = root.querySelector('[data-action="cleanup-confirm"]');
  const preview = root.querySelector('[data-action="cleanup-preview"]');
  const mode = drawerValue(root, 'cleanupMode');
  const raw = input.value;
  const valid = mode === 'all' || (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)));
  input.dataset.invalid = String(!valid);
  if (!valid) {
    warning.textContent = t(root, 'invalidDays');
    // 规划 §8：非法天数时按钮置灰——预估与确认一起置灰，不只挡确认。
    if (confirm) confirm.disabled = true;
    if (preview) preview.disabled = true;
    return false;
  }
  if (mode === 'olderThanDays' && Number(raw) === 0) {
    warning.textContent = cleanupWarningText(root);
  } else {
    warning.textContent = '';
  }
  if (confirm) confirm.disabled = false;
  if (preview) preview.disabled = false;
  return true;
}

function cleanupWarningText(root) {
  return drawerChecked(root, 'cleanupIncludeProtected') || drawerChecked(root, 'cleanupIncludeProtectedGalleries')
    ? t(root, 'zeroDayInclude')
    : t(root, 'zeroDayKeep');
}

function showQuotaConfirm(root, token, cost, accountUpdatedAt = 0) {
  const confirm = root.querySelector('[data-role="quota-confirm"]');
  confirm.hidden = false;
  confirm.dataset.token = token;
  // 记住弹出确认框时的账号状态时间戳；账号状态再次刷新时自动收起。
  confirm.dataset.accountUpdatedAt = String(accountUpdatedAt ?? 0);
  root.querySelector('[data-role="quota-confirm-text"]').textContent = t(root, 'confirmCost', { cost: formatNumber(root, cost) });
  clearTimeout(root.__ehplusQuotaConfirmTimer);
  root.__ehplusQuotaConfirmTimer = setTimeout(() => {
    hideQuotaConfirm(root);
  }, 15000);
  clampPanelPosition(root);
}

function hideQuotaConfirm(root) {
  const confirm = root.querySelector('[data-role="quota-confirm"]');
  if (!confirm) return;
  confirm.hidden = true;
  confirm.dataset.token = '';
  confirm.dataset.accountUpdatedAt = '';
  clearTimeout(root.__ehplusQuotaConfirmTimer);
  clampPanelPosition(root);
}

function updateResultText(root, result) {
  if (!result?.ok) return t(root, 'updateFailed', { message: result?.message ?? 'unknown' });
  if (result.configured === false) return t(root, 'updateNotConfigured');
  if (result.updateAvailable) return t(root, 'updateAvailable', { version: result.latestVersion ?? t(root, 'none') });
  return t(root, 'updateLatest');
}

function applyLanguage(root) {
  const lang = languageOf(root);
  root.__ehplusLanguage = lang;
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(root, node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(root, node.dataset.i18nTitle);
  });
}

function languageOf(root) {
  const value = root?.__ehplusState?.settings?.language
    ?? root?.querySelector?.('[data-setting="language"]')?.value
    ?? root?.__ehplusLanguage
    ?? 'zh-CN';
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

function t(root, key, params = {}) {
  const lang = languageOf(root);
  let text = I18N[lang]?.[key] ?? I18N['zh-CN'][key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

function dawnResultText(root, dawn) {
  if (!dawn?.lastRunAt && (!dawn?.lastEventType || dawn.lastEventType === 'none')) return t(root, 'dawnNotRun');
  if (dawn.lastEventType === 'dawn') {
    const rewardText = formatDawnRewardText(root, dawn.rewards);
    return rewardText ? t(root, 'dawnSuccessWithReward', { reward: rewardText }) : t(root, 'dawnSuccess');
  }
  if (dawn.lastEventType === 'alreadyClaimed' || dawn.lastEventType === 'hvMonster') {
    return t(root, 'dawnCheckedOn', { date: formatDawnResultDate(root, dawn.lastRunAt) });
  }
  return dawn?.lastResult ?? t(root, 'none');
}

function formatDawnRewardText(root, rewards = {}) {
  return [
    rewards.exp ? `EXP +${formatNumber(root, rewards.exp)}` : '',
    rewards.credits ? `Credits +${formatNumber(root, rewards.credits)}` : '',
    rewards.gp ? `GP +${formatNumber(root, rewards.gp)}` : '',
    rewards.hath ? `Hath +${formatNumber(root, rewards.hath)}` : ''
  ].filter(Boolean).join('，');
}

function formatDawnResultDate(root, value) {
  if (!value) return t(root, 'none');
  const date = new Date(value);
  if (languageOf(root) === 'en-US') {
    return new Intl.DateTimeFormat('en-US', {
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric'
  }).format(date);
}

function githubLinkUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return null;
    if (
      parsed.hostname !== 'github.com'
      && parsed.hostname !== 'objects.githubusercontent.com'
      && !parsed.hostname.endsWith('.githubusercontent.com')
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function createExternalLink(url, text = url) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  link.title = url;
  return link;
}

function renderKv(target, pairs) {
  if (!target) return;
  target.replaceChildren(...pairs.map(([key, value, className, linkUrl]) => {
    const row = document.createElement('div');
    const dt = document.createElement('span');
    const dd = linkUrl ? createExternalLink(linkUrl, value) : document.createElement('strong');
    if (className) row.classList.add(`ehplus-kv-${className}`);
    dt.textContent = key;
    if (!linkUrl) dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

function miniPill(label, value, tone) {
  const item = document.createElement('span');
  item.textContent = `${label} ${value}`;
  if (tone) item.classList.add(`ehplus-quota-tone-${tone}`);
  return item;
}

function renderMiniStats(root, state) {
  const pills = [
    ...miniStatsPills(root, state),
    ...miniLogPills(root, state)
  ];
  root.querySelector('[data-role="mini-stats"]').replaceChildren(...pills);
}

function logFieldEntries(root, state) {
  return [
    [t(root, 'currentLogUsage'), formatBytes(state?.storage?.logBytes ?? 0), 'logUsage'],
    [t(root, 'logRows'), `${formatNumber(root, state?.storage?.logCount ?? 0)} ${t(root, 'entries')}`, 'logRows']
  ];
}

function miniLogPills(root, state) {
  const settings = state?.settings ?? {};
  const fields = normalizedLogDisplayFields(settings.logDisplayFields);
  const entries = [
    [t(root, 'currentLogUsage'), formatBytes(state?.storage?.logBytes ?? 0), 'logUsage'],
    [t(root, 'logCount'), `${formatNumber(root, state?.storage?.logCount ?? 0)} ${t(root, 'entries')}`, 'logRows']
  ];
  return entries
    .filter((entry) => fields[entry[2]] !== false)
    .map(([label, value]) => miniPill(label, value));
}

function miniStatsPills(root, state) {
  const settings = state?.settings ?? {};
  const fields = normalizedStatsDisplayFields(settings.statsDisplayFields);
  return statsFieldEntries(root, state?.stats ?? {})
    .filter((entry) => fields[entry[2]] !== false)
    .map(([label, value]) => miniPill(label, value));
}

function translateCellState(root, state) {
  const map = {
    loading: 'cellLoading',
    idle: 'cellIdle',
    prefetch: 'cellPrefetch',
    hit: 'cellHit',
    paused: 'cellPaused',
    error: 'cellError',
    cached: 'cellCached',
    meta: 'cellMeta',
    queued: 'cellQueued',
    miss: 'cellMiss'
  };
  return map[state] ? t(root, map[state]) : state;
}

function normalizedCellColors(value) {
  const colors = { ...DEFAULT_CELL_COLORS };
  for (const key of CELL_COLOR_KEYS) {
    colors[key] = normalizeHexColor(value?.[key], DEFAULT_CELL_COLORS[key]);
  }
  return colors;
}

function normalizedAccountStatusFields(value) {
  const fields = { ...DEFAULT_ACCOUNT_STATUS_FIELDS };
  if (value && typeof value === 'object') {
    for (const key of ACCOUNT_STATUS_FIELD_KEYS) {
      if (typeof value[key] === 'boolean') fields[key] = value[key];
    }
  }
  return fields;
}

function normalizedStatsDisplayFields(value) {
  const fields = { ...DEFAULT_STATS_DISPLAY_FIELDS };
  if (value && typeof value === 'object') {
    for (const key of STATS_DISPLAY_FIELD_KEYS) {
      if (typeof value[key] === 'boolean') fields[key] = value[key];
    }
  }
  return fields;
}

function normalizedLogDisplayFields(value) {
  const fields = { ...DEFAULT_LOG_DISPLAY_FIELDS };
  if (value && typeof value === 'object') {
    for (const key of LOG_DISPLAY_FIELD_KEYS) {
      if (typeof value[key] === 'boolean') fields[key] = value[key];
    }
  }
  return fields;
}

function normalizeHexColor(value, fallback) {
  return parseHexColor(value) ?? fallback;
}

function parseHexColor(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[\da-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map((item) => item + item).join('').toLowerCase()}`;
  }
  if (/^[\da-f]{2}$/i.test(raw)) return `#${raw.repeat(3).toLowerCase()}`;
  return null;
}

function flashStatus(root, text) {
  const status = root.querySelector('[data-role="status"]');
  const previous = status.textContent;
  status.textContent = text;
  root.__ehplusFlashUntil = Date.now() + 1400;
  clearTimeout(root.__ehplusFlashTimer);
  root.__ehplusFlashTimer = setTimeout(() => {
    status.textContent = previous;
  }, 1400);
}

function setDrawerStatus(root, text) {
  const status = root.querySelector('[data-role="settings-status"]');
  if (status) {
    status.textContent = text;
    status.title = text;
    status.scrollLeft = 0;
  }
}

function responseErrorMessage(response) {
  const message = response?.error ?? 'unknown';
  return String(message).replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown';
}

function setSelect(root, key, value) {
  const select = root.querySelector(`[data-setting="${key}"]`);
  if (select) select.value = value;
}

function setValue(root, key, value) {
  const input = root.querySelector(`[data-setting="${key}"]`);
  if (input) input.value = value;
}

function setChecked(root, key, value) {
  const input = root.querySelector(`[data-setting="${key}"]`);
  if (input) input.checked = Boolean(value);
}

function checked(value) {
  return value ? 'checked' : '';
}

function balanceLabel(key) {
  return {
    credits: 'Credits',
    gp: 'GP',
    hath: 'Hath'
  }[key] ?? key;
}

function migrationStatusText(root, status) {
  return {
    idle: t(root, 'idle'),
    running: t(root, 'running'),
    cancelling: t(root, 'migrationCancelling'),
    cancelled: t(root, 'migrationCancelledState'),
    completed: t(root, 'completed'),
    failed: t(root, 'failed')
  }[status] ?? status;
}

function formatNumber(root, value) {
  return new Intl.NumberFormat(languageOf(root)).format(Number(value) || 0);
}

function formatNullableNumber(root, value) {
  return Number.isFinite(value) ? formatNumber(root, value) : '-';
}

function formatPercent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatImageStorageSummary(root, storage = {}) {
  const imageCount = Math.max(0, Number(storage.imageRecords) || 0);
  return `${formatNumber(root, imageCount)} ${t(root, 'imageCountUnit')} / ${formatBytes(storage.imageBytes ?? 0)}`;
}

function formatSigned(root, value) {
  const number = Number(value) || 0;
  return `${number > 0 ? '+' : ''}${formatNumber(root, number)}`;
}

function formatDateTime(root, value) {
  if (!value) return t(root, 'none');
  return new Intl.DateTimeFormat(languageOf(root), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatBytes(bytes) {
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  const tb = gb * 1024;
  const value = Number(bytes) || 0;
  if (value < mb) return `${(value / kb).toFixed(1)} KB`;
  if (value < gb) return `${(value / mb).toFixed(1)} MB`;
  if (value < tb) return `${(value / gb).toFixed(1)} GB`;
  return `${(value / tb).toFixed(1)} TB`;
}

bootstrapEHPlus();

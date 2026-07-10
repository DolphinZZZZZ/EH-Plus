import { buildRequestDetail } from './live-api.js';

export const PRELOAD_DB_NAME = 'ehplus-preload-cache';
export const PRELOAD_STORE_NAME = 'pages';
export const PRELOAD_DB_VERSION = 1;
export const PRELOAD_QUEUE_RECONCILE_MIN_INTERVAL_MS = 1000;
export const PRELOAD_QUEUE_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  SKIPPED: 'skipped',
  ERROR: 'error'
});

export function classifyEhPage(url) {
  const parsed = parseUrl(url);
  if (!parsed || !isEhOrigin(parsed.origin)) return null;

  const reader = parsed.pathname.match(/^\/s\/([^/]+)\/(\d+)-(\d+)\/?$/);
  if (reader) {
    return {
      type: 'reader',
      origin: parsed.origin,
      url: parsed.href,
      token: reader[1],
      gid: reader[2],
      pageNo: Number(reader[3]),
      pageKey: `${reader[2]}:${Number(reader[3])}`
    };
  }

  const gallery = parsed.pathname.match(/^\/g\/(\d+)\/([^/?#]+)\/?$/);
  if (gallery) {
    return {
      type: 'gallery',
      origin: parsed.origin,
      url: parsed.href,
      gid: gallery[1],
      token: gallery[2],
      galleryKey: `${gallery[1]}:${gallery[2]}`
    };
  }

  return null;
}

export function shouldStartPreload(settings = {}, runtime = {}, context = {}) {
  if (settings.preloadEnabled === false) return { ok: false, reason: 'preload-disabled' };
  if (settings.autoPagerEnabled === true && runtime.ownAutoPagerContinuing === true) {
    return { ok: false, reason: 'ehplus-autopager-continuing' };
  }
  if (runtime.currentPagePreloadDisabled === true && runtime.currentPagePreloadDisabledReason !== 'page-image-requests-active') {
    return { ok: false, reason: runtime.currentPagePreloadDisabledReason || 'page-image-requests-active' };
  }
  if (runtime.preloadMode === 'auto-pager-cache-fill-only') {
    return { ok: false, reason: 'auto-pager-cache-fill-only' };
  }
  if (!['reader', 'gallery'].includes(context.type)) return { ok: false, reason: 'unsupported-page' };
  return { ok: true, reason: 'enabled' };
}

export function parseReaderHtml(html, baseUrl) {
  const base = parseUrl(baseUrl);
  const page = classifyEhPage(baseUrl);
  const result = {
    page,
    imageUrl: null,
    imageName: '',
    nextReaderUrl: null,
    prevReaderUrl: null,
    nlToken: null
  };

  result.imageUrl = firstMatch(html, [
    /<img\b[^>]*\bid=["']img["'][^>]*\bsrc=["']([^"']+)["']/i,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\bid=["']img["']/i,
    /\bi3\s*=\s*["'][^"']*<img[^>]+src=["']([^"']+)["']/i,
    /\bi7\s*=\s*["']([^"']+)["']/i
  ], base);

  result.nextReaderUrl = firstMatch(html, [
    /<a\b[^>]*\bid=["']next["'][^>]*\bhref=["']([^"']+)["']/i,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bid=["']next["']/i,
    /\bnexturl\s*=\s*["']([^"']+)["']/i
  ], base);

  result.prevReaderUrl = firstMatch(html, [
    /<a\b[^>]*\bid=["']prev["'][^>]*\bhref=["']([^"']+)["']/i,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bid=["']prev["']/i,
    /\bprevurl\s*=\s*["']([^"']+)["']/i
  ], base);

  result.nlToken = extractReaderNlToken(html);

  const name = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) ?? html.match(/<title[^>]*>([^<]+)<\/title>/i);
  result.imageName = decodeHtml(name?.[1] ?? '');

  return result;
}

export function parseGalleryHtml(html, baseUrl, limit = 6) {
  const base = parseUrl(baseUrl);
  const galleryPage = classifyEhPage(baseUrl);
  const titles = normalizeRecordTitles({
    title: extractElementText(html, 'gn'),
    originalTitle: extractElementText(html, 'gj')
  }, galleryPage?.gid);
  const seen = new Set();
  const links = [];
  const re = /<a\b[^>]*\bhref=["']([^"']*\/s\/[^"']+)["'][^>]*>/gi;
  let match = null;

  while ((match = re.exec(html)) && links.length < limit) {
    const href = normalizeUrl(match[1], base);
    const page = classifyEhPage(href);
    if (!page || page.type !== 'reader' || seen.has(page.pageKey)) continue;
    seen.add(page.pageKey);
    links.push({
      ...page,
      url: href,
      title: titles.title,
      originalTitle: titles.originalTitle
    });
  }

  return {
    gallery: galleryPage ? { ...galleryPage, title: titles.title, originalTitle: titles.originalTitle } : galleryPage,
    readerPages: links
  };
}

export async function openPreloadDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PRELOAD_DB_NAME, PRELOAD_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(PRELOAD_STORE_NAME)
        ? request.transaction.objectStore(PRELOAD_STORE_NAME)
        : db.createObjectStore(PRELOAD_STORE_NAME, { keyPath: 'pageKey' });
      ensureIndex(store, 'resourceKey', 'resourceKey', { unique: false });
      ensureIndex(store, 'galleryKey', 'galleryKey', { unique: false });
      ensureIndex(store, 'updatedAt', 'updatedAt', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getPreloadRecord(db, pageKey) {
  return idbRequest(storeFor(db, 'readonly').get(pageKey));
}

export async function putPreloadRecord(db, record) {
  return idbRequest(storeFor(db, 'readwrite').put(record));
}

export async function listPreloadRecords(db) {
  return idbRequest(storeFor(db, 'readonly').getAll());
}

export function createIndexedDbPreloadStore(db) {
  return {
    kind: 'indexeddb',
    async get(pageKey) {
      return getPreloadRecord(db, pageKey);
    },
    async getByResourceKey(resourceKey) {
      return getPreloadRecordByResourceKey(db, resourceKey);
    },
    async hydrate(record) {
      return hydratePreloadRecord(record);
    },
    async put(record) {
      return putPreloadRecord(db, record);
    },
    async list() {
      return listPreloadRecords(db);
    },
    async deleteMany(records = []) {
      const store = storeFor(db, 'readwrite');
      await Promise.all(records
        .map((record) => record?.pageKey)
        .filter(Boolean)
        .map((pageKey) => idbRequest(store.delete(pageKey))));
    },
    // 按天清理图片只删图片体，保留页面元数据/索引/统计（规划 §8）。
    async stripImages(records = []) {
      for (const record of records) {
        const pageKey = record?.pageKey;
        if (!pageKey) continue;
        const existing = await getPreloadRecord(db, pageKey);
        if (!existing) continue;
        await putPreloadRecord(db, stripImageFromRecord(existing));
      }
    },
    async clear() {
      return idbRequest(storeFor(db, 'readwrite').clear());
    }
  };
}

export function stripImageFromRecord(record, at = Date.now()) {
  return {
    ...record,
    imageBlob: null,
    dataUrl: null,
    imageBytes: 0,
    hasImageBlob: false,
    deliveryKind: null,
    imageStrippedAt: at
  };
}

export async function getPreloadRecordByResourceKey(db, resourceKey) {
  return idbRequest(storeFor(db, 'readonly').index('resourceKey').get(resourceKey));
}

export async function hydratePreloadRecord(record) {
  if (!record || record.dataUrl || !record.imageBlob) return record;

  const image = await recordImageBlob(record);
  if (!image) return record;

  return {
    ...record,
    dataUrl: await blobToDataUrl(image, record.mimeType || image.type),
    imageBytes: image.size,
    hasImageBlob: image.size > 0,
    deliveryKind: 'data-url'
  };
}

async function recordImageBlob(record) {
  const image = record?.imageBlob;
  if (image instanceof Blob) return image;
  if (image instanceof ArrayBuffer || ArrayBuffer.isView(image)) {
    return new Blob([image], { type: record.mimeType || 'application/octet-stream' });
  }
  if (typeof image === 'string') {
    if (image.startsWith('data:')) return dataUrlToBlob(image, record.mimeType);
    return new Blob([image], { type: record.mimeType || 'application/octet-stream' });
  }
  return null;
}

export async function fetchPreloadReader(page, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestDetails = [];
  const { html, parsed, detail } = await fetchReaderDocument(fetchImpl, page, {
    source: options.source ?? 'reader-preload',
    debugTextEnabled: options.debugTextEnabled
  });
  requestDetails.push(detail);
  const imageUrl = parsed.imageUrl;
  let image = null;

  if (imageUrl && options.blobCacheEnabled !== false) {
    const fetched = await fetchReaderImageWithNlRetry(fetchImpl, {
      imageUrl,
      pageUrl: page.url,
      nlToken: parsed.nlToken,
      requestDetails,
      source: options.source ?? 'reader-preload',
      debugTextEnabled: options.debugTextEnabled
    });
    if (fetched.imageUrl) parsed.imageUrl = fetched.imageUrl;
    if (fetched.nlToken) parsed.nlToken = fetched.nlToken;
    image = fetched.image;
    image.dataUrl = await blobToDataUrl(image.blob, image.type);
  }

  const now = options.now?.() ?? Date.now();
  const record = buildPreloadRecord({
    page,
    parsed,
    image,
    html,
    now,
    source: options.source ?? 'reader-preload'
  });
  if (options.debugTextEnabled === true) {
    record.requestDetails = requestDetails;
  }
  return record;
}

async function fetchReaderDocument(fetchImpl, page, options = {}) {
  const { text: html, detail } = await fetchText(fetchImpl, page.url, {
    source: options.source ?? 'reader-preload',
    debugTextEnabled: options.debugTextEnabled
  });
  return {
    html,
    detail,
    parsed: parseReaderHtml(html, page.url)
  };
}

export async function buildExternalImageCacheFillRecord(event, options = {}) {
  const page = externalImageCacheFillPage(event);
  if (!page) throw new Error('external image cache-fill requires gid:pageNo pageKey');
  const imageUrl = normalizeUrl(event?.url ?? event?.imageUrl, parseUrl(page.url));
  if (!imageUrl) throw new Error('external image cache-fill requires an image URL');

  const fetchImpl = options.fetchImpl ?? fetch;
  const image = await fetchBlob(fetchImpl, imageUrl);
  image.dataUrl = await blobToDataUrl(image.blob, image.type);

  return buildPreloadRecord({
    page,
    parsed: {
      imageUrl,
      imageName: event?.imageName ?? ''
    },
    image,
    html: '',
    now: options.now?.() ?? Date.now(),
    source: options.source ?? 'external-image-cache-fill'
  });
}

// 规划 §953：只有 H@H 图片 URL、无法解析 gid:pageNo 时写入临时
// resource-only 缓存；以 url:<资源URL> 作为存储键，不进入永久 gid:pageNo
// 索引，合作缓存仍可按 resourceKey 命中。
export async function buildExternalResourceCacheFillRecord(event, options = {}) {
  const imageUrl = normalizeUrl(event?.url ?? event?.imageUrl, null);
  if (!imageUrl) throw new Error('external resource cache-fill requires an image URL');

  const fetchImpl = options.fetchImpl ?? fetch;
  const image = await fetchBlob(fetchImpl, imageUrl);
  image.dataUrl = await blobToDataUrl(image.blob, image.type);
  const now = options.now?.() ?? Date.now();

  return {
    gid: null,
    pageNo: null,
    pageKey: `url:${imageUrl}`,
    pageUrl: normalizeUrl(event?.pageUrl, null) ?? '',
    galleryKey: null,
    imageUrl,
    resourceKey: imageUrl,
    recordKind: 'resource-only',
    nextReaderUrl: null,
    prevReaderUrl: null,
    imageName: event?.imageName ?? '',
    title: '',
    originalTitle: '',
    imageBlob: image.blob,
    dataUrl: image.dataUrl,
    imageBytes: image.blob?.size ?? 0,
    mimeType: image.type ?? inferMimeType(imageUrl),
    hasImageBlob: Boolean(image.blob),
    htmlBytes: 0,
    storageClass: 'temporary',
    source: options.source ?? 'external-image-cache-fill',
    readCount: 0,
    cacheHitCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccess: now
  };
}

export function createPreloadRequestGateFetch(fetchImpl = fetch, beforeRequest = null) {
  return async (url, init) => {
    if (typeof beforeRequest === 'function') {
      await beforeRequest({ url, init });
    }
    return fetchImpl(url, init);
  };
}

export function buildPreloadRecord({ page, parsed, image, html, now, source }) {
  const imageBytes = image?.blob?.size ?? 0;
  const titles = normalizeRecordTitles({
    title: page.title ?? parsed.title ?? parsed.imageName,
    originalTitle: page.originalTitle ?? parsed.originalTitle
  }, page.gid);
  return {
    gid: page.gid,
    pageNo: page.pageNo,
    pageKey: page.pageKey,
    pageUrl: page.url,
    galleryKey: page.galleryKey ?? null,
    imageUrl: parsed.imageUrl,
    resourceKey: parsed.imageUrl,
    nextReaderUrl: parsed.nextReaderUrl ?? null,
    prevReaderUrl: parsed.prevReaderUrl ?? null,
    imageName: parsed.imageName,
    title: titles.title,
    originalTitle: titles.originalTitle,
    imageBlob: image?.blob ?? null,
    dataUrl: image?.dataUrl ?? null,
    imageBytes,
    mimeType: image?.type ?? inferMimeType(parsed.imageUrl),
    hasImageBlob: Boolean(image?.blob),
    htmlBytes: byteLength(html),
    storageClass: 'permanent',
    source,
    readCount: 0,
    cacheHitCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccess: now
  };
}

function normalizeRecordTitles(values = {}, fallback) {
  const primary = String(values.title ?? '').trim();
  const original = String(values.originalTitle ?? '').trim();
  const fallbackTitle = String(fallback ?? '').trim();
  if (!primary && !original) {
    return {
      title: fallbackTitle,
      originalTitle: fallbackTitle
    };
  }
  return {
    title: primary || original,
    originalTitle: original
  };
}

function extractElementText(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html ?? '').match(new RegExp(`<[^>]+\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'));
  return decodeHtml(stripHtml(match?.[1] ?? ''));
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').trim();
}

function externalImageCacheFillPage(event) {
  const key = String(event?.pageKey ?? '').trim();
  const match = key.match(/^(\d+):(\d+)$/);
  if (!match) return null;

  const pageNo = Number(match[2]);
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) return null;

  const pageUrl = normalizeUrl(event?.pageUrl, null);
  return {
    type: 'reader',
    origin: pageUrl ? parseUrl(pageUrl)?.origin : null,
    url: pageUrl ?? '',
    gid: match[1],
    pageNo,
    pageKey: `${match[1]}:${pageNo}`
  };
}

export async function runPreloadFromContext(context, settings = {}, runtime = {}, options = {}) {
  const decision = shouldStartPreload(settings, runtime, context);
  if (!decision.ok) {
    return { ok: true, skipped: true, reason: decision.reason, queued: 0, completed: 0, failed: 0, records: [] };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const db = options.db ?? (options.store ? null : await openPreloadDb());
  const store = options.store ?? createIndexedDbPreloadStore(db);
  const limit = normalizePositiveInteger(settings.preloadAhead, 6);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const pages = [];
  const requestDetails = [];

  if (context.type === 'reader') {
    const result = await preloadReaderChain(context, {
      store,
      fetchImpl,
      limit,
      settings,
      now: options.now,
      reconcileQueue: options.reconcileQueue,
      onProgress
    });
    return result;
  } else if (context.type === 'gallery') {
    const { text: html, detail } = await fetchText(fetchImpl, context.url, {
      source: 'gallery-preload',
      debugTextEnabled: settings.logDebugEnabled === true
    });
    requestDetails.push(detail);
    pages.push(...parseGalleryHtml(html, context.url, limit).readerPages);
  }

  const records = [];
  let completed = 0;
  let failed = 0;
  // 排队数 = 尚未处理完的候选页（含当前处理中的一页）。
  let remaining = pages.length;
  onProgress?.(remaining);

  for (const page of pages) {
    const existing = await store.get(page.pageKey);
    if (recordHasImageBlob(existing)) {
      remaining -= 1;
      onProgress?.(remaining);
      continue;
    }

    try {
      const record = await fetchPreloadReader(page, {
        fetchImpl,
        blobCacheEnabled: settings.blobCacheEnabled !== false,
        debugTextEnabled: settings.logDebugEnabled === true,
        now: options.now,
        source: context.type === 'gallery' ? 'gallery-preload' : 'reader-preload'
      });
      if (Array.isArray(record.requestDetails)) {
        requestDetails.push(...record.requestDetails);
        delete record.requestDetails;
      }
      await store.put(record);
      records.push(record);
      completed += 1;
    } catch (error) {
      failed += 1;
      if (Array.isArray(error.requestDetails)) {
        requestDetails.push(...error.requestDetails);
      }
      records.push({
        pageKey: page.pageKey,
        pageUrl: page.url,
        error: error?.message ?? String(error),
        status: PRELOAD_QUEUE_STATUSES.ERROR
      });
    }
    remaining -= 1;
    onProgress?.(remaining);
  }

  return {
    ok: true,
    skipped: false,
    reason: 'completed',
    queued: pages.length,
    completed,
    failed,
    records,
    requestDetails
  };
}

export async function preloadReaderChain(context, options = {}) {
  const db = options.db ?? (options.store ? null : await openPreloadDb());
  const store = options.store ?? createIndexedDbPreloadStore(db);
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = normalizePositiveInteger(options.limit, 6);
  const settings = options.settings ?? {};
  const concurrency = normalizePositiveInteger(settings.globalConcurrency, 5);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const requestDetails = [];
  const records = [];
  const seen = new Set([context.pageKey]);
  let completed = 0;
  let failed = 0;
  const queue = [];
  const recordsByOrder = new Map();
  let scheduled = 0;
  // 排队数 = 队列中待处理 + 各 worker 正在处理的候选页。
  let inFlight = 0;
  const reportPending = () => onProgress?.(queue.length + inFlight);

  try {
    const navigation = await resolveReaderNavigation(context, {
      store,
      fetchImpl,
      settings,
      requestDetails
    });
    enqueueReaderCandidate(queue, {
      direction: 'next',
      url: navigation.nextReaderUrl,
      offset: 1,
      seen,
      limit,
      scheduled: () => scheduled,
      onScheduled: () => { scheduled += 1; }
    });
    enqueueReaderCandidate(queue, {
      direction: 'prev',
      url: navigation.prevReaderUrl,
      offset: 1,
      seen,
      limit,
      scheduled: () => scheduled,
      onScheduled: () => { scheduled += 1; }
    });
    reportPending();
  } catch (error) {
    failed += 1;
    if (Array.isArray(error.requestDetails)) {
      requestDetails.push(...error.requestDetails);
    }
    recordsByOrder.set(0, {
      pageKey: context.pageKey,
      pageUrl: context.url,
      error: error?.message ?? String(error),
      status: PRELOAD_QUEUE_STATUSES.ERROR
    });
  }

  // 队列去重/重排（规划 §953）：默认保持双向交错入队顺序作为兜底；
  // reconcileQueue 由调用方注入（页面观测去重、降级、会话过期清空），
  // 任何失败或缺数据都原样保留队列，绝不因调度信息缺失而卡住预加载。
  let lastReconcileAt = 0;
  async function maybeReconcileQueue() {
    if (typeof options.reconcileQueue !== 'function') return;
    if (queue.length === 0) return;
    const now = Date.now();
    if (now - lastReconcileAt < PRELOAD_QUEUE_RECONCILE_MIN_INTERVAL_MS) return;
    lastReconcileAt = now;
    try {
      const next = await options.reconcileQueue(queue.slice());
      if (Array.isArray(next)) {
        queue.length = 0;
        queue.push(...next);
      }
    } catch {
      // 兜底：保持原队列顺序。
    }
  }

  async function runWorker() {
    while (queue.length > 0) {
      await maybeReconcileQueue();
      const candidate = queue.shift();
      if (!candidate) break;
      inFlight += 1;
      try {
        const result = await preloadReaderCandidate(candidate, {
          store,
          fetchImpl,
          settings,
          requestDetails,
          now: options.now,
          // 页面已加载该页时不再抓图片（去重），但仍解析续接链接保持链式发现。
          skipImageFetch: candidate.externalSkipImage === true
        });
        if (result.record) {
          recordsByOrder.set(candidate.order, result.record);
        }
        if (result.completed) {
          completed += 1;
        }
        enqueueReaderCandidate(queue, {
          direction: candidate.direction,
          url: result.continuationUrl,
          offset: candidate.offset + 1,
          seen,
          limit,
          scheduled: () => scheduled,
          onScheduled: () => { scheduled += 1; }
        });
      } catch (error) {
        failed += 1;
        if (Array.isArray(error.requestDetails)) {
          requestDetails.push(...error.requestDetails);
        }
        recordsByOrder.set(candidate.order, {
          pageKey: candidate.page.pageKey,
          pageUrl: candidate.page.url,
          error: error?.message ?? String(error),
          status: PRELOAD_QUEUE_STATUSES.ERROR
        });
      } finally {
        inFlight -= 1;
        reportPending();
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, limit));
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  records.push(...[...recordsByOrder.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, record]) => record));

  return {
    ok: true,
    skipped: false,
    reason: 'completed',
    queued: scheduled,
    completed,
    failed,
    records,
    requestDetails
  };
}

async function preloadReaderCandidate(candidate, { store, fetchImpl, settings, requestDetails, now, skipImageFetch = false }) {
  const existing = await store.get(candidate.page.pageKey);
  const linkField = readerDirectionLinkField(candidate.direction);
  if (recordHasImageBlob(existing)) {
    const navigation = existing[linkField] === undefined
      ? await resolveReaderNavigation({ ...candidate.page, url: existing.pageUrl ?? candidate.page.url }, {
        store,
        fetchImpl,
        settings,
        requestDetails
      })
      : null;
    return {
      record: existing,
      completed: false,
      continuationUrl: existing[linkField] ?? navigation?.[linkField] ?? null
    };
  }

  // 页面正在展示该页图片时只解析续接链接（外部补存随后落库），不重复抓图。
  if (skipImageFetch) {
    const navigation = await resolveReaderNavigation(candidate.page, {
      store,
      fetchImpl,
      settings,
      requestDetails
    });
    return {
      record: null,
      completed: false,
      continuationUrl: navigation?.[linkField] ?? null
    };
  }

  const record = await fetchPreloadReader(candidate.page, {
    fetchImpl,
    blobCacheEnabled: settings.blobCacheEnabled !== false,
    debugTextEnabled: settings.logDebugEnabled === true,
    now,
    source: 'reader-preload'
  });
  if (Array.isArray(record.requestDetails)) {
    requestDetails.push(...record.requestDetails);
    delete record.requestDetails;
  }
  await store.put(record);
  return {
    record,
    completed: true,
    continuationUrl: record[linkField] ?? null
  };
}

async function resolveReaderNavigation(page, { store, fetchImpl, settings, requestDetails }) {
  const existing = await store.get(page.pageKey);
  if (existing && existing.nextReaderUrl !== undefined && existing.prevReaderUrl !== undefined) {
    return {
      nextReaderUrl: existing.nextReaderUrl ?? null,
      prevReaderUrl: existing.prevReaderUrl ?? null
    };
  }

  let html = '';
  let parsed = null;
  let detail = null;
  try {
    const fetched = await fetchReaderDocument(fetchImpl, page, {
      source: 'reader-nextlink',
      debugTextEnabled: settings.logDebugEnabled === true
    });
    html = fetched.html;
    parsed = fetched.parsed;
    detail = fetched.detail;
  } catch (error) {
    if (existing && (existing.nextReaderUrl || existing.prevReaderUrl)) {
      return {
        nextReaderUrl: existing.nextReaderUrl ?? null,
        prevReaderUrl: existing.prevReaderUrl ?? null
      };
    }
    throw error;
  }
  requestDetails.push(detail);

  const record = buildPreloadRecord({
    page,
    parsed,
    image: null,
    html,
    now: Date.now(),
    source: 'reader-nextlink'
  });
  const currentExisting = existing ?? {};
  const nextReaderUrl = parsed.nextReaderUrl ?? currentExisting.nextReaderUrl ?? null;
  const prevReaderUrl = parsed.prevReaderUrl ?? currentExisting.prevReaderUrl ?? null;
  await store.put({
    ...record,
    ...currentExisting,
    nextReaderUrl,
    prevReaderUrl,
    updatedAt: Date.now()
  });

  return {
    nextReaderUrl,
    prevReaderUrl
  };
}

function enqueueReaderCandidate(queue, { direction, url, offset, seen, limit, scheduled, onScheduled }) {
  if (scheduled() >= limit) return false;
  const page = classifyEhPage(url);
  if (!page || page.type !== 'reader' || seen.has(page.pageKey)) return false;
  seen.add(page.pageKey);
  onScheduled();
  queue.push({
    direction,
    offset,
    order: readerCandidateOrder(direction, offset),
    page
  });
  return true;
}

function readerCandidateOrder(direction, offset) {
  return (offset - 1) * 2 + (direction === 'prev' ? 1 : 0);
}

function readerDirectionLinkField(direction) {
  return direction === 'prev' ? 'prevReaderUrl' : 'nextReaderUrl';
}

export function summarizePreloadRecords(records = []) {
  let imageBytes = 0;
  let imageRecords = 0;
  let metadataRecords = 0;
  const cooperativeRecords = [];
  const readerRecords = [];

  for (const record of records) {
    // 浏览历史记录不计入缓存统计，也不进入合作缓存索引（规划 §556）。
    if (record?.recordKind === 'history') continue;
    metadataRecords += 1;
    const hasImage = recordHasImageBlob(record);
    if (hasImage) imageRecords += 1;
    imageBytes += recordImageBytes(record);
    cooperativeRecords.push(toCooperativeRecord(record));
    const readerRecord = toReaderSummaryRecord(record, hasImage);
    if (readerRecord) readerRecords.push(readerRecord);
  }

  return {
    imageBytes,
    imageRecords,
    metadataRecords,
    cacheRecords: metadataRecords,
    cooperativeRecords,
    readerRecords
  };
}

function toReaderSummaryRecord(record, hasImage) {
  const parsed = parseReaderRecordKey(record);
  if (!parsed) return null;
  return {
    gid: parsed.gid,
    pageNo: parsed.pageNo,
    pageKey: parsed.pageKey,
    hasImage
  };
}

function parseReaderRecordKey(record) {
  const keyMatch = String(record?.pageKey ?? '').match(/^(\d+):(\d+)$/);
  if (keyMatch) {
    const pageNo = Number(keyMatch[2]);
    if (Number.isSafeInteger(pageNo) && pageNo >= 1) {
      return { gid: keyMatch[1], pageNo, pageKey: `${keyMatch[1]}:${pageNo}` };
    }
  }
  const page = classifyEhPage(record?.pageUrl);
  return page?.type === 'reader' ? page : null;
}

export function toCooperativeRecord(record) {
  return {
    ...record,
    dataUrl: record.dataUrl ?? null,
    deliveryKind: record.dataUrl ? 'data-url' : record.deliveryKind
  };
}

function recordHasImageBlob(record) {
  // 规划 §968：图片体包含 imageBlob / dataUrl / 有效 imageBytes / 目录图片文件；
  // 目录模式下元数据缺失时靠 directoryImageFile 判定，避免重复抓取已落盘图片。
  return recordImageBytes(record) > 0
    || record?.hasImageBlob === true
    || Boolean(record?.directoryImageFile)
    || (typeof record?.dataUrl === 'string' && record.dataUrl.length > 0);
}

function recordImageBytes(record) {
  const declaredBytes = Number(record?.imageBytes);
  if (Number.isFinite(declaredBytes) && declaredBytes > 0) return declaredBytes;

  const blob = record?.imageBlob;
  if (!blob) return 0;
  if (Number.isFinite(Number(blob.size)) && Number(blob.size) > 0) return Number(blob.size);
  if (Number.isFinite(Number(blob.byteLength)) && Number(blob.byteLength) > 0) return Number(blob.byteLength);
  if (typeof blob === 'string') return byteLength(blob);

  return 0;
}

async function fetchText(fetchImpl, url, options = {}) {
  const startedAt = Date.now();
  let response = null;
  let text = '';
  try {
    response = await fetchImpl(url, { credentials: 'include', cache: 'force-cache' });
    text = await response.text();
  } catch (error) {
    error.requestDetails = [buildRequestDetail({
      source: options.source,
      url,
      method: 'GET',
      startedAt,
      response,
      text,
      error,
      debugTextEnabled: options.debugTextEnabled
    })];
    throw error;
  }
  const detail = buildRequestDetail({
    source: options.source,
    url,
    method: 'GET',
    startedAt,
    response,
    text,
    debugTextEnabled: options.debugTextEnabled
  });
  if (!response?.ok) {
    const error = new Error(`HTTP ${response?.status ?? 'error'} for ${url}`);
    error.requestDetails = [detail];
    throw error;
  }
  return { text, detail };
}

async function fetchBlob(fetchImpl, url) {
  const response = await fetchImpl(url, { credentials: 'include', cache: 'force-cache' });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'error'} for ${url}`);
  const blob = await response.blob();
  return {
    blob,
    type: blob.type || response.headers?.get?.('content-type') || inferMimeType(url),
    bytes: blob.size
  };
}

async function fetchReaderImageWithNlRetry(fetchImpl, options) {
  const initialError = await fetchBlob(fetchImpl, options.imageUrl)
    .then((image) => ({ image }))
    .catch((error) => ({ error }));
  if (initialError.image) {
    return {
      image: initialError.image,
      imageUrl: options.imageUrl,
      nlToken: options.nlToken ?? null
    };
  }

  const fallbackError = initialError.error;
  const retried = await retryReaderImageWithNl(fetchImpl, options, fallbackError);
  if (retried?.image) return retried;
  throw fallbackError;
}

async function retryReaderImageWithNl(fetchImpl, options, fallbackError) {
  let token = options.nlToken;
  let pageUrl = options.pageUrl;
  const tried = new Set();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!token || !isReaderPageUrl(pageUrl)) return null;
    const retryUrl = addSearchParamToUrl(pageUrl, 'nl', token);
    if (tried.has(retryUrl)) return null;
    tried.add(retryUrl);

    let retryDoc = null;
    try {
      retryDoc = await fetchText(fetchImpl, retryUrl, {
        source: `${options.source ?? 'reader-preload'}-nl-retry`,
        debugTextEnabled: options.debugTextEnabled
      });
      options.requestDetails?.push(retryDoc.detail);
    } catch (error) {
      attachCauseRequestDetails(fallbackError, error);
      return null;
    }

    const parsed = parseReaderHtml(retryDoc.text, retryUrl);
    if (!parsed.imageUrl && !parsed.nlToken) return null;

    if (parsed.imageUrl) {
      try {
        const image = await fetchBlob(fetchImpl, parsed.imageUrl);
        return {
          image,
          imageUrl: parsed.imageUrl,
          nlToken: parsed.nlToken ?? token
        };
      } catch (error) {
        fallbackError = error;
      }
    }

    if (!parsed.nlToken || parsed.nlToken === token) return null;
    token = parsed.nlToken;
    pageUrl = retryUrl;
  }

  return null;
}

function attachCauseRequestDetails(targetError, causeError) {
  if (!targetError || !Array.isArray(causeError?.requestDetails)) return;
  targetError.requestDetails = [
    ...(Array.isArray(targetError.requestDetails) ? targetError.requestDetails : []),
    ...causeError.requestDetails
  ];
}

function addSearchParamToUrl(url, name, value) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  parsed.searchParams.set(name, value);
  return parsed.href;
}

function isReaderPageUrl(url) {
  return classifyEhPage(url)?.type === 'reader';
}

function firstMatch(html, patterns, base) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const url = normalizeUrl(match?.[1], base);
    if (url) return url;
  }
  return null;
}

function extractExhentaiNlToken(value) {
  const match = String(value ?? '').match(/nl\(['"]([^'"]+)['"]\)/);
  return match?.[1] ?? null;
}

function extractReaderNlToken(html) {
  const loadfail = html.match(/<[^>]*\bid=["']loadfail["'][^>]*>/i)?.[0];
  const img = html.match(/<img\b[^>]*\bid=["']img["'][^>]*>/i)?.[0]
    ?? html.match(/<img\b[^>]*\bonerror\s*=[^>]*>/i)?.[0];
  return extractExhentaiNlToken(decodeHtml(loadfail)) || extractExhentaiNlToken(decodeHtml(img));
}

function normalizeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(decodeHtml(value.trim()), base?.href).href;
  } catch {
    return null;
  }
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isEhOrigin(origin) {
  return origin === 'https://e-hentai.org' || origin === 'https://exhentai.org';
}

function ensureIndex(store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function storeFor(db, mode) {
  return db.transaction(PRELOAD_STORE_NAME, mode).objectStore(PRELOAD_STORE_NAME);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function byteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function inferMimeType(url) {
  const path = parseUrl(url)?.pathname ?? '';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  return 'application/octet-stream';
}

async function blobToDataUrl(blob, mimeType) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${mimeType || blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function dataUrlToBlob(value, fallbackMimeType) {
  const match = String(value ?? '').match(/^data:([^,;]+)?(?:;base64)?,(.+)$/i);
  if (!match) return new Blob([String(value ?? '')], { type: fallbackMimeType || 'application/octet-stream' });
  const mimeType = match[1] || fallbackMimeType || 'application/octet-stream';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

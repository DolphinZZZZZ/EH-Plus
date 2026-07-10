export const COOPERATIVE_CACHE_QUERY_TYPE = 'EHPLUS_COOPERATIVE_CACHE_QUERY';
export const COOPERATIVE_CACHE_RESPONSE_TYPE = 'EHPLUS_COOPERATIVE_CACHE_RESPONSE';
export const COOPERATIVE_API_VERSION = 1;

export const COOPERATIVE_RESPONSE_MODES = Object.freeze({
  URL: 'url',
  METADATA: 'metadata'
});

export const COOPERATIVE_STORAGE_CLASSES = Object.freeze({
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary'
});

export const COOPERATIVE_CACHE_TYPES = Object.freeze({
  READER: 'reader',
  GALLERY: 'gallery',
  RESOURCE: 'resource'
});

export function isCooperativeCacheQuery(message) {
  return message?.type === COOPERATIVE_CACHE_QUERY_TYPE;
}

export function normalizePageKey(pageKey) {
  if (typeof pageKey !== 'string' && typeof pageKey !== 'number') return null;
  const value = String(pageKey).trim();
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) return null;

  const pageNo = Number(match[2]);
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) return null;
  return `${match[1]}:${pageNo}`;
}

export function normalizeResourceUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  try {
    const parsed = new URL(url, globalThis.location?.href);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function parseReaderPageKey(url) {
  const normalized = normalizeResourceUrl(url);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
    if (!match) return null;
    return normalizePageKey(`${match[1]}:${match[2]}`);
  } catch {
    return null;
  }
}

export function normalizeGalleryKey(galleryKey) {
  if (typeof galleryKey !== 'string' && typeof galleryKey !== 'number') return null;
  const value = String(galleryKey).trim();
  const match = value.match(/^(\d+):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

export function parseGalleryKey(url) {
  const normalized = normalizeResourceUrl(url);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/g\/(\d+)\/([^/?#]+)\/?$/);
    if (!match) return null;
    return normalizeGalleryKey(`${match[1]}:${match[2]}`);
  } catch {
    return null;
  }
}

export function resolveCooperativePageKey(message) {
  const explicit = normalizePageKey(message?.pageKey);
  if (explicit) return explicit;

  const gid = String(message?.gid ?? '').trim();
  const pageNo = Number(message?.pageNo);
  if (/^\d+$/.test(gid) && Number.isSafeInteger(pageNo) && pageNo >= 1) {
    return `${gid}:${pageNo}`;
  }

  return parseReaderPageKey(message?.pageUrl)
    ?? parseReaderPageKey(message?.readerUrl)
    ?? parseReaderPageKey(message?.url);
}

export function resolveCooperativeGalleryKey(message) {
  const explicit = normalizeGalleryKey(message?.galleryKey);
  if (explicit) return explicit;

  const gid = String(message?.gid ?? '').trim();
  const token = String(message?.token ?? message?.galleryToken ?? '').trim();
  if (/^\d+$/.test(gid) && /^[A-Za-z0-9_-]+$/.test(token)) {
    return `${gid}:${token}`;
  }

  return parseGalleryKey(message?.galleryUrl)
    ?? parseGalleryKey(message?.url);
}

export function normalizeCooperativeCacheQuery(message) {
  if (!isCooperativeCacheQuery(message)) {
    return { ok: false, reason: 'unsupported-message-type' };
  }

  const pageKey = resolveCooperativePageKey(message);
  const galleryKey = resolveCooperativeGalleryKey(message);
  const url = parseReaderPageKey(message?.url) || parseGalleryKey(message?.url) ? null : message?.url;
  const resourceKey = normalizeResourceUrl(message?.imageUrl ?? message?.resourceUrl ?? url);
  const responseMode = Object.values(COOPERATIVE_RESPONSE_MODES).includes(message?.responseMode)
    ? message.responseMode
    : COOPERATIVE_RESPONSE_MODES.URL;

  if (!pageKey && !galleryKey && !resourceKey) {
    return { ok: false, reason: 'missing-cache-key' };
  }

  return {
    ok: true,
    version: COOPERATIVE_API_VERSION,
    cacheType: resolveCacheType({ pageKey, galleryKey, resourceKey }),
    pageKey,
    galleryKey,
    resourceKey,
    responseMode,
    requestedBy: typeof message.requestedBy === 'string' ? message.requestedBy.slice(0, 80) : ''
  };
}

export function buildCooperativeCacheResponse(records, message, options = {}) {
  if (options.enabled === false) {
    return missResponse('disabled');
  }

  const query = normalizeCooperativeCacheQuery(message);
  if (!query.ok) {
    return missResponse(query.reason);
  }

  const hit = findCooperativeCacheHit(records, query);
  return buildCooperativeCacheResponseFromHit(hit, query, options);
}

export function buildCooperativeCacheResponseFromHit(hit, queryOrMessage, options = {}) {
  if (options.enabled === false) {
    return missResponse('disabled');
  }

  const query = queryOrMessage?.ok === true
    ? queryOrMessage
    : normalizeCooperativeCacheQuery(queryOrMessage);
  if (!query.ok) {
    return missResponse(query.reason);
  }

  if (!hit) {
    return missResponse('not-found', query);
  }

  const delivery = buildDelivery(hit, query.responseMode);
  if (query.responseMode === COOPERATIVE_RESPONSE_MODES.URL && !delivery.url) {
    return missResponse('not-deliverable', query);
  }

  const pageKey = normalizePageKey(hit.pageKey) ?? query.pageKey;
  const galleryKey = normalizeGalleryKey(hit.galleryKey) ?? query.galleryKey;
  const [readerGid, pageNoText] = pageKey ? pageKey.split(':') : [hit.gid ?? null, hit.pageNo ?? null];
  const [galleryGid, galleryToken] = galleryKey ? galleryKey.split(':') : [hit.gid ?? null, hit.token ?? null];
  const cacheType = resolveCacheType({ pageKey, galleryKey, resourceKey: query.resourceKey });
  const gid = cacheType === COOPERATIVE_CACHE_TYPES.GALLERY ? galleryGid : readerGid;
  const imageUrl = normalizeResourceUrl(hit.imageUrl ?? hit.resourceKey);
  const galleryUrl = normalizeResourceUrl(hit.galleryUrl);
  const title = cacheRecordTitle(hit, gid);
  const originalTitle = normalizedText(hit.originalTitle);

  return {
    ok: true,
    type: COOPERATIVE_CACHE_RESPONSE_TYPE,
    version: COOPERATIVE_API_VERSION,
    source: 'EH＋',
    hit: true,
    reason: 'hit',
    cacheType,
    pageKey,
    galleryKey,
    gid: gid ? String(gid) : null,
    token: galleryToken ? String(galleryToken) : null,
    pageNo: Number.isSafeInteger(Number(pageNoText)) ? Number(pageNoText) : null,
    title,
    originalTitle,
    galleryUrl,
    imageUrl,
    resourceKey: normalizeResourceUrl(hit.resourceKey ?? imageUrl),
    storageClass: hit.storageClass ?? (cacheType === COOPERATIVE_CACHE_TYPES.RESOURCE ? COOPERATIVE_STORAGE_CLASSES.TEMPORARY : COOPERATIVE_STORAGE_CLASSES.PERMANENT),
    mimeType: hit.mimeType ?? inferMimeType(imageUrl),
    bytes: Number.isFinite(Number(hit.imageBytes ?? hit.galleryBytes ?? hit.bytes)) ? Number(hit.imageBytes ?? hit.galleryBytes ?? hit.bytes) : null,
    responseMode: query.responseMode,
    delivery,
    requestedBy: query.requestedBy,
    countsAsCacheHit: true,
    statsDelta: statsDeltaForCacheType(cacheType),
    simulated: Boolean(hit.simulated)
  };
}

function cacheRecordTitle(record, fallback) {
  const title = normalizedText(record?.title);
  if (title) return title;
  return normalizedText(record?.originalTitle)
    || normalizedText(record?.titleJpn)
    || normalizedText(record?.imageName)
    || String(fallback ?? '').trim();
}

function normalizedText(value) {
  return String(value ?? '').trim();
}

export function findCooperativeCacheHit(allRecords, query) {
  if (!Array.isArray(allRecords)) return null;

  // 浏览历史记录不参与缓存命中（规划 §10：历史不缓存图片、不计入命中率）。
  const records = allRecords.filter((record) => record?.recordKind !== 'history');

  const resolvePointer = (record) => resolveCanonicalRecord(records, record, query);
  const candidates = [];
  const addCandidate = (record) => {
    if (!record) return;
    const resolved = resolvePointer(record);
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  };

  if (query.pageKey) {
    const byPageKey = records.find((record) => normalizePageKey(record?.pageKey) === query.pageKey);
    addCandidate(byPageKey);
    const byPageAlias = records.find((record) => stringList(record?.pageKeyAliases).includes(query.pageKey));
    addCandidate(byPageAlias);
  }

  if (query.galleryKey) {
    const byGalleryKey = records.find((record) => {
      const keys = [
        record?.galleryKey,
        record?.galleryUrl,
        record?.url
      ].map((value) => normalizeGalleryKey(value) ?? parseGalleryKey(value));
      return keys.includes(query.galleryKey);
    });
    addCandidate(byGalleryKey);
  }

  if (query.resourceKey) {
    const byResourceKey = records.find((record) => {
      const keys = [
        record?.resourceKey,
        record?.imageUrl,
        record?.url,
        ...stringList(record?.resourceKeyAliases),
        ...stringList(record?.imageUrlAliases),
        ...stringList(record?.urlAliases)
      ].map(normalizeResourceUrl);
      return keys.includes(query.resourceKey);
    });
    addCandidate(byResourceKey);
  }

  if (query.responseMode === COOPERATIVE_RESPONSE_MODES.URL) {
    return candidates.find((record) => Boolean(buildDelivery(record, query.responseMode).url))
      ?? candidates.find(recordCanDeliver)
      ?? candidates[0]
      ?? null;
  }

  return candidates[0] ?? null;
}

export function recordCanDeliver(record) {
  if (!record) return false;
  if (Boolean(buildDelivery(record, COOPERATIVE_RESPONSE_MODES.URL).url)) return true;

  const bytes = Number(record.imageBytes ?? record.galleryBytes ?? record.bytes);
  const hasStoredBytes = Number.isFinite(bytes) && bytes > 0;
  if (typeof record.directoryImageFile === 'string' && record.directoryImageFile.trim()) {
    return record.hasImageBlob === true || hasStoredBytes;
  }

  const blob = record.imageBlob;
  if (blob instanceof Blob) return blob.size > 0;
  if (blob instanceof ArrayBuffer) return blob.byteLength > 0;
  if (ArrayBuffer.isView(blob)) return blob.byteLength > 0;

  return false;
}

function resolveCanonicalRecord(records, record, query = {}, seen = new Set()) {
  if (!record?.canonicalPageKey) return record;
  const key = normalizePageKey(record.canonicalPageKey);
  if (!key || seen.has(key)) return record;
  seen.add(key);
  const canonical = records.find((item) => normalizePageKey(item?.pageKey) === key);
  if (!canonical) return record;
  const resolved = resolveCanonicalRecord(records, canonical, query, seen);
  return {
    ...resolved,
    pageKey: normalizePageKey(record.pageKey) ?? query.pageKey ?? resolved.pageKey,
    gid: record.gid ?? query.pageKey?.split(':')[0] ?? resolved.gid,
    pageNo: record.pageNo ?? Number(query.pageKey?.split(':')[1]) ?? resolved.pageNo,
    pageUrl: record.pageUrl ?? resolved.pageUrl,
    galleryKey: record.galleryKey ?? resolved.galleryKey,
    resourceKey: normalizeResourceUrl(record.resourceKey ?? record.imageUrl) ?? resolved.resourceKey,
    imageUrl: normalizeResourceUrl(record.imageUrl ?? record.resourceKey) ?? resolved.imageUrl,
    canonicalPageKey: resolved.pageKey
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

// 读取尝试（命中与否）都计入访问：外部 API 调用、读取本地缓存、
// 未命中后回退请求外链，对同一次访问只计一次读取。
export function applyCooperativeStatsDelta(stats, response) {
  const cacheType = response?.cacheType ?? null;
  if (!cacheType) return stats;

  const hit = response?.hit === true && response.countsAsCacheHit === true;
  const delta = hit
    ? (response.statsDelta ?? statsDeltaForCacheType(cacheType))
    : missStatsDeltaForCacheType(cacheType);

  return {
    ...stats,
    readerReads: (stats?.readerReads ?? 0) + (delta.readerReads ?? 0),
    readerHits: (stats?.readerHits ?? 0) + (delta.readerHits ?? 0),
    galleryReads: (stats?.galleryReads ?? 0) + (delta.galleryReads ?? 0),
    galleryResourceReads: (stats?.galleryResourceReads ?? 0) + (delta.galleryResourceReads ?? 0)
  };
}

function missResponse(reason, query = null) {
  return {
    ok: true,
    type: COOPERATIVE_CACHE_RESPONSE_TYPE,
    version: COOPERATIVE_API_VERSION,
    source: 'EH＋',
    hit: false,
    reason,
    cacheType: query?.cacheType ?? null,
    pageKey: query?.pageKey ?? null,
    galleryKey: query?.galleryKey ?? null,
    resourceKey: query?.resourceKey ?? null,
    countsAsCacheHit: false,
    statsDelta: {
      readerReads: 0,
      readerHits: 0,
      galleryReads: 0,
      galleryResourceReads: 0
    }
  };
}

function buildDelivery(record, responseMode) {
  if (responseMode === COOPERATIVE_RESPONSE_MODES.METADATA) {
    return { kind: 'metadata' };
  }

  const url = record.blobUrl ?? record.dataUrl ?? record.cacheUrl ?? record.deliveryUrl ?? null;
  return {
    kind: record.deliveryKind ?? inferDeliveryKind(url),
    url
  };
}

function inferDeliveryKind(url) {
  if (typeof url !== 'string') return 'none';
  if (url.startsWith('blob:')) return 'blob-url';
  if (url.startsWith('data:')) return 'data-url';
  if (url.startsWith('chrome-extension:')) return 'extension-url';
  return 'url';
}

function resolveCacheType({ pageKey, galleryKey, resourceKey }) {
  if (pageKey) return COOPERATIVE_CACHE_TYPES.READER;
  if (galleryKey) return COOPERATIVE_CACHE_TYPES.GALLERY;
  if (resourceKey) return COOPERATIVE_CACHE_TYPES.RESOURCE;
  return null;
}

function statsDeltaForCacheType(cacheType) {
  if (cacheType === COOPERATIVE_CACHE_TYPES.GALLERY) {
    // 画廊访问（galleryReads）由真实页面会话计数，元数据命中只计资源缓存读取。
    return {
      readerReads: 0,
      readerHits: 0,
      galleryReads: 0,
      galleryResourceReads: 1
    };
  }

  if (cacheType === COOPERATIVE_CACHE_TYPES.RESOURCE) {
    // 纯资源 URL 命中（如 /g/ 缩略图）不得计入 /s/ 阅读统计（规划 §10/§941）。
    return {
      readerReads: 0,
      readerHits: 0,
      galleryReads: 0,
      galleryResourceReads: 1
    };
  }

  return {
    readerReads: 1,
    readerHits: 1,
    galleryReads: 0,
    galleryResourceReads: 0
  };
}

// 未命中：/s/ 查询仍计一次图片访问（随后回退到外链请求属于同一次访问）；
// 画廊/资源查询未命中不产生缓存读取计数。
function missStatsDeltaForCacheType(cacheType) {
  if (cacheType === COOPERATIVE_CACHE_TYPES.READER) {
    return {
      readerReads: 1,
      readerHits: 0,
      galleryReads: 0,
      galleryResourceReads: 0
    };
  }
  return {
    readerReads: 0,
    readerHits: 0,
    galleryReads: 0,
    galleryResourceReads: 0
  };
}

function inferMimeType(url) {
  const value = String(url ?? '').split('?')[0].toLowerCase();
  if (value.endsWith('.png')) return 'image/png';
  if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg';
  if (value.endsWith('.gif')) return 'image/gif';
  if (value.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

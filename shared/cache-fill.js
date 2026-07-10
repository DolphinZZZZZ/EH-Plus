const DEFAULT_CACHE_FILL_TTL_MS = 120000;

export const CACHE_STORAGE_CLASSES = Object.freeze({
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary'
});

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

export function normalizePageKey(pageKey) {
  if (typeof pageKey !== 'string' && typeof pageKey !== 'number') return null;
  const value = String(pageKey).trim();
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const pageNo = Number(match[2]);
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) return null;
  return `${match[1]}:${pageNo}`;
}

export function resolvePageKey(event) {
  const explicit = normalizePageKey(event?.pageKey);
  if (explicit) return explicit;

  const gid = String(event?.gid ?? '').trim();
  const pageNo = Number(event?.pageNo);
  if (!/^\d+$/.test(gid) || !Number.isSafeInteger(pageNo) || pageNo < 1) {
    return null;
  }

  return `${gid}:${pageNo}`;
}

export function createExternalImageCacheFillState({
  ttlMs = DEFAULT_CACHE_FILL_TTL_MS,
  now = () => Date.now()
} = {}) {
  return {
    ttlMs,
    now,
    ownRequests: new Map(),
    pending: new Map(),
    cached: new Set()
  };
}

export function markOwnResourceRequest(state, url, at = state.now()) {
  const key = normalizeResourceUrl(url);
  if (!key) return null;
  state.ownRequests.set(key, at);
  pruneExternalImageCacheFillState(state, at);
  return key;
}

export function markCachedResource(state, url, at = state.now()) {
  const event = typeof url === 'string' ? { pageKey: url } : url;
  const pageKey = resolvePageKey(event);
  const resourceKey = normalizeResourceUrl(event?.url);
  const key = pageKey ?? resourceKey;
  if (!key) return null;

  state.cached.add(key);
  state.pending.delete(key);
  if (resourceKey) state.ownRequests.delete(resourceKey);
  pruneExternalImageCacheFillState(state, at);
  return key;
}

export function planExternalImageCacheFill(state, event, settings = {}) {
  const at = Number.isFinite(event?.at) ? event.at : state.now();
  pruneExternalImageCacheFillState(state, at);

  if (settings.blobCacheEnabled === false || settings.externalImageCacheFillEnabled === false) {
    return { action: 'skip', reason: 'disabled' };
  }

  const key = normalizeResourceUrl(event?.url);
  if (!key) return { action: 'skip', reason: 'invalid-url' };

  const pageKey = resolvePageKey(event);
  const cacheKey = pageKey ?? key;
  const storageClass = pageKey ? CACHE_STORAGE_CLASSES.PERMANENT : CACHE_STORAGE_CLASSES.TEMPORARY;

  if (event?.source === 'own' || state.ownRequests.has(key)) {
    return { action: 'skip', reason: 'own-request', key: cacheKey, pageKey, url: key, storageClass };
  }

  if (state.cached.has(cacheKey)) {
    return { action: 'skip', reason: 'cached', key: cacheKey, pageKey, url: key, storageClass };
  }

  if (state.pending.has(cacheKey)) {
    return { action: 'skip', reason: 'pending', key: cacheKey, pageKey, url: key, storageClass };
  }

  state.pending.set(cacheKey, at);
  return {
    action: 'cache-fill',
    key: cacheKey,
    pageKey,
    url: key,
    resourceKey: key,
    storageClass,
    mode: 'low-priority-cache-first'
  };
}

export function completeExternalImageCacheFill(state, url, result, at = state.now()) {
  const event = typeof url === 'string' ? { url, pageKey: result?.pageKey } : url;
  const pageKey = resolvePageKey(event) ?? resolvePageKey(result);
  const resourceKey = normalizeResourceUrl(event?.url);
  const key = pageKey ?? resourceKey;
  if (!key) return null;

  state.pending.delete(key);
  if (result?.cached) {
    state.cached.add(key);
  }

  pruneExternalImageCacheFillState(state, at);
  return key;
}

export function pruneExternalImageCacheFillState(state, at = state.now()) {
  const cutoff = at - state.ttlMs;
  for (const [key, timestamp] of state.ownRequests) {
    if (timestamp < cutoff) state.ownRequests.delete(key);
  }
  for (const [key, timestamp] of state.pending) {
    if (timestamp < cutoff) state.pending.delete(key);
  }
}

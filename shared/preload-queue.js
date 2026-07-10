import { normalizePageKey, normalizeResourceUrl, resolvePageKey } from './cache-fill.js';

export const PRELOAD_QUEUE_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running'
});

export const EXTERNAL_PRELOAD_STATES = Object.freeze({
  LOADING: 'loading',
  LOADED: 'loaded'
});

export const PRELOAD_QUEUE_ACTIONS = Object.freeze({
  KEEP: 'keep',
  REMOVE: 'remove',
  DOWNGRADE: 'downgrade'
});

export const PRELOAD_REQUEST_DECISIONS = Object.freeze({
  PROCEED: 'proceed',
  SKIP: 'skip'
});

export function shouldSkipPreloadRequest(settings = {}, runtime = {}, request) {
  if (request?.kind === 'external-image-cache-fill' || request?.mode === 'low-priority-cache-first') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'external-image-cache-fill'
    };
  }

  const pageKey = resolvePreloadPageKey(request);
  if (!pageKey) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'not-reader-page-request'
    };
  }

  const status = request?.status;
  if (status === PRELOAD_QUEUE_STATUSES.RUNNING || status === 'sent') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'already-sent',
      pageKey
    };
  }

  if (settings?.preloadEnabled === false) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.SKIP,
      reason: 'preload-disabled',
      pageKey
    };
  }

  return shouldSkipPreloadRequestForAutoPager(runtime, request, settings);
}

export function shouldSkipPreloadRequestForAutoPager(runtime, request, settings = {}) {
  if (settings?.autoPagerEnabled === true && runtime?.ownAutoPagerContinuing === true) {
    return shouldSkipQueuedReaderPreloadRequest(request, 'ehplus-autopager-continuing');
  }

  if (runtime?.currentPagePreloadDisabled && runtime.currentPagePreloadDisabledReason !== 'page-image-requests-active') {
    return shouldSkipQueuedReaderPreloadRequest(request, runtime.currentPagePreloadDisabledReason || 'page-image-requests-active');
  }

  if (runtime?.currentPagePreloadDisabledReason === 'page-image-requests-active') {
    return shouldProceedReaderPreloadRequest(request, settings?.autoPagerEnabled === true ? 'ehplus-autopager-idle' : 'compatibility-disabled');
  }

  if (settings?.autoPagerEnabled === true) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'ehplus-autopager-idle'
    };
  }

  if (!runtime?.currentPagePreloadDisabled) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'compatibility-disabled'
    };
  }

  return shouldSkipQueuedReaderPreloadRequest(request, 'auto-pager-cache-fill-only');
}

function shouldProceedReaderPreloadRequest(request, reason) {
  if (request?.kind === 'external-image-cache-fill' || request?.mode === 'low-priority-cache-first') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'external-image-cache-fill'
    };
  }

  const pageKey = resolvePreloadPageKey(request);
  if (!pageKey) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'not-reader-page-request'
    };
  }

  const status = request?.status;
  if (status === PRELOAD_QUEUE_STATUSES.RUNNING || status === 'sent') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'already-sent',
      pageKey
    };
  }

  return {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason,
    pageKey
  };
}

function shouldSkipQueuedReaderPreloadRequest(request, reason) {
  if (request?.kind === 'external-image-cache-fill' || request?.mode === 'low-priority-cache-first') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'external-image-cache-fill'
    };
  }

  const pageKey = resolvePreloadPageKey(request);
  if (!pageKey) {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'not-reader-page-request'
    };
  }

  const status = request?.status;
  if (status === PRELOAD_QUEUE_STATUSES.RUNNING || status === 'sent') {
    return {
      action: PRELOAD_REQUEST_DECISIONS.PROCEED,
      reason: 'already-sent',
      pageKey
    };
  }

  return {
    action: PRELOAD_REQUEST_DECISIONS.SKIP,
    reason,
    pageKey
  };
}

export function removePreloadQueueForSettings(queue, settings = {}, runtime = {}) {
  return removePreloadQueue(queue, (item) => shouldSkipPreloadRequest(settings, runtime, item));
}

export function removePreloadQueueForAutoPagerPage(queue, runtime) {
  return removePreloadQueue(queue, (item) => shouldSkipPreloadRequestForAutoPager(runtime, item));
}

function removePreloadQueue(queue, decide) {
  const kept = [];
  const actions = [];

  for (const item of queue ?? []) {
    const decision = decide(item);
    if (decision.action === PRELOAD_REQUEST_DECISIONS.SKIP) {
      actions.push({
        action: PRELOAD_QUEUE_ACTIONS.REMOVE,
        reason: decision.reason,
        key: decision.pageKey ? `page:${decision.pageKey}` : undefined,
        item
      });
      continue;
    }

    kept.push(item);
    actions.push({
      action: PRELOAD_QUEUE_ACTIONS.KEEP,
      reason: decision.reason,
      item
    });
  }

  return { queue: kept, actions };
}

export function reconcilePreloadQueueWithExternalActivity(queue, observations, options = {}) {
  const downgradedPriority = options.downgradedPriority ?? 'external-low';
  const normalizedObservations = normalizeObservationSets(observations);
  const runningKeys = new Set();

  for (const item of queue ?? []) {
    const normalized = normalizePreloadQueueItem(item);
    if (normalized.status === PRELOAD_QUEUE_STATUSES.RUNNING) {
      for (const key of normalized.keys) runningKeys.add(key);
    }
  }

  const kept = [];
  const actions = [];
  const queuedKeys = new Set();

  for (const item of queue ?? []) {
    const normalized = normalizePreloadQueueItem(item);
    if (normalized.keys.length === 0) {
      kept.push(item);
      actions.push({ action: PRELOAD_QUEUE_ACTIONS.KEEP, reason: 'missing-key', item });
      continue;
    }

    const loadedKey = firstMatchingKey(normalized.keys, normalizedObservations.loaded);
    if (loadedKey) {
      if (normalized.status === PRELOAD_QUEUE_STATUSES.RUNNING) {
        kept.push(item);
        actions.push({ action: PRELOAD_QUEUE_ACTIONS.KEEP, reason: 'already-sent', key: loadedKey, item });
      } else {
        actions.push({ action: PRELOAD_QUEUE_ACTIONS.REMOVE, reason: 'external-loaded', key: loadedKey, item });
      }
      continue;
    }

    const duplicateRunningKey = firstMatchingKey(normalized.keys, runningKeys);
    if (normalized.status !== PRELOAD_QUEUE_STATUSES.RUNNING && duplicateRunningKey) {
      actions.push({ action: PRELOAD_QUEUE_ACTIONS.REMOVE, reason: 'duplicate-running', key: duplicateRunningKey, item });
      continue;
    }

    const duplicateQueuedKey = firstMatchingKey(normalized.keys, queuedKeys);
    if (normalized.status !== PRELOAD_QUEUE_STATUSES.RUNNING && duplicateQueuedKey) {
      actions.push({ action: PRELOAD_QUEUE_ACTIONS.REMOVE, reason: 'duplicate-queued', key: duplicateQueuedKey, item });
      continue;
    }

    const loadingKey = firstMatchingKey(normalized.keys, normalizedObservations.loading);
    if (loadingKey && normalized.status !== PRELOAD_QUEUE_STATUSES.RUNNING) {
      const downgraded = {
        ...item,
        priority: downgradedPriority,
        externalState: EXTERNAL_PRELOAD_STATES.LOADING
      };
      kept.push(downgraded);
      for (const key of normalized.keys) queuedKeys.add(key);
      actions.push({ action: PRELOAD_QUEUE_ACTIONS.DOWNGRADE, reason: 'external-loading', key: loadingKey, item: downgraded });
      continue;
    }

    kept.push(item);
    if (normalized.status !== PRELOAD_QUEUE_STATUSES.RUNNING) {
      for (const key of normalized.keys) queuedKeys.add(key);
    }
    actions.push({ action: PRELOAD_QUEUE_ACTIONS.KEEP, reason: 'unmatched', item });
  }

  return { queue: kept, actions };
}

export function normalizeExternalPreloadObservation(observation) {
  const pageKey = resolvePageKey(observation)
    ?? parseReaderPageKey(observation?.pageUrl)
    ?? parseReaderPageKey(observation?.readerUrl)
    ?? parseReaderPageKey(observation?.url);
  const resourceKey = normalizeResourceUrl(observation?.imageUrl ?? observation?.resourceUrl);
  const state = normalizeExternalState(observation?.state ?? observation?.status);
  const keys = buildPreloadKeys({ pageKey, resourceKey });

  if (!state || keys.length === 0) return null;
  return { state, pageKey, resourceKey, keys };
}

export function normalizePreloadQueueItem(item) {
  const pageKey = resolvePageKey(item)
    ?? parseReaderPageKey(item?.pageUrl)
    ?? parseReaderPageKey(item?.readerUrl);
  const resourceKey = normalizeResourceUrl(item?.imageUrl ?? item?.resourceUrl ?? item?.url);
  const status = item?.status === PRELOAD_QUEUE_STATUSES.RUNNING
    ? PRELOAD_QUEUE_STATUSES.RUNNING
    : PRELOAD_QUEUE_STATUSES.QUEUED;

  return {
    pageKey,
    resourceKey,
    status,
    keys: buildPreloadKeys({ pageKey, resourceKey })
  };
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

function resolvePreloadPageKey(request) {
  return resolvePageKey(request)
    ?? parseReaderPageKey(request?.pageUrl)
    ?? parseReaderPageKey(request?.readerUrl)
    ?? parseReaderPageKey(request?.url);
}

function normalizeObservationSets(observations) {
  const loaded = new Set();
  const loading = new Set();

  for (const observation of observations ?? []) {
    const normalized = normalizeExternalPreloadObservation(observation);
    if (!normalized) continue;

    const target = normalized.state === EXTERNAL_PRELOAD_STATES.LOADED ? loaded : loading;
    for (const key of normalized.keys) target.add(key);
  }

  for (const key of loaded) {
    loading.delete(key);
  }

  return { loaded, loading };
}

function normalizeExternalState(value) {
  if (['loaded', 'complete', 'completed', 'cached'].includes(value)) return EXTERNAL_PRELOAD_STATES.LOADED;
  if (['loading', 'pending', 'started'].includes(value)) return EXTERNAL_PRELOAD_STATES.LOADING;
  return null;
}

function buildPreloadKeys({ pageKey, resourceKey }) {
  const keys = [];
  if (pageKey) keys.push(`page:${pageKey}`);
  if (resourceKey) keys.push(`resource:${resourceKey}`);
  return keys;
}

function firstMatchingKey(keys, set) {
  return keys.find((key) => set.has(key)) ?? null;
}

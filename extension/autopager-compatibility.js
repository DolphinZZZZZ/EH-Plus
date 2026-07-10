export const AUTOPAGER_REPORT_TYPE = 'EHPLUS_PAGE_IMAGE_ACTIVITY';
export const AUTOPAGER_PAGE_SESSION_STARTED_TYPE = 'EHPLUS_PAGE_SESSION_STARTED';
export const OWN_AUTOPAGER_STATUS_TYPE = 'EHPLUS_REPORT_OWN_AUTOPAGER_STATUS';
export const AUTOPAGER_COMPATIBILITY_MODE = 'auto-pager-compat';
export const AUTOPAGER_CACHE_FILL_ONLY_MODE = 'auto-pager-cache-fill-only';
export const OWN_AUTOPAGER_MODE = 'ehplus-autopager';
export const PAGE_IMAGE_REQUESTS_ACTIVE_REASON = 'page-image-requests-active';

export function normalizeAutoPagerCompatibilityReport(message, now = Date.now()) {
  const detection = message?.detection ?? {};
  const detected = Boolean(detection.detected);
  const mode = detected ? AUTOPAGER_COMPATIBILITY_MODE : 'normal';
  const confidence = Math.max(0, Math.min(1, Number(detection.confidence) || 0));
  const matches = Array.isArray(detection.matches)
    ? detection.matches.slice(0, 8).map(normalizeMatch).filter(Boolean)
    : [];

  return {
    detected,
    mode,
    shouldYieldNextPageRequests: detected && detection.shouldYieldNextPageRequests !== false,
    confidence,
    matches,
    url: typeof message?.url === 'string' ? message.url.slice(0, 500) : '',
    pageSessionId: normalizeShortString(message?.pageSessionId, 120),
    tabId: normalizeTabId(message?.tabId),
    observedAt: Number.isFinite(Number(message?.observedAt)) ? Number(message.observedAt) : now,
    reportedAt: now
  };
}

export function applyAutoPagerCompatibilityReport(runtime = {}, message, now = Date.now()) {
  const report = normalizeAutoPagerCompatibilityReport(message, now);
  if (!report.detected) {
    return releasePageImageRequestPause(runtime, report);
  }

  const previous = runtime.autoPagerCompatibility ?? {};
  const next = {
    ...runtime,
    autoPagerDetected: false,
    compatibilityMode: runtime.compatibilityMode ?? 'normal',
    preloadMode: runtime.preloadMode ?? 'normal',
    shouldYieldNextPageRequests: report.shouldYieldNextPageRequests,
    pageImageRequestsActive: true,
    pageImageRequestsLastActiveAt: report.observedAt,
    autoPagerCompatibility: {
      active: true,
      mode: PAGE_IMAGE_REQUESTS_ACTIVE_REASON,
      preloadMode: runtime.preloadMode ?? 'normal',
      onlyExternalImageCacheFill: false,
      shouldYieldNextPageRequests: report.shouldYieldNextPageRequests,
      confidence: report.confidence,
      matches: report.matches,
      sourceNames: uniqueNames(report.matches),
      url: report.url,
      pageSessionId: report.pageSessionId,
      tabId: report.tabId,
      detectedAt: previous.detectedAt ?? report.observedAt,
      lastDetectedAt: report.observedAt,
      lastReportedAt: report.reportedAt
    }
  };

  return {
    runtime: next,
    report,
    changed: previous.active !== true
      || runtime.pageImageRequestsActive !== true
      || runtime.shouldYieldNextPageRequests !== report.shouldYieldNextPageRequests
      || JSON.stringify(previous.matches ?? []) !== JSON.stringify(report.matches)
  };
}

function releasePageImageRequestPause(runtime = {}, report) {
  const sameSession = !report.pageSessionId
    || runtime.currentPagePreloadDisabledPageSessionId === report.pageSessionId;
  const sameTab = report.tabId === null
    || runtime.currentPagePreloadDisabledTabId === null
    || runtime.currentPagePreloadDisabledTabId === report.tabId;
  const shouldRelease = runtime.currentPagePreloadDisabled === true
    && runtime.currentPagePreloadDisabledReason === PAGE_IMAGE_REQUESTS_ACTIVE_REASON
    && sameSession
    && sameTab;

  if (!shouldRelease) {
    return {
      runtime: {
        ...runtime,
        pageImageRequestsActive: false,
        pageImageRequestsLastIdleAt: report.observedAt
      },
      report,
      changed: runtime.pageImageRequestsActive === true
    };
  }

  if (runtime.ownAutoPagerContinuing === true) {
    return {
      runtime: {
        ...runtime,
        compatibilityMode: 'normal',
        preloadMode: OWN_AUTOPAGER_MODE,
        shouldYieldNextPageRequests: false,
        currentPagePreloadDisabled: true,
        currentPagePreloadDisabledReason: 'ehplus-autopager-continuing',
        currentPagePreloadDisabledAt: report.observedAt,
        currentPagePreloadDisabledUrl: report.url,
        currentPagePreloadDisabledPageSessionId: report.pageSessionId,
        currentPagePreloadDisabledTabId: report.tabId,
        autoPagerCompatibility: null,
        pageImageRequestsActive: false,
        pageImageRequestsLastIdleAt: report.observedAt
      },
      report,
      changed: true
    };
  }

  return {
    runtime: {
      ...runtime,
      autoPagerDetected: false,
      compatibilityMode: 'normal',
      preloadMode: 'normal',
      shouldYieldNextPageRequests: false,
      currentPagePreloadDisabled: false,
      currentPagePreloadDisabledReason: '',
      currentPagePreloadDisabledAt: 0,
      currentPagePreloadDisabledUrl: '',
      currentPagePreloadDisabledPageSessionId: '',
      currentPagePreloadDisabledTabId: null,
      autoPagerCompatibility: null,
      pageImageRequestsActive: false,
      pageImageRequestsLastIdleAt: report.observedAt,
      takeoverState: runtime.owner === 'extension' ? 'extension-owner' : runtime.takeoverState
    },
    report,
    changed: true
  };
}

export function applyOwnAutoPagerStatus(runtime = {}, message, now = Date.now()) {
  const report = normalizeOwnAutoPagerStatus(message, now);
  const previous = runtime.ownAutoPager ?? {};
  const continuing = report.enabled && report.continuing;
  const next = {
    ...runtime,
    ownAutoPagerActive: report.enabled,
    ownAutoPagerContinuing: continuing,
    ownAutoPagerStatus: report.status,
    ownAutoPagerPageSessionId: report.pageSessionId,
    ownAutoPager: {
      active: report.enabled,
      continuing,
      status: report.status,
      reason: report.reason,
      url: report.url,
      nextUrl: report.nextUrl,
      pageSessionId: report.pageSessionId,
      tabId: report.tabId,
      appendedPages: report.appendedPages,
      maxPages: report.maxPages,
      updatedAt: report.observedAt,
      reportedAt: report.reportedAt
    }
  };

  if (continuing) {
    Object.assign(next, {
      preloadMode: OWN_AUTOPAGER_MODE,
      currentPagePreloadDisabled: true,
      currentPagePreloadDisabledReason: 'ehplus-autopager-continuing',
      currentPagePreloadDisabledAt: report.observedAt,
      currentPagePreloadDisabledUrl: report.url,
      currentPagePreloadDisabledPageSessionId: report.pageSessionId,
      currentPagePreloadDisabledTabId: report.tabId
    });
  } else if (runtime.currentPagePreloadDisabledReason === 'ehplus-autopager-continuing') {
    Object.assign(next, {
      preloadMode: 'normal',
      currentPagePreloadDisabled: false,
      currentPagePreloadDisabledReason: '',
      currentPagePreloadDisabledAt: 0,
      currentPagePreloadDisabledUrl: '',
      currentPagePreloadDisabledPageSessionId: '',
      currentPagePreloadDisabledTabId: null
    });
  }

  return {
    runtime: next,
    report,
    changed: previous.continuing !== continuing
      || previous.status !== report.status
      || previous.pageSessionId !== report.pageSessionId
      || previous.nextUrl !== report.nextUrl
      || runtime.currentPagePreloadDisabledReason === 'ehplus-autopager-continuing'
      || continuing
  };
}

export function resetOwnAutoPagerStatus(runtime = {}) {
  if (!runtime.ownAutoPager && !runtime.ownAutoPagerActive && !runtime.ownAutoPagerContinuing && runtime.currentPagePreloadDisabledReason !== 'ehplus-autopager-continuing') {
    return runtime;
  }

  const next = {
    ...runtime,
    ownAutoPagerActive: false,
    ownAutoPagerContinuing: false,
    ownAutoPagerStatus: 'disabled',
    ownAutoPagerPageSessionId: '',
    ownAutoPager: null
  };
  if (runtime.currentPagePreloadDisabledReason === 'ehplus-autopager-continuing') {
    Object.assign(next, {
      preloadMode: 'normal',
      currentPagePreloadDisabled: false,
      currentPagePreloadDisabledReason: '',
      currentPagePreloadDisabledAt: 0,
      currentPagePreloadDisabledUrl: '',
      currentPagePreloadDisabledPageSessionId: '',
      currentPagePreloadDisabledTabId: null
    });
  }
  return next;
}

export function resetAutoPagerCompatibilityForPageSession(runtime = {}, message, now = Date.now()) {
  const pageSessionId = normalizeShortString(message?.pageSessionId, 120);
  const tabId = normalizeTabId(message?.tabId);
  const url = typeof message?.url === 'string' ? message.url.slice(0, 500) : '';
  const shouldResetOwnAutoPager = shouldResetOwnAutoPagerForPageSession(runtime, {
    pageSessionId,
    tabId,
    url,
    ownAutoPagerDomActive: message?.ownAutoPagerDomActive
  });
  const runtimeAfterOwnAutoPagerReset = shouldResetOwnAutoPager ? resetOwnAutoPagerStatus(runtime) : runtime;
  const samePausedPageSession = pageSessionId
    && runtimeAfterOwnAutoPagerReset.currentPagePreloadDisabledPageSessionId === pageSessionId
    && (tabId === null || runtimeAfterOwnAutoPagerReset.currentPagePreloadDisabledTabId === tabId);
  const shouldReset = runtimeAfterOwnAutoPagerReset.currentPagePreloadDisabled === true && !samePausedPageSession;

  if (!shouldReset) {
    return {
      runtime: {
        ...runtimeAfterOwnAutoPagerReset,
        activePageSessionId: pageSessionId,
        activePageTabId: tabId,
        activePageUrl: url,
        activePageStartedAt: now
      },
      changed: shouldResetOwnAutoPager
    };
  }

  return {
    runtime: {
      ...runtimeAfterOwnAutoPagerReset,
      autoPagerDetected: false,
      compatibilityMode: 'normal',
      preloadMode: 'normal',
      shouldYieldNextPageRequests: false,
      currentPagePreloadDisabled: false,
      currentPagePreloadDisabledReason: '',
      currentPagePreloadDisabledAt: 0,
      currentPagePreloadDisabledUrl: '',
      currentPagePreloadDisabledPageSessionId: '',
      currentPagePreloadDisabledTabId: null,
      autoPagerCompatibility: null,
      ownAutoPagerActive: false,
      ownAutoPagerContinuing: false,
      ownAutoPagerStatus: 'idle',
      ownAutoPagerPageSessionId: '',
      ownAutoPager: null,
      takeoverState: runtime.owner === 'extension' ? 'extension-owner' : runtime.takeoverState,
      activePageSessionId: pageSessionId,
      activePageTabId: tabId,
      activePageUrl: url,
      activePageStartedAt: now
    },
    changed: true
  };
}

function shouldResetOwnAutoPagerForPageSession(runtime = {}, message = {}) {
  const hasOwnAutoPagerState = runtime.ownAutoPagerActive === true
    || runtime.ownAutoPagerContinuing === true
    || runtime.currentPagePreloadDisabledReason === 'ehplus-autopager-continuing'
    || Boolean(runtime.ownAutoPager);
  if (!hasOwnAutoPagerState) return false;
  if (message.ownAutoPagerDomActive === false) return true;

  const sameSession = message.pageSessionId
    && runtime.ownAutoPagerPageSessionId === message.pageSessionId;
  const ownTabId = normalizeTabId(runtime.ownAutoPager?.tabId);
  const sameTab = message.tabId === null
    || ownTabId === null
    || ownTabId === message.tabId;
  if (!sameSession || !sameTab) return true;

  const previousUrl = runtime.ownAutoPager?.url || runtime.currentPagePreloadDisabledUrl || '';
  return Boolean(message.url && previousUrl && stripHash(previousUrl) !== stripHash(message.url));
}

function normalizeOwnAutoPagerStatus(message, now) {
  const status = normalizeShortString(message?.status, 40) || 'idle';
  return {
    enabled: message?.enabled !== false,
    continuing: message?.continuing === true,
    status,
    reason: normalizeShortString(message?.reason, 120),
    url: typeof message?.url === 'string' ? message.url.slice(0, 500) : '',
    nextUrl: typeof message?.nextUrl === 'string' ? message.nextUrl.slice(0, 500) : '',
    pageSessionId: normalizeShortString(message?.pageSessionId, 120),
    tabId: normalizeTabId(message?.tabId),
    appendedPages: normalizeNonNegativeInteger(message?.appendedPages),
    maxPages: normalizeNonNegativeInteger(message?.maxPages),
    observedAt: Number.isFinite(Number(message?.observedAt)) ? Number(message.observedAt) : now,
    reportedAt: now
  };
}

function normalizeMatch(match) {
  if (!match || typeof match !== 'object') return null;
  return {
    id: normalizeShortString(match.id, 80) || 'unknown',
    name: normalizeShortString(match.name, 80) || 'Unknown auto-pager',
    confidence: Math.max(0, Math.min(1, Number(match.confidence) || 0))
  };
}

function uniqueNames(matches) {
  return [...new Set(matches.map((match) => match.name).filter(Boolean))];
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeShortString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function stripHash(url) {
  return String(url).split('#')[0];
}

function normalizeTabId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

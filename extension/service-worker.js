import {
  applyAutoPagerCompatibilityReport,
  applyOwnAutoPagerStatus,
  resetAutoPagerCompatibilityForPageSession,
  resetOwnAutoPagerStatus,
  AUTOPAGER_PAGE_SESSION_STARTED_TYPE,
  AUTOPAGER_REPORT_TYPE,
  OWN_AUTOPAGER_STATUS_TYPE
} from './autopager-compatibility.js';
import {
  applyCooperativeStatsDelta,
  buildCooperativeCacheResponse,
  buildCooperativeCacheResponseFromHit,
  COOPERATIVE_CACHE_QUERY_TYPE,
  COOPERATIVE_CACHE_TYPES,
  findCooperativeCacheHit,
  isCooperativeCacheQuery,
  normalizeCooperativeCacheQuery,
  normalizePageKey,
  normalizeResourceUrl,
  resolveCooperativePageKey
} from './cooperative-cache-api.js';
import {
  planDuplicateImageMerge
} from './cache-dedupe.js';
import {
  MAX_ACCOUNT_REFRESH_ACTIVE_TABS,
  shouldRefreshAccountOnTabTransition,
  summarizeAccountRefreshTabUrl,
  summarizeAccountRefreshTabs
} from './account-refresh-scheduler.js';
import {
  postLiveQuotaReset,
  readLiveAccountStatus,
  readLiveDawnEvent,
  RESET_QUOTA_BODY
} from './live-api.js';
import {
  buildExternalImageCacheFillRecord,
  buildExternalResourceCacheFillRecord,
  classifyEhPage,
  createPreloadRequestGateFetch,
  createIndexedDbPreloadStore,
  openPreloadDb,
  runPreloadFromContext,
  stripImageFromRecord,
  summarizePreloadRecords
} from './preload-engine.js';
import {
  applyDirectoryAuthorizationRuntime,
  createDirectoryPreloadStore,
  dismissDirectoryAuthorizationNotice,
  loadDirectoryHandleRecord,
  loadWritableDirectoryHandle,
  saveDirectoryHandle,
  writeDirectoryLogsSnapshot,
  writeDirectoryStateSnapshot
} from './directory-storage.js';
import {
  galleryMetadataPageKey,
  isProtectedGallery,
  isProtectedImage,
  planImageCacheLimitCleanup,
  planRuntimeCleanup,
  planTemporaryCacheCleanup,
  protectionSettings,
  recordHasStoredImage,
  recordStoredBytes,
  shouldAllowNewImageCache,
  summarizeProtectedStorage,
  touchRecordAccess
} from '../shared/cleanup.js';
import { parsePositiveStorageLimit } from '../shared/format.js';
import { reconcilePreloadQueueWithExternalActivity } from '../shared/preload-queue.js';
import { recordFrequentWatch, updateFrequentWatchTitle } from '../shared/statistics.js';

const STATE_KEY = 'ehplus_live_state';
const LOGS_KEY = 'ehplus_live_logs';
const SERVICE_WORKER_PROBE_KEY = 'ehplus_service_worker_probe';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
// 1.0.0 统一命名前的旧存储键：安装/更新时一次性清除（含 ehpe_ 时代的状态与日志）。
const LEGACY_STORAGE_KEYS = ['ehpe_offline_state', 'ehpe_live_state', 'ehpe_live_logs', 'ehpe_service_worker_probe'];
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const SETTINGS_VERSION = 15;
const HISTORY_RECORD_KIND = 'history';
const DEBUG_TEXT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DAWN_ALARM_NAME = 'ehplus-background-dawn';
const ACCOUNT_REFRESH_ALARM_NAME = 'ehplus-account-refresh';
const CACHE_DEDUPE_ALARM_NAME = 'ehplus-cache-dedupe';
const RUNTIME_CLEANUP_ALARM_NAME = 'ehplus-runtime-cleanup';
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_REFRESH_INTERVAL_MINUTES = 10;
const CACHE_DEDUPE_INTERVAL_MINUTES = 60;
const RUNTIME_CLEANUP_INTERVAL_MINUTES = 24 * 60;
const RUNTIME_CLEANUP_INTERVAL_MS = RUNTIME_CLEANUP_INTERVAL_MINUTES * 60 * 1000;
const READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS = 1500;
const READER_CACHE_FIRST_DNR_OPERATION_TIMEOUT_MS = 1000;
const FAST_CACHE_STORE_TIMEOUT_MS = 1500;
const FAST_CACHE_RECORD_TIMEOUT_MS = 1200;
const FAST_CACHE_RESPONSE_TIMEOUT_MS = 2400;
const INTERNAL_CACHE_QUERY_TYPE = 'EHPLUS_INTERNAL_CACHE_QUERY';
const PRELOAD_CACHE_SYNC_TIMEOUT_MS = 2500;
const PAGE_SESSION_BACKGROUND_DELAY_MS = 750;
const STATE_BACKGROUND_SYNC_DELAY_MS = 250;
const DIRECTORY_SELECTION_BACKGROUND_DELAY_MS = 0;
// 日志裁剪以 logRetentionDays 与 logLimitValue/logLimitUnit 设置为准（规划 §13）。
// 条数上限仅作为极端情况下的保险阈值；由于未申请 unlimitedStorage，
// chrome.storage.local 配额约 10MB，字节上限额外被安全值封顶。
const MAX_RUNTIME_LOG_ENTRIES = 2000;
const RUNTIME_LOG_STORAGE_SAFETY_BYTES = 4 * 1024 * 1024;
const MAX_DEBUG_TEXT_CHARS_IN_STATE = 2000;
const PENDING_LOG_ENTRIES = Symbol('ehplusPendingLogEntries');
const DEFAULT_ACCOUNT_STATUS_FIELDS = {
  quota: true,
  resetCost: false,
  credits: true,
  gp: true,
  hath: true,
  updatedAt: false
};
const DEFAULT_STATS_DISPLAY_FIELDS = {
  readerReads: false,
  readerHits: false,
  readerHitRate: false,
  galleryReads: false,
  galleryCache: false
};
const DEFAULT_LOG_DISPLAY_FIELDS = {
  logUsage: true,
  logRows: true
};
const GITHUB_REPOSITORY_NAME = 'EH＋';
const GITHUB_REPOSITORY_URL = 'https://github.com/DolphinZZZZZ/EH-Plus';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/DolphinZZZZZ/EH-Plus/releases/latest';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/DolphinZZZZZ/EH-Plus/releases';
const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const EXTERNAL_IMAGE_CACHE_FILL_TTL_MS = 120000;
const PAGE_NETWORK_ACTIVITY_QUERY_TYPE = 'EHPLUS_PAGE_NETWORK_ACTIVITY_QUERY';
const PRELOAD_NETWORK_ACTIVITY_QUERY_TIMEOUT_MS = 1000;
const PRELOAD_NETWORK_ACTIVITY_POLL_MS = 250;
const READER_CACHE_FIRST_BLOCK_RULE_BASE_ID = 300000;
const READER_CACHE_FIRST_BLOCK_AUTO_RELEASE_MS = 30000;
const READER_CACHE_FIRST_PLACEHOLDER_PATH = '/images/cache-first-placeholder.svg';
const readerCacheFirstBlockReleaseTimers = new Map();
const CACHE_STORAGE_CLASSES = Object.freeze({
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary'
});
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

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  language: 'zh-CN',
  storageMode: 'indexeddb',
  directoryCacheEnabled: false,
  directoryLabel: '',
  deleteOldCacheAfterMigration: false,
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
  logDisplayFields: DEFAULT_LOG_DISPLAY_FIELDS,
  logRetentionDays: 30,
  logLimitValue: 100,
  logLimitUnit: 'MB',
  storageLimitValue: 2,
  storageLimitUnit: 'GB',
  accountStatusFields: DEFAULT_ACCOUNT_STATUS_FIELDS,
  dawnEnabled: false,
  backgroundDawnEnabled: false,
  statsEnabled: true,
  statsDisplayFields: DEFAULT_STATS_DISPLAY_FIELDS,
  historyLimit: 100,
  protectHighReadImages: false,
  highReadThreshold: 3,
  protectHighReadGalleries: false,
  highReadGalleryThreshold: 3,
  cleanupScope: 'all',
  cleanupMode: 'olderThanDays',
  cleanupDays: 7,
  cleanupIncludeProtected: false,
  cleanupIncludeProtectedGalleries: false,
  cellColors: DEFAULT_CELL_COLORS
};

let pendingDirectoryPickerTabId = null;
let pendingDirectorySwitchSnapshot = null;
let pendingDirectorySwitchRequest = null;

// ---------- state-message-timeout 优化：内存态状态/日志缓存 ----------
// 状态读走内存，写内存后合并落盘；日志追加只操作内存数组并防抖落盘，
// 避免每条日志都全量读写 storage 并重复 JSON.stringify 阻塞事件循环。
const STATE_PERSIST_DEBOUNCE_MS = 200;
const LOG_FLUSH_DEBOUNCE_MS = 500;
let stateMemoryCache = null;
let stateUpdateChain = Promise.resolve();
let statePersistTimer = 0;
let statePersistPending = null;
const logMemory = {
  loaded: false,
  logs: []
};
let logFlushTimer = 0;
const logByteSizeCache = new WeakMap();
const logDebugTextCleanCache = new WeakSet();

// ---------- 预加载实时计数（面板“当前并发/当前排队”显示） ----------
const preloadLive = {
  activeRequests: 0,
  sessions: new Map()
};
const PRELOAD_LIVE_SESSION_TTL_MS = 10 * 60 * 1000;

const DEFAULT_STATE = {
  extensionVersion: EXTENSION_VERSION,
  mode: 'official',
  lastStartedAt: 0,
  lastPopupOpenedAt: 0,
  counters: {
    startupCount: 0,
    popupOpenCount: 0,
    requestCount: 0
  },
  floatingPanel: {
    left: 12,
    top: 12,
    collapsed: false
  },
  runtime: {
    owner: 'extension',
    takeoverState: 'extension-owner',
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
    activePageSessionId: '',
    activePageTabId: null,
    activePageUrl: '',
    activePageStartedAt: 0,
    autoPagerCompatibility: null,
    ownAutoPagerActive: false,
    ownAutoPagerContinuing: false,
    ownAutoPagerStatus: 'idle',
    ownAutoPagerPageSessionId: '',
    ownAutoPager: null,
    lastStopSignalAt: 0,
    heartbeatTimeoutMs: 5000,
    requestedStorageMode: 'indexeddb',
    effectiveStorageMode: 'indexeddb',
    directoryAuthorizationRequired: false,
    directoryAuthorizationIncident: 0,
    directoryAuthorizationNoticeDismissedIncident: 0
  },
  accountRefresh: {
    activeCount: 0,
    activeTabs: [],
    alarmEnabled: false,
    lastOpenedAt: 0,
    lastRefreshAt: 0,
    lastReason: ''
  },
  settings: DEFAULT_SETTINGS,
  account: {
    quotaUsed: null,
    quotaLimit: null,
    resetCostGp: null,
    credits: null,
    gp: null,
    hath: null,
    updatedAt: 0,
    quotaTone: 'unknown',
    lastReset: null,
    resetPrepare: null
  },
  storage: {
    totalBytes: 0,
    imageBytes: 0,
    logBytes: 0,
    logCount: 0,
    otherBytes: 0,
    protectedImageBytes: 0,
    protectedGalleryBytes: 0,
    cacheRecords: 0,
    imageRecords: 0,
    metadataRecords: 0,
    readerRecords: [],
    protectedImages: 0,
    protectedGalleries: 0,
    cacheBlockedReason: '',
    usageBytes: 0,
    quotaBytes: 2147483648,
    lastCalculatedAt: 0
  },
  stats: {
    readerHits: 0,
    readerReads: 0,
    galleryReads: 0,
    galleryResourceReads: 0,
    frequent: []
  },
  dawn: {
    lastRunAt: 0,
    lastResult: '尚未签到',
    lastEventType: 'none',
    nextOfficialResetText: 'UTC 00:00 / 北京时间 08:00',
    scheduledAfterText: 'UTC 03:00 后',
    rewards: {},
    backgroundSuccessCount: 0,
    unknownEventText: ''
  },
  cleanup: {
    lastPreview: null,
    lastResult: null,
    lastAutoCleanupAt: 0
  },
  migration: {
    status: 'idle',
    oldCacheCount: 0,
    oldCacheBytes: 0,
    targetDirectoryLabel: '未授权',
    totalCount: 0,
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    deletedOldCache: false,
    lastRunAt: 0,
    progressUpdatedAt: 0,
    lastError: ''
  },
  about: {
    currentVersion: EXTENSION_VERSION,
    repositoryName: GITHUB_REPOSITORY_NAME,
    repositoryUrl: GITHUB_REPOSITORY_URL,
    releasesApiUrl: GITHUB_RELEASES_API_URL,
    releasesPageUrl: GITHUB_RELEASES_PAGE_URL,
    sourceName: 'GitHub',
    uniqueSource: true,
    freeSoftware: true,
    lastUpdateCheck: null,
    updateCheckIntervalMs: UPDATE_CHECK_INTERVAL_MS
  },
  logs: [
    {
      at: 0,
      level: 'info',
      event: 'runtime.init',
      action: 'initialize-official',
      message: `${EXTENSION_VERSION} 已启动`,
      requestId: 'boot',
      simulated: false,
      source: 'service-worker',
      page: null,
      context: {
        mode: 'official',
        source: 'default-state'
      },
      result: {
        ok: true
      }
    }
  ]
};

let cooperativeCacheRecords = [];
let cooperativeCacheRecordsSyncedAt = 0;
const externalImageCacheFillState = createExternalImageCacheFillState();
let runtimeCleanupWakeCheckPromise = null;

writeServiceWorkerProbe('top-level').catch(() => {});

setTimeout(() => {
  initializeRuntimeCleanupOnWake('service-worker-wakeup').catch(() => {});
}, 0);

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
  const state = await updateState((state) => addLog({
    ...state,
    lastStartedAt: Date.now(),
    counters: {
      ...state.counters,
      startupCount: state.counters.startupCount + 1
    }
  }, {
    level: 'info',
    event: 'runtime.installed',
    action: 'initialize-extension',
    message: '扩展已安装或更新',
    context: {
      version: state.extensionVersion,
      mode: state.mode
    },
    result: {
      startupCount: state.counters.startupCount + 1
    }
  }));
  await syncBackgroundDawnAlarm(state.settings);
  await refreshAccountScheduleFromTabs({ reason: 'installed', refreshOnTransition: false });
  await syncCacheDedupeAlarm();
  await syncRuntimeCleanupAlarm();
  await maybeRunRuntimeCleanupOnWake('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await updateState((state) => addLog({
    ...state,
    lastStartedAt: Date.now(),
    counters: {
      ...state.counters,
      startupCount: state.counters.startupCount + 1
    }
  }, {
    level: 'info',
    event: 'runtime.startup',
    action: 'start-extension',
    message: '扩展运行时已启动',
    context: {
      version: state.extensionVersion,
      mode: state.mode
    },
    result: {
      startupCount: state.counters.startupCount + 1
    }
  }));
  await syncBackgroundDawnAlarm(state.settings);
  await refreshAccountScheduleFromTabs({ reason: 'startup', refreshOnTransition: false });
  await syncCacheDedupeAlarm();
  await syncRuntimeCleanupAlarm();
  await maybeRunRuntimeCleanupOnWake('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAWN_ALARM_NAME) {
    runBackgroundDawnAlarm().catch((error) => {
      appendErrorLog({ type: 'EHPLUS_BACKGROUND_DAWN_ALARM' }, null, error).catch(() => {});
    });
    return;
  }

  if (alarm.name === ACCOUNT_REFRESH_ALARM_NAME) {
    runScheduledAccountRefresh().catch((error) => {
      appendErrorLog({ type: 'EHPLUS_ACCOUNT_REFRESH_ALARM' }, null, error).catch(() => {});
    });
    return;
  }

  if (alarm.name === CACHE_DEDUPE_ALARM_NAME) {
    runCacheDedupeAlarm().catch((error) => {
      appendErrorLog({ type: 'EHPLUS_CACHE_DEDUPE_ALARM' }, null, error).catch(() => {});
    });
    return;
  }

  if (alarm.name === RUNTIME_CLEANUP_ALARM_NAME) {
    runRuntimeCleanupAlarm().catch((error) => {
      appendErrorLog({ type: 'EHPLUS_RUNTIME_CLEANUP_ALARM' }, null, error).catch(() => {});
    });
  }
});

chrome.tabs.onRemoved.addListener(() => {
  refreshAccountScheduleFromTabs({ reason: 'tab-removed' }).catch((error) => {
    appendErrorLog({ type: 'EHPLUS_ACCOUNT_REFRESH_TABS' }, null, error).catch(() => {});
  });
  maybeCleanupTemporaryCache('tab-removed').catch((error) => {
    appendErrorLog({ type: 'EHPLUS_TEMPORARY_CACHE_CLEANUP' }, null, error).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!('url' in changeInfo) && changeInfo.status !== 'complete') return;
  if ('url' in changeInfo && !isReaderPageUrlForCacheFirst(changeInfo.url)) {
    releaseReaderCacheFirstBlock(tabId).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_RELEASE', tabId }, null, error).catch(() => {});
    });
  }
  refreshAccountScheduleFromTabs({ reason: 'tab-updated', tabId, tabUrl: tab?.url ?? changeInfo.url }).catch((error) => {
    appendErrorLog({ type: 'EHPLUS_ACCOUNT_REFRESH_TABS' }, null, error).catch(() => {});
  });
});

if (chrome.webNavigation?.onCommitted) {
  chrome.webNavigation.onBeforeNavigate?.addListener((details) => {
    if (details.frameId !== 0) return;
    releaseReaderCacheFirstBlock(details.tabId).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_NAVIGATION_BLOCK_BEFORE', tabId: details.tabId }, null, error).catch(() => {});
    });
  });

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    releaseReaderCacheFirstBlock(details.tabId).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_NAVIGATION_BLOCK', tabId: details.tabId }, null, error).catch(() => {});
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withTimeout(
    handleMessage(message, sender),
    internalMessageResponseTimeoutMs(message),
    internalMessageTimeoutFallback(message)
  )
    .then(sendResponse)
    .catch((error) => {
      appendErrorLog(message, sender, error)
        .catch(() => {});
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  withTimeout(
    handleExternalMessage(message, sender),
    internalMessageResponseTimeoutMs(message),
    internalMessageTimeoutFallback(message)
  )
    .then(sendResponse)
    .catch((error) => {
      appendErrorLog(message, sender, error)
        .catch(() => {});
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

function internalMessageResponseTimeoutMs(message) {
  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_BLOCK') return 600;
  if (message?.type === 'EHPLUS_GET_STATE') return 900;
  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_TIMING') return 900;
  if (isCooperativeCacheQuery(message) && message?.fastResponse === true) return FAST_CACHE_RESPONSE_TIMEOUT_MS;
  return 5000;
}

function internalMessageTimeoutFallback(message) {
  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_BLOCK') {
    return {
      ok: true,
      accepted: true,
      blocked: message.action === 'ensure',
      fallback: 'message-timeout'
    };
  }

  if (message?.type === 'EHPLUS_GET_STATE') {
    return {
      ok: true,
      fallback: 'message-timeout',
      state: normalizeState({
        runtime: {
          owner: 'extension',
          state: 'message-timeout-fallback',
          updatedAt: Date.now()
        }
      })
    };
  }

  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_TIMING') {
    return {
      ok: false,
      logged: false,
      error: 'message-timeout'
    };
  }

  if (isCooperativeCacheQuery(message) && message?.fastResponse === true) {
    const timing = fastCacheTimeoutFallback(Date.now()).timing;
    return {
      ...attachCooperativeTiming(buildCooperativeCacheResponse([], message, { enabled: true }), {
        ...timing,
        totalMs: FAST_CACHE_RESPONSE_TIMEOUT_MS
      }),
      countsAsCacheHit: false,
      fastResponse: true
    };
  }

  return {
    ok: false,
    error: 'message-timeout'
  };
}

async function writeServiceWorkerProbe(stage) {
  await chrome.storage.local.set({
    [SERVICE_WORKER_PROBE_KEY]: {
      stage,
      at: Date.now(),
      version: chrome.runtime?.getManifest?.().version ?? DEFAULT_STATE.extensionVersion
    }
  });
}

async function handleMessage(message, sender) {
  if (isCooperativeCacheQuery(message)) {
    return handleCooperativeCacheQuery(message, sender);
  }

  if (message?.type === AUTOPAGER_REPORT_TYPE) {
    return handleAutoPagerCompatibilityReport(message, sender);
  }

  if (message?.type === OWN_AUTOPAGER_STATUS_TYPE) {
    return handleOwnAutoPagerStatus(message, sender);
  }

  if (message?.type === INTERNAL_CACHE_QUERY_TYPE) {
    return handleInternalCacheQuery(message, sender);
  }

  if (message?.type === AUTOPAGER_PAGE_SESSION_STARTED_TYPE) {
    scheduleBackgroundTask(message, sender, async () => {
      await handleAutoPagerPageSessionStarted(message, sender);
      await handlePageSessionStarted(message, sender);
      const state = await refreshAccountScheduleFromTabs({ reason: 'page-session-started' });
      triggerPreloadForPage(message, sender);
      triggerPageOpenDawnCheck(sender);
      await syncBackgroundDawnAlarm(state.settings);
      await maybeRunRuntimeCleanupOnWake('page-session-started');
    }, PAGE_SESSION_BACKGROUND_DELAY_MS);
    return { ok: true, accepted: true };
  }

  if (message?.type === 'EHPLUS_PAGE_TITLES_OBSERVED') {
    return handlePageTitlesObserved(message, sender);
  }

  if (message?.type === 'EHPLUS_HISTORY_LIST') {
    return handleHistoryList(message);
  }

  if (message?.type === 'EHPLUS_HISTORY_DELETE') {
    return handleHistoryDelete(message, sender);
  }

  if (message?.type === 'EHPLUS_HISTORY_CLEAR') {
    return handleHistoryClear(sender);
  }

  if (message?.type === 'EHPLUS_OPEN_HISTORY') {
    const url = chrome.runtime.getURL('history.html');
    const existingTabs = await chrome.tabs.query({ url });
    if (existingTabs.length > 0) {
      await chrome.tabs.update(existingTabs[0].id, { active: true });
      if (existingTabs[0].windowId != null) {
        await chrome.windows.update(existingTabs[0].windowId, { focused: true }).catch(() => {});
      }
    } else {
      await chrome.tabs.create({ url });
    }
    return { ok: true };
  }

  if (message?.type === 'EHPLUS_EXTERNAL_IMAGE_CACHE_FILL') {
    return handleExternalImageCacheFill(message, sender);
  }

  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_BLOCK') {
    return handleReaderCacheFirstBlockMessage(message, sender);
  }

  if (message?.type === 'EHPLUS_READER_CACHE_FIRST_TIMING') {
    return handleReaderCacheFirstTiming(message, sender);
  }

  if (message?.type === 'EHPLUS_GET_STATE') {
    // 面板轮询走内存态；后台缓存态同步限流，避免每次 GET_STATE 都全量扫库。
    scheduleBackgroundTask({ type: 'EHPLUS_PRELOAD_CACHE_STATE_SYNC' }, sender, () => syncPreloadCacheState({ maxAgeMs: 4000 }), STATE_BACKGROUND_SYNC_DELAY_MS);
    return { ok: true, state: attachPreloadLive(await getState()) };
  }

  if (message?.type === 'EHPLUS_POPUP_OPENED') {
    const state = await updateState((current) => addLog({
      ...current,
      lastPopupOpenedAt: Date.now(),
      counters: {
        ...current.counters,
        popupOpenCount: current.counters.popupOpenCount + 1
      }
    }, {
      level: 'debug',
      event: 'popup.opened',
      action: 'render-popup',
      message: 'Popup 已打开',
      sender,
      context: {
        popupOpenCount: current.counters.popupOpenCount + 1,
        visibleLanguage: current.settings.language
      },
      result: {
        ok: true
      }
    }));
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_OPEN_DIRECTORY_PICKER') {
    return handleOpenDirectoryPicker(sender);
  }

  if (message?.type === 'EHPLUS_DIRECTORY_SELECTED') {
    return handleDirectorySelected(message, sender);
  }

  if (message?.type === 'EHPLUS_DIRECTORY_SWITCH_RESPONSE') {
    return handleDirectorySwitchResponse(message, sender);
  }

  if (message?.type === 'EHPLUS_DISMISS_DIRECTORY_AUTHORIZATION_NOTICE') {
    const state = await updateState((current) => ({
      ...current,
      runtime: dismissDirectoryAuthorizationNotice(current.runtime)
    }));
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_UPDATE_SETTINGS') {
    const incoming = sanitizeSettings(message.settings ?? {});
    const state = await updateState((current) => {
      const nextSettings = normalizeSettings({
        ...current.settings,
        ...incoming,
        settingsVersion: SETTINGS_VERSION
      });
      const next = {
        ...current,
        settings: nextSettings,
        runtime: nextSettings.autoPagerEnabled === true
          ? current.runtime
          : resetOwnAutoPagerStatus(current.runtime)
      };
      return addLog(next, {
        level: 'info',
        event: 'settings.update',
        action: 'apply-settings-immediately',
        message: '设置已立即生效',
        sender,
        context: {
          changedKeys: Object.keys(incoming),
          nextSettings: incoming
        },
        result: {
          ok: true,
          persisted: true
        }
      }, nextSettings);
    });
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_REFRESH_ACCOUNT') {
    const requestOptions = await logRequestOptions();
    const account = await readLiveAccountStatus(sender, requestOptions);
    const state = await applyAccountRefreshResult(account, sender, 'manual');
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_RESET_QUOTA_PREPARE') {
    const token = createRequestId('quota');
    const requestOptions = await logRequestOptions();
    const account = await readLiveAccountStatus(sender, requestOptions);
    const state = await updateState((current) => {
      const before = accountBalances(account);
      return addLog({
        ...current,
        account: {
          ...current.account,
          ...pickAccountStatus(account),
          resetPrepare: {
            token,
            nominalGp: account.resetCostGp,
            before,
            preparedAt: Date.now(),
            expiresAt: Date.now() + 15000
          }
        },
        counters: bumpRequest(current.counters)
      }, {
        level: 'info',
        event: 'quota-reset.prepare',
        action: 'prepare-reset-quota-live',
        message: '已读取真实账号状态并准备限额重置确认',
        sender,
        requestId: token,
        context: {
          officialPostBody: RESET_QUOTA_BODY,
          origin: account.origin,
          before,
          requestDetails: account.requestDetails
        },
        result: {
          nominalGp: account.resetCostGp,
          confirmationRequired: true
        }
      });
    });
    return { ok: true, state, token };
  }

  if (message?.type === 'EHPLUS_RESET_QUOTA_CONFIRM') {
    const current = await getState();
    const prepare = current.account.resetPrepare;
    const expired = Boolean(prepare) && Number.isFinite(Number(prepare.expiresAt)) && Date.now() > Number(prepare.expiresAt);
    if (!prepare || prepare.token !== message.token || expired) {
      const reason = expired ? 'confirm-expired' : 'invalid-token';
      const state = await updateState((item) => addLog({
        ...item,
        account: {
          ...item.account,
          resetPrepare: expired ? null : item.account.resetPrepare
        }
      }, {
        level: 'warning',
        event: 'quota-reset.confirm',
        action: 'confirm-reset-quota-live',
        message: '限额重置确认已过期或无效',
        sender,
        context: {
          token: message.token,
          expiresAt: prepare?.expiresAt ?? null
        },
        result: {
          ok: false,
          reason
        }
      }));
      return { ok: false, state, error: reason };
    }

    const before = prepare.before;
    const requestOptions = logOptionsFromSettings(current.settings);
    const postResult = await postLiveQuotaReset(sender, requestOptions);
    const account = await readLiveAccountStatus(sender, requestOptions);
    const after = accountBalances(account);
    const delta = calculateBalanceDelta(before, after);
    const lastReset = {
      ok: true,
      at: Date.now(),
      nominalGp: prepare.nominalGp,
      before,
      after,
      delta,
      showActualCost: shouldShowActualCost({ nominalGp: prepare.nominalGp, delta }),
      message: '已成功重置限额'
    };
    const state = await updateState((item) => addLog({
      ...item,
      account: {
        ...item.account,
        ...pickAccountStatus(account),
        resetPrepare: null,
        lastReset
      },
      counters: bumpRequest(item.counters)
    }, {
      level: 'info',
      event: 'quota-reset.confirm',
      action: 'confirm-reset-quota-live',
      message: '限额重置已完成',
      sender,
      requestId: prepare.token,
      context: {
        officialPostBody: RESET_QUOTA_BODY,
        postUrl: postResult.url,
        before,
        requestDetails: [
          ...(postResult.requestDetails ?? []),
          ...(account.requestDetails ?? [])
        ]
      },
      result: lastReset
    }));
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_RESET_QUOTA_CANCEL') {
    const state = await updateState((current) => addLog({
      ...current,
      account: {
        ...current.account,
        resetPrepare: null
      }
    }, {
      level: 'info',
      event: 'quota-reset.cancel',
      action: 'cancel-reset-quota',
      message: '已取消限额重置确认',
      sender,
      context: {
        token: message.token
      },
      result: {
        ok: true
      }
    }));
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_RUN_DAWN') {
    const state = await runDawnCheck(sender, 'manual');
    return { ok: true, state };
  }

  if (message?.type === 'EHPLUS_CLEANUP_PREVIEW') {
    const request = normalizeCleanupRequest(message, null);
    const current = await getState();
    const preview = await buildCleanupPreview(current, request);
    const state = await updateState((current) => addLog({
      ...current,
      cleanup: {
        ...current.cleanup,
        lastPreview: preview
      }
    }, {
      level: 'info',
      event: 'cleanup.preview',
      action: 'preview-cleanup',
      message: '已生成清理预估',
      sender,
      context: request,
      result: preview
    }));
    return { ok: true, state, preview };
  }

  if (message?.type === 'EHPLUS_CLEANUP_CONFIRM') {
    const request = normalizeCleanupRequest(message, null);
    const current = await getState();
    const result = await cleanupActiveStorage(current, request);
    cooperativeCacheRecords = [];
    cooperativeCacheRecordsSyncedAt = 0;
    const state = await updateState((current) => addLog(applyCleanupResult(current, result), {
      level: 'info',
      event: 'cleanup.confirm',
      action: 'confirm-cleanup',
      message: '清理操作已完成',
      sender,
      context: request,
      result
    }));
    await syncPreloadCacheState();
    return { ok: true, state, result };
  }

  if (message?.type === 'EHPLUS_RUN_MIGRATION') {
    const deleteOldCache = Boolean(message.deleteOldCacheAfterMigration);
    if (migrationRunState.running) {
      return { ok: true, accepted: true, alreadyRunning: true, state: await getState() };
    }

    // 迁移放后台跑：条目多时远超消息 5s 超时；进度写入 state.migration，
    // 浮窗轮询 EHPLUS_GET_STATE 展示“已迁移 x / y”，可随时 EHPLUS_CANCEL_MIGRATION。
    const state = await updateState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        directoryCacheEnabled: true,
        storageMode: 'directory',
        directoryLabel: current.settings.directoryLabel,
        deleteOldCacheAfterMigration: deleteOldCache
      },
      migration: {
        ...current.migration,
        status: 'running',
        totalCount: 0,
        migratedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        progressUpdatedAt: Date.now(),
        lastError: ''
      }
    }));

    scheduleBackgroundTask({ type: 'EHPLUS_RUN_MIGRATION_BACKGROUND' }, sender, async () => {
      const result = await migrateIndexedDbCacheToDirectory({ deleteOldCache });
      await updateState((current) => {
        return addLog({
          ...current,
          migration: {
            ...current.migration,
            status: migrationResultStatus(result),
            targetDirectoryLabel: current.settings.directoryLabel || current.migration.targetDirectoryLabel,
            oldCacheCount: result.oldCacheCount,
            oldCacheBytes: result.oldCacheBytes,
            totalCount: result.totalCount ?? current.migration.totalCount,
            migratedCount: result.migratedCount,
            skippedCount: result.skippedCount ?? 0,
            failedCount: result.failedCount,
            deletedOldCache: result.deletedOldCache === true,
            lastRunAt: Date.now(),
            progressUpdatedAt: Date.now(),
            lastError: result.ok || result.cancelled ? '' : (result.error ?? 'migration failed')
          }
        }, {
          level: result.ok ? 'info' : (result.cancelled ? 'warn' : 'error'),
          event: 'migration.run',
          action: 'run-directory-migration',
          message: result.ok ? '授权目录迁移完成' : (result.cancelled ? '授权目录迁移已取消' : '授权目录迁移失败'),
          sender,
          context: {
            source: 'IndexedDB/Blob',
            target: current.settings.directoryLabel || current.migration.targetDirectoryLabel,
            deleteOldCacheAfterMigration: deleteOldCache
          },
          result: {
            ...result,
            failures: (result.failures ?? []).slice(0, 5)
          }
        });
      });
      await syncPreloadCacheState();
    }, 0);

    return { ok: true, accepted: true, state };
  }

  if (message?.type === 'EHPLUS_CANCEL_MIGRATION') {
    const accepted = requestMigrationCancel();
    if (!accepted) {
      return { ok: true, accepted: false, running: false, state: await getState() };
    }
    const state = await updateState((current) => ({
      ...current,
      migration: {
        ...current.migration,
        status: 'cancelling',
        progressUpdatedAt: Date.now()
      }
    }));
    return { ok: true, accepted: true, running: true, state };
  }

  if (message?.type === 'EHPLUS_EXPORT_DEBUG') {
    const current = await getState();
    const logs = await readRuntimeLogs(current.settings);
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      mode: current.mode,
      settings: current.settings,
      account: current.account,
      storage: current.storage,
      stats: current.stats,
      dawn: current.dawn,
      migration: current.migration,
      cleanup: current.cleanup,
      logs: logs.slice(0, 120)
    };
    const state = await updateState((item) => addLog(item, {
      level: 'info',
      event: 'diagnostics.export',
      action: 'export-diagnostics-state',
      message: '已导出诊断状态',
      sender,
      context: {
        logCount: exportPayload.logs.length
      },
      result: {
        ok: true
      }
    }));
    return { ok: true, state, export: exportPayload };
  }

  if (message?.type === 'EHPLUS_CHECK_UPDATE') {
    return runUpdateCheck(sender, { reason: 'manual', force: true });
  }

  if (message?.type === 'EHPLUS_CHECK_UPDATE_IF_DUE') {
    const current = await getState();
    const lastCheckedAt = current.about?.lastUpdateCheck?.checkedAt ?? 0;
    const due = Date.now() - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
    if (!due) {
      return {
        ok: true,
        skipped: true,
        state: current,
        result: current.about?.lastUpdateCheck ?? null
      };
    }
    return runUpdateCheck(sender, { reason: 'scheduled-7d', force: false });
  }

  if (message?.type === 'EHPLUS_DOWNLOAD_UPDATE') {
    const url = String(message.url ?? '');
    if (!isAllowedGithubDownloadUrl(url)) {
      const result = {
        ok: false,
        message: '下载地址不是允许的 GitHub Release 地址',
        url
      };
      const state = await updateState((current) => addLog(current, {
        level: 'warning',
        event: 'about.download-update',
        action: 'download-github-release',
        message: result.message,
        sender,
        context: {
          url
        },
        result
      }));
      return { ok: true, state, result };
    }

    const downloadId = await chrome.downloads.download({
      url,
      saveAs: true
    });
    const result = {
      ok: true,
      message: '已开始下载 GitHub Release 文件',
      url,
      downloadId
    };
    const state = await updateState((current) => addLog(current, {
      level: 'info',
      event: 'about.download-update',
      action: 'download-github-release',
      message: result.message,
      sender,
      context: {
        url
      },
      result
    }));
    return { ok: true, state, result };
  }

  if (message?.type === 'EHPLUS_UPDATE_FLOATING_PANEL') {
    const state = await updateState((current) => addLog({
      ...current,
      floatingPanel: {
        ...current.floatingPanel,
        ...(message.panel ?? {})
      }
    }, {
      level: 'debug',
      event: 'floating-panel.update',
      action: 'persist-floating-panel',
      message: '浮窗状态已更新',
      sender,
      context: {
        panel: message.panel ?? {}
      },
      result: {
        ok: true
      }
    }));
    return { ok: true, state };
  }

  return { ok: false, error: `Unsupported message type: ${message?.type ?? 'unknown'}` };
}

function scheduleBackgroundTask(message, sender, task, delayMs = 0) {
  setTimeout(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        appendErrorLog(message, sender, error).catch(() => {});
      });
  }, Math.max(0, delayMs));
}

async function handleOpenDirectoryPicker(sender) {
  pendingDirectoryPickerTabId = sender?.tab?.id ?? null;
  pendingDirectorySwitchSnapshot = null;
  const before = await getState();
  if (before.settings.storageMode === 'directory' && before.settings.directoryLabel) {
    try {
      const record = await loadDirectoryHandleRecord();
      if (record?.handle) {
        const store = await createDirectoryPreloadStore(record.handle);
        const summary = summarizePreloadRecords(await store.list());
        if ((summary.cacheRecords ?? 0) > 0 || (summary.imageBytes ?? 0) > 0) {
          pendingDirectorySwitchSnapshot = {
            fromLabel: before.settings.directoryLabel,
            fromHandleRecord: record,
            fromCacheCount: summary.cacheRecords,
            fromCacheBytes: summary.imageBytes
          };
        }
      }
    } catch {
      pendingDirectorySwitchSnapshot = null;
    }
  }
  if (!chrome.windows?.create) {
    return { ok: false, error: 'directory picker window is unavailable' };
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL('directory-picker.html'),
    type: 'popup',
    width: 520,
    height: 360,
    focused: true
  });
  return { ok: true, pickerOpened: true, state: await getState() };
}

async function handleDirectorySelected(message, sender) {
  const label = typeof message.label === 'string' ? message.label.slice(0, 260) : '';
  const selectedAt = Number.isFinite(message.selectedAt) ? message.selectedAt : Date.now();
  const before = await getState();
  const selectedHandle = await loadWritableDirectoryHandle({ refresh: true });
  if (!selectedHandle) {
    return { ok: false, error: 'directory-not-authorized' };
  }
  const snapshot = pendingDirectorySwitchSnapshot;
  pendingDirectorySwitchSnapshot = null;

  if (snapshot?.fromLabel && snapshot.fromLabel !== label) {
    pendingDirectorySwitchRequest = {
      fromLabel: snapshot.fromLabel,
      toLabel: label,
      selectedAt,
      snapshot,
      sender
    };
    await notifyDirectorySwitchConfirm(snapshot.fromLabel, label);
    return {
      ok: true,
      pendingConfirmation: true,
      fromLabel: snapshot.fromLabel,
      toLabel: label
    };
  }

  scheduleBackgroundTask({
    type: 'EHPLUS_DIRECTORY_SELECTION_FINALIZE',
    label,
    selectedAt
  }, sender, () => finalizeDirectorySelection({
    label,
    selectedAt,
    before,
    sender
  }), DIRECTORY_SELECTION_BACKGROUND_DELAY_MS);

  return {
    ok: true,
    accepted: true,
    migrationPending: true,
    label
  };
}

async function handleDirectorySwitchResponse(message, sender) {
  const pending = pendingDirectorySwitchRequest;
  if (!pending) {
    return { ok: false, error: 'no-pending-directory-switch' };
  }

  pendingDirectorySwitchRequest = null;
  if (message?.confirmed !== true) {
    await saveDirectoryHandle(pending.snapshot.fromHandleRecord.handle, {
      label: pending.snapshot.fromLabel
    });
    const state = await getState();
    await notifyDirectorySelected(state);
    return { ok: true, cancelled: true, state };
  }

  const before = await getState();
  const newHandle = await loadWritableDirectoryHandle();
  if (!newHandle) {
    return { ok: false, error: 'directory-not-authorized' };
  }

  scheduleBackgroundTask({
    type: 'EHPLUS_DIRECTORY_SWITCH_FINALIZE',
    label: pending.toLabel,
    selectedAt: pending.selectedAt
  }, pending.sender ?? sender, async () => {
    const migrationResult = await migrateDirectoryCacheToDirectory(
      pending.snapshot.fromHandleRecord.handle,
      newHandle,
      { deleteOldCache: before.settings.deleteOldCacheAfterMigration === true }
    );
    await finalizeDirectorySelection({
      label: pending.toLabel,
      selectedAt: pending.selectedAt,
      before,
      sender: pending.sender ?? sender,
      migrationResult,
      migrationSourceLabel: pending.fromLabel
    });
  }, DIRECTORY_SELECTION_BACKGROUND_DELAY_MS);

  return {
    ok: true,
    accepted: true,
    migrationPending: true,
    label: pending.toLabel
  };
}

async function finalizeDirectorySelection({
  label,
  selectedAt,
  before,
  sender,
  migrationResult = null,
  migrationSourceLabel = ''
}) {
  const result = migrationResult ?? await migrateIndexedDbCacheToDirectory({
    deleteOldCache: before.settings.deleteOldCacheAfterMigration === true
  });
  const state = await updateState((current) => addLog({
    ...current,
    settings: normalizeSettings({
      ...current.settings,
      storageMode: 'directory',
      directoryCacheEnabled: true,
      directoryLabel: label,
      settingsVersion: SETTINGS_VERSION
    }),
    runtime: applyDirectoryAuthorizationRuntime(current.runtime, {
      requestedMode: 'directory',
      directoryLabel: label,
      writable: true
    }),
    migration: {
      ...current.migration,
      status: migrationResultStatus(result),
      targetDirectoryLabel: label,
      oldCacheCount: result.oldCacheCount,
      oldCacheBytes: result.oldCacheBytes,
      totalCount: result.totalCount ?? current.migration.totalCount,
      migratedCount: result.migratedCount,
      skippedCount: result.skippedCount ?? 0,
      failedCount: result.failedCount,
      deletedOldCache: result.deletedOldCache,
      lastRunAt: selectedAt,
      progressUpdatedAt: Date.now(),
      lastError: result.ok || result.cancelled ? '' : (result.error ?? 'migration failed')
    }
  }, {
    level: result.ok ? 'info' : (result.cancelled ? 'warn' : 'error'),
    event: 'storage.directory',
    action: migrationSourceLabel ? 'switch-and-migrate-directory-storage' : 'authorize-and-migrate-directory-storage',
    message: result.ok
      ? migrationSourceLabel
        ? `已将 ${migrationSourceLabel} 的缓存迁移到 ${label}`
        : '自定义存储目录已授权，缓存已切换并迁移到该目录'
      : result.cancelled
        ? `目录已切换到 ${label}，迁移被手动取消（可重试续迁）`
        : migrationSourceLabel
          ? `目录已切换到 ${label}，但旧目录缓存迁移失败`
          : '自定义存储目录已授权，但旧缓存迁移失败',
    sender,
    context: {
      label,
      sourceLabel: migrationSourceLabel || 'IndexedDB/Blob'
    },
    result: {
      ...result,
      failures: (result.failures ?? []).slice(0, 5),
      storageMode: 'directory'
    }
  }));
  await syncPreloadCacheState();
  await notifyDirectorySelected(state);
  return { ok: true, state };
}

async function migrateDirectoryCacheToDirectory(fromHandle, toHandle, { deleteOldCache = false } = {}) {
  try {
    const source = await createDirectoryPreloadStore(fromHandle);
    const target = await createDirectoryPreloadStore(toHandle);
    return await migratePreloadRecordsToStore(source, target, { deleteOldCache });
  } catch (error) {
    return emptyMigrationResult(error?.message ?? String(error));
  }
}

async function notifyDirectorySwitchConfirm(fromLabel, toLabel) {
  const tabId = pendingDirectoryPickerTabId;
  if (tabId == null || !chrome.tabs?.sendMessage) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'EHPLUS_DIRECTORY_SWITCH_CONFIRM',
      fromLabel,
      toLabel
    });
  } catch {
    // The source tab may have navigated away.
  }
}

async function notifyDirectorySelected(state) {
  const tabId = pendingDirectoryPickerTabId;
  pendingDirectoryPickerTabId = null;
  if (tabId == null || !chrome.tabs?.sendMessage) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'EHPLUS_DIRECTORY_SELECTED',
      state
    });
  } catch {
    // The source tab may have navigated away.
  }
}

async function handleReaderCacheFirstBlockMessage(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'missing-tab-id' };
  }
  if (message.action === 'release') {
    releaseReaderCacheFirstBlock(tabId).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_RELEASE', tabId }, sender, error).catch(() => {});
    });
    return { ok: true, blocked: false, accepted: true };
  }
  if (message.action === 'ensure') {
    const state = await withTimeout(getState(), 150, null);
    if (!state && !isReaderPageUrlForCacheFirst(message.url || sender?.tab?.url)) {
      releaseReaderCacheFirstBlock(tabId).catch((error) => {
        appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_RELEASE_AFTER_STATE_TIMEOUT', tabId }, sender, error).catch(() => {});
      });
      return { ok: false, blocked: false, error: 'state-timeout' };
    }
    const effectiveState = state ?? { settings: { readerCacheFirstEnabled: true } };
    if (effectiveState.settings?.readerCacheFirstEnabled !== true || !isReaderPageUrlForCacheFirst(message.url || sender?.tab?.url)) {
      releaseReaderCacheFirstBlock(tabId).catch((error) => {
        appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_RELEASE_AFTER_DISABLED', tabId }, sender, error).catch(() => {});
      });
      return { ok: true, blocked: false, reason: 'disabled-or-not-reader' };
    }
    ensureReaderCacheFirstBlock(tabId, effectiveState).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_ENSURE', tabId }, sender, error).catch(() => {});
    });
    return {
      ok: true,
      blocked: true,
      ruleId: readerCacheFirstBlockRuleId(tabId),
      accepted: true,
      deferred: state === null
    };
  }
  return { ok: false, error: 'unsupported-cache-first-block-action' };
}

async function ensureReaderCacheFirstBlock(tabId, state = null) {
  if (!Number.isInteger(tabId) || !chrome.declarativeNetRequest?.updateSessionRules) return;
  const current = state ?? await withTimeout(getState(), 150, { settings: { readerCacheFirstEnabled: true } });
  if (current.settings?.readerCacheFirstEnabled !== true) {
    await releaseReaderCacheFirstBlock(tabId);
    return;
  }

  const ruleId = readerCacheFirstBlockRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: READER_CACHE_FIRST_PLACEHOLDER_PATH
        }
      },
      condition: {
        tabIds: [tabId],
        regexFilter: '^https://[^/:]+\\.hath\\.network(?::[0-9]+)?/',
        resourceTypes: ['image']
      }
    }]
  });
  scheduleReaderCacheFirstBlockAutoRelease(tabId);
}

async function releaseReaderCacheFirstBlock(tabId) {
  if (!Number.isInteger(tabId) || !chrome.declarativeNetRequest?.updateSessionRules) return;
  clearReaderCacheFirstBlockAutoRelease(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [readerCacheFirstBlockRuleId(tabId)]
  });
}

function scheduleReaderCacheFirstBlockAutoRelease(tabId) {
  clearReaderCacheFirstBlockAutoRelease(tabId);
  const timer = setTimeout(() => {
    readerCacheFirstBlockReleaseTimers.delete(tabId);
    releaseReaderCacheFirstBlock(tabId).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_READER_CACHE_FIRST_BLOCK_AUTO_RELEASE', tabId }, null, error).catch(() => {});
    });
  }, READER_CACHE_FIRST_BLOCK_AUTO_RELEASE_MS);
  readerCacheFirstBlockReleaseTimers.set(tabId, timer);
}

function clearReaderCacheFirstBlockAutoRelease(tabId) {
  const timer = readerCacheFirstBlockReleaseTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  readerCacheFirstBlockReleaseTimers.delete(tabId);
}

function readerCacheFirstBlockRuleId(tabId) {
  return READER_CACHE_FIRST_BLOCK_RULE_BASE_ID + (Number(tabId) % 100000);
}

function isReaderPageUrlForCacheFirst(url) {
  try {
    const parsed = new URL(url);
    return /^(e-hentai\.org|exhentai\.org)$/.test(parsed.hostname)
      && /^\/s\/[^/]+\/\d+-\d+\/?$/.test(parsed.pathname)
      && !parsed.searchParams.has('nl');
  } catch {
    return false;
  }
}

async function handleReaderCacheFirstTiming(message, sender) {
  const state = await updateState((current) => addLog(current, {
    level: message.result === 'hit' ? 'info' : 'debug',
    event: 'reader-cache-first.timing',
    action: 'record-reader-cache-first-timing',
    message: message.result === 'hit' ? 'reader cache-first 命中耗时已记录' : 'reader cache-first 回退耗时已记录',
    sender,
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
      networkBlock: String(message.networkBlock ?? '').slice(0, 80)
    },
    result: {
      ok: true,
      timing: normalizeTimingPayload(message.timing),
      startedAt: finiteNumberOrNull(message.startedAt),
      finishedAt: finiteNumberOrNull(message.finishedAt),
      durationMs: durationFromTimestamps(message.startedAt, message.finishedAt),
      indexReadOk: message.indexReadOk === true,
      imageLoadOk: message.imageLoadOk === true,
      indexReadError: String(message.indexReadError ?? '').slice(0, 180),
      imageLoadResult: String(message.imageLoadResult ?? '').slice(0, 80),
      fallbackRequestResult: String(message.fallbackRequestResult ?? '').slice(0, 80),
      originalSrc: String(message.originalSrc ?? '').slice(0, 240),
      finalSrc: String(message.finalSrc ?? '').slice(0, 240)
    }
  }));

  return { ok: true, logged: true, logCount: state.storage?.logCount ?? 0 };
}

async function handleExternalMessage(message, sender) {
  if (isCooperativeCacheQuery(message)) {
    return handleCooperativeCacheQuery(message, sender);
  }

  return {
    ok: false,
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    error: `Unsupported external message type: ${message?.type ?? 'unknown'}`
  };
}

async function handleCooperativeCacheQuery(message, sender) {
  const statsMode = resolveCooperativeStatsMode(message);
  const shouldFastRespond = message?.fastResponse === true
    && message?.requestedBy === 'EH＋-content';
  if (shouldFastRespond) {
    const startedAt = Date.now();
    const fastCache = cooperativeCacheRecords.length > 0
      ? { records: cooperativeCacheRecords, store: null, timing: fastCacheTiming({ source: 'memory' }) }
      : await withTimeout(
        loadFastCooperativeCacheRecords(message),
        FAST_CACHE_RESPONSE_TIMEOUT_MS,
        fastCacheTimeoutFallback(startedAt)
      );
    const response = await withTimeout(buildHydratedCooperativeCacheResponse(fastCache.records, message, {
      store: fastCache.store,
      timing: fastCache.timing,
      enabled: true
    }), Math.max(250, FAST_CACHE_RESPONSE_TIMEOUT_MS - (Date.now() - startedAt)), null)
      ?? attachCooperativeTiming(buildCooperativeCacheResponse([], message, { enabled: true }), {
        ...fastCache.timing,
        imageLoadOk: false,
        indexReadOk: false,
        indexReadError: fastCache.timing?.indexReadError || 'fast-response-timeout'
      });
    // 快速路径先回包，统计在后台补记（读取本地缓存也算一次图片访问）。
    scheduleFastCacheStatsUpdate(response, message, sender, statsMode);
    return {
      ...response,
      timing: {
        ...response.timing,
        totalMs: Date.now() - startedAt
      },
      countsAsCacheHit: statsMode !== 'none' && response.countsAsCacheHit === true,
      fastResponse: true
    };
  }

  await syncPreloadCacheState({
    skipStateUpdate: false,
    maxAgeMs: 1500
  });
  const current = await getState();
  const response = buildCooperativeCacheResponse(cooperativeCacheRecords, message, {
    enabled: current.settings.blobCacheEnabled !== false
  });

  const state = await updateCooperativeCacheStatsAndLog(response, message, sender, statsMode);
  return {
    ...response,
    countsAsCacheHit: statsMode !== 'none' && response.countsAsCacheHit === true,
    stats: {
      readerReads: state.stats.readerReads,
      readerHits: state.stats.readerHits,
      galleryReads: state.stats.galleryReads,
      galleryResourceReads: state.stats.galleryResourceReads
    }
  };
}

// 统计口径（规划 §10/§941）：
// - none：内容脚本明确声明不计（画廊缩略图替换等）。
// - hit-only：访问已由页面会话计数（/s/ cache-first 主图查询），这里只补命中。
// - full：读取尝试与命中都计（外部 API、自动翻页拼接页等独立图片访问）。
function resolveCooperativeStatsMode(message) {
  const fromContent = message?.requestedBy === 'EH＋-content';
  if (!fromContent) return 'full';
  if (message?.countStats === false) return 'none';
  if (message?.statsScope === 'hit-only') return 'hit-only';
  return 'full';
}

function applyCooperativeStatsDeltaWithMode(stats, response, statsMode) {
  if (statsMode === 'none') return stats;
  if (statsMode === 'full') return applyCooperativeStatsDelta(stats, response);
  if (!(response?.hit === true && response.countsAsCacheHit === true)) return stats;
  if (response.cacheType === COOPERATIVE_CACHE_TYPES.READER) {
    return {
      ...stats,
      readerHits: (stats?.readerHits ?? 0) + 1
    };
  }
  if (response.cacheType === COOPERATIVE_CACHE_TYPES.GALLERY
    || response.cacheType === COOPERATIVE_CACHE_TYPES.RESOURCE) {
    return {
      ...stats,
      galleryResourceReads: (stats?.galleryResourceReads ?? 0) + 1
    };
  }
  return stats;
}

function scheduleFastCacheStatsUpdate(response, message, sender, statsMode) {
  if (statsMode === 'none') return;
  const isHit = response?.hit === true;
  // hit-only 未命中无事可做；full 模式未命中但无 cacheType（无效查询）也无事可做。
  if (statsMode === 'hit-only' && !isHit) return;
  if (statsMode === 'full' && !isHit && !response?.cacheType) return;
  scheduleBackgroundTask(message, sender, async () => {
    if (isHit) {
      await touchCacheRecordFromResponse(response, { cacheHit: true });
    }
    await updateState((current) => ({
      ...current,
      stats: applyCooperativeStatsDeltaWithMode(current.stats, response, statsMode)
    }));
  }, 0);
}

async function handleInternalCacheQuery(message, sender) {
  return handleCooperativeCacheQuery({
    ...message,
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    requestedBy: 'EH＋-content',
    // 内部查询默认不计统计；调用方明确要求时（如 /s/ 拼接页）按完整口径计。
    countStats: message?.countStats === true,
    fastResponse: true
  }, sender);
}

async function loadFastCooperativeCacheRecords(message) {
  const timing = fastCacheTiming({ source: 'storage' });
  const startedAt = Date.now();
  try {
    const storeStartedAt = Date.now();
    const store = await withTimeout(createFastPreloadStore(), FAST_CACHE_STORE_TIMEOUT_MS, null);
    timing.storeOpenMs = Date.now() - storeStartedAt;
    if (!store) {
      timing.indexReadOk = false;
      timing.indexReadError = 'store-timeout';
      timing.indexReadMs = Date.now() - startedAt;
      return { records: [], store: null, timing };
    }
    const records = [];
    const seen = new Set();
    const addRecord = (record) => {
      const key = record?.pageKey ?? record?.resourceKey ?? record?.imageUrl ?? '';
      if (!record || seen.has(key)) return;
      seen.add(key);
      records.push(record);
    };

    const pageKey = resolveCooperativePageKey(message);
    const resourceKey = normalizeResourceUrl(message?.imageUrl ?? message?.resourceUrl);
    const reads = [];
    if (pageKey && typeof store.get === 'function') {
      reads.push((async () => {
        const pageStartedAt = Date.now();
        const pageRecord = await withTimeout(store.get(pageKey), FAST_CACHE_RECORD_TIMEOUT_MS, null);
        timing.pageIndexReadMs = Date.now() - pageStartedAt;
        return pageRecord;
      })());
    }
    if (resourceKey && typeof store.getByResourceKey === 'function') {
      reads.push((async () => {
        const resourceStartedAt = Date.now();
        const resourceRecord = await withTimeout(store.getByResourceKey(resourceKey), FAST_CACHE_RECORD_TIMEOUT_MS, null);
        timing.resourceIndexReadMs = Date.now() - resourceStartedAt;
        return resourceRecord;
      })());
    }
    const indexRecords = await Promise.all(reads);
    for (const record of indexRecords) addRecord(record);

    timing.indexReadMs = Date.now() - startedAt;
    timing.indexReadOk = true;
    timing.indexRecordsFound = records.length;
    return { records, store, timing };
  } catch (error) {
    timing.indexReadMs = Date.now() - startedAt;
    timing.indexReadOk = false;
    timing.indexReadError = error?.message ?? String(error);
    return { records: [], store: null, timing };
  }
}

function fastCacheTimeoutFallback(startedAt = Date.now()) {
  const timing = fastCacheTiming({ source: 'timeout' });
  timing.indexReadMs = Date.now() - startedAt;
  timing.indexReadOk = false;
  timing.indexReadError = 'fast-response-timeout';
  timing.indexRecordsFound = 0;
  return { records: [], store: null, timing };
}

async function buildHydratedCooperativeCacheResponse(records, message, options = {}) {
  if (options.enabled === false) {
    return attachCooperativeTiming(buildCooperativeCacheResponse(records, message, options), options.timing);
  }

  const query = normalizeCooperativeCacheQuery(message);
  if (!query.ok) {
    return attachCooperativeTiming(buildCooperativeCacheResponse(records, message, options), options.timing);
  }

  const hitSelectStartedAt = Date.now();
  const hit = findCooperativeCacheHit(records, query);
  if (options.timing) options.timing.hitSelectMs = Date.now() - hitSelectStartedAt;
  if (!hit) {
    return attachCooperativeTiming(buildCooperativeCacheResponseFromHit(null, query, options), options.timing);
  }

  const hydratedHit = await hydrateCooperativeCacheHit(hit, options.store, options.timing);
  return attachCooperativeTiming(buildCooperativeCacheResponseFromHit(hydratedHit, query, options), options.timing);
}

async function hydrateCooperativeCacheHit(record, store, timing = null) {
  if (!record || typeof store?.hydrate !== 'function') return record;
  const startedAt = Date.now();
  try {
    const hydrated = await withTimeout(store.hydrate(record), FAST_CACHE_RECORD_TIMEOUT_MS, record);
    if (timing) {
      timing.imageLoadMs = Date.now() - startedAt;
      timing.imageLoadOk = Boolean(hydrated?.dataUrl ?? hydrated?.blobUrl ?? hydrated?.cacheUrl ?? hydrated?.deliveryUrl);
    }
    return hydrated;
  } catch {
    if (timing) {
      timing.imageLoadMs = Date.now() - startedAt;
      timing.imageLoadOk = false;
    }
    return record;
  }
}

function fastCacheTiming(initial = {}) {
  return {
    unit: 'ms',
    source: initial.source ?? '',
    storeOpenMs: null,
    pageIndexReadMs: null,
    resourceIndexReadMs: null,
    indexReadMs: null,
    indexReadOk: null,
    indexReadError: null,
    indexRecordsFound: null,
    hitSelectMs: null,
    imageLoadMs: null,
    imageLoadOk: null,
    totalMs: null
  };
}

function attachCooperativeTiming(response, timing = null) {
  if (!timing) return response;
  return {
    ...response,
    timing: {
      ...timing
    }
  };
}

async function updateCooperativeCacheStatsAndLog(response, message, sender, statsMode = 'full') {
  if (response?.hit) {
    await touchCacheRecordFromResponse(response, { cacheHit: statsMode !== 'none' });
  }

  const watchInput = buildFrequentWatchInput(response, message);
  const state = await updateState((item) => {
    let stats = applyCooperativeStatsDeltaWithMode(item.stats, response, statsMode);
    if (watchInput) {
      stats = recordFrequentWatch(stats, watchInput);
    }
    return addLog({
      ...item,
      stats
    }, {
      level: response.hit ? 'info' : 'debug',
      event: 'cooperative-cache.query',
      action: 'answer-cooperative-cache-query',
      message: response.hit ? '合作式缓存查询命中' : '合作式缓存查询未命中',
      sender,
      context: {
        requestedBy: message?.requestedBy ?? '',
        responseMode: response.responseMode ?? message?.responseMode ?? 'url',
        cacheType: response.cacheType ?? null,
        pageKey: response.pageKey ?? null,
        galleryKey: response.galleryKey ?? null,
        resourceKey: response.resourceKey ?? null,
        statsMode
      },
      result: {
        ok: true,
        hit: response.hit,
        reason: response.reason,
        countsAsCacheHit: statsMode !== 'none' && response.countsAsCacheHit === true
      }
    });
  });

  return state;
}

async function handlePageSessionStarted(message, sender) {
  const page = classifyEhPage(message?.url);
  const state = await updateState((current) => {
    const resetResult = resetAutoPagerCompatibilityForPageSession(current.runtime, {
      ...message,
      tabId: sender?.tab?.id ?? null
    }, message.observedAt ?? Date.now());
    const runtime = resetResult.runtime;
    const watchInput = buildFrequentWatchInputFromPage(page, message);
    let stats = watchInput ? recordFrequentWatch(current.stats, watchInput) : current.stats;
    // 每次真实页面会话计一次访问：/s/ 计图片访问、/g/ 计画廊访问（无论是否命中缓存）。
    if (page?.type === 'reader') {
      stats = {
        ...stats,
        readerReads: (stats.readerReads ?? 0) + 1
      };
    } else if (page?.type === 'gallery') {
      stats = {
        ...stats,
        galleryReads: (stats.galleryReads ?? 0) + 1
      };
    }
    return addLog({
      ...current,
      runtime,
      stats
    }, {
      level: 'debug',
      event: 'preload.page-session',
      action: 'start-page-session',
      message: page ? '页面会话已记录，准备预加载' : '页面会话已记录，非预加载页面',
      sender,
      context: {
        page,
        autoPagerCompatibilityReset: resetResult.changed
      },
      result: {
        ok: true
      }
    });
  });

  scheduleBackgroundTask({ type: 'EHPLUS_PAGE_SESSION_CACHE_TOUCH', url: message?.url }, sender, async () => {
    if (page?.pageKey) {
      await touchCacheRecordAccess(page.pageKey, { cacheHit: false });
    } else if (page?.type === 'gallery' && page.galleryKey) {
      await touchGalleryRecordAccess(page);
    }
  });

  // 浏览历史只由真实页面会话产生（规划 §10 浏览历史）；
  // 合作查询、缩略图替换、外部补存、后台预加载都不会走到这里。
  scheduleBackgroundTask({ type: 'EHPLUS_PAGE_SESSION_HISTORY', url: message?.url }, sender, async () => {
    await recordBrowsingHistoryVisit(page, message);
  });

  return state;
}

async function handlePageTitlesObserved(message, sender) {
  const page = classifyEhPage(message?.url ?? sender?.tab?.url ?? '');
  const title = String(message?.title ?? '').trim();
  const originalTitle = String(message?.originalTitle ?? '').trim();
  const hasGalleryMeta = Boolean(message?.galleryMeta && typeof message.galleryMeta === 'object');
  if (!page || (!title && !originalTitle && !hasGalleryMeta)) {
    return { ok: true, updated: false };
  }

  if (title || originalTitle) {
    await updateState((current) => ({
      ...current,
      stats: updateFrequentWatchTitle(current.stats, {
        pageType: page.type === 'gallery' ? 'g' : 's',
        gid: page.gid,
        token: page.token,
        title: title || page.gid,
        originalTitle,
        galleryUrl: page.type === 'gallery' ? page.url : undefined,
        lastPageUrl: page.type === 'reader' ? page.url : undefined
      })
    }));
  }

  // 标题/元数据同步不增加历史访问次数。
  updateBrowsingHistoryMetadata(page, message).catch(() => {});

  return { ok: true, updated: true };
}

// 附加实时预加载计数（不落盘）：全局在途请求数 + 每个页面会话的排队数。
function attachPreloadLive(state) {
  const now = Date.now();
  for (const [sessionId, entry] of preloadLive.sessions) {
    if (now - (entry?.updatedAt ?? 0) > PRELOAD_LIVE_SESSION_TTL_MS) {
      preloadLive.sessions.delete(sessionId);
    }
  }
  const sessions = {};
  for (const [sessionId, entry] of preloadLive.sessions) {
    sessions[sessionId] = { pending: entry.pending ?? 0 };
  }
  return {
    ...state,
    preloadLive: {
      activeRequests: preloadLive.activeRequests,
      sessions
    }
  };
}

function reportPreloadLivePending(pageSessionId, pending) {
  if (!pageSessionId) return;
  preloadLive.sessions.set(pageSessionId, {
    pending: Math.max(0, Number(pending) || 0),
    updatedAt: Date.now()
  });
}

// 全局并发上限实时取自设置（内存态），修改设置后无需重启即生效；
// 实际闸门由 preloadScheduler（聚焦优先调度器）统一执行。
function globalPreloadConcurrencyLimit() {
  const limit = Number(stateMemoryCache?.settings?.globalConcurrency);
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 5;
}

function triggerPreloadForPage(message, sender) {
  runPreloadForPage(message, sender, { status: 'per-request-network-gate' })
    .catch((error) => {
      updateState((current) => addLog(current, {
        level: 'error',
        event: 'preload.run',
        action: 'run-page-preload',
        message: '预加载执行失败',
        sender,
        context: {
          url: message?.url
        },
        result: {
          ok: false,
          error: error?.message ?? String(error)
        }
      })).catch(() => {});
    });
}

function triggerPageOpenDawnCheck(sender) {
  setTimeout(() => {
    runPageOpenDawnCheck(sender).catch((error) => {
      appendErrorLog({ type: 'EHPLUS_PAGE_OPEN_DAWN' }, sender, error).catch(() => {});
    });
  }, 0);
}

async function runPageOpenDawnCheck(sender) {
  const state = await getState();
  if (state.settings.dawnEnabled !== true) return null;
  if (!isAfterDawnWindow()) return state;
  if (hasRunTodayAfterDawnWindow(state.dawn.lastRunAt)) return state;
  return runDawnCheck(sender, 'page-open');
}

async function runPreloadForPage(message, sender, detectionGate = null) {
  const current = await getState();
  const context = classifyEhPage(message?.url);
  if (!context) return null;

  // 多开页面时各页会话都允许预加载（规划 §953 聚焦优先，不再“最后会话独占”）；
  // 仅当发起页已翻页/导航（会话过期）时跳过。探测失败按放行兜底。
  const tabId = Number.isSafeInteger(sender?.tab?.id) ? sender.tab.id : null;
  if (tabId != null) {
    const probe = await queryPageNetworkActivity(tabId, {
      pageSessionId: message?.pageSessionId ?? '',
      pageUrl: message?.url ?? '',
      observedAt: Date.now()
    });
    if (probe?.pageSessionMatched === false) {
      return null;
    }
  }

  const store = await createManagedPreloadStore(current.settings);
  // 先等页面网络空闲，再过全局调度槽（聚焦标签优先），最后才真正发请求。
  // 并发上限实时取自设置（内存态），修改设置后无需重启即生效。
  const slotFetch = createPreloadSlotAwareFetch(fetch, {
    tabId,
    limit: globalPreloadConcurrencyLimit
  });
  const fetchImpl = createPreloadRequestGateFetch(slotFetch, ({ url }) => {
    return waitForPageNetworkIdleBeforePreload({ url, page: context, message, sender });
  });
  const reconcileQueue = tabId != null && context.type === 'reader'
    ? (queue) => reconcileReaderPreloadQueueWithTab(queue, { tabId, message })
    : undefined;
  const pageSessionId = message?.pageSessionId ?? '';
  const result = await runPreloadFromContext(context, current.settings, current.runtime, {
    store,
    fetchImpl,
    reconcileQueue,
    onProgress: (pending) => reportPreloadLivePending(pageSessionId, pending)
  });
  reportPreloadLivePending(pageSessionId, 0);
  await syncPreloadCacheState({ store });
  const state = await updateState((item) => addLog({
    ...item,
    counters: {
      ...item.counters,
      requestCount: (item.counters.requestCount ?? 0) + (result.completed ?? 0) + (result.failed ?? 0)
    }
  }, {
    level: result.failed ? 'error' : (result.skipped ? 'debug' : 'info'),
    event: 'preload.run',
    action: 'run-page-preload',
    message: preloadResultMessage(result),
    sender,
    context: {
      pageType: context.type,
      pageKey: context.pageKey ?? null,
      galleryKey: context.galleryKey ?? null,
      url: context.url,
      autoPagerDetectionGate: detectionGate,
      requestDetails: result.requestDetails ?? []
    },
    result: withoutRequestDetails(result)
  }));
  return { state, result };
}

// 全局预加载调度器（规划 §953）：全部页面共享 globalConcurrency 个请求槽，
// 聚焦标签页的请求优先获得空槽；切换页面只影响尚未发出的请求（等待者重排），
// 已发出的请求继续完成。聚焦信息不可用时人人平权（默认排序兜底），并有
// 等待超时强制放行，保证任何簿记异常都不会永久卡住预加载。
const PRELOAD_SLOT_WAIT_FAILSAFE_MS = 120000;
const preloadScheduler = {
  focusedTabId: null,
  inFlight: 0,
  limit: 5,
  waiters: []
};

function preloadSchedulerFocus(tabId) {
  preloadScheduler.focusedTabId = Number.isSafeInteger(tabId) ? tabId : null;
  wakePreloadWaiters();
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  preloadSchedulerFocus(activeInfo?.tabId ?? null);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId })
    .then((tabs) => {
      if (Number.isSafeInteger(tabs?.[0]?.id)) preloadSchedulerFocus(tabs[0].id);
    })
    .catch(() => {});
});

function preloadTabIsFocused(tabId) {
  return preloadScheduler.focusedTabId == null || tabId == null || tabId === preloadScheduler.focusedTabId;
}

function acquirePreloadSlot(tabId, limit) {
  const scheduler = preloadScheduler;
  scheduler.limit = normalizePositiveInteger(limit, 5);
  if (scheduler.inFlight < scheduler.limit && (preloadTabIsFocused(tabId) || scheduler.waiters.length === 0)) {
    scheduler.inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiter = { tabId, resolve, timer: 0 };
    waiter.timer = setTimeout(() => {
      const index = scheduler.waiters.indexOf(waiter);
      if (index >= 0) scheduler.waiters.splice(index, 1);
      scheduler.inFlight += 1;
      resolve();
    }, PRELOAD_SLOT_WAIT_FAILSAFE_MS);
    scheduler.waiters.push(waiter);
  });
}

function releasePreloadSlot() {
  const scheduler = preloadScheduler;
  scheduler.inFlight = Math.max(0, scheduler.inFlight - 1);
  wakePreloadWaiters();
}

function wakePreloadWaiters() {
  const scheduler = preloadScheduler;
  while (scheduler.inFlight < scheduler.limit && scheduler.waiters.length > 0) {
    let index = 0;
    if (scheduler.focusedTabId != null) {
      const focusedIndex = scheduler.waiters.findIndex(
        (waiter) => waiter.tabId == null || waiter.tabId === scheduler.focusedTabId
      );
      if (focusedIndex >= 0) index = focusedIndex;
    }
    const [waiter] = scheduler.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    scheduler.inFlight += 1;
    waiter.resolve();
  }
}

function createPreloadSlotAwareFetch(fetchImpl, { tabId, limit }) {
  return async (url, init) => {
    await acquirePreloadSlot(tabId, typeof limit === 'function' ? limit() : limit);
    preloadLive.activeRequests += 1;
    try {
      return await fetchImpl(url, init);
    } finally {
      preloadLive.activeRequests = Math.max(0, preloadLive.activeRequests - 1);
      releasePreloadSlot();
    }
  };
}

// 预加载队列与页面观测对账（规划 §953，shared/preload-queue.js 的运行时落地）：
// 页面已加载的页 → 改为只解析续接链接不抓图；正在加载的页 → 降级到队尾；
// 会话过期 → 清空未发送队列。观测不可用时返回原队列（默认排序兜底）。
async function reconcileReaderPreloadQueueWithTab(queue, { tabId, message }) {
  const activity = await queryPageNetworkActivity(tabId, {
    pageSessionId: message?.pageSessionId ?? '',
    pageUrl: message?.url ?? '',
    observedAt: Date.now()
  });
  if (activity?.pageSessionMatched === false) return [];
  if (activity?.ok !== true || !Array.isArray(activity.observations)) return queue;
  return reconcileReaderPreloadQueue(queue, activity.observations);
}

function reconcileReaderPreloadQueue(queue, observations) {
  const wrappers = queue.map((candidate) => ({
    candidate,
    pageKey: candidate?.page?.pageKey,
    pageUrl: candidate?.page?.url,
    status: 'queued'
  }));
  const { actions } = reconcilePreloadQueueWithExternalActivity(wrappers, observations);
  const normal = [];
  const tail = [];
  for (const action of actions) {
    const candidate = action.item?.candidate;
    if (!candidate) continue;
    if (action.action === 'remove') {
      if (action.reason === 'external-loaded') {
        normal.push({ ...candidate, externalSkipImage: true });
      }
      continue;
    }
    if (action.action === 'downgrade') {
      tail.push(candidate);
      continue;
    }
    normal.push(candidate);
  }
  return [...normal, ...tail];
}

async function waitForPageNetworkIdleBeforePreload({ url, page, message, sender }) {
  const tabId = sender?.tab?.id;
  if (!Number.isSafeInteger(tabId)) return { ok: true, skipped: true, reason: 'missing-tab' };

  while (true) {
    const activity = await queryPageNetworkActivity(tabId, {
      pageSessionId: message?.pageSessionId ?? '',
      pageUrl: message?.url ?? page?.url ?? '',
      requestUrl: typeof url === 'string' ? url : String(url ?? ''),
      observedAt: Date.now()
    });

    if (activity?.pageSessionMatched === false) {
      return {
        ...activity,
        busy: false,
        reason: 'stale-page-session'
      };
    }

    if (activity?.ok !== true || activity.busy !== true) {
      return activity;
    }

    await delay(PRELOAD_NETWORK_ACTIVITY_POLL_MS);
  }
}

async function queryPageNetworkActivity(tabId, details = {}) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, {
      type: PAGE_NETWORK_ACTIVITY_QUERY_TYPE,
      ...details
    }), PRELOAD_NETWORK_ACTIVITY_QUERY_TIMEOUT_MS, {
      ok: false,
      busy: false,
      reason: 'query-timeout'
    });
  } catch (error) {
    return {
      ok: false,
      busy: false,
      reason: 'query-error',
      error: error?.message ?? String(error)
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleExternalImageCacheFill(message, sender) {
  const current = await getState();
  const items = Array.isArray(message?.items) ? message.items.slice(0, 64) : [];
  if (!items.length) return { ok: true, state: current, result: externalImageCacheFillEmptyResult() };
  // 多开页面各自的补存上报都有效（规划 §953 多页面预加载），不再用
  // “全局最后会话”当过滤器；页面导航后 content script 即销毁，无法发出
  // 迟到上报，无会话标识的上报仍拒绝。
  if (!message?.pageSessionId) {
    return { ok: true, state: current, result: externalImageCacheFillEmptyResult('missing-page-session') };
  }

  const result = {
    ok: true,
    planned: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    reasons: {},
    records: []
  };

  for (const item of items) {
    const event = normalizeExternalImageCacheFillItem(item);
    const plan = planExternalImageCacheFill(externalImageCacheFillState, event, current.settings);
    if (plan.action !== 'cache-fill') {
      result.skipped += 1;
      incrementReason(result.reasons, plan.reason ?? 'skipped');
      continue;
    }

    result.planned += 1;
    try {
      const cached = await cacheFillExternalImage(plan, event);
      if (cached?.cached) {
        result.cached += 1;
        result.records.push({
          pageKey: cached.pageKey,
          imageUrl: cached.url,
          storageClass: cached.storageClass
        });
      } else {
        result.skipped += 1;
        incrementReason(result.reasons, cached?.reason ?? 'not-cached');
      }
      completeExternalImageCacheFill(externalImageCacheFillState, event, cached);
    } catch (error) {
      result.failed += 1;
      incrementReason(result.reasons, 'fetch-failed');
      completeExternalImageCacheFill(externalImageCacheFillState, event, { cached: false, pageKey: event.pageKey });
      result.records.push({
        pageKey: event.pageKey,
        imageUrl: event.url,
        error: error?.message ?? String(error)
      });
    }
  }

  await syncPreloadCacheState();
  const state = await updateState((item) => addLog(item, {
    level: result.failed ? 'warning' : (result.cached ? 'info' : 'debug'),
    event: 'external-image-cache-fill.run',
    action: 'cache-fill-external-images',
    message: `外部图片补存完成：${result.cached} 成功，${result.skipped} 跳过，${result.failed} 失败`,
    sender,
    context: {
      url: message?.url,
      pageSessionId: message?.pageSessionId,
      observedAt: message?.observedAt,
      itemCount: items.length,
      reasons: result.reasons
    },
    result
  }));
  return { ok: true, state, result };
}

async function cacheFillExternalImage(plan, event) {
  const store = await createManagedPreloadStore();
  // 规划 §953：能解析 gid:pageNo 的写永久索引；只有 H@H URL 的写
  // url:<资源URL> 临时记录（TEMPORARY，全部 EH/EX 页面关闭时清理）。
  const existing = plan.pageKey
    ? await store.get(plan.pageKey)
    : await store.getByResourceKey(plan.resourceKey ?? plan.url);
  if (existing && recordHasStoredImage(existing)) {
    return { cached: false, reason: 'existing-record', pageKey: plan.pageKey, url: plan.url };
  }

  const record = plan.pageKey
    ? await buildExternalImageCacheFillRecord({
      ...event,
      url: plan.url,
      imageUrl: plan.url,
      pageKey: plan.pageKey,
      pageUrl: event.pageUrl
    }, {
      fetchImpl: fetch,
      source: 'external-image-cache-fill'
    })
    : await buildExternalResourceCacheFillRecord({
      url: plan.url,
      pageUrl: event.pageUrl
    }, {
      fetchImpl: fetch,
      source: 'external-image-cache-fill'
    });
  if (plan.resourceKey) record.resourceKey = plan.resourceKey;
  record.storageClass = plan.storageClass;
  try {
    await store.put(record);
  } catch (error) {
    return {
      cached: false,
      reason: 'storage-blocked',
      pageKey: plan.pageKey,
      url: plan.url,
      error: error?.message ?? String(error)
    };
  }
  return {
    cached: true,
    pageKey: record.pageKey,
    url: record.imageUrl,
    storageClass: record.storageClass
  };
}

async function migrateIndexedDbCacheToDirectory({ deleteOldCache = false } = {}) {
  try {
    const handle = await loadWritableDirectoryHandle();
    if (!handle) {
      return emptyMigrationResult('directory-not-authorized');
    }

    const source = await createIndexedDbStore();
    const target = await createDirectoryPreloadStore(handle);
    return await migratePreloadRecordsToStore(source, target, { deleteOldCache });
  } catch (error) {
    return emptyMigrationResult(error?.message ?? String(error));
  }
}

// 迁移取消标志放内存即可：迁移与取消都发生在同一次 SW 生命周期内；
// SW 被杀等同迁移中断，续迁由“目标已有等价记录则跳过”承担（规划 §14）。
const migrationRunState = {
  running: false,
  cancelRequested: false
};

function requestMigrationCancel() {
  if (!migrationRunState.running) return false;
  migrationRunState.cancelRequested = true;
  return true;
}

function migrationResultStatus(result) {
  if (result?.cancelled === true) return 'cancelled';
  return result?.ok === true ? 'completed' : 'failed';
}

function emptyMigrationResult(error = '') {
  return {
    ok: false,
    cancelled: false,
    ...(error ? { error } : {}),
    oldCacheCount: 0,
    oldCacheBytes: 0,
    totalCount: 0,
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    migratedBytes: 0,
    failures: [],
    deletedOldCache: false,
    verified: false
  };
}

// 规划 §14：迁移完成前逐条校验（索引可读、文件大小一致），记录已迁移条目以支持
// 中断后续迁；用户可随时取消，取消/存在失败条目时绝不清空旧缓存。
async function migratePreloadRecordsToStore(source, target, { deleteOldCache = false } = {}) {
  migrationRunState.running = true;
  migrationRunState.cancelRequested = false;
  try {
    const records = await source.list();
    const summary = summarizePreloadRecords(records);
    const totalCount = records.length;
    let migratedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let migratedBytes = 0;
    let cancelled = false;
    const failures = [];
    let lastProgressAt = Date.now();
    let sinceProgress = 0;

    await writeMigrationProgress({ totalCount, migratedCount, skippedCount, failedCount });

    for (const record of records) {
      if (migrationRunState.cancelRequested) {
        cancelled = true;
        break;
      }

      const outcome = await migrateSinglePreloadRecord(source, target, record);
      if (outcome.status === 'skipped') {
        skippedCount += 1;
      } else if (outcome.status === 'migrated') {
        migratedCount += 1;
        migratedBytes += outcome.bytes;
      } else {
        failedCount += 1;
        if (failures.length < 20) {
          failures.push({ pageKey: outcome.pageKey, error: outcome.error });
        }
      }

      sinceProgress += 1;
      const now = Date.now();
      if (sinceProgress >= 25 || now - lastProgressAt >= 750) {
        sinceProgress = 0;
        lastProgressAt = now;
        await writeMigrationProgress({ totalCount, migratedCount, skippedCount, failedCount });
      }
    }

    const verified = !cancelled && failedCount === 0;
    if (verified && deleteOldCache) {
      await source.clear();
    }

    return {
      ok: verified,
      cancelled,
      oldCacheCount: summary.cacheRecords,
      oldCacheBytes: summary.imageBytes,
      totalCount,
      migratedCount,
      skippedCount,
      failedCount,
      migratedBytes,
      failures,
      deletedOldCache: verified && deleteOldCache,
      verified
    };
  } catch (error) {
    return emptyMigrationResult(error?.message ?? String(error));
  } finally {
    migrationRunState.running = false;
    migrationRunState.cancelRequested = false;
  }
}

async function migrateSinglePreloadRecord(source, target, record) {
  const pageKey = typeof record?.pageKey === 'string' && record.pageKey
    ? record.pageKey
    : (record?.resourceKey ?? '');
  try {
    const expectedBytes = migrationRecordImageBytes(record);
    const hasImageBody = expectedBytes > 0
      || Boolean(record?.imageBlob)
      || (typeof record?.dataUrl === 'string' && record.dataUrl.length > 0)
      || Boolean(record?.directoryImageFile);

    // 续迁：目标已有等价记录（图片体字节一致，或双方都是纯索引）则跳过。
    const existing = await readMigratedTargetRecord(target, record);
    if (existing) {
      if (!hasImageBody) {
        return { status: 'skipped', pageKey };
      }
      const existingBytes = migrationRecordImageBytes(existing);
      if (existingBytes > 0 && (expectedBytes === 0 || existingBytes === expectedBytes)) {
        return { status: 'skipped', pageKey };
      }
    }

    // 目录→目录迁移的 list 只带索引不带图片体，先从源目录水合出真实文件，
    // 否则写入新目录的只有索引 JSON、没有图片文件。
    let payload = record;
    if (hasImageBody && !record?.imageBlob && !record?.dataUrl
      && record?.directoryImageFile && typeof source.hydrate === 'function') {
      payload = await source.hydrate(record);
      if (payload?.hasImageBlob !== true) {
        return { status: 'failed', pageKey, error: 'source-image-unreadable' };
      }
    }

    await target.put(payload);

    const reread = await readMigratedTargetRecord(target, record);
    if (!reread) {
      return { status: 'failed', pageKey, error: 'verify-index-missing' };
    }
    if (hasImageBody) {
      const verifyBytes = migrationRecordImageBytes(payload) || expectedBytes;
      const hydrated = typeof target.hydrate === 'function' ? await target.hydrate(reread) : reread;
      if (hydrated?.hasImageBlob !== true) {
        return { status: 'failed', pageKey, error: 'verify-image-unreadable' };
      }
      if (verifyBytes > 0 && Number(hydrated.imageBytes) !== verifyBytes) {
        return { status: 'failed', pageKey, error: 'verify-bytes-mismatch' };
      }
    }

    return {
      status: 'migrated',
      pageKey,
      bytes: migrationRecordImageBytes(payload) || expectedBytes
    };
  } catch (error) {
    return { status: 'failed', pageKey, error: error?.message ?? String(error) };
  }
}

async function readMigratedTargetRecord(target, record) {
  const pageKey = typeof record?.pageKey === 'string' ? record.pageKey : '';
  if (pageKey) {
    const byPage = await target.get(pageKey).catch(() => null);
    if (byPage) return byPage;
  }
  const resourceKey = record?.resourceKey ?? record?.resourceUrl ?? record?.imageUrl ?? '';
  if (resourceKey && typeof target.getByResourceKey === 'function') {
    return target.getByResourceKey(resourceKey).catch(() => null);
  }
  return null;
}

function migrationRecordImageBytes(record) {
  const declared = Number(record?.imageBytes);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const blob = record?.imageBlob;
  if (blob && Number.isFinite(Number(blob.size)) && Number(blob.size) > 0) return Number(blob.size);
  return 0;
}

async function writeMigrationProgress(progress) {
  await updateState((current) => ({
    ...current,
    migration: {
      ...current.migration,
      status: 'running',
      totalCount: progress.totalCount,
      migratedCount: progress.migratedCount,
      skippedCount: progress.skippedCount,
      failedCount: progress.failedCount,
      progressUpdatedAt: Date.now()
    }
  })).catch(() => {});
}

function normalizeExternalImageCacheFillItem(item) {
  return {
    pageKey: typeof item?.pageKey === 'string' ? item.pageKey : '',
    pageUrl: typeof item?.pageUrl === 'string' ? item.pageUrl : '',
    url: typeof item?.imageUrl === 'string' ? item.imageUrl : item?.url,
    source: item?.source === 'own' ? 'own' : 'external',
    at: Number.isFinite(item?.observedAt) ? item.observedAt : Date.now()
  };
}

function externalImageCacheFillEmptyResult(reason = 'empty') {
  return {
    ok: true,
    planned: 0,
    cached: 0,
    skipped: reason === 'empty' ? 0 : 1,
    failed: 0,
    reasons: reason === 'empty' ? {} : { [reason]: 1 },
    records: []
  };
}

function incrementReason(reasons, key) {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

function createExternalImageCacheFillState({
  ttlMs = EXTERNAL_IMAGE_CACHE_FILL_TTL_MS,
  now = () => Date.now()
} = {}) {
  return {
    ttlMs,
    now,
    pending: new Map(),
    cached: new Set()
  };
}

function planExternalImageCacheFill(state, event, settings = {}) {
  const at = Number.isFinite(event?.at) ? event.at : state.now();
  pruneExternalImageCacheFillState(state, at);

  if (settings.blobCacheEnabled === false || settings.externalImageCacheFillEnabled === false) {
    return { action: 'skip', reason: 'disabled' };
  }

  const url = normalizeResourceUrl(event?.url);
  if (!url) return { action: 'skip', reason: 'invalid-url' };

  const pageKey = normalizePageKey(event?.pageKey);
  const cacheKey = pageKey ?? url;
  const storageClass = pageKey ? CACHE_STORAGE_CLASSES.PERMANENT : CACHE_STORAGE_CLASSES.TEMPORARY;

  if (event?.source === 'own') {
    return { action: 'skip', reason: 'own-request', key: cacheKey, pageKey, url, storageClass };
  }
  if (state.cached.has(cacheKey)) {
    return { action: 'skip', reason: 'cached', key: cacheKey, pageKey, url, storageClass };
  }
  if (state.pending.has(cacheKey)) {
    return { action: 'skip', reason: 'pending', key: cacheKey, pageKey, url, storageClass };
  }

  state.pending.set(cacheKey, at);
  return {
    action: 'cache-fill',
    key: cacheKey,
    pageKey,
    url,
    resourceKey: url,
    storageClass,
    mode: 'low-priority-cache-first'
  };
}

function completeExternalImageCacheFill(state, event, result, at = state.now()) {
  const pageKey = normalizePageKey(event?.pageKey) ?? normalizePageKey(result?.pageKey);
  const resourceKey = normalizeResourceUrl(event?.url);
  const key = pageKey ?? resourceKey;
  if (!key) return null;

  state.pending.delete(key);
  if (result?.cached) state.cached.add(key);
  pruneExternalImageCacheFillState(state, at);
  return key;
}

function pruneExternalImageCacheFillState(state, at = state.now()) {
  const cutoff = at - state.ttlMs;
  for (const [key, timestamp] of state.pending) {
    if (timestamp < cutoff) state.pending.delete(key);
  }
}

async function runDawnCheck(sender, source = 'manual') {
  const beforeState = await getState();
  const requestOptions = logOptionsFromSettings(beforeState.settings);
  const event = await readLiveDawnEvent(sender, requestOptions);
  const isBackground = source === 'background';
  return updateState((current) => {
    const backgroundSuccessCount = isBackground && event.type === 'dawn'
      ? (current.dawn.backgroundSuccessCount ?? 0) + 1
      : (current.dawn.backgroundSuccessCount ?? 0);
    return addLog({
      ...current,
      dawn: {
        ...current.dawn,
        lastRunAt: event.checkedAt,
        lastResult: dawnResultMessage(event),
        lastEventType: event.type,
        rewards: event.type === 'dawn' ? event.rewards : {},
        backgroundSuccessCount,
        unknownEventText: event.type === 'unknown' ? event.message : ''
      },
      counters: bumpRequest(current.counters)
    }, {
      level: 'info',
      event: 'dawn.run',
      action: isBackground ? 'run-dawn-background' : 'run-dawn-live',
      message: dawnResultMessage(event),
      sender,
      context: {
        source: event.sourceUrl,
        origin: event.origin,
        runSource: source,
        pageOpenEnabled: current.settings.dawnEnabled,
        backgroundEnabled: current.settings.backgroundDawnEnabled,
        requestDetails: event.requestDetails
      },
      result: {
        eventType: event.type,
        rewards: event.rewards,
        countedBackgroundSuccess: isBackground && event.type === 'dawn'
      }
    });
  });
}

async function runBackgroundDawnAlarm() {
  const state = await getState();
  if (state.settings.backgroundDawnEnabled !== true) {
    await chrome.alarms.clear(DAWN_ALARM_NAME);
    return null;
  }
  if (hasRunTodayAfterDawnWindow(state.dawn.lastRunAt)) {
    await syncBackgroundDawnAlarm(state.settings);
    return state;
  }
  const next = await runDawnCheck(null, 'background');
  await syncBackgroundDawnAlarm(next.settings);
  return next;
}

async function syncBackgroundDawnAlarm(settings = DEFAULT_SETTINGS) {
  if (settings.backgroundDawnEnabled !== true) {
    await chrome.alarms.clear(DAWN_ALARM_NAME);
    return;
  }
  const existing = await chrome.alarms.get(DAWN_ALARM_NAME);
  if (existing?.periodInMinutes === 24 * 60 && (existing.scheduledTime ?? 0) > Date.now()) return;

  await chrome.alarms.create(DAWN_ALARM_NAME, {
    when: nextDawnAlarmTime(),
    periodInMinutes: 24 * 60
  });
}

async function refreshAccountScheduleFromTabs(options = {}) {
  const tabs = await chrome.tabs.query({
    url: [
      'https://e-hentai.org/g/*',
      'https://e-hentai.org/s/*',
      'https://exhentai.org/g/*',
      'https://exhentai.org/s/*'
    ]
  });
  const summary = summarizeAccountRefreshTabs(tabs);
  const previous = await getState();
  const shouldRefresh = options.refreshOnTransition !== false
    && shouldRefreshAccountOnTabTransition(previous.accountRefresh?.activeCount, summary.activeCount);

  const state = await updateState((current) => ({
    ...current,
    accountRefresh: {
      ...current.accountRefresh,
      activeCount: summary.activeCount,
      activeTabs: summary.activeTabs,
      alarmEnabled: summary.hasActivePages,
      lastOpenedAt: shouldRefresh ? Date.now() : current.accountRefresh?.lastOpenedAt ?? 0,
      lastReason: options.reason ?? current.accountRefresh?.lastReason ?? ''
    }
  }));

  await syncAccountRefreshAlarm(summary.hasActivePages);
  if (shouldRefresh) {
    triggerBackgroundAccountRefresh('page-open-transition');
  }
  return state;
}

async function syncAccountRefreshAlarm(enabled) {
  if (!enabled) {
    await chrome.alarms.clear(ACCOUNT_REFRESH_ALARM_NAME);
    return;
  }
  const existing = await chrome.alarms.get(ACCOUNT_REFRESH_ALARM_NAME);
  if (existing?.periodInMinutes === ACCOUNT_REFRESH_INTERVAL_MINUTES) return;

  await chrome.alarms.create(ACCOUNT_REFRESH_ALARM_NAME, {
    delayInMinutes: ACCOUNT_REFRESH_INTERVAL_MINUTES,
    periodInMinutes: ACCOUNT_REFRESH_INTERVAL_MINUTES
  });
}

function triggerBackgroundAccountRefresh(reason) {
  runBackgroundAccountRefresh(reason).catch((error) => {
    appendErrorLog({ type: 'EHPLUS_BACKGROUND_ACCOUNT_REFRESH', reason }, null, error).catch(() => {});
  });
}

async function runScheduledAccountRefresh() {
  await refreshAccountScheduleFromTabs({ reason: 'alarm', refreshOnTransition: false });
  const state = await getState();
  if ((state.accountRefresh?.activeCount ?? 0) <= 0) {
    await syncAccountRefreshAlarm(false);
    return state;
  }
  return runBackgroundAccountRefresh('interval-600s');
}

async function runBackgroundAccountRefresh(reason) {
  const state = await getState();
  if ((state.accountRefresh?.activeCount ?? 0) <= 0) return state;
  const requestOptions = logOptionsFromSettings(state.settings);
  const account = await readLiveAccountStatus(null, requestOptions);
  return applyAccountRefreshResult(account, null, reason);
}

async function applyAccountRefreshResult(account, sender, source) {
  return updateState((current) => addLog({
    ...current,
    account: {
      ...current.account,
      ...pickAccountStatus(account),
      resetPrepare: null
    },
    accountRefresh: {
      ...current.accountRefresh,
      lastRefreshAt: account.updatedAt ?? Date.now(),
      lastReason: source
    },
    counters: bumpRequest(current.counters)
  }, {
    level: 'info',
    event: 'account.refresh',
    action: source === 'manual' ? 'refresh-account-live' : 'refresh-account-background',
    message: source === 'manual' ? '账号状态已刷新' : '后台账号状态已刷新',
    sender,
    context: {
      sources: account.sources,
      origin: account.origin,
      runSource: source,
      intervalSeconds: ACCOUNT_REFRESH_INTERVAL_MINUTES * 60,
      activePageCount: current.accountRefresh?.activeCount ?? 0,
      requestBodySent: false,
      requestDetails: account.requestDetails
    },
    result: {
      quotaUsed: account.quotaUsed,
      quotaLimit: account.quotaLimit,
      resetCostGp: account.resetCostGp,
      credits: account.credits,
      gp: account.gp,
      hath: account.hath
    }
  }));
}

async function syncCacheDedupeAlarm() {
  const existing = await chrome.alarms.get(CACHE_DEDUPE_ALARM_NAME);
  if (existing?.periodInMinutes === CACHE_DEDUPE_INTERVAL_MINUTES) return;

  await chrome.alarms.create(CACHE_DEDUPE_ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CACHE_DEDUPE_INTERVAL_MINUTES
  });
}

async function syncRuntimeCleanupAlarm() {
  const existing = await chrome.alarms.get(RUNTIME_CLEANUP_ALARM_NAME);
  if (existing?.periodInMinutes === RUNTIME_CLEANUP_INTERVAL_MINUTES) return;

  await chrome.alarms.create(RUNTIME_CLEANUP_ALARM_NAME, {
    delayInMinutes: RUNTIME_CLEANUP_INTERVAL_MINUTES,
    periodInMinutes: RUNTIME_CLEANUP_INTERVAL_MINUTES
  });
}

async function initializeRuntimeCleanupOnWake(reason = 'service-worker-wakeup') {
  await compactStoredStateOnBoot();
  await syncRuntimeCleanupAlarm();
  await maybeRunRuntimeCleanupOnWake(reason);
}

async function maybeRunRuntimeCleanupOnWake(reason = 'service-worker-wakeup') {
  if (runtimeCleanupWakeCheckPromise) return runtimeCleanupWakeCheckPromise;

  runtimeCleanupWakeCheckPromise = (async () => {
    const state = await getState();
    const lastAutoCleanupAt = Number(state.cleanup?.lastAutoCleanupAt ?? 0);
    const now = Date.now();
    if (Number.isFinite(lastAutoCleanupAt) && lastAutoCleanupAt > 0 && now - lastAutoCleanupAt < RUNTIME_CLEANUP_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: 'cleanup-interval-not-elapsed', lastAutoCleanupAt };
    }

    return runRuntimeCleanupAlarm({ reason, now });
  })();

  try {
    return await runtimeCleanupWakeCheckPromise;
  } finally {
    runtimeCleanupWakeCheckPromise = null;
  }
}

function nextDawnAlarmTime(now = Date.now()) {
  const date = new Date(now);
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3, 0, 0, 0);
  return now < target ? target : target + DAY_MS;
}

function hasRunTodayAfterDawnWindow(lastRunAt, now = Date.now()) {
  if (!Number.isFinite(lastRunAt) || lastRunAt <= 0) return false;
  const date = new Date(now);
  const todayWindow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3, 0, 0, 0);
  return lastRunAt >= todayWindow;
}

function isAfterDawnWindow(now = Date.now()) {
  const date = new Date(now);
  const todayWindow = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3, 0, 0, 0);
  return now >= todayWindow;
}

function withoutRequestDetails(result) {
  if (!result || typeof result !== 'object') return result;
  const { requestDetails, ...next } = result;
  return next;
}

async function runCacheDedupeAlarm() {
  const result = await mergeDuplicatePreloadImages();
  await syncPreloadCacheState();
  if (!result.ok || result.mergedRecords === 0) return result;

  await updateState((current) => addLog(current, {
    level: 'info',
    event: 'cache-dedupe.run',
    action: 'merge-duplicate-image-cache',
    message: `重复图片合并完成：${result.groups} 组，释放 ${result.releasedBytes} 字节`,
    context: {
      intervalMinutes: CACHE_DEDUPE_INTERVAL_MINUTES,
      scannedRecords: result.scannedRecords
    },
    result
  }));
  return result;
}

async function runRuntimeCleanupAlarm({ reason = 'alarm', now = Date.now() } = {}) {
  const state = await getState();
  const request = buildAutomaticCleanupRequest(state.settings);
  if (!request) {
    return { ok: true, skipped: true, reason: 'cleanup-days-disabled' };
  }

  const result = await cleanupActiveStorage(state, request);
  const removedCacheRecords = result.images.success + result.other.success;
  const removedItems = removedCacheRecords + result.logs.success;
  if (removedCacheRecords > 0) {
    cooperativeCacheRecords = [];
    cooperativeCacheRecordsSyncedAt = 0;
  }

  await updateState((current) => {
    const applied = applyCleanupResult(current, result);
    const next = {
      ...applied,
      cleanup: {
        ...applied.cleanup,
        lastAutoCleanupAt: now
      }
    };
    if (removedItems === 0) return next;

    return addLog(next, {
      level: 'info',
      event: 'cleanup.auto',
      action: 'cleanup-expired-runtime-data',
      message: `后台自动清理完成：${removedItems} 项，释放 ${result.releaseBytes} 字节`,
      context: {
        intervalMinutes: RUNTIME_CLEANUP_INTERVAL_MINUTES,
        reason,
        request
      },
      result
    });
  });

  if (removedCacheRecords > 0) {
    await syncPreloadCacheState();
  }

  return { ok: true, result };
}

function buildAutomaticCleanupRequest(settings = DEFAULT_SETTINGS) {
  const days = clampInteger(settings.cleanupDays, 0, 3650, DEFAULT_SETTINGS.cleanupDays);
  if (days <= 0) return null;

  return {
    scope: normalizeChoice(settings.cleanupScope, ['all', 'images', 'logs', 'other'], DEFAULT_SETTINGS.cleanupScope),
    mode: 'olderThanDays',
    days,
    includeProtected: false,
    includeProtectedGalleries: false
  };
}

async function mergeDuplicatePreloadImages() {
  try {
    const store = await createActivePreloadStore();
    const records = await store.list();
    const hashedRecords = await withImageHashes(records);
    const plan = planDuplicateImageMerge(hashedRecords);
    if (plan.action !== 'merge') {
      return {
        ok: true,
        action: 'keep',
        scannedRecords: plan.scannedRecords,
        groups: 0,
        mergedRecords: 0,
        releasedBytes: 0
      };
    }

    for (const record of [...plan.canonicalUpdates, ...plan.pointerUpdates]) {
      await store.put(record);
    }

    return {
      ok: true,
      action: 'merge',
      scannedRecords: plan.scannedRecords,
      groups: plan.duplicateGroups,
      mergedRecords: plan.duplicateImageRecords.length,
      canonicalRecords: plan.canonicalUpdates.length,
      pointerRecords: plan.pointerUpdates.length,
      releasedBytes: plan.releasedBytes
    };
  } catch (error) {
    return {
      ok: false,
      action: 'error',
      error: error?.message ?? String(error),
      scannedRecords: 0,
      groups: 0,
      mergedRecords: 0,
      releasedBytes: 0
    };
  }
}

async function withImageHashes(records) {
  const result = [];
  for (const record of records) {
    if (record?.imageHash || record?.contentHash || record?.sha256) {
      result.push(record);
      continue;
    }

    const imageHash = await hashRecordImage(record);
    result.push(imageHash ? { ...record, imageHash } : record);
  }
  return result;
}

async function hashRecordImage(record) {
  const bytes = await recordImageBytes(record);
  if (!bytes) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function recordImageBytes(record) {
  if (record?.imageBlob instanceof Blob) {
    return record.imageBlob.arrayBuffer();
  }

  if (typeof record?.dataUrl === 'string') {
    return dataUrlBytes(record.dataUrl);
  }

  if (record?.imageBlob instanceof ArrayBuffer) {
    return record.imageBlob;
  }

  if (ArrayBuffer.isView(record?.imageBlob)) {
    return record.imageBlob.buffer.slice(record.imageBlob.byteOffset, record.imageBlob.byteOffset + record.imageBlob.byteLength);
  }

  if (typeof record?.imageBlob === 'string') {
    return new TextEncoder().encode(record.imageBlob).buffer;
  }

  return null;
}

async function createActivePreloadStore(settings = null) {
  const activeSettings = settings ?? (await getState()).settings;
  if (activeSettings.storageMode === 'directory' && activeSettings.directoryLabel) {
    const handle = await loadWritableDirectoryHandle();
    if (handle) {
      await syncDirectoryAuthorizationRuntime(activeSettings, true);
      return createDirectoryPreloadStore(handle);
    }
    await syncDirectoryAuthorizationRuntime(activeSettings, false);
  } else {
    await syncDirectoryAuthorizationRuntime(activeSettings, false);
  }
  const db = await openPreloadDb();
  return createIndexedDbPreloadStore(db);
}

async function createFastPreloadStore() {
  const handle = await loadWritableDirectoryHandle();
  if (handle) {
    return createDirectoryPreloadStore(handle);
  }
  const activeSettings = stateMemoryCache?.settings;
  if (activeSettings?.storageMode === 'directory' && activeSettings.directoryLabel) {
    syncDirectoryAuthorizationRuntime(activeSettings, false).catch(() => {});
  }
  const db = await openPreloadDb();
  return createIndexedDbPreloadStore(db);
}

async function syncDirectoryAuthorizationRuntime(settings, writable) {
  const current = await getState();
  const nextRuntime = applyDirectoryAuthorizationRuntime(current.runtime, {
    requestedMode: settings?.storageMode,
    directoryLabel: settings?.directoryLabel,
    writable
  });
  if (
    nextRuntime.requestedStorageMode === current.runtime.requestedStorageMode
    && nextRuntime.effectiveStorageMode === current.runtime.effectiveStorageMode
    && nextRuntime.directoryAuthorizationRequired === current.runtime.directoryAuthorizationRequired
    && nextRuntime.directoryAuthorizationIncident === current.runtime.directoryAuthorizationIncident
  ) {
    return current;
  }

  return updateState((state) => ({
    ...state,
    runtime: applyDirectoryAuthorizationRuntime(state.runtime, {
      requestedMode: settings?.storageMode,
      directoryLabel: settings?.directoryLabel,
      writable
    })
  }));
}

async function createManagedPreloadStore(settings = null) {
  const activeSettings = settings ?? (await getState()).settings;
  const base = await createActivePreloadStore(activeSettings);
  return {
    ...base,
    async put(record) {
      await ensureCanStoreImageRecord(base, record, activeSettings);
      const stored = await base.put(record);
      await enforceImageCacheLimits(activeSettings, base);
      return stored;
    }
  };
}

async function createIndexedDbStore() {
  const db = await openPreloadDb();
  return createIndexedDbPreloadStore(db);
}

function storageLimitBytes(settings = DEFAULT_SETTINGS) {
  try {
    return parsePositiveStorageLimit(settings.storageLimitValue, settings.storageLimitUnit);
  } catch {
    return null;
  }
}

async function countEhGalleryReaderTabs() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://e-hentai.org/g/*',
      'https://e-hentai.org/s/*',
      'https://exhentai.org/g/*',
      'https://exhentai.org/s/*'
    ]
  });
  return tabs.length;
}

async function ensureCanStoreImageRecord(store, record, settings = DEFAULT_SETTINGS) {
  if (!recordHasStoredImage(record)) return;

  if (record?.pageKey) {
    const existing = await store.get(record.pageKey);
    if (existing && recordHasStoredImage(existing)) return;
  }

  const records = await store.list();
  const decision = shouldAllowNewImageCache(records, {
    maxImageBytes: storageLimitBytes(settings),
    protection: protectionSettings(settings)
  });
  if (!decision.allow) {
    await updateState((current) => ({
      ...current,
      storage: {
        ...current.storage,
        cacheBlockedReason: decision.reason ?? ''
      }
    }));
    throw new Error(decision.reason ?? 'image-cache-blocked');
  }

  await updateState((current) => ({
    ...current,
    storage: {
      ...current.storage,
      cacheBlockedReason: ''
    }
  }));
}

async function enforceImageCacheLimits(settings = DEFAULT_SETTINGS, store = null) {
  const activeStore = store ?? await createActivePreloadStore(settings);
  // 浏览历史不参与临时缓存/大小上限清理（规划 §556）。
  let records = withoutHistoryRecords(await activeStore.list());
  const openEhPageCount = await countEhGalleryReaderTabs();
  const temporaryPlan = planTemporaryCacheCleanup({ records, openEhPageCount });
  if (temporaryPlan.action === 'cleanup' && temporaryPlan.records.length > 0) {
    await activeStore.deleteMany(temporaryPlan.records);
    records = withoutHistoryRecords(await activeStore.list());
  }

  // 分配存储上限按总占用口径执行（规划 §953：临时项计入总存储空间，
  // 触发总存储大小限制时先清临时再清永久图片）：日志与其他缓存字节
  // 不可被本路径淘汰，从上限中扣除后得到图片字节预算。
  const allocatedBytes = storageLimitBytes(settings);
  let maxImageBytes = allocatedBytes;
  if (Number.isFinite(allocatedBytes)) {
    const currentState = await getState();
    const logBytes = Number(currentState.storage?.logBytes) || 0;
    maxImageBytes = Math.max(0, allocatedBytes - logBytes - computeOtherBytes(records));
  }

  const limitPlan = planImageCacheLimitCleanup(records, {
    maxImageBytes,
    protection: protectionSettings(settings)
  });
  if (limitPlan.action === 'cleanup' && limitPlan.records.length > 0) {
    await activeStore.deleteMany(limitPlan.records);
  }

  return { temporaryPlan, limitPlan };
}

// 优先用存储层原生 stripImages（目录模式需同步删 images/ 文件并改写索引）；
// 兜底逐条回读后写回无图片体记录。
async function stripStoreImages(store, records = []) {
  if (records.length === 0) return;
  if (typeof store.stripImages === 'function') {
    await store.stripImages(records);
    return;
  }
  for (const record of records) {
    if (!record?.pageKey) continue;
    const existing = await store.get(record.pageKey);
    if (!existing) continue;
    await store.put(stripImageFromRecord(existing));
  }
}

async function maybeCleanupTemporaryCache(reason = 'tabs-changed') {
  const state = await getState();
  const store = await createActivePreloadStore(state.settings);
  const result = await enforceImageCacheLimits(state.settings, store);
  if (result.temporaryPlan.action !== 'cleanup' || result.temporaryPlan.records.length === 0) {
    return null;
  }

  cooperativeCacheRecords = [];
  cooperativeCacheRecordsSyncedAt = 0;
  await syncPreloadCacheState({ store });
  return updateState((current) => addLog(current, {
    level: 'info',
    event: 'temporary-cache.cleanup',
    action: 'cleanup-temporary-cache',
    message: `临时缓存已清理：${result.temporaryPlan.records.length} 项`,
    context: { reason, openEhPageCount: result.temporaryPlan.openEhPageCount },
    result: {
      ok: true,
      removed: result.temporaryPlan.records.length
    }
  }));
}

async function touchCacheRecordAccess(pageKey, { cacheHit = false } = {}) {
  if (!pageKey) return null;
  const store = await createActivePreloadStore();
  const record = await store.get(pageKey);
  if (!record) return null;

  const touched = touchRecordAccess(record, {
    readInc: 1,
    cacheHitInc: cacheHit ? 1 : 0
  });
  await store.put(touched);
  // 访问计数写回后限流同步，避免高频访问触发全量缓存重扫。
  await syncPreloadCacheState({ store, maxAgeMs: 3000 });
  return touched;
}

async function touchGalleryRecordAccess(page) {
  if (!page?.galleryKey) return null;
  const pageKey = galleryMetadataPageKey(page.galleryKey);
  const store = await createActivePreloadStore();
  const existing = await store.get(pageKey);
  const now = Date.now();
  const base = existing ?? {
    pageKey,
    galleryKey: page.galleryKey,
    gid: page.gid,
    token: page.token,
    recordKind: 'gallery-metadata',
    pageType: 'g',
    readCount: 0,
    cacheHitCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccess: now
  };
  const touched = touchRecordAccess(base, { readInc: 1, cacheHitInc: 0, at: now });
  await store.put(touched);
  await syncPreloadCacheState({ store, maxAgeMs: 3000 });
  return touched;
}

async function touchCacheRecordFromResponse(response, { cacheHit = false } = {}) {
  const pageKey = response?.pageKey ?? response?.canonicalPageKey ?? null;
  if (pageKey) {
    return touchCacheRecordAccess(pageKey, { cacheHit });
  }
  return null;
}

function buildFrequentWatchInputFromPage(page, message) {
  if (!page) return null;
  const readAt = message?.observedAt ?? Date.now();

  if (page.type === 'gallery') {
    return {
      pageType: 'g',
      gid: page.gid,
      token: page.token,
      title: message?.title || page.gid,
      originalTitle: message?.originalTitle ?? '',
      galleryUrl: page.url,
      readAt
    };
  }

  if (page.type === 'reader') {
    return {
      pageType: 's',
      gid: page.gid,
      token: page.token,
      title: message?.title || page.gid,
      originalTitle: message?.originalTitle ?? '',
      lastPageUrl: page.url,
      readAt
    };
  }

  return null;
}

// ---------- 浏览历史（规划 §10 浏览历史）----------

function historyPageKey(gid) {
  return `history:${String(gid ?? '').trim()}`;
}

function isHistoryRecord(record) {
  return record?.recordKind === HISTORY_RECORD_KIND
    || (typeof record?.pageKey === 'string' && record.pageKey.startsWith('history:'));
}

function withoutHistoryRecords(records = []) {
  return records.filter((record) => !isHistoryRecord(record));
}

function historyText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function historyHttpUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\//i.test(url) ? url.slice(0, 600) : '';
}

function historyRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null;
}

function historyPagesCount(value) {
  const pages = Number(value);
  return Number.isSafeInteger(pages) && pages > 0 ? pages : null;
}

function settingsHistoryLimit(settings = DEFAULT_SETTINGS) {
  return normalizePositiveInteger(settings.historyLimit, DEFAULT_SETTINGS.historyLimit);
}

function mergeHistoryRecord(existing, page, message, { now = Date.now(), incrementVisit = false } = {}) {
  const gid = String(page.gid ?? '').trim();
  const meta = message?.galleryMeta && typeof message.galleryMeta === 'object' ? message.galleryMeta : {};
  const base = isHistoryRecord(existing) ? existing : null;
  const isGallery = page.type === 'gallery';

  return {
    pageKey: historyPageKey(gid),
    recordKind: HISTORY_RECORD_KIND,
    gid,
    galleryToken: isGallery ? String(page.token ?? '') : (base?.galleryToken ?? ''),
    readerToken: page.type === 'reader' ? String(page.token ?? '') : (base?.readerToken ?? ''),
    title: historyText(message?.title, 400) || base?.title || '',
    titleJpn: historyText(message?.originalTitle, 400) || base?.titleJpn || '',
    thumbUrl: historyHttpUrl(meta.thumbUrl) || base?.thumbUrl || '',
    category: historyText(meta.category, 40) || base?.category || '',
    uploader: historyText(meta.uploader, 120) || base?.uploader || '',
    rating: historyRating(meta.rating) ?? base?.rating ?? null,
    pages: historyPagesCount(meta.pages) ?? base?.pages ?? null,
    galleryUrl: isGallery ? page.url : (base?.galleryUrl ?? ''),
    lastPageUrl: page.type === 'reader' ? page.url : (base?.lastPageUrl ?? ''),
    lastPageNo: page.type === 'reader' ? (Number(page.pageNo) || null) : (base?.lastPageNo ?? null),
    historyVisitCount: (Number(base?.historyVisitCount) || 0) + (incrementVisit ? 1 : 0),
    historyFirstVisitedAt: Number(base?.historyFirstVisitedAt) || now,
    historyLastVisitedAt: incrementVisit ? now : (Number(base?.historyLastVisitedAt) || now),
    sourcePageType: isGallery ? 'g' : 's',
    createdAt: Number(base?.createdAt) || now,
    updatedAt: now,
    imageBlob: null,
    dataUrl: null,
    hasImageBlob: false,
    imageBytes: 0
  };
}

async function recordBrowsingHistoryVisit(page, message) {
  if (!page || !['gallery', 'reader'].includes(page.type)) return null;
  const gid = String(page.gid ?? '').trim();
  if (!/^\d+$/.test(gid)) return null;

  const state = await getState();
  const store = await createActivePreloadStore(state.settings);
  const existing = await store.get(historyPageKey(gid));
  const observedAt = Number(message?.observedAt);
  const record = mergeHistoryRecord(existing, page, message, {
    now: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
    incrementVisit: true
  });

  // /s/ 阅读页 URL 不含画廊 token，尽力从经常观看统计回填画廊链接。
  if (!record.galleryUrl || !record.galleryToken) {
    const fallback = (state.stats?.frequent ?? []).find((item) => item.pageType === 'g' && String(item.gid) === gid);
    if (fallback) {
      record.galleryUrl = record.galleryUrl || historyHttpUrl(fallback.galleryUrl);
      record.galleryToken = record.galleryToken || String(fallback.token ?? '');
    }
  }

  await store.put(record);
  await truncateBrowsingHistory(store, state.settings);
  return record;
}

async function updateBrowsingHistoryMetadata(page, message) {
  if (!page || !['gallery', 'reader'].includes(page.type)) return null;
  const gid = String(page.gid ?? '').trim();
  if (!/^\d+$/.test(gid)) return null;

  const store = await createActivePreloadStore();
  const existing = await store.get(historyPageKey(gid));
  if (!isHistoryRecord(existing)) return null;

  const record = mergeHistoryRecord(existing, page, message, { incrementVisit: false });
  await store.put(record);
  return record;
}

async function truncateBrowsingHistory(store, settings, records = null) {
  const limit = settingsHistoryLimit(settings);
  const historyRecords = (records ?? (await store.list()).filter(isHistoryRecord));
  if (historyRecords.length <= limit) {
    return { removed: 0, total: historyRecords.length };
  }

  const sorted = [...historyRecords].sort((left, right) => {
    return (Number(left.historyLastVisitedAt) || 0) - (Number(right.historyLastVisitedAt) || 0);
  });
  const toDelete = sorted.slice(0, historyRecords.length - limit);
  await store.deleteMany(toDelete);
  return { removed: toDelete.length, total: historyRecords.length - toDelete.length };
}

function publicHistoryEntry(record) {
  return {
    gid: String(record.gid ?? ''),
    galleryToken: record.galleryToken ?? '',
    readerToken: record.readerToken ?? '',
    title: record.title ?? '',
    titleJpn: record.titleJpn ?? '',
    thumbUrl: record.thumbUrl ?? '',
    category: record.category ?? '',
    uploader: record.uploader ?? '',
    rating: record.rating ?? null,
    pages: record.pages ?? null,
    galleryUrl: record.galleryUrl ?? '',
    lastPageUrl: record.lastPageUrl ?? '',
    lastPageNo: record.lastPageNo ?? null,
    historyVisitCount: Number(record.historyVisitCount) || 0,
    historyFirstVisitedAt: Number(record.historyFirstVisitedAt) || 0,
    historyLastVisitedAt: Number(record.historyLastVisitedAt) || 0,
    sourcePageType: record.sourcePageType === 'g' ? 'g' : 's'
  };
}

async function handleHistoryList(message) {
  const state = await getState();
  const store = await createActivePreloadStore(state.settings);
  const historyRecords = (await store.list()).filter(isHistoryRecord);
  // 打开历史列表时执行上限截断（规划 §590）。
  const truncated = await truncateBrowsingHistory(store, state.settings, historyRecords);
  const limit = settingsHistoryLimit(state.settings);
  const remaining = truncated.removed > 0
    ? (await store.list()).filter(isHistoryRecord)
    : historyRecords;

  const sortBy = message?.sortBy === 'visitCount' ? 'visitCount' : 'lastVisited';
  const entries = remaining
    .map(publicHistoryEntry)
    .sort((left, right) => {
      if (sortBy === 'visitCount') {
        return (right.historyVisitCount - left.historyVisitCount)
          || (right.historyLastVisitedAt - left.historyLastVisitedAt);
      }
      return (right.historyLastVisitedAt - left.historyLastVisitedAt)
        || (right.historyVisitCount - left.historyVisitCount);
    });

  return {
    ok: true,
    entries,
    total: entries.length,
    limit,
    sortBy,
    language: state.settings.language
  };
}

async function handleHistoryDelete(message, sender) {
  const gid = String(message?.gid ?? '').trim();
  if (!/^\d+$/.test(gid)) {
    return { ok: false, error: 'invalid-gid' };
  }

  const store = await createActivePreloadStore();
  const record = await store.get(historyPageKey(gid));
  if (!isHistoryRecord(record)) {
    return { ok: true, removed: 0 };
  }

  await store.deleteMany([record]);
  await updateState((current) => addLog(current, {
    level: 'info',
    event: 'history.delete',
    action: 'delete-history-entry',
    message: `已删除浏览历史记录：${gid}`,
    sender,
    context: { gid, title: record.title ?? '' },
    result: { ok: true, removed: 1 }
  }));
  return { ok: true, removed: 1 };
}

async function handleHistoryClear(sender) {
  const store = await createActivePreloadStore();
  const records = (await store.list()).filter(isHistoryRecord);
  if (records.length > 0) {
    await store.deleteMany(records);
  }

  await updateState((current) => addLog(current, {
    level: 'info',
    event: 'history.clear',
    action: 'clear-history-entries',
    message: `已清空浏览历史：${records.length} 条`,
    sender,
    result: { ok: true, removed: records.length }
  }));
  return { ok: true, removed: records.length };
}

function buildFrequentWatchInput(response, message) {
  if (!response?.hit) return null;
  const readAt = Date.now();

  if (response.cacheType === 'gallery' || response.galleryKey) {
    const [gid, token] = String(response.galleryKey ?? `${response.gid}:${response.token}`).split(':');
    if (!gid) return null;
    return {
      pageType: 'g',
      gid,
      token,
      title: response.title || gid,
      originalTitle: response.originalTitle ?? '',
      galleryUrl: message?.galleryUrl ?? message?.url ?? '',
      readAt
    };
  }

  const pageKey = response.pageKey ?? resolveCooperativePageKey(message);
  if (!pageKey) return null;

  const [gid, pageNo] = pageKey.split(':');
  return {
    pageType: 's',
    gid,
    pageNo: Number(pageNo),
    title: response.title || gid,
    originalTitle: response.originalTitle ?? '',
    lastPageUrl: message?.pageUrl ?? message?.url ?? '',
    readAt
  };
}

function computeOtherBytes(records = []) {
  return records.reduce((total, record) => {
    if (recordHasStoredImage(record)) return total;
    const bytes = Number(record?.htmlBytes ?? record?.galleryBytes ?? record?.bytes ?? 0);
    return total + (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
  }, 0);
}

function runtimeLogKey(log) {
  return `${log?.at ?? 0}:${log?.requestId ?? ''}`;
}

function dataUrlBytes(value) {
  const match = value.match(/^data:[^,]*;base64,(.+)$/i);
  if (!match) return new TextEncoder().encode(value).buffer;
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function syncPreloadCacheState(options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 0;
  if (maxAgeMs > 0 && cooperativeCacheRecords.length > 0 && Date.now() - cooperativeCacheRecordsSyncedAt <= maxAgeMs) {
    return null;
  }

  let summary = null;
  let records = [];
  try {
    const store = options.store ?? await withTimeout(createActivePreloadStore(), PRELOAD_CACHE_SYNC_TIMEOUT_MS, null);
    if (!store) return null;
    records = await withTimeout(store.list(), PRELOAD_CACHE_SYNC_TIMEOUT_MS, null);
    if (!Array.isArray(records)) return null;
    summary = summarizePreloadRecords(records);
    cooperativeCacheRecords = summary.cooperativeRecords;
    cooperativeCacheRecordsSyncedAt = Date.now();
  } catch {
    return null;
  }

  if (options.skipStateUpdate === true) {
    return summary;
  }

  const current = await getState();
  const protectedSummary = summarizeProtectedStorage(records, current.settings);
  const otherBytes = computeOtherBytes(records);
  const logBytes = current.storage?.logBytes ?? 0;
  const totalBytes = summary.imageBytes + logBytes + otherBytes;
  const maxImageBytes = storageLimitBytes(current.settings);
  const cacheDecision = shouldAllowNewImageCache(records, {
    maxImageBytes,
    protection: protectionSettings(current.settings)
  });

  await updateState((state) => ({
    ...state,
    storage: {
      ...state.storage,
      imageBytes: summary.imageBytes,
      imageRecords: summary.imageRecords,
      metadataRecords: summary.metadataRecords,
      cacheRecords: summary.cacheRecords,
      readerRecords: summary.readerRecords,
      otherBytes,
      logBytes,
      totalBytes,
      protectedImages: protectedSummary.protectedImages,
      protectedImageBytes: protectedSummary.protectedImageBytes,
      protectedGalleries: protectedSummary.protectedGalleries,
      protectedGalleryBytes: protectedSummary.protectedGalleryBytes,
      cacheBlockedReason: cacheDecision.allow ? '' : (cacheDecision.reason ?? state.storage.cacheBlockedReason ?? ''),
      lastCalculatedAt: Date.now()
    }
  }));
  return summary;
}

function preloadResultMessage(result) {
  if (result.skipped) {
    return result.reason === 'page-image-requests-active'
      ? '当前页面图片请求未结束，本次预加载请求将在发出前等待'
      : result.reason === 'auto-pager-cache-fill-only'
      ? '兼容模式已暂停主动预加载'
      : '预加载已暂停';
  }
  return `预加载完成：${result.completed} 成功，${result.failed} 失败`;
}

async function handleAutoPagerCompatibilityReport(message, sender) {
  let result = null;
  const normalizedMessage = {
    ...message,
    tabId: sender?.tab?.id
  };
  const state = await updateState((current) => {
    result = applyAutoPagerCompatibilityReport(current.runtime, normalizedMessage);
    if (!result.report.detected) {
      return addLog({
        ...current,
        runtime: result.runtime
      }, {
        level: 'debug',
        event: 'page-image-activity',
        action: result.changed ? 'record-page-image-idle' : 'keep-page-image-idle',
        message: result.changed
          ? '当前页面图片请求已结束，后续预加载请求可继续发出'
          : '当前页面没有未完成图片请求',
        sender,
        context: {
          url: result.report.url,
          pageSessionId: result.report.pageSessionId
        },
        result: {
          ok: true,
          active: false,
          preloadDecisionReleased: result.changed
        }
      });
    }

    return addLog({
      ...current,
      runtime: result.runtime
    }, {
      level: result.changed ? 'info' : 'debug',
      event: 'page-image-activity',
      action: 'record-page-image-requests-active',
      message: result.changed
        ? '当前页面仍有图片请求，后续预加载请求将在发出前等待'
        : '当前页面图片请求仍未结束，后续预加载请求继续等待',
      sender,
      context: {
        url: result.report.url,
        pageSessionId: result.report.pageSessionId,
        pendingImageCount: normalizedMessage.detection?.pendingImageCount ?? null
      },
      result: {
        ok: true,
        active: true,
        mode: result.runtime.compatibilityMode,
        preloadMode: result.runtime.preloadMode,
        shouldYieldNextPageRequests: result.runtime.shouldYieldNextPageRequests,
        currentPagePreloadDisabled: result.runtime.currentPagePreloadDisabled
      }
    });
  });

  return {
    ok: true,
    active: result.report.detected,
    changed: result.changed,
    runtime: state.runtime,
    report: result.report
  };
}

async function handleOwnAutoPagerStatus(message, sender) {
  let result = null;
  const normalizedMessage = {
    ...message,
    tabId: sender?.tab?.id
  };
  const state = await updateState((current) => {
    if (current.settings?.autoPagerEnabled !== true) {
      result = {
        runtime: resetOwnAutoPagerStatus(current.runtime),
        report: { status: 'disabled', continuing: false },
        changed: current.runtime?.ownAutoPagerActive === true || current.runtime?.ownAutoPagerContinuing === true
      };
      return {
        ...current,
        runtime: result.runtime
      };
    }

    result = applyOwnAutoPagerStatus(current.runtime, normalizedMessage);
    return addLog({
      ...current,
      runtime: result.runtime
    }, {
      level: result.changed ? 'debug' : 'debug',
      event: 'autopager.own',
      action: 'update-own-autopager-status',
      message: result.report.continuing
        ? 'EH＋自动翻页仍会继续拼接页面，主动预加载已暂停'
        : 'EH＋自动翻页不再继续拼接页面，主动预加载可继续',
      sender,
      context: {
        url: result.report.url,
        nextUrl: result.report.nextUrl,
        pageSessionId: result.report.pageSessionId,
        status: result.report.status,
        reason: result.report.reason,
        appendedPages: result.report.appendedPages,
        maxPages: result.report.maxPages
      },
      result: {
        ok: true,
        continuing: result.report.continuing,
        preloadMode: result.runtime.preloadMode,
        currentPagePreloadDisabled: result.runtime.currentPagePreloadDisabled
      }
    });
  });

  return {
    ok: true,
    changed: result.changed,
    runtime: state.runtime,
    report: result.report
  };
}

async function handleAutoPagerPageSessionStarted(message, sender) {
  let result = null;
  const normalizedMessage = {
    ...message,
    tabId: sender?.tab?.id
  };
  const state = await updateState((current) => {
    result = resetAutoPagerCompatibilityForPageSession(current.runtime, normalizedMessage);
    if (!result.changed) {
      return {
        ...current,
        runtime: result.runtime
      };
    }

    return addLog({
      ...current,
      runtime: result.runtime
    }, {
      level: 'debug',
      event: 'autopager.compatibility',
      action: 'reset-page-session',
      message: '新页面会话已开始，自动翻页兼容状态已重置',
      sender,
      context: {
        url: normalizedMessage.url,
        pageSessionId: normalizedMessage.pageSessionId
      },
      result: {
        ok: true,
        compatibilityMode: result.runtime.compatibilityMode,
        preloadMode: result.runtime.preloadMode
      }
    });
  });

  return {
    ok: true,
    changed: result.changed,
    runtime: state.runtime
  };
}

async function getState() {
  if (stateMemoryCache) return stateMemoryCache;
  const stored = await chrome.storage.local.get(STATE_KEY);
  stateMemoryCache = normalizeState(stored[STATE_KEY]);
  return stateMemoryCache;
}

// updateState 串行化：并发调用按序执行，避免读-改-写竞态互相覆盖。
async function updateState(mutator) {
  const run = async () => {
    const mutated = mutator(await getState());
    const pendingLogs = pendingLogEntries(mutated);
    let next = normalizeState(mutated);
    if (pendingLogs.length > 0) {
      const logSummary = await appendLogEntries(pendingLogs, next.settings);
      next = normalizeState({
        ...next,
        storage: {
          ...next.storage,
          logBytes: logSummary.logBytes,
          logCount: logSummary.logCount
        }
      });
    }
    await writeRuntimeState(next);
    queueDirectoryStateSnapshot(next);
    return next;
  };
  const result = stateUpdateChain.then(run, run);
  stateUpdateChain = result.then(() => {}, () => {});
  return result;
}

async function compactStoredStateOnBoot() {
  // 优先走内存缓存，避免与已发生的 updateState 内存写竞态后再用旧盘面覆盖。
  if (!stateMemoryCache) {
    const stored = await chrome.storage.local.get(STATE_KEY);
    if (!stored?.[STATE_KEY]) return;
    stateMemoryCache = normalizeState(stored[STATE_KEY]);
  }
  const rawState = stateMemoryCache;
  const legacyLogs = Array.isArray(rawState?.logs) ? rawState.logs : null;
  const logSummary = legacyLogs
    ? await replaceLogs(legacyLogs, rawState.settings)
    : {
        logBytes: rawState?.storage?.logBytes ?? DEFAULT_STATE.storage.logBytes,
        logCount: rawState?.storage?.logCount ?? DEFAULT_STATE.storage.logCount
      };
  const compact = normalizeState({
    ...rawState,
    logs: undefined,
    storage: {
      ...(rawState?.storage ?? {}),
      logBytes: logSummary.logBytes,
      logCount: logSummary.logCount
    }
  });
  await writeRuntimeState(compact);
  queueDirectoryStateSnapshot(compact);
}

async function writeRuntimeState(state) {
  const next = normalizeState(state);
  delete next.logs;
  stateMemoryCache = next;
  schedulePersistRuntimeState(next);
  return next;
}

// 状态落盘防抖：内存缓存立即生效，storage 写合并到 200ms 一次，
// 高并发场景下大幅减少全量序列化与 storage IPC。
function schedulePersistRuntimeState(state) {
  statePersistPending = state;
  if (statePersistTimer) return;
  statePersistTimer = setTimeout(() => {
    statePersistTimer = 0;
    const pending = statePersistPending;
    statePersistPending = null;
    if (!pending) return;
    chrome.storage.local.set({ [STATE_KEY]: pending }).catch(() => {});
  }, STATE_PERSIST_DEBOUNCE_MS);
}

function queueDirectoryStateSnapshot(state) {
  if (state?.settings?.storageMode !== 'directory' || !state.settings.directoryLabel) return;
  loadWritableDirectoryHandle()
    .then((handle) => handle ? writeDirectoryStateSnapshot(handle, state) : null)
    .catch(() => {});
}

function queueDirectoryLogsSnapshot(logs) {
  loadWritableDirectoryHandle()
    .then((handle) => handle ? writeDirectoryLogsSnapshot(handle, logs) : null)
    .catch(() => {});
}

function normalizeState(value) {
  const settings = normalizeSettings(migrateSettings(value?.settings ?? {}));
  const accountRefreshActiveTabs = normalizeAccountRefreshActiveTabs(value?.accountRefresh?.activeTabs);
  const storage = {
    ...DEFAULT_STATE.storage,
    ...(value?.storage ?? {})
  };
  storage.totalBytes = storage.imageBytes + storage.logBytes + storage.otherBytes;
  storage.usageBytes = storage.totalBytes;

  const normalized = {
    ...DEFAULT_STATE,
    ...(value ?? {}),
    extensionVersion: EXTENSION_VERSION,
    counters: {
      ...DEFAULT_STATE.counters,
      ...(value?.counters ?? {})
    },
    settings,
    floatingPanel: {
      ...DEFAULT_STATE.floatingPanel,
      ...(value?.floatingPanel ?? {})
    },
    runtime: {
      ...DEFAULT_STATE.runtime,
      ...(value?.runtime ?? {})
    },
    account: {
      ...DEFAULT_STATE.account,
      ...(value?.account ?? {})
    },
    accountRefresh: {
      ...DEFAULT_STATE.accountRefresh,
      ...(value?.accountRefresh ?? {}),
      activeTabs: accountRefreshActiveTabs
    },
    storage,
    stats: {
      ...DEFAULT_STATE.stats,
      ...(value?.stats ?? {}),
      frequent: Array.isArray(value?.stats?.frequent) ? value.stats.frequent : DEFAULT_STATE.stats.frequent
    },
    dawn: {
      ...DEFAULT_STATE.dawn,
      ...(value?.dawn ?? {}),
      rewards: {
        ...DEFAULT_STATE.dawn.rewards,
        ...(value?.dawn?.rewards ?? {})
      }
    },
    cleanup: {
      ...DEFAULT_STATE.cleanup,
      ...(value?.cleanup ?? {})
    },
    migration: {
      ...DEFAULT_STATE.migration,
      ...(value?.migration ?? {})
    },
    about: {
      ...DEFAULT_STATE.about,
      ...(value?.about ?? {}),
      currentVersion: EXTENSION_VERSION,
      repositoryName: GITHUB_REPOSITORY_NAME,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesApiUrl: GITHUB_RELEASES_API_URL,
      releasesPageUrl: GITHUB_RELEASES_PAGE_URL
    }
  };
  delete normalized.logs;
  return normalized;
}

function normalizeAccountRefreshActiveTabs(activeTabs) {
  if (!Array.isArray(activeTabs)) return DEFAULT_STATE.accountRefresh.activeTabs;
  return activeTabs
    .slice(0, MAX_ACCOUNT_REFRESH_ACTIVE_TABS)
    .map((tab) => ({
      id: tab?.id ?? null,
      url: summarizeAccountRefreshTabUrl(tab?.url)
    }));
}

function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    settingsVersion: SETTINGS_VERSION,
    preloadAhead: normalizePositiveInteger(settings.preloadAhead, DEFAULT_SETTINGS.preloadAhead),
    preloadQueueDisplayEnabled: settings.preloadQueueDisplayEnabled === true,
    globalConcurrency: normalizePositiveInteger(settings.globalConcurrency, DEFAULT_SETTINGS.globalConcurrency),
    concurrencyDisplayEnabled: settings.concurrencyDisplayEnabled === true,
    pageOffset: normalizeNonNegativeInteger(settings.pageOffset, DEFAULT_SETTINGS.pageOffset),
    highReadThreshold: clampInteger(settings.highReadThreshold, 0, 999999, DEFAULT_SETTINGS.highReadThreshold),
    highReadGalleryThreshold: clampInteger(settings.highReadGalleryThreshold, 0, 999999, DEFAULT_SETTINGS.highReadGalleryThreshold),
    autoPagerEnabled: settings.autoPagerEnabled === true,
    autoPagerRemain: normalizePositiveNumber(settings.autoPagerRemain, DEFAULT_SETTINGS.autoPagerRemain),
    autoPagerMaxPages: normalizePositiveInteger(settings.autoPagerMaxPages, DEFAULT_SETTINGS.autoPagerMaxPages),
    autoPagerImmediateEnabled: settings.autoPagerImmediateEnabled === true,
    autoPagerImmediatePages: normalizeNonNegativeInteger(settings.autoPagerImmediatePages, DEFAULT_SETTINGS.autoPagerImmediatePages),
    autoPagerSeparatorEnabled: settings.autoPagerSeparatorEnabled !== false,
    autoPagerAplus: settings.autoPagerAplus !== false,
    logRetentionDays: clampInteger(settings.logRetentionDays, 0, 3650, DEFAULT_SETTINGS.logRetentionDays),
    logLimitValue: clampInteger(settings.logLimitValue, 0, 1048576, DEFAULT_SETTINGS.logLimitValue),
    storageLimitValue: clampInteger(settings.storageLimitValue, 0, 1048576, DEFAULT_SETTINGS.storageLimitValue),
    cleanupDays: clampInteger(settings.cleanupDays, 0, 3650, DEFAULT_SETTINGS.cleanupDays),
    logLimitUnit: ['KB', 'MB', 'GB'].includes(settings.logLimitUnit) ? settings.logLimitUnit : DEFAULT_SETTINGS.logLimitUnit,
    logDebugEnabled: settings.logDebugEnabled === true,
    storageLimitUnit: ['KB', 'MB', 'GB'].includes(settings.storageLimitUnit) ? settings.storageLimitUnit : DEFAULT_SETTINGS.storageLimitUnit,
    language: settings.language === 'en-US' ? 'en-US' : 'zh-CN',
    storageMode: settings.storageMode === 'directory' ? 'directory' : 'indexeddb',
    directoryCacheEnabled: settings.storageMode === 'directory' && Boolean(settings.directoryLabel),
    directoryLabel: typeof settings.directoryLabel === 'string' ? settings.directoryLabel.slice(0, 260) : '',
    cleanupScope: ['all', 'images', 'logs', 'other'].includes(settings.cleanupScope) ? settings.cleanupScope : DEFAULT_SETTINGS.cleanupScope,
    cleanupMode: settings.cleanupMode === 'all' ? 'all' : 'olderThanDays',
    accountStatusFields: normalizeAccountStatusFields(settings.accountStatusFields),
    statsDisplayFields: normalizeStatsDisplayFields(settings.statsDisplayFields),
    historyLimit: normalizePositiveInteger(settings.historyLimit, DEFAULT_SETTINGS.historyLimit),
    logDisplayFields: normalizeLogDisplayFields(settings.logDisplayFields),
    cellColors: normalizeCellColors(settings.cellColors)
  };
}

function migrateSettings(settings) {
  const migrated = {
    ...settings
  };

  if ((migrated.settingsVersion ?? 0) < 2) {
    migrated.logRetentionDays = 30;
    migrated.logLimitValue = 100;
    migrated.logLimitUnit = 'MB';
  }

  if ((migrated.settingsVersion ?? 0) < 3) {
    migrated.language = 'zh-CN';
    migrated.preloadAhead = Number.isFinite(Number(migrated.preloadAhead)) ? Number(migrated.preloadAhead) : 6;
    migrated.globalConcurrency = 5;
    migrated.pageOffset = 24;
    migrated.blobCacheEnabled = true;
    migrated.externalImageCacheFillEnabled = true;
    migrated.cleanupScope = 'all';
    migrated.cleanupMode = 'olderThanDays';
    migrated.cleanupDays = 7;
    migrated.cleanupIncludeProtected = false;
    migrated.cleanupIncludeProtectedGalleries = false;
  }

  if ((migrated.settingsVersion ?? 0) < 4) {
    migrated.protectHighReadGalleries = false;
    migrated.highReadGalleryThreshold = 3;
    migrated.cleanupIncludeProtectedGalleries = false;
  }

  if ((migrated.settingsVersion ?? 0) < 5) {
    migrated.statsDisplayFields = DEFAULT_STATS_DISPLAY_FIELDS;
  }

  if ((migrated.settingsVersion ?? 0) < 6) {
    migrated.logDisplayFields = DEFAULT_LOG_DISPLAY_FIELDS;
  }

  if ((migrated.settingsVersion ?? 0) < 7) {
    migrated.storageLimitValue = 2;
    migrated.storageLimitUnit = 'GB';
  }

  if ((migrated.settingsVersion ?? 0) < 8) {
    migrated.logDebugEnabled = false;
  }

  if ((migrated.settingsVersion ?? 0) < 13) {
    migrated.readerCacheFirstEnabled = false;
  }

  if ((migrated.settingsVersion ?? 0) < 14) {
    migrated.autoPagerEnabled = false;
    migrated.autoPagerRemain = 1;
    migrated.autoPagerMaxPages = 99;
    migrated.autoPagerImmediateEnabled = false;
    migrated.autoPagerImmediatePages = 2;
    migrated.autoPagerSeparatorEnabled = true;
    migrated.autoPagerAplus = true;
  }

  if ((migrated.settingsVersion ?? 0) < 15) {
    migrated.historyLimit = 100;
  }

  if ((migrated.settingsVersion ?? 0) < 10 && isLegacySingleCacheHitStatsDisplayDefault(migrated.statsDisplayFields)) {
    migrated.statsDisplayFields = DEFAULT_STATS_DISPLAY_FIELDS;
  }

  if (isLegacyAllStatsDisplayDefault(migrated.statsDisplayFields)) {
    migrated.statsDisplayFields = DEFAULT_STATS_DISPLAY_FIELDS;
  }

  if (!Number.isFinite(Number(migrated.globalConcurrency))) {
    migrated.globalConcurrency = Number.isFinite(Number(migrated.warmWindow)) ? Number(migrated.warmWindow) : 5;
  }
  delete migrated.hotWindow;
  delete migrated.warmWindow;
  delete migrated.debugVerbose;
  delete migrated.accountStatusEnabled;
  delete migrated.showBackgroundDawnCount;
  delete migrated.statsFilter;

  migrated.settingsVersion = SETTINGS_VERSION;
  return migrated;
}

function normalizeAccountStatusFields(value) {
  return {
    ...DEFAULT_ACCOUNT_STATUS_FIELDS,
    ...(value && typeof value === 'object' ? value : {})
  };
}

function normalizeStatsDisplayFields(value) {
  return {
    ...DEFAULT_STATS_DISPLAY_FIELDS,
    ...(value && typeof value === 'object' ? value : {})
  };
}

function normalizeLogDisplayFields(value) {
  return {
    ...DEFAULT_LOG_DISPLAY_FIELDS,
    ...(value && typeof value === 'object' ? value : {})
  };
}

function isLegacyAllStatsDisplayDefault(value) {
  if (!value || typeof value !== 'object') return false;
  return ['readerReads', 'readerHits', 'readerHitRate', 'galleryReads', 'galleryCache']
    .every((key) => value[key] === true);
}

function isLegacySingleCacheHitStatsDisplayDefault(value) {
  if (!value || typeof value !== 'object') return false;
  return value.readerReads === false
    && value.readerHits === true
    && value.readerHitRate === false
    && value.galleryReads === false
    && value.galleryCache === false;
}

function sanitizeSettings(settings) {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  return Object.fromEntries(Object.entries(settings).filter(([key]) => allowed.has(key)));
}

function normalizeCellColors(value) {
  const next = { ...DEFAULT_CELL_COLORS };
  for (const key of Object.keys(DEFAULT_CELL_COLORS)) {
    next[key] = normalizeHexColor(value?.[key], DEFAULT_CELL_COLORS[key]);
  }
  return next;
}

function normalizeHexColor(value, fallback) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[\da-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map((item) => item + item).join('').toLowerCase()}`;
  }
  if (/^[\da-f]{2}$/i.test(raw)) return `#${raw.repeat(3).toLowerCase()}`;
  return fallback;
}

async function appendErrorLog(message, sender, error) {
  try {
    return await updateState((current) => addLog(current, {
      level: 'error',
      event: 'runtime.error',
      action: 'handle-message',
      message: error.message,
      sender,
      context: {
        messageType: message?.type,
        inputSummary: summarizeMessage(message),
        requestDetails: Array.isArray(error.requestDetails) ? error.requestDetails : []
      },
      error: {
        message: error.message,
        stack: error.stack
      },
      result: {
        ok: false
      }
    }));
  } catch {
    // Avoid recursive logging failures.
    return null;
  }
}

function addLog(state, entry, settings = state.settings ?? DEFAULT_SETTINGS) {
  const next = { ...state };
  const pending = pendingLogEntries(state);
  Object.defineProperty(next, PENDING_LOG_ENTRIES, {
    value: [
      ...pending,
      { entry, settings }
    ],
    enumerable: false
  });
  return next;
}

function pendingLogEntries(value) {
  return Array.isArray(value?.[PENDING_LOG_ENTRIES]) ? value[PENDING_LOG_ENTRIES] : [];
}

async function ensureLogMemoryLoaded() {
  if (logMemory.loaded) return;
  const stored = await chrome.storage.local.get([LOGS_KEY, STATE_KEY]);
  logMemory.logs = Array.isArray(stored[LOGS_KEY])
    ? stored[LOGS_KEY]
    : Array.isArray(stored[STATE_KEY]?.logs)
      ? stored[STATE_KEY].logs
      : [...DEFAULT_STATE.logs];
  logMemory.loaded = true;
}

// 日志落盘防抖：追加只改内存数组，写盘合并到 500ms 一次。
function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = 0;
    const logs = logMemory.logs;
    chrome.storage.local.set({ [LOGS_KEY]: logs }).catch(() => {});
    queueDirectoryLogsSnapshot(logs);
  }, LOG_FLUSH_DEBOUNCE_MS);
}

async function appendLogEntries(entries, settings = DEFAULT_SETTINGS) {
  await ensureLogMemoryLoaded();
  const incoming = settings.loggingEnabled
    ? entries.map((item) => normalizeLogEntry(item.entry))
    : [];
  logMemory.logs = trimLogs([...incoming, ...logMemory.logs], settings);
  scheduleLogFlush();
  return {
    logs: logMemory.logs,
    logBytes: estimateLogBytes(logMemory.logs),
    logCount: logMemory.logs.length
  };
}

async function readRuntimeLogs(settings = DEFAULT_SETTINGS) {
  await ensureLogMemoryLoaded();
  return trimLogs(logMemory.logs, settings);
}

async function replaceLogs(logs, settings = DEFAULT_SETTINGS) {
  const nextLogs = trimLogs(logs ?? [], settings);
  logMemory.logs = nextLogs;
  logMemory.loaded = true;
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = 0;
  }
  await chrome.storage.local.set({ [LOGS_KEY]: nextLogs });
  queueDirectoryLogsSnapshot(nextLogs);
  return {
    logs: nextLogs,
    logBytes: estimateLogBytes(nextLogs),
    logCount: nextLogs.length
  };
}

function normalizeLogEntry(entry) {
  return {
    at: Date.now(),
    level: entry.level ?? 'info',
    event: entry.event ?? 'runtime.event',
    action: entry.action ?? 'unknown-action',
    message: entry.message ?? '',
    requestId: entry.requestId ?? createRequestId(),
    simulated: Boolean(entry.simulated),
    source: normalizeSource(entry.sender),
    page: normalizeSender(entry.sender),
    context: entry.context ?? {},
    result: entry.result ?? null,
    error: entry.error ?? null
  };
}

function trimLogs(logs, settings = DEFAULT_SETTINGS) {
  const retentionDays = clampInteger(settings.logRetentionDays, 0, 3650, 30);
  const maxBytes = Math.min(
    toBytes(settings.logLimitValue, settings.logLimitUnit),
    RUNTIME_LOG_STORAGE_SAFETY_BYTES
  );
  const now = Date.now();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const retained = logs
    .filter((log) => (log.at ?? 0) >= cutoff || log.requestId === 'boot')
    .map((log) => trimDebugText(log, settings, now))
    .slice(0, MAX_RUNTIME_LOG_ENTRIES);
  const next = [];
  let totalBytes = 0;

  for (const log of retained) {
    const size = logByteLength(log);
    if (totalBytes + size > maxBytes && next.length > 0) {
      break;
    }
    next.push(log);
    totalBytes += size;
  }

  return next;
}

// 单条日志字节数按对象缓存，避免每次裁剪/估算都重复 JSON.stringify。
function logByteLength(log) {
  if (!log || typeof log !== 'object') return byteLength(log);
  const cached = logByteSizeCache.get(log);
  if (cached != null) return cached;
  const size = byteLength(log);
  logByteSizeCache.set(log, size);
  return size;
}

function logOptionsFromSettings(settings = DEFAULT_SETTINGS) {
  return {
    debugTextEnabled: settings.logDebugEnabled === true
  };
}

async function logRequestOptions() {
  const state = await getState();
  return logOptionsFromSettings(state.settings);
}

function trimDebugText(log, settings = DEFAULT_SETTINGS, now = Date.now()) {
  // 无 debugText 的条目缓存结论，避免每次裁剪都深度遍历整个对象树。
  if (log && typeof log === 'object' && logDebugTextCleanCache.has(log)) return log;
  const keepDebugText = settings.logDebugEnabled === true && (log.at ?? 0) >= now - DEBUG_TEXT_RETENTION_MS;
  if (!hasDebugText(log)) {
    if (log && typeof log === 'object') logDebugTextCleanCache.add(log);
    return log;
  }
  if (keepDebugText) return truncateDebugText(log);
  return stripDebugText(log);
}

function hasDebugText(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'debugText')) return true;
  if (Array.isArray(value)) return value.some((item) => hasDebugText(item));
  return Object.values(value).some((item) => hasDebugText(item));
}

function stripDebugText(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripDebugText(item));
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'debugText' || key === 'debugTextChars' || key === 'debugTextCapturedAt') continue;
    next[key] = stripDebugText(item);
  }
  return next;
}

function truncateDebugText(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => truncateDebugText(item));
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'debugText' && typeof item === 'string' && item.length > MAX_DEBUG_TEXT_CHARS_IN_STATE) {
      next[key] = item.slice(0, MAX_DEBUG_TEXT_CHARS_IN_STATE);
      next.debugTextTruncated = true;
      next.debugTextStoredChars = MAX_DEBUG_TEXT_CHARS_IN_STATE;
      continue;
    }
    next[key] = truncateDebugText(item);
  }
  return next;
}

function toBytes(value, unit) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) && numeric >= 0 ? numeric : 100;
  if (unit === 'KB') return safeValue * KB;
  if (unit === 'GB') return safeValue * GB;
  return safeValue * MB;
}

function byteLength(value) {
  return new Blob([JSON.stringify(value)]).size;
}

function estimateLogBytes(logs) {
  return logs.reduce((total, log) => total + logByteLength(log), 0);
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), timeoutMs);
    })
  ]);
}

function normalizeTimingPayload(timing = {}) {
  return {
    unit: 'ms',
    queryElapsedMs: finiteNumberOrNull(timing.queryElapsedMs),
    storeOpenMs: finiteNumberOrNull(timing.storeOpenMs),
    indexReadMs: finiteNumberOrNull(timing.indexReadMs),
    pageIndexReadMs: finiteNumberOrNull(timing.pageIndexReadMs),
    resourceIndexReadMs: finiteNumberOrNull(timing.resourceIndexReadMs),
    hitSelectMs: finiteNumberOrNull(timing.hitSelectMs),
    responseImageLoadMs: finiteNumberOrNull(timing.responseImageLoadMs),
    responseTotalMs: finiteNumberOrNull(timing.responseTotalMs),
    pageImageLoadMs: finiteNumberOrNull(timing.pageImageLoadMs),
    fallbackRequestMs: finiteNumberOrNull(timing.fallbackRequestMs)
  };
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function durationFromTimestamps(startedAt, finishedAt) {
  const started = finiteNumberOrNull(startedAt);
  const finished = finiteNumberOrNull(finishedAt);
  if (started == null || finished == null || finished < started) return null;
  return finished - started;
}

function normalizeSender(sender) {
  if (!sender) return null;
  return {
    id: sender.id,
    tabId: sender.tab?.id,
    url: sender.tab?.url,
    frameId: sender.frameId,
    origin: sender.origin
  };
}

function normalizeSource(sender) {
  if (!sender) return 'service-worker';
  if (sender.id && sender.id !== chrome.runtime.id) return 'external-extension';
  if (sender.tab) return 'content-script';
  if (sender.url?.includes('popup.html')) return 'popup';
  return 'extension';
}

function createRequestId(prefix = 'ehplus') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return numeric;
}

function normalizeNonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

function bumpRequest(counters) {
  return {
    ...counters,
    requestCount: (counters.requestCount ?? counters.simulatedRequestCount ?? 0) + 1
  };
}

function accountBalances(account) {
  return {
    credits: account.credits,
    gp: account.gp,
    hath: account.hath
  };
}

function pickAccountStatus(account) {
  return {
    quotaUsed: account.quotaUsed,
    quotaLimit: account.quotaLimit,
    resetCostGp: account.resetCostGp,
    credits: account.credits,
    gp: account.gp,
    hath: account.hath,
    updatedAt: account.updatedAt,
    quotaTone: account.quotaTone
  };
}

function calculateBalanceDelta(before, after) {
  const delta = {};
  for (const key of ['credits', 'gp', 'hath']) {
    const difference = (after[key] ?? 0) - (before[key] ?? 0);
    if (difference !== 0) delta[key] = difference;
  }
  return delta;
}

function shouldShowActualCost({ nominalGp, delta }) {
  const entries = Object.entries(delta ?? {});
  return entries.length > 0 && !(entries.length === 1 && delta.gp === -nominalGp);
}

function dawnResultMessage(event) {
  if (event.type === 'dawn') return '签到成功';
  if (event.type === 'alreadyClaimed') return '今日已签到';
  if (event.type === 'hvMonster') return '今日已签到';
  if (event.type === 'empty') return 'news.php 未返回事件';
  return '未识别的官方事件';
}

function normalizeCleanupRequest(message, settings) {
  return {
    scope: normalizeChoice(message.scope ?? settings?.cleanupScope, ['all', 'images', 'logs', 'other'], 'all'),
    mode: normalizeChoice(message.mode ?? settings?.cleanupMode, ['all', 'olderThanDays'], 'olderThanDays'),
    days: clampInteger(message.days ?? settings?.cleanupDays, 0, 3650, 7),
    includeProtected: Boolean(message.includeProtected ?? settings?.cleanupIncludeProtected),
    includeProtectedGalleries: Boolean(message.includeProtectedGalleries ?? settings?.cleanupIncludeProtectedGalleries)
  };
}

function normalizeChoice(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

async function buildCleanupPreview(state, request) {
  const store = await createActivePreloadStore(state.settings);
  // 浏览历史不参与缓存清理，仅由历史入口删除（规划 §592）。
  const records = withoutHistoryRecords(await store.list());
  const logs = await readRuntimeLogs(state.settings);
  return planRuntimeCleanup({
    records,
    logs,
    settings: state.settings,
    request,
    now: Date.now()
  });
}

async function cleanupActiveStorage(state, request) {
  const store = await createActivePreloadStore(state.settings);
  // 浏览历史不参与缓存清理，仅由历史入口删除（规划 §592）。
  const records = withoutHistoryRecords(await store.list());
  const logs = await readRuntimeLogs(state.settings);
  const plan = planRuntimeCleanup({
    records,
    logs,
    settings: state.settings,
    request,
    now: Date.now()
  });

  // 规划 §8：按天清理图片只删图片体，保留页面元数据/索引/统计；
  // “全部清理”模式仍整条删除。
  const stripImagesOnly = request.mode === 'olderThanDays';
  if (stripImagesOnly) {
    await stripStoreImages(store, plan.recordsToDelete.images);
    await store.deleteMany(plan.recordsToDelete.other);
  } else {
    await store.deleteMany([...plan.recordsToDelete.images, ...plan.recordsToDelete.other]);
  }

  const deleteLogKeys = new Set(plan.logsToDelete.map((log) => runtimeLogKey(log)));
  const remainingLogs = logs.filter((log) => !deleteLogKeys.has(runtimeLogKey(log)));
  const logSummary = await replaceLogs(remainingLogs, state.settings);

  return {
    ok: true,
    request,
    at: plan.createdAt,
    images: {
      success: plan.images.count,
      skipped: plan.images.skippedProtected,
      protectedRemoved: plan.images.protectedRemoved,
      failed: 0,
      bytes: plan.images.bytes,
      stripped: stripImagesOnly
    },
    logs: {
      success: plan.logs.count,
      skipped: 0,
      failed: 0,
      bytes: plan.logs.bytes
    },
    other: {
      success: plan.other.count,
      skipped: plan.other.skippedProtectedGalleries,
      protectedGalleriesRemoved: plan.other.protectedGalleriesRemoved,
      failed: 0,
      bytes: plan.other.bytes
    },
    releaseBytes: plan.releaseBytes,
    logBytes: logSummary.logBytes,
    logCount: logSummary.logCount
  };
}

function applyCleanupResult(state, result) {
  // 按天清理只剥离图片体，页面记录仍在，cacheRecords 不随之减少。
  const removedImageRecords = result.images.stripped ? 0 : result.images.success;
  return {
    ...state,
    cleanup: {
      ...state.cleanup,
      lastResult: result
    },
    storage: {
      ...state.storage,
      imageBytes: Math.max(0, state.storage.imageBytes - result.images.bytes),
      logBytes: Math.max(0, result.logBytes ?? state.storage.logBytes ?? 0),
      logCount: Math.max(0, result.logCount ?? state.storage.logCount ?? 0),
      otherBytes: Math.max(0, state.storage.otherBytes - result.other.bytes),
      totalBytes: Math.max(0, (state.storage.totalBytes ?? 0) - result.releaseBytes),
      cacheRecords: Math.max(0, state.storage.cacheRecords - removedImageRecords - result.other.success),
      imageRecords: Math.max(0, state.storage.imageRecords - result.images.success),
      protectedImages: Math.max(0, state.storage.protectedImages - (result.images.protectedRemoved ?? 0)),
      protectedImageBytes: result.images.protectedRemoved
        ? Math.max(0, state.storage.protectedImageBytes - result.images.bytes)
        : state.storage.protectedImageBytes,
      protectedGalleries: Math.max(0, state.storage.protectedGalleries - (result.other.protectedGalleriesRemoved ?? 0)),
      protectedGalleryBytes: result.other.protectedGalleriesRemoved
        ? Math.max(0, state.storage.protectedGalleryBytes - result.other.bytes)
        : state.storage.protectedGalleryBytes
    }
  };
}

async function checkUpdate() {
  const checkedAt = Date.now();
  const currentVersion = chrome.runtime.getManifest().version;

  if (!GITHUB_RELEASES_API_URL) {
    return {
      ok: true,
      configured: false,
      source: 'GitHub',
      repositoryName: GITHUB_REPOSITORY_NAME,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesPageUrl: GITHUB_RELEASES_PAGE_URL,
      checkedAt,
      currentVersion,
      updateAvailable: false,
      latestVersion: null,
      downloadUrl: null,
      message: '尚未配置项目 GitHub Release 地址，无法检查真实版本。'
    };
  }

  try {
    const response = await fetch(GITHUB_RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json'
      },
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`GitHub release query failed: HTTP ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name ?? release.name ?? '');
    const downloadUrl = selectReleaseAsset(release);
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    return {
      ok: true,
      configured: true,
      source: 'GitHub',
      repositoryName: GITHUB_REPOSITORY_NAME,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesPageUrl: release.html_url ?? GITHUB_RELEASES_PAGE_URL,
      checkedAt,
      currentVersion,
      latestVersion,
      updateAvailable,
      downloadUrl,
      message: updateAvailable ? '发现 GitHub 新版本。' : '当前已是最新版本。'
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      source: 'GitHub',
      repositoryName: GITHUB_REPOSITORY_NAME,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesPageUrl: GITHUB_RELEASES_PAGE_URL,
      checkedAt,
      currentVersion,
      updateAvailable: false,
      latestVersion: null,
      downloadUrl: null,
      message: error.message
    };
  }
}

async function runUpdateCheck(sender, { reason, force }) {
  const result = await checkUpdate();
  const state = await updateState((current) => addLog({
    ...current,
    about: {
      ...current.about,
      currentVersion: current.extensionVersion,
      repositoryName: GITHUB_REPOSITORY_NAME,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesApiUrl: GITHUB_RELEASES_API_URL,
      releasesPageUrl: GITHUB_RELEASES_PAGE_URL,
      updateCheckIntervalMs: UPDATE_CHECK_INTERVAL_MS,
      lastUpdateCheck: result
    }
  }, {
    level: result.ok ? 'info' : 'warning',
    event: 'about.check-update',
    action: 'check-github-release',
    message: result.message,
    sender,
    context: {
      reason,
      force,
      repositoryUrl: GITHUB_REPOSITORY_URL,
      releasesApiUrl: GITHUB_RELEASES_API_URL || null,
      intervalMs: UPDATE_CHECK_INTERVAL_MS
    },
    result
  }));
  return { ok: true, state, result };
}

function normalizeVersion(value) {
  return String(value).trim().replace(/^v/i, '');
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function selectReleaseAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const preferred = assets.find((asset) => /extension.*\.zip$/i.test(asset.name ?? ''))
    ?? assets.find((asset) => /\.zip$/i.test(asset.name ?? ''))
    ?? assets[0];
  return preferred?.browser_download_url ?? release.zipball_url ?? release.html_url ?? null;
}

function isAllowedGithubDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'github.com'
      || parsed.hostname === 'objects.githubusercontent.com'
      || parsed.hostname.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

function summarizeMessage(message) {
  if (!message) return null;
  return Object.fromEntries(Object.entries(message).map(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [key, value];
    }
    if (value && typeof value === 'object') {
      return [key, Object.keys(value)];
    }
    return [key, value];
  }));
}

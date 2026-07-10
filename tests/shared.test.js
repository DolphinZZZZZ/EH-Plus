import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

import { parseHomeQuota, parseExchangeBalances, quotaColor } from '../shared/account-parser.js';
import {
  applyAutoPagerCompatibilityReport,
  applyOwnAutoPagerStatus,
  AUTOPAGER_COMPATIBILITY_MODE,
  OWN_AUTOPAGER_MODE,
  resetAutoPagerCompatibilityForPageSession
} from '../extension/autopager-compatibility.js';
import {
  AUTOPAGER_COMPATIBILITY_MODE as DETECTION_COMPATIBILITY_MODE,
  detectAutoPagerCompatibility,
  summarizeDomForAutoPagerDetection
} from '../shared/autopager-detection.js';
import {
  applyCooperativeStatsDelta,
  buildCooperativeCacheResponse,
  COOPERATIVE_CACHE_QUERY_TYPE,
  COOPERATIVE_CACHE_TYPES,
  COOPERATIVE_RESPONSE_MODES,
  findCooperativeCacheHit,
  normalizeCooperativeCacheQuery,
  parseGalleryKey,
  parseReaderPageKey,
  recordCanDeliver
} from '../extension/cooperative-cache-api.js';
import {
  CACHE_STORAGE_CLASSES,
  completeExternalImageCacheFill,
  createExternalImageCacheFillState,
  markCachedResource,
  markOwnResourceRequest,
  planExternalImageCacheFill
} from '../shared/cache-fill.js';
import { DEDUPE_POINTER_SOURCE, planDuplicateImageMerge } from '../extension/cache-dedupe.js';
import {
  createDirectoryPreloadStore,
  directoryLogDate,
  writeDirectoryLogsSnapshot
} from '../extension/directory-storage.js';
import * as directoryStorage from '../extension/directory-storage.js';
import {
  isAccountRefreshPageUrl,
  shouldRefreshAccountOnTabTransition,
  summarizeAccountRefreshTabUrl,
  summarizeAccountRefreshTabs
} from '../extension/account-refresh-scheduler.js';
import { CLEANUP_SCOPES } from '../shared/constants.js';
import {
  galleryMetadataPageKey,
  planCleanup,
  planImageCacheLimitCleanup,
  planRuntimeCleanup,
  planTemporaryCacheCleanup,
  recordHasStoredImage,
  shouldAllowNewImageCache,
  summarizeProtectedStorage,
  touchRecordAccess
} from '../shared/cleanup.js';
import { parseDawnEvent } from '../shared/dawn-parser.js';
import { FakeStorage, buildPageKey } from '../shared/fake-storage.js';
import { formatBytes, parsePositiveStorageLimit } from '../shared/format.js';
import { migrateImages } from '../shared/migration.js';
import {
  buildExternalImageCacheFillRecord,
  buildExternalResourceCacheFillRecord,
  classifyEhPage,
  createPreloadRequestGateFetch,
  hydratePreloadRecord,
  parseGalleryHtml,
  parseReaderHtml,
  preloadReaderChain,
  runPreloadFromContext,
  shouldStartPreload,
  summarizePreloadRecords
} from '../extension/preload-engine.js';
import { buildRequestDetail, readLiveAccountStatus, readLiveDawnEvent, postLiveQuotaReset } from '../extension/live-api.js';
import {
  PRELOAD_QUEUE_ACTIONS,
  PRELOAD_REQUEST_DECISIONS,
  reconcilePreloadQueueWithExternalActivity,
  removePreloadQueueForSettings,
  removePreloadQueueForAutoPagerPage,
  shouldSkipPreloadRequest,
  shouldSkipPreloadRequestForAutoPager
} from '../shared/preload-queue.js';
import { buildResetQuotaRequest, calculateBalanceDelta, shouldShowActualCost } from '../shared/reset-quota.js';
import { createStats, calculateReaderCacheHitRate, filterFrequentWatch, getFrequentlyWatched, recordFrequentWatch, recordRead, updateFrequentWatchTitle } from '../shared/statistics.js';
import { summarizeStorage } from '../shared/storage-summary.js';
import { imageCleanupZeroDayMessage, parseNonNegativeIntegerDays } from '../shared/validation.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('formats byte sizes with one decimal and TB maximum unit', () => {
  assert.equal(formatBytes(512 * 1024), '512.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.equal(formatBytes(4 * 1024 ** 4), '4.0 TB');
  assert.equal(parsePositiveStorageLimit(50, 'MB'), 50 * 1024 * 1024);
});

test('storage summary shows image count and byte size together', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /\[t\(root, 'images'\), formatImageStorageSummary\(root, storage\)\]/);
  assert.match(source, /function formatImageStorageSummary\(root, storage = \{\}\)/);
  assert.match(source, /\$\{formatNumber\(root, imageCount\)\} \$\{t\(root, 'imageCountUnit'\)\} \/ \$\{formatBytes\(storage\.imageBytes \?\? 0\)\}/);
});

test('stats panel opens history via service worker and does not render frequently watched controls', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.doesNotMatch(source, /data-role="watch-filter"/);
  assert.doesNotMatch(source, /data-role="watch-list"/);
  assert.match(source, /function openHistoryPage\(root\)/);
  // history.html 不是 web accessible，页面上下文 window.open 会被 Chrome 屏蔽，
  // 必须走后台 EHPLUS_OPEN_HISTORY 由 chrome.tabs 打开（规划 §598 2026-07-07 更正）。
  assert.doesNotMatch(source, /globalThis\.open\(chrome\.runtime\.getURL\('history\.html'\)/);
  assert.match(source, /function openHistoryPage\(root\) \{[\s\S]{0,600}?EHPLUS_OPEN_HISTORY/);
});

test('about panel renders clickable GitHub URLs and does not render recommendation links', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /const repositoryUrl = githubLinkUrl\(about\.repositoryUrl\)/);
  assert.match(source, /\[t\(root, 'githubSource'\), repositoryUrl \|\| about\.repositoryName \|\| t\(root, 'none'\), '', repositoryUrl\]/);
  assert.match(source, /const downloadUrl = githubLinkUrl\(result\.downloadUrl\)/);
  assert.match(source, /resultNode\.append\(createExternalLink\(downloadUrl\)\)/);
  assert.match(source, /function createExternalLink\(url, text = url\)/);
  assert.doesNotMatch(source, /cooperativeCacheNotice/);
  assert.doesNotMatch(source, /href="https:\/\/github\.com\/machsix\/Super-preloader"/);
});

test('history page owns the page-type filter for frequent viewing', async () => {
  const html = await readFile(join(root, 'extension', 'history.html'), 'utf8');
  const script = await readFile(join(root, 'extension', 'history.js'), 'utf8');

  assert.match(html, /data-role="history-page-filter"/);
  assert.match(script, /let pageFilter = 'all'/);
  assert.match(script, /entry\.sourcePageType === pageFilter/);
});

test('validates non-negative integer cleanup days', () => {
  for (const value of [0, 1, '7', '30', '365']) {
    assert.deepEqual(parseNonNegativeIntegerDays(value), { ok: true, value: Number(value) });
  }

  for (const value of [-1, 1.5, 'abc', '', 'NaN', 'Infinity']) {
    assert.equal(parseNonNegativeIntegerDays(value).ok, false);
  }

  assert.equal(imageCleanupZeroDayMessage(), '0天表示不按照时间清理缓存。');
  assert.equal(imageCleanupZeroDayMessage({ includeProtected: true }), '0天表示不按照时间清理缓存。');
});

test('parses account quota and balances from offline fixtures', async () => {
  const home = await fixtureText('html/home-quota.html');
  const hath = await fixtureText('html/exchange-hath.html');
  const gp = await fixtureText('html/exchange-gp.html');

  assert.deepEqual(parseHomeQuota(home), {
    used: 465,
    limit: 50000,
    resetCostGp: 930
  });
  assert.deepEqual(parseHomeQuota(`
    <p>You are currently at 0 towards your account limit of 5,000.</p>
    <p>You can reset your image quota by spending 0 GP.</p>
  `), {
    used: 0,
    limit: 5000,
    resetCostGp: 0
  });
  assert.deepEqual(parseExchangeBalances(hath), {
    credits: 123456,
    hath: 789,
    gp: null
  });
  assert.deepEqual(parseExchangeBalances(gp), {
    credits: 123456,
    hath: null,
    gp: 62000
  });
  assert.equal(quotaColor({ used: 465, limit: 50000 }), 'green');
  assert.equal(quotaColor({ used: 25000, limit: 50000 }), 'yellow');
  assert.equal(quotaColor({ used: 50001, limit: 50000 }), 'red');
});

test('builds compact EH request diagnostics without full HTML bodies', () => {
  const detail = buildRequestDetail({
    source: 'home',
    url: 'https://e-hentai.org/home.php',
    method: 'GET',
    startedAt: Date.now() - 12,
    response: {
      url: 'https://e-hentai.org/home.php',
      status: 200,
      ok: true,
      redirected: false,
      headers: new Map([['content-type', 'text/html']])
    },
    text: '<html><head><title>Home</title><script>secret()</script></head><body> Image Limits: 1 / 500 '.repeat(20)
  });

  assert.equal(detail.source, 'home');
  assert.equal(detail.status, 200);
  assert.equal(detail.contentType, 'text/html');
  assert.equal(detail.title, 'Home');
  assert.ok(detail.durationMs >= 0);
  assert.ok(detail.textSample.length <= 240);
  assert.equal(detail.textSample.includes('secret()'), false);
  assert.equal(detail.debugText, undefined);
});

test('keeps full text diagnostics only when debug text logging is enabled for text responses', () => {
  const html = '<html><head><title>Debug</title></head><body>完整 HTML 响应</body></html>';
  const detail = buildRequestDetail({
    source: 'news',
    url: 'https://e-hentai.org/news.php',
    method: 'GET',
    startedAt: Date.now() - 5,
    response: {
      url: 'https://e-hentai.org/news.php',
      status: 200,
      ok: true,
      redirected: false,
      headers: new Map([['content-type', 'text/html; charset=UTF-8']])
    },
    text: html,
    debugTextEnabled: true
  });

  assert.equal(detail.debugText, html);
  assert.equal(detail.debugTextChars, html.length);
  assert.ok(detail.debugTextCapturedAt > 0);
});

test('does not keep debug response bodies for non-text content types', () => {
  const detail = buildRequestDetail({
    source: 'image',
    url: 'https://example.test/file.jpg',
    method: 'GET',
    startedAt: Date.now() - 5,
    response: {
      url: 'https://example.test/file.jpg',
      status: 200,
      ok: true,
      redirected: false,
      headers: new Map([['content-type', 'image/jpeg']])
    },
    text: 'binary-like-placeholder',
    debugTextEnabled: true
  });

  assert.equal(detail.debugText, undefined);
});

test('uses E-Hentai account endpoints even when triggered from ExHentai pages', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = responseBodyForUrl(String(url));
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: String(url),
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return body;
      }
    };
  };

  try {
    const sender = { tab: { url: 'https://exhentai.org/g/100/abc/' } };
    const account = await readLiveAccountStatus(sender);
    const dawn = await readLiveDawnEvent(sender);
    const reset = await postLiveQuotaReset(sender);

    assert.equal(account.origin, 'https://e-hentai.org');
    assert.equal(dawn.sourceUrl, 'https://e-hentai.org/news.php');
    assert.equal(reset.url, 'https://e-hentai.org/home.php');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://e-hentai.org/home.php',
      'https://e-hentai.org/exchange.php?t=hath',
      'https://e-hentai.org/exchange.php?t=gp',
      'https://e-hentai.org/news.php',
      'https://e-hentai.org/home.php'
    ]);
    assert.equal(calls.at(-1).init.method, 'POST');
    assert.equal(calls.some((call) => call.url.startsWith('https://exhentai.org/')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parses Dawn, already-claimed, HV monster-as-claimed, empty, and unknown events', async () => {
  const dawn = parseDawnEvent(await fixtureText('html/news-dawn.html'));
  assert.equal(dawn.type, 'dawn');
  assert.deepEqual(dawn.rewards, {
    exp: 30,
    credits: 10426,
    gp: 10000,
    hath: 16
  });

  const monster = parseDawnEvent(await fixtureText('html/news-hv-monster.html'));
  assert.equal(monster.type, 'alreadyClaimed');
  assert.equal(monster.links[0].href, 'https://hentaiverse.org/');

  assert.equal(parseDawnEvent(await fixtureText('html/news-empty.html')).type, 'unknown');

  const unknown = parseDawnEvent(await fixtureText('html/news-unknown-event.html'));
  assert.equal(unknown.type, 'unknown');
  assert.equal(unknown.links[0].href, 'https://e-hentai.org/news.php');
  const alreadyClaimed = parseDawnEvent(`<div id="eventpane">You have already claimed today's Dawn reward.</div>`);
  assert.equal(alreadyClaimed.type, 'alreadyClaimed');
  assert.equal(alreadyClaimed.message, `You have already claimed today's Dawn reward.`);
});

test('summarizes image, log, and other storage buckets', async () => {
  const records = await fixtureJson('data/cache-records.json');
  const summary = summarizeStorage({
    records,
    logs: [{ message: 'abc' }],
    other: [{ key: 'value' }]
  });

  assert.equal(summary.imageBytes, 42);
  assert.equal(summary.temporaryImageBytes, 0);
  assert.equal(summary.logBytes, 3);
  assert.ok(summary.otherBytes > 0);
  assert.equal(summary.totalBytes, summary.imageBytes + summary.logBytes + summary.otherBytes);
});

test('plans image cleanup with high-read protection', async () => {
  const records = await fixtureJson('data/cache-records.json');
  const now = Date.UTC(2024, 6, 15);
  const plan = planCleanup({
    records,
    scope: CLEANUP_SCOPES.IMAGES,
    mode: 'olderThanDays',
    days: 7,
    now,
    protection: {
      protectHighReadImages: true,
      highReadThreshold: 3
    }
  });

  assert.deepEqual(plan.records.map((record) => record.pageKey), ['1001:2']);
  assert.deepEqual(plan.skippedProtected.map((record) => record.pageKey).sort(), ['1001:1', '1002:1']);

  const includeProtected = planCleanup({
    records,
    scope: CLEANUP_SCOPES.IMAGES,
    mode: 'olderThanDays',
    days: 7,
    now,
    includeProtected: true,
    protection: {
      protectHighReadImages: true,
      highReadThreshold: 3
    }
  });
  assert.deepEqual(includeProtected.records.map((record) => record.pageKey).sort(), ['1001:1', '1001:2', '1002:1']);
});

test('does not clean by age when cleanup days is zero', async () => {
  const records = await fixtureJson('data/cache-records.json');
  const now = Date.UTC(2024, 6, 15);
  const plan = planCleanup({
    records,
    scope: CLEANUP_SCOPES.IMAGES,
    mode: 'olderThanDays',
    days: 0,
    now,
    includeProtected: true,
    protection: {
      protectHighReadImages: true,
      highReadThreshold: 3
    }
  });

  assert.deepEqual(plan.records, []);
  assert.deepEqual(plan.skippedProtected, []);
});

test('plans gallery cleanup with high-read protection', () => {
  const now = Date.UTC(2024, 6, 15);
  const galleries = [
    { gid: '1001', readCount: 8, updatedAt: Date.UTC(2024, 5, 1), title: 'protected' },
    { gid: '1002', readCount: 2, updatedAt: Date.UTC(2024, 5, 1), title: 'cleanable' }
  ];
  const plan = planCleanup({
    galleries,
    scope: CLEANUP_SCOPES.OTHER,
    mode: 'olderThanDays',
    days: 7,
    now,
    protection: {
      protectHighReadGalleries: true,
      highReadGalleryThreshold: 3
    }
  });

  assert.deepEqual(plan.other.map((gallery) => gallery.gid), ['1002']);
  assert.deepEqual(plan.skippedProtectedGalleries.map((gallery) => gallery.gid), ['1001']);

  const includeProtectedGalleries = planCleanup({
    galleries,
    scope: CLEANUP_SCOPES.OTHER,
    mode: 'olderThanDays',
    days: 7,
    now,
    includeProtectedGalleries: true,
    protection: {
      protectHighReadGalleries: true,
      highReadGalleryThreshold: 3
    }
  });
  assert.deepEqual(includeProtectedGalleries.other.map((gallery) => gallery.gid).sort(), ['1001', '1002']);
});

test('blocks new image blobs when protected images exceed size cap', async () => {
  const records = await fixtureJson('data/cache-records.json');
  const result = shouldAllowNewImageCache(records, {
    maxImageBytes: 20,
    protection: {
      protectHighReadImages: true,
      highReadThreshold: 3
    }
  });

  assert.equal(result.allow, false);
  assert.equal(result.protectedBytes, 28);
});

test('plans runtime cleanup preview by record age and deletes matching logs', () => {
  const now = Date.UTC(2024, 5, 10);
  const records = [
    { pageKey: '1001:1', imageBytes: 100, updatedAt: Date.UTC(2024, 5, 1), readCount: 1 },
    { pageKey: '1001:2', imageBytes: 200, updatedAt: Date.UTC(2024, 5, 8), readCount: 1 }
  ];
  const logs = [
    { at: Date.UTC(2024, 5, 1), message: 'old log', requestId: 'a' },
    { at: Date.UTC(2024, 5, 9), message: 'new log', requestId: 'b' }
  ];

  const preview = planRuntimeCleanup({
    records,
    logs,
    settings: {},
    request: { scope: 'all', mode: 'olderThanDays', days: 7, includeProtected: false, includeProtectedGalleries: false },
    now
  });

  assert.equal(preview.images.count, 1);
  assert.equal(preview.images.bytes, 100);
  assert.equal(preview.logs.count, 1);
  assert.equal(preview.cutoffAt, now - 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(preview.recordsToDelete.images.map((record) => record.pageKey), ['1001:1']);
  assert.equal(preview.logsToDelete.length, 1);
});

test('runtime cleanup days zero disables time-based cleanup', () => {
  const now = Date.UTC(2024, 5, 10);
  const records = [
    { pageKey: '1001:1', imageBytes: 100, updatedAt: Date.UTC(2024, 5, 1), readCount: 1 },
    { pageKey: '1001:2', imageBytes: 200, updatedAt: Date.UTC(2024, 5, 8), readCount: 1 },
    { pageKey: 'gallery:2001', galleryBytes: 50, updatedAt: Date.UTC(2024, 5, 1), readCount: 5 }
  ];
  const logs = [
    { at: Date.UTC(2024, 5, 1), message: 'old log', requestId: 'a' }
  ];

  const preview = planRuntimeCleanup({
    records,
    logs,
    settings: { protectHighReadGalleries: true, highReadGalleryThreshold: 3 },
    request: { scope: 'all', mode: 'olderThanDays', days: 0, includeProtected: true, includeProtectedGalleries: true },
    now
  });

  assert.equal(preview.cutoffAt, null);
  assert.equal(preview.images.count, 0);
  assert.equal(preview.logs.count, 0);
  assert.equal(preview.other.count, 0);
  assert.equal(preview.releaseBytes, 0);
  assert.deepEqual(preview.recordsToDelete.images, []);
  assert.deepEqual(preview.recordsToDelete.other, []);
  assert.deepEqual(preview.logsToDelete, []);
  assert.equal(preview.warning, '0天表示不按照时间清理缓存。');
});

test('plans runtime cleanup without Node Buffer for service worker compatibility', () => {
  const originalBuffer = globalThis.Buffer;
  globalThis.Buffer = undefined;

  try {
    const preview = planRuntimeCleanup({
      records: [],
      logs: [{ at: 1, message: 'old log' }],
      settings: {},
      request: { scope: 'logs', mode: 'olderThanDays', days: 1, includeProtected: false, includeProtectedGalleries: false },
      now: 3 * 24 * 60 * 60 * 1000
    });

    assert.equal(preview.logs.count, 1);
    assert.ok(preview.logs.bytes > 0);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

test('service worker registers scheduled TTL cleanup alarm', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  assert.match(source, /const RUNTIME_CLEANUP_ALARM_NAME = 'ehplus-runtime-cleanup'/);
  assert.match(source, /const RUNTIME_CLEANUP_INTERVAL_MINUTES = 24 \* 60/);
  assert.match(source, /const RUNTIME_CLEANUP_INTERVAL_MS = RUNTIME_CLEANUP_INTERVAL_MINUTES \* 60 \* 1000/);
  assert.match(source, /lastAutoCleanupAt: 0/);
  assert.match(source, /chrome\.alarms\.get\(RUNTIME_CLEANUP_ALARM_NAME\)/);
  assert.match(source, /existing\?\.periodInMinutes === RUNTIME_CLEANUP_INTERVAL_MINUTES/);
  assert.match(source, /chrome\.alarms\.create\(RUNTIME_CLEANUP_ALARM_NAME/);
  assert.match(source, /delayInMinutes: RUNTIME_CLEANUP_INTERVAL_MINUTES/);
  assert.match(source, /periodInMinutes: RUNTIME_CLEANUP_INTERVAL_MINUTES/);
  assert.match(source, /initializeRuntimeCleanupOnWake\('service-worker-wakeup'\)/);
  assert.match(source, /maybeRunRuntimeCleanupOnWake\('page-session-started'\)/);
  assert.match(source, /now - lastAutoCleanupAt < RUNTIME_CLEANUP_INTERVAL_MS/);
  assert.match(source, /reason: 'cleanup-interval-not-elapsed'/);
  assert.match(source, /lastAutoCleanupAt: now/);
  assert.match(source, /alarm\.name === RUNTIME_CLEANUP_ALARM_NAME/);
  assert.match(source, /runRuntimeCleanupAlarm/);
  assert.match(source, /mode: 'olderThanDays'/);
  assert.match(source, /if \(days <= 0\) return null/);
});

test('includes protected images when cleaning all cache', () => {
  const records = [
    { pageKey: '1001:1', imageBytes: 100, readCount: 8, updatedAt: Date.UTC(2024, 5, 1) },
    { pageKey: '1001:2', imageBytes: 50, readCount: 1, updatedAt: Date.UTC(2024, 5, 1) }
  ];

  const preview = planRuntimeCleanup({
    records,
    logs: [],
    settings: { protectHighReadImages: true, highReadThreshold: 3 },
    request: { scope: 'images', mode: 'all', days: 0, includeProtected: false, includeProtectedGalleries: false },
    now: Date.UTC(2024, 5, 10)
  });

  assert.equal(preview.images.count, 2);
  assert.equal(preview.images.skippedProtected, 0);
  assert.equal(preview.images.protectedRemoved, 1);
});

test('tracks read counts and protected storage summaries', () => {
  const touched = touchRecordAccess({ pageKey: '1001:1', readCount: 3, cacheHitCount: 1 }, {
    readInc: 1,
    cacheHitInc: 1,
    at: 1000
  });
  assert.equal(touched.readCount, 4);
  assert.equal(touched.cacheHitCount, 2);
  assert.equal(touched.lastAccess, 1000);

  const summary = summarizeProtectedStorage([
    { pageKey: '1001:1', imageBytes: 100, readCount: 4 },
    { pageKey: galleryMetadataPageKey('2002:token'), readCount: 5, galleryKey: '2002:token' }
  ], {
    protectHighReadImages: true,
    highReadThreshold: 3,
    protectHighReadGalleries: true,
    highReadGalleryThreshold: 3
  });

  assert.equal(summary.protectedImages, 1);
  assert.equal(summary.protectedImageBytes, 100);
  assert.equal(summary.protectedGalleries, 1);
});

test('maintains frequently watched entries for reader and gallery pages', () => {
  let stats = { readerReads: 0, readerHits: 0, frequent: [] };
  stats = recordFrequentWatch(stats, {
    pageType: 's',
    gid: '2786404',
    title: 'Reader A',
    lastPageUrl: 'https://e-hentai.org/s/fake-reader-token-a/2786404-1',
    readAt: 1000
  });
  stats = recordFrequentWatch(stats, {
    pageType: 'g',
    gid: '2002',
    token: 'abc',
    title: 'Gallery B',
    galleryUrl: 'https://e-hentai.org/g/2002/abc/',
    readAt: 2000
  });
  stats = recordFrequentWatch(stats, {
    pageType: 's',
    gid: '2786404',
    title: 'Reader A',
    lastPageUrl: 'https://e-hentai.org/s/fake-reader-token-b/2786404-2',
    readAt: 3000
  });

  assert.equal(stats.frequent.length, 2);
  assert.equal(stats.frequent[0].gid, '2786404');
  assert.equal(stats.frequent[0].readCount, 2);
  assert.equal(filterFrequentWatch(stats, { pageType: 'g' })[0].gid, '2002');

  stats = recordFrequentWatch(stats, {
    pageType: 's',
    gid: '2786404',
    title: '2786404',
    originalTitle: 'Reader A Japanese',
    readAt: 4000
  });
  assert.equal(stats.frequent[0].title, 'Reader A');
  assert.equal(stats.frequent[0].originalTitle, 'Reader A Japanese');

  stats = recordFrequentWatch(stats, {
    pageType: 's',
    gid: '2786404',
    title: 'Reader A Updated',
    originalTitle: 'Reader A Japanese',
    readAt: 5000
  });
  assert.equal(stats.frequent[0].title, 'Reader A Updated');

  stats = updateFrequentWatchTitle(stats, {
    pageType: 's',
    gid: '2786404',
    title: 'Reader A DOM Title',
    originalTitle: 'Reader A Japanese',
    lastPageUrl: 'https://e-hentai.org/s/fake-reader-token-b/2786404-2'
  });
  assert.equal(stats.frequent[0].title, 'Reader A DOM Title');
  assert.equal(stats.frequent[0].readCount, 4);
});

test('cleans temporary image cache only after all EH pages are closed', () => {
  const records = [
    { pageKey: '1001:1', imageBytes: 10, storageClass: CACHE_STORAGE_CLASSES.PERMANENT },
    {
      resourceKey: 'https://a.hath.network/1.webp',
      imageBytes: 20,
      storageClass: CACHE_STORAGE_CLASSES.TEMPORARY,
      readCount: 8,
      cacheHitCount: 5
    }
  ];

  const keep = planTemporaryCacheCleanup({ records, openEhPageCount: 1 });
  assert.equal(keep.action, 'keep');
  assert.equal(keep.records.length, 0);

  const cleanup = planTemporaryCacheCleanup({ records, openEhPageCount: 0 });
  assert.equal(cleanup.action, 'cleanup');
  assert.deepEqual(cleanup.records.map((record) => record.resourceKey), ['https://a.hath.network/1.webp']);
  assert.equal(cleanup.statsDelta, undefined);
  assert.equal(cleanup.records[0].cacheHitCount, 5);
});

test('prioritizes temporary images when image cache exceeds size limit', () => {
  const records = [
    { pageKey: '1001:1', imageBytes: 70, storageClass: CACHE_STORAGE_CLASSES.PERMANENT, lastAccess: 1 },
    { resourceKey: 'https://a.hath.network/old.webp', imageBytes: 20, storageClass: CACHE_STORAGE_CLASSES.TEMPORARY, lastAccess: 2 },
    { resourceKey: 'https://a.hath.network/new.webp', imageBytes: 20, storageClass: CACHE_STORAGE_CLASSES.TEMPORARY, lastAccess: 3 }
  ];

  const plan = planImageCacheLimitCleanup(records, { maxImageBytes: 80 });
  assert.equal(plan.action, 'cleanup');
  assert.deepEqual(plan.records.map((record) => record.resourceKey), [
    'https://a.hath.network/old.webp',
    'https://a.hath.network/new.webp'
  ]);
});

test('plans duplicate image cache merge by URL and image hash', () => {
  const records = [
    {
      pageKey: '1001:1',
      imageUrl: 'https://img.example.test/a.webp',
      resourceKey: 'https://img.example.test/a.webp',
      imageBytes: 100,
      imageHash: 'a'.repeat(64),
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT,
      readCount: 3,
      cacheHitCount: 2,
      updatedAt: 10,
      lastAccess: 20
    },
    {
      pageKey: '1001:2',
      imageUrl: 'https://img.example.test/a.webp#fragment',
      resourceKey: 'https://img.example.test/a.webp',
      imageBytes: 100,
      imageHash: 'a'.repeat(64),
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT,
      readCount: 4,
      cacheHitCount: 1,
      updatedAt: 30,
      lastAccess: 40
    },
    {
      pageKey: '1001:3',
      imageUrl: 'https://cdn.example.test/different-url.webp',
      resourceKey: 'https://cdn.example.test/different-url.webp',
      imageBytes: 100,
      imageHash: 'a'.repeat(64),
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT,
      readCount: 1,
      cacheHitCount: 0,
      updatedAt: 50,
      lastAccess: 60
    }
  ];

  const plan = planDuplicateImageMerge(records, { now: 1000 });
  assert.equal(plan.action, 'merge');
  assert.equal(plan.duplicateGroups, 1);
  assert.equal(plan.canonicalUpdates.length, 1);
  assert.equal(plan.pointerUpdates.length, 2);
  assert.equal(plan.releasedBytes, 200);

  const canonical = plan.canonicalUpdates[0];
  assert.equal(canonical.pageKey, '1001:2');
  assert.deepEqual(canonical.pageKeyAliases.sort(), ['1001:1', '1001:3']);
  assert.equal(canonical.readCount, 8);
  assert.equal(canonical.cacheHitCount, 3);
  assert.equal(canonical.mergedImageCount, 3);

  const pointer = plan.pointerUpdates.find((record) => record.pageKey === '1001:1');
  assert.equal(pointer.source, DEDUPE_POINTER_SOURCE);
  assert.equal(pointer.canonicalPageKey, '1001:2');
  assert.equal(pointer.hasImageBlob, false);
  assert.equal(pointer.imageBytes, 0);
  assert.equal(pointer.duplicateImageBytes, 100);
});

test('migrates fake image cache with hash verification', async () => {
  const source = new FakeStorage(await fixtureJson('data/cache-records.json'));
  const target = new FakeStorage();
  const result = await migrateImages({ source, target, deleteSourceAfterSuccess: false });

  assert.equal(result.failed.length, 0);
  assert.equal(result.migrated.length, 3);
  assert.equal(target.list().length, 3);
  assert.equal(source.list().length, 3);
});

test('records /s and /g reads separately and computes /s cache hit rate', () => {
  const stats = createStats();
  recordRead(stats, {
    pageType: 's',
    gid: 9001001,
    pageNo: 1,
    cacheHit: true,
    title: 'Reader A',
    galleryUrl: 'https://e-hentai.org/g/9001001/fake-gallery-token-a/',
    readAt: 10
  });
  recordRead(stats, {
    pageType: 's',
    gid: 9001001,
    pageNo: 2,
    cacheHit: false,
    title: 'Reader A',
    readAt: 20
  });
  recordRead(stats, {
    pageType: 'g',
    gid: 9001002,
    cacheHit: false,
    title: 'Gallery B',
    galleryUrl: 'https://exhentai.org/g/9001002/fake-gallery-token-b/',
    readAt: 30
  });

  assert.deepEqual(calculateReaderCacheHitRate(stats), {
    hits: 1,
    total: 2,
    rate: 0.5
  });

  const watched = getFrequentlyWatched(stats, { pageType: 'all' });
  assert.equal(watched[0].gid, '9001001');
  assert.equal(watched[0].readCount, 2);
  assert.equal(getFrequentlyWatched(stats, { pageType: 'g' })[0].gid, '9001002');
});

test('normalizes cooperative cache queries by page key, reader URL, gallery URL, and resource URL', () => {
  assert.equal(parseReaderPageKey('https://exhentai.org/s/fake-reader-token-a/2786404-1'), '2786404:1');
  assert.equal(parseGalleryKey('https://exhentai.org/g/9001002/fake-gallery-token-b/'), '9001002:fake-gallery-token-b');

  assert.deepEqual(normalizeCooperativeCacheQuery({
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    requestedBy: 'Super-preloader'
  }), {
    ok: true,
    version: 1,
    cacheType: COOPERATIVE_CACHE_TYPES.READER,
    pageKey: '2786404:2',
    galleryKey: null,
    resourceKey: null,
    responseMode: COOPERATIVE_RESPONSE_MODES.URL,
    requestedBy: 'Super-preloader'
  });

  assert.deepEqual(normalizeCooperativeCacheQuery({
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    galleryUrl: 'https://exhentai.org/g/9001002/fake-gallery-token-b/',
    requestedBy: 'Pagetual'
  }), {
    ok: true,
    version: 1,
    cacheType: COOPERATIVE_CACHE_TYPES.GALLERY,
    pageKey: null,
    galleryKey: '9001002:fake-gallery-token-b',
    resourceKey: null,
    responseMode: COOPERATIVE_RESPONSE_MODES.URL,
    requestedBy: 'Pagetual'
  });

  assert.equal(normalizeCooperativeCacheQuery({
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp#loaded'
  }).resourceKey, 'https://fake-a.hath.network/virtual/fixture/02.webp');

  assert.equal(normalizeCooperativeCacheQuery({
    type: COOPERATIVE_CACHE_QUERY_TYPE
  }).reason, 'missing-cache-key');
});

test('returns cooperative cache hits and counts only successful hits', () => {
  const records = [
    {
      pageKey: '2786404:2',
      imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp',
      title: 'English Gallery Title',
      originalTitle: '日本語ギャラリータイトル',
      blobUrl: 'blob:chrome-extension://ehplus/2786404-2',
      mimeType: 'image/webp',
      imageBytes: 123,
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT
    }
  ];
  const stats = { readerReads: 10, readerHits: 6 };
  const hit = buildCooperativeCacheResponse(records, {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    responseMode: COOPERATIVE_RESPONSE_MODES.URL
  });

  assert.equal(hit.hit, true);
  assert.equal(hit.pageKey, '2786404:2');
  assert.equal(hit.cacheType, COOPERATIVE_CACHE_TYPES.READER);
  assert.equal(hit.title, 'English Gallery Title');
  assert.equal(hit.originalTitle, '日本語ギャラリータイトル');
  assert.equal(hit.delivery.url, 'blob:chrome-extension://ehplus/2786404-2');
  assert.equal(hit.countsAsCacheHit, true);
  assert.deepEqual(applyCooperativeStatsDelta(stats, hit), {
    readerReads: 11,
    readerHits: 7,
    galleryReads: 0,
    galleryResourceReads: 0
  });

  const miss = buildCooperativeCacheResponse(records, {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:3'
  });
  assert.equal(miss.hit, false);
  assert.equal(miss.reason, 'not-found');
  // 2026-07-07：读取尝试（命中与否）都计入访问，未命中回退外链仍属同一次访问，
  // 因此 miss 也让 readerReads +1，只是不计 readerHits。
  assert.deepEqual(applyCooperativeStatsDelta(stats, miss), {
    readerReads: 11,
    readerHits: 6,
    galleryReads: 0,
    galleryResourceReads: 0
  });
});

test('cooperative cache hits when either page key or resource URL is deliverable', () => {
  const pageRecord = {
    pageKey: '2786404:2',
    imageUrl: 'https://img.example.test/old-token.webp',
    dataUrl: 'data:image/webp;base64,cGFnZQ==',
    mimeType: 'image/webp',
    imageBytes: 4,
    storageClass: CACHE_STORAGE_CLASSES.PERMANENT
  };
  const resourceRecord = {
    resourceKey: 'https://img.example.test/new-token.webp',
    imageUrl: 'https://img.example.test/new-token.webp',
    dataUrl: 'data:image/webp;base64,dXJs',
    mimeType: 'image/webp',
    imageBytes: 3,
    storageClass: CACHE_STORAGE_CLASSES.TEMPORARY
  };

  const byPageKey = buildCooperativeCacheResponse([pageRecord], {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    imageUrl: 'https://img.example.test/new-token.webp'
  });
  assert.equal(byPageKey.hit, true);
  assert.equal(byPageKey.pageKey, '2786404:2');
  assert.equal(byPageKey.delivery.url, 'data:image/webp;base64,cGFnZQ==');

  const byUrlAfterMetadataOnlyPage = buildCooperativeCacheResponse([
    {
      pageKey: '2786404:2',
      imageUrl: 'https://img.example.test/old-token.webp',
      hasImageBlob: false,
      imageBytes: 0
    },
    resourceRecord
  ], {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    imageUrl: 'https://img.example.test/new-token.webp'
  });
  assert.equal(byUrlAfterMetadataOnlyPage.hit, true);
  assert.equal(byUrlAfterMetadataOnlyPage.pageKey, '2786404:2');
  assert.equal(byUrlAfterMetadataOnlyPage.resourceKey, 'https://img.example.test/new-token.webp');
  assert.equal(byUrlAfterMetadataOnlyPage.delivery.url, 'data:image/webp;base64,dXJs');
});

test('returns canonical image data through dedupe pointer records', () => {
  const records = [
    {
      pageKey: '2786404:1',
      pageKeyAliases: ['2786404:2'],
      imageUrl: 'https://img.example.test/canonical.webp',
      resourceKey: 'https://img.example.test/canonical.webp',
      dataUrl: 'data:image/webp;base64,Y2Fub25pY2Fs',
      mimeType: 'image/webp',
      imageBytes: 9,
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT
    },
    {
      pageKey: '2786404:2',
      imageUrl: 'https://img.example.test/old-url.webp',
      resourceKey: 'https://img.example.test/old-url.webp',
      canonicalPageKey: '2786404:1',
      hasImageBlob: false,
      imageBytes: 0,
      source: DEDUPE_POINTER_SOURCE
    }
  ];

  const byPageKey = buildCooperativeCacheResponse(records, {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    responseMode: COOPERATIVE_RESPONSE_MODES.URL
  });
  assert.equal(byPageKey.hit, true);
  assert.equal(byPageKey.pageKey, '2786404:2');
  assert.equal(byPageKey.pageNo, 2);
  assert.equal(byPageKey.canonicalPageKey, undefined);
  assert.equal(byPageKey.delivery.url, 'data:image/webp;base64,Y2Fub25pY2Fs');

  const byOldUrl = buildCooperativeCacheResponse(records, {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    imageUrl: 'https://img.example.test/old-url.webp'
  });
  assert.equal(byOldUrl.hit, true);
  assert.equal(byOldUrl.resourceKey, 'https://img.example.test/old-url.webp');
  assert.equal(byOldUrl.delivery.url, 'data:image/webp;base64,Y2Fub25pY2Fs');
});

test('returns cooperative gallery cache hits and updates /g statistics separately', () => {
  const records = [
    {
      galleryKey: '9001002:fake-gallery-token-b',
      galleryUrl: 'https://exhentai.org/g/9001002/fake-gallery-token-b/',
      dataUrl: 'data:application/json;base64,e30=',
      mimeType: 'application/json',
      galleryBytes: 2,
      storageClass: CACHE_STORAGE_CLASSES.PERMANENT
    }
  ];
  const stats = {
    readerReads: 10,
    readerHits: 6,
    galleryReads: 2,
    galleryResourceReads: 1
  };
  const hit = buildCooperativeCacheResponse(records, {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    galleryUrl: 'https://exhentai.org/g/9001002/fake-gallery-token-b/',
    responseMode: COOPERATIVE_RESPONSE_MODES.URL
  });

  assert.equal(hit.hit, true);
  assert.equal(hit.cacheType, COOPERATIVE_CACHE_TYPES.GALLERY);
  assert.equal(hit.galleryKey, '9001002:fake-gallery-token-b');
  assert.equal(hit.gid, '9001002');
  assert.equal(hit.token, 'fake-gallery-token-b');
  assert.equal(hit.delivery.url, 'data:application/json;base64,e30=');
  // 2026-07-07：galleryReads（画廊访问次数）改由真实页面会话计数，
  // 元数据缓存命中只计资源缓存读取（galleryResourceReads）。
  assert.deepEqual(applyCooperativeStatsDelta(stats, hit), {
    readerReads: 10,
    readerHits: 6,
    galleryReads: 2,
    galleryResourceReads: 2
  });
});

test('counts temporary resource cache hits and keeps statistics after temporary cleanup', () => {
  const temporaryRecord = {
    resourceKey: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    dataUrl: 'data:image/webp;base64,AAAA',
    mimeType: 'image/webp',
    imageBytes: 4,
    storageClass: CACHE_STORAGE_CLASSES.TEMPORARY
  };
  const stats = {
    readerReads: 10,
    readerHits: 6,
    galleryReads: 2,
    galleryResourceReads: 1
  };
  const hit = buildCooperativeCacheResponse([temporaryRecord], {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    imageUrl: temporaryRecord.imageUrl,
    responseMode: COOPERATIVE_RESPONSE_MODES.URL
  });

  assert.equal(hit.hit, true);
  assert.equal(hit.cacheType, COOPERATIVE_CACHE_TYPES.RESOURCE);
  assert.equal(hit.storageClass, CACHE_STORAGE_CLASSES.TEMPORARY);
  const nextStats = applyCooperativeStatsDelta(stats, hit);
  assert.deepEqual(nextStats, {
    readerReads: 10,
    readerHits: 6,
    galleryReads: 2,
    galleryResourceReads: 2
  });

  const cleanup = planTemporaryCacheCleanup({ records: [temporaryRecord], openEhPageCount: 0 });
  assert.deepEqual(cleanup.records, [temporaryRecord]);
  assert.deepEqual(nextStats, {
    readerReads: 10,
    readerHits: 6,
    galleryReads: 2,
    galleryResourceReads: 2
  });
});

test('builds official reset quota request and display delta decisions', () => {
  assert.deepEqual(buildResetQuotaRequest(), {
    method: 'POST',
    url: 'https://e-hentai.org/home.php',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'reset_imagelimit=Reset+Quota'
  });

  assert.deepEqual(calculateBalanceDelta(
    { credits: 1000, gp: 100, hath: 3 },
    { credits: 700, gp: 100, hath: 3 }
  ), { credits: -300 });
  assert.equal(shouldShowActualCost({ nominalGp: 930, delta: { gp: -930 } }), false);
  assert.equal(shouldShowActualCost({ nominalGp: 930, delta: { credits: -300 } }), true);
  assert.equal(shouldShowActualCost({ nominalGp: 930, delta: {} }), false);
});

test('detects known auto-pager markers and enters compatibility mode', () => {
  const superPreloader = detectAutoPagerCompatibility({
    selectors: ['#sp-fw-container']
  });

  assert.equal(superPreloader.detected, true);
  assert.equal(superPreloader.mode, DETECTION_COMPATIBILITY_MODE);
  assert.equal(superPreloader.shouldYieldNextPageRequests, true);
  assert.equal(superPreloader.matches[0].name, 'Super-preloader');

  const pagetual = detectAutoPagerCompatibility({
    messages: [{ command: 'pagetual', action: 'insert' }]
  });
  assert.equal(pagetual.detected, true);
  assert.equal(pagetual.matches[0].name, 'Pagetual');

  const infy = detectAutoPagerCompatibility({
    selectors: ['.infy-scroll-page']
  });
  assert.equal(infy.detected, true);
  assert.equal(infy.matches[0].name, 'Infy Scroll');
});

test('detects generic auto-pager behavior without treating one next link as auto-paging', () => {
  const normal = detectAutoPagerCompatibility({
    insertedReaderPages: 1,
    recentRequests: [
      { url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', at: 1000 }
    ],
    now: 1000
  });

  assert.equal(normal.detected, false);
  assert.equal(normal.shouldYieldNextPageRequests, false);

  const inserted = detectAutoPagerCompatibility({
    insertedReaderPages: 2
  });
  assert.equal(inserted.detected, true);
  assert.equal(inserted.matches[0].id, 'generic-next-page-inserts');

  const fastRequests = detectAutoPagerCompatibility({
    recentRequests: [
      { url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', at: 1000 },
      { url: 'https://exhentai.org/s/fake-reader-token-b/2786404-2', at: 1800 }
    ],
    now: 1800
  }, {
    threshold: 0.68
  });
  assert.equal(fastRequests.detected, true);
  assert.equal(fastRequests.matches[0].id, 'generic-fast-reader-requests');
});

test('does not treat native reader navigation links as inserted auto-pager pages', () => {
  const root = fakeAutoPagerRoot({
    anchors: [
      { href: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', id: 'prev' },
      { href: 'https://exhentai.org/s/fake-reader-token-b/2786404-2', id: 'next' },
      { href: 'https://exhentai.org/s/fake-reader-token-z/2786404-28' }
    ],
    images: [
      {
        id: 'img',
        src: 'https://fake-b.hath.network/virtual/fixture/01.webp'
      }
    ]
  });
  const summary = summarizeDomForAutoPagerDetection(root);
  const detection = detectAutoPagerCompatibility(summary);

  assert.equal(summary.insertedReaderPages, 0);
  assert.equal(detection.detected, false);
});

test('detects generic auto-pager when extra reader images are inserted', () => {
  const root = fakeAutoPagerRoot({
    images: [
      {
        id: 'img',
        src: 'https://fake-b.hath.network/virtual/fixture/01.webp'
      },
      {
        src: 'https://fake-a.hath.network/virtual/fixture/02.webp'
      },
      {
        src: 'https://fake-a.hath.network/virtual/fixture/03.webp'
      }
    ]
  });
  const summary = summarizeDomForAutoPagerDetection(root);
  const detection = detectAutoPagerCompatibility(summary);

  assert.equal(summary.insertedReaderPages, 2);
  assert.equal(detection.detected, true);
  assert.equal(detection.matches[0].id, 'generic-next-page-inserts');
});

test('records page image activity without disabling the whole preload run', () => {
  const result = applyAutoPagerCompatibilityReport({
    owner: 'extension',
    takeoverState: 'extension-owner',
    shouldYieldNextPageRequests: false
  }, {
    detection: {
      detected: true,
      shouldYieldNextPageRequests: true,
      confidence: 1,
      matches: [
        { id: 'page-image-requests-active', name: 'Page image requests', confidence: 1 }
      ]
    },
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    pageSessionId: 'session-1',
    observedAt: 1000
  }, 1100);

  assert.equal(result.changed, true);
  assert.equal(result.runtime.compatibilityMode, 'normal');
  assert.equal(result.runtime.takeoverState, 'extension-owner');
  assert.equal(result.runtime.shouldYieldNextPageRequests, true);
  assert.equal(result.runtime.preloadMode, 'normal');
  assert.equal(result.runtime.currentPagePreloadDisabled, undefined);
  assert.equal(result.runtime.pageImageRequestsActive, true);
  assert.equal(result.runtime.autoPagerCompatibility.sourceNames[0], 'Page image requests');
  assert.equal(result.runtime.autoPagerCompatibility.onlyExternalImageCacheFill, false);
  assert.equal(result.runtime.autoPagerCompatibility.detectedAt, 1000);

  const released = applyAutoPagerCompatibilityReport(result.runtime, {
    detection: {
      detected: false,
      shouldYieldNextPageRequests: false,
      confidence: 0,
      matches: []
    },
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    pageSessionId: 'session-1',
    observedAt: 2000
  }, 2100);

  assert.equal(released.changed, true);
  assert.equal(released.runtime.compatibilityMode, 'normal');
  assert.equal(released.runtime.preloadMode, 'normal');
  assert.equal(released.runtime.currentPagePreloadDisabled, undefined);
  assert.equal(released.runtime.pageImageRequestsActive, false);
});

test('page image idle does not clear EH plus built-in auto-pager pause', () => {
  const result = applyAutoPagerCompatibilityReport({
    owner: 'extension',
    ownAutoPagerContinuing: true,
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active',
    currentPagePreloadDisabledPageSessionId: 'session-1',
    currentPagePreloadDisabledTabId: 42
  }, {
    tabId: 42,
    detection: {
      detected: false,
      shouldYieldNextPageRequests: false
    },
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    pageSessionId: 'session-1',
    observedAt: 2000
  }, 2100);

  assert.equal(result.changed, true);
  assert.equal(result.runtime.preloadMode, OWN_AUTOPAGER_MODE);
  assert.equal(result.runtime.currentPagePreloadDisabled, true);
  assert.equal(result.runtime.currentPagePreloadDisabledReason, 'ehplus-autopager-continuing');
});

test('applies EH plus built-in auto-pager status as the only built-in pause condition', () => {
  const running = applyOwnAutoPagerStatus({
    owner: 'extension',
    preloadMode: 'normal',
    currentPagePreloadDisabled: false
  }, {
    enabled: true,
    continuing: true,
    status: 'ready',
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    nextUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    pageSessionId: 'session-1',
    appendedPages: 0,
    maxPages: 99,
    observedAt: 1000
  }, 1100);

  assert.equal(running.runtime.preloadMode, OWN_AUTOPAGER_MODE);
  assert.equal(running.runtime.ownAutoPagerContinuing, true);
  assert.equal(running.runtime.currentPagePreloadDisabledReason, 'ehplus-autopager-continuing');

  const stopped = applyOwnAutoPagerStatus(running.runtime, {
    enabled: true,
    continuing: false,
    status: 'done',
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    pageSessionId: 'session-1',
    appendedPages: 2,
    maxPages: 99,
    observedAt: 2000
  }, 2100);

  assert.equal(stopped.runtime.preloadMode, 'normal');
  assert.equal(stopped.runtime.ownAutoPagerContinuing, false);
  assert.equal(stopped.runtime.currentPagePreloadDisabled, false);
});

test('resets stale auto-pager preload pause for a new page session in the same tab', () => {
  const result = resetAutoPagerCompatibilityForPageSession({
    owner: 'extension',
    compatibilityMode: AUTOPAGER_COMPATIBILITY_MODE,
    preloadMode: 'auto-pager-cache-fill-only',
    shouldYieldNextPageRequests: true,
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'auto-pager-detected',
    currentPagePreloadDisabledAt: 1000,
    currentPagePreloadDisabledUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    currentPagePreloadDisabledPageSessionId: 'session-1',
    currentPagePreloadDisabledTabId: 42,
    takeoverState: AUTOPAGER_COMPATIBILITY_MODE,
    autoPagerCompatibility: { active: true }
  }, {
    pageSessionId: 'session-2',
    tabId: 42,
    url: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
  }, 2000);

  assert.equal(result.changed, true);
  assert.equal(result.runtime.compatibilityMode, 'normal');
  assert.equal(result.runtime.preloadMode, 'normal');
  assert.equal(result.runtime.currentPagePreloadDisabled, false);
  assert.equal(result.runtime.currentPagePreloadDisabledPageSessionId, '');
  assert.equal(result.runtime.activePageSessionId, 'session-2');
  assert.equal(result.runtime.activePageTabId, 42);
  assert.equal(result.runtime.activePageUrl, 'https://exhentai.org/s/fake-reader-token-b/2786404-2');
  assert.equal(result.runtime.takeoverState, 'extension-owner');
});

test('resets stale auto-pager preload pause when another tab becomes active', () => {
  const result = resetAutoPagerCompatibilityForPageSession({
    owner: 'extension',
    compatibilityMode: AUTOPAGER_COMPATIBILITY_MODE,
    preloadMode: 'auto-pager-cache-fill-only',
    shouldYieldNextPageRequests: true,
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'auto-pager-detected',
    currentPagePreloadDisabledAt: 1000,
    currentPagePreloadDisabledUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    currentPagePreloadDisabledPageSessionId: 'session-1',
    currentPagePreloadDisabledTabId: 42,
    takeoverState: AUTOPAGER_COMPATIBILITY_MODE,
    autoPagerCompatibility: { active: true }
  }, {
    pageSessionId: 'session-2',
    tabId: 84,
    url: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
  }, 2000);

  assert.equal(result.changed, true);
  assert.equal(result.runtime.compatibilityMode, 'normal');
  assert.equal(result.runtime.preloadMode, 'normal');
  assert.equal(result.runtime.currentPagePreloadDisabled, false);
  assert.equal(result.runtime.currentPagePreloadDisabledPageSessionId, '');
  assert.equal(result.runtime.activePageSessionId, 'session-2');
  assert.equal(result.runtime.activePageTabId, 84);
});

test('resets stale EH plus built-in auto-pager pause when current DOM has no auto-pager', () => {
  const result = resetAutoPagerCompatibilityForPageSession({
    owner: 'extension',
    preloadMode: OWN_AUTOPAGER_MODE,
    ownAutoPagerActive: true,
    ownAutoPagerContinuing: true,
    ownAutoPagerStatus: 'inserted',
    ownAutoPagerPageSessionId: 'old-session',
    ownAutoPager: {
      active: true,
      continuing: true,
      status: 'inserted',
      url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1?nl=old',
      pageSessionId: 'old-session',
      tabId: 42
    },
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'ehplus-autopager-continuing',
    currentPagePreloadDisabledUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1?nl=old',
    currentPagePreloadDisabledPageSessionId: 'old-session',
    currentPagePreloadDisabledTabId: 42
  }, {
    pageSessionId: 'new-session',
    tabId: 42,
    url: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    ownAutoPagerDomActive: false
  }, 2000);

  assert.equal(result.changed, true);
  assert.equal(result.runtime.preloadMode, 'normal');
  assert.equal(result.runtime.ownAutoPagerActive, false);
  assert.equal(result.runtime.ownAutoPagerContinuing, false);
  assert.equal(result.runtime.ownAutoPager, null);
  assert.equal(result.runtime.currentPagePreloadDisabled, false);
  assert.equal(result.runtime.currentPagePreloadDisabledReason, '');
  assert.equal(result.runtime.activePageSessionId, 'new-session');
  assert.equal(result.runtime.activePageTabId, 42);
  assert.equal(result.runtime.activePageUrl, 'https://exhentai.org/s/fake-reader-token-a/2786404-1');
});

test('page session startup resets stale auto-pager compatibility state before preload', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(source, /async function handlePageSessionStarted\(message, sender\) \{/);
  assert.match(source, /resetAutoPagerCompatibilityForPageSession\(current\.runtime/);
  assert.match(source, /autoPagerCompatibilityReset: resetResult\.changed/);
});

test('content script reports built-in auto-pager DOM state and falls back to stored settings', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(source, /ownAutoPagerDomActive: hasBuiltInAutoPagerDom\(\)/);
  assert.match(source, /function hasBuiltInAutoPagerDom\(\) \{/);
  assert.match(source, /readBackendPanelState\(\)\s*\.catch\(\(\) => readStoredPanelState\(\)\)/);
});

test('isolated cache-first aligns with built-in auto-pager DOM and yields before stitching', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  // isolated 与 MAIN world 统一用内置自动翻页自己的 DOM 痕迹判定（规划 2026-07-07 双 world 协调）。
  assert.match(source, /function isAutoPagerCompatibilityActive\(\) \{\s*return hasBuiltInAutoPagerDom\(\);\s*\}/);
  assert.doesNotMatch(source, /function isAutoPagerCompatibilityActive\(\) \{\s*return false;\s*\}/);

  // 自动翻页启动时先结算 cache-first 并等待 DNR 网络门释放，再预取/拼接。
  assert.match(source, /async function yieldLocalReaderCacheFirstToBuiltInAutoPager\(\) \{/);
  assert.match(source, /state\.cacheFirstYield = yieldLocalReaderCacheFirstToBuiltInAutoPager\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(source, /await waitForLocalReaderCacheFirstNetworkBlockRelease\(pageKey, 'auto-pager'\);/);
  assert.match(source, /await state\.cacheFirstYield;/);

  // 游离片段中已失败的拼接图在插入后补发 error 事件，交给 MAIN world nl 守卫换源重试。
  assert.match(source, /function retryFailedBuiltInAutoPagerImages\(root\) \{/);
  assert.match(source, /retryFailedBuiltInAutoPagerImages\(state\.insertAfter\);/);
  assert.match(source, /img\.dispatchEvent\(new Event\('error'\)\);/);
});

test('account background refresh watches only EH/EX gallery and reader tabs', () => {
  assert.equal(isAccountRefreshPageUrl('https://e-hentai.org/g/123/token/'), true);
  assert.equal(isAccountRefreshPageUrl('https://exhentai.org/s/fake-reader-token-d/2786404-4'), true);
  assert.equal(isAccountRefreshPageUrl('https://e-hentai.org/home.php'), false);
  assert.equal(isAccountRefreshPageUrl('https://example.test/g/123/token/'), false);

  const summary = summarizeAccountRefreshTabs([
    { id: 1, url: 'https://e-hentai.org/g/123/token/' },
    { id: 2, url: 'https://exhentai.org/s/fake-reader-token-d/2786404-4' },
    { id: 3, url: 'https://e-hentai.org/home.php' }
  ]);

  assert.equal(summary.activeCount, 2);
  assert.deepEqual(summary.activeTabs.map((tab) => tab.id), [1, 2]);
  assert.deepEqual(summary.activeTabs.map((tab) => tab.url), [
    'https://e-hentai.org/g/123/token/',
    'https://exhentai.org/s/fake-reader-token-d/2786404-4'
  ]);
  assert.equal(
    summarizeAccountRefreshTabUrl('https://exhentai.org/s/fake-reader-token-d/2786404-4?nl=fake-nl-token#frag'),
    'https://exhentai.org/s/fake-reader-token-d/2786404-4'
  );
  assert.equal(summarizeAccountRefreshTabUrl(`not a url ${'x'.repeat(300)}`).length, 240);
});

test('account background refresh opens only on zero-to-active tab transitions', () => {
  assert.equal(shouldRefreshAccountOnTabTransition(0, 1), true);
  assert.equal(shouldRefreshAccountOnTabTransition(0, 2), true);
  assert.equal(shouldRefreshAccountOnTabTransition(1, 2), false);
  assert.equal(shouldRefreshAccountOnTabTransition(1, 0), false);
  assert.equal(shouldRefreshAccountOnTabTransition(0, 0), false);
});

test('builds original-compatible page keys', () => {
  assert.equal(buildPageKey(123, 4), '123:4');
});

test('removes or downgrades queued preload work already handled by auto-pagers', () => {
  const queue = [
    { id: 'sent', pageKey: '2786404:1', status: 'running', priority: 'normal' },
    { id: 'loaded-page', pageKey: '2786404:2', status: 'queued', priority: 'normal' },
    { id: 'loading-image', imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp#frag', status: 'queued', priority: 'normal' },
    { id: 'duplicate', pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', status: 'queued', priority: 'normal' },
    { id: 'fresh', pageKey: '2786404:3', status: 'queued', priority: 'normal' }
  ];
  const result = reconcilePreloadQueueWithExternalActivity(queue, [
    { pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2', state: 'loaded' },
    { imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp', state: 'loading' }
  ]);

  assert.deepEqual(result.queue.map((item) => item.id), ['sent', 'loading-image', 'fresh']);
  assert.equal(result.queue.find((item) => item.id === 'loading-image').priority, 'external-low');
  assert.equal(result.queue.find((item) => item.id === 'loading-image').externalState, 'loading');
  assert.deepEqual(result.actions.map((action) => [action.item.id, action.action, action.reason]), [
    ['sent', PRELOAD_QUEUE_ACTIONS.KEEP, 'unmatched'],
    ['loaded-page', PRELOAD_QUEUE_ACTIONS.REMOVE, 'external-loaded'],
    ['loading-image', PRELOAD_QUEUE_ACTIONS.DOWNGRADE, 'external-loading'],
    ['duplicate', PRELOAD_QUEUE_ACTIONS.REMOVE, 'duplicate-running'],
    ['fresh', PRELOAD_QUEUE_ACTIONS.KEEP, 'unmatched']
  ]);
});

test('does not cancel already-sent preload work even if an auto-pager loaded it', () => {
  const result = reconcilePreloadQueueWithExternalActivity([
    { id: 'running', pageKey: '2786404:2', status: 'running', priority: 'normal' }
  ], [
    { pageKey: '2786404:2', state: 'loaded' }
  ]);

  assert.deepEqual(result.queue.map((item) => item.id), ['running']);
  assert.deepEqual(result.actions.map((action) => [action.action, action.reason]), [
    [PRELOAD_QUEUE_ACTIONS.KEEP, 'already-sent']
  ]);
});

test('keeps queued reader page preload requests while page image requests are active', () => {
  assert.deepEqual(shouldSkipPreloadRequestForAutoPager({
    currentPagePreloadDisabled: false
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'compatibility-disabled'
  });

  assert.deepEqual(shouldSkipPreloadRequestForAutoPager({
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active'
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'compatibility-disabled',
    pageKey: '2786404:1'
  });

  assert.deepEqual(shouldSkipPreloadRequestForAutoPager({
    currentPagePreloadDisabled: true
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    status: 'running'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'already-sent',
    pageKey: '2786404:1'
  });

  assert.deepEqual(shouldSkipPreloadRequestForAutoPager({
    currentPagePreloadDisabled: true
  }, {
    kind: 'external-image-cache-fill',
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'external-image-cache-fill'
  });

  assert.deepEqual(shouldSkipPreloadRequestForAutoPager({
    currentPagePreloadDisabled: true
  }, {
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'not-reader-page-request'
  });
});

test('skips unsent reader preload work when preload is disabled', () => {
  assert.deepEqual(shouldSkipPreloadRequest({
    preloadEnabled: false
  }, {
    currentPagePreloadDisabled: false
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.SKIP,
    reason: 'preload-disabled',
    pageKey: '2786404:1'
  });

  assert.deepEqual(shouldSkipPreloadRequest({
    preloadEnabled: false
  }, {}, {
    pageKey: '2786404:2',
    status: 'running'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'already-sent',
    pageKey: '2786404:2'
  });

  assert.deepEqual(shouldSkipPreloadRequest({
    preloadEnabled: true,
    autoPagerEnabled: true
  }, {
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active',
    ownAutoPagerContinuing: false
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'ehplus-autopager-idle',
    pageKey: '2786404:1'
  });

  assert.deepEqual(shouldSkipPreloadRequest({
    preloadEnabled: true,
    autoPagerEnabled: true
  }, {
    ownAutoPagerContinuing: true
  }, {
    pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.SKIP,
    reason: 'ehplus-autopager-continuing',
    pageKey: '2786404:1'
  });

  assert.deepEqual(shouldSkipPreloadRequest({
    preloadEnabled: false
  }, {}, {
    kind: 'external-image-cache-fill',
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    status: 'queued'
  }), {
    action: PRELOAD_REQUEST_DECISIONS.PROCEED,
    reason: 'external-image-cache-fill'
  });
});

test('removes queued reader preload work when preload is disabled', () => {
  const result = removePreloadQueueForSettings([
    { id: 'page-queued', pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', status: 'queued' },
    { id: 'page-running', pageKey: '2786404:2', status: 'running' },
    { id: 'cache-fill', kind: 'external-image-cache-fill', imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp', status: 'queued' },
    { id: 'image-only', imageUrl: 'https://fake-a.hath.network/virtual/fixture/03.webp', status: 'queued' }
  ], {
    preloadEnabled: false
  });

  assert.deepEqual(result.queue.map((item) => item.id), ['page-running', 'cache-fill', 'image-only']);
  assert.deepEqual(result.actions.map((action) => [action.item.id, action.action, action.reason]), [
    ['page-queued', PRELOAD_QUEUE_ACTIONS.REMOVE, 'preload-disabled'],
    ['page-running', PRELOAD_QUEUE_ACTIONS.KEEP, 'already-sent'],
    ['cache-fill', PRELOAD_QUEUE_ACTIONS.KEEP, 'external-image-cache-fill'],
    ['image-only', PRELOAD_QUEUE_ACTIONS.KEEP, 'not-reader-page-request']
  ]);
});

test('keeps queued reader preload work while page image requests are active', () => {
  const result = removePreloadQueueForAutoPagerPage([
    { id: 'page-queued', pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', status: 'queued' },
    { id: 'page-running', pageKey: '2786404:2', status: 'running' },
    { id: 'cache-fill', kind: 'external-image-cache-fill', imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp', status: 'queued' },
    { id: 'image-only', imageUrl: 'https://fake-a.hath.network/virtual/fixture/03.webp', status: 'queued' }
  ], {
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active'
  });

  assert.deepEqual(result.queue.map((item) => item.id), ['page-queued', 'page-running', 'cache-fill', 'image-only']);
  assert.deepEqual(result.actions.map((action) => [action.item.id, action.action, action.reason]), [
    ['page-queued', PRELOAD_QUEUE_ACTIONS.KEEP, 'compatibility-disabled'],
    ['page-running', PRELOAD_QUEUE_ACTIONS.KEEP, 'already-sent'],
    ['cache-fill', PRELOAD_QUEUE_ACTIONS.KEEP, 'external-image-cache-fill'],
    ['image-only', PRELOAD_QUEUE_ACTIONS.KEEP, 'not-reader-page-request']
  ]);
});

test('parses reader and gallery pages for preload targets', async () => {
  const readerHtml = await fixtureText('html/reader-page-1.html');
  const readerUrl = 'https://exhentai.org/s/fake-reader-token-a/2786404-1';
  const reader = parseReaderHtml(readerHtml, readerUrl);

  assert.deepEqual(classifyEhPage(readerUrl), {
    type: 'reader',
    origin: 'https://exhentai.org',
    url: readerUrl,
    token: 'fake-reader-token-a',
    gid: '2786404',
    pageNo: 1,
    pageKey: '2786404:1'
  });
  assert.equal(reader.imageUrl, 'https://exhentai.org/fullimg.php?gid=2786404&page=1&token=fake-image-token-1');
  assert.equal(reader.nextReaderUrl, 'https://exhentai.org/s/fake-reader-token-a/2786404-2');
  assert.equal(reader.nlToken, null);

  const galleryHtml = await fixtureText('html/gallery-page.html');
  const gallery = parseGalleryHtml(galleryHtml, 'https://exhentai.org/g/2786404/fake-gallery-token-main/', 10);
  assert.deepEqual(gallery.readerPages.map((page) => [page.pageKey, page.url]), [
    ['2786404:1', 'https://exhentai.org/s/fake-reader-token-a/2786404-1'],
    ['2786404:2', 'https://exhentai.org/s/fake-reader-token-d/2786404-2']
  ]);

  const titledGallery = parseGalleryHtml(`
    <h1 id="gn">English Title</h1>
    <h1 id="gj">日本語タイトル</h1>
    <a href="/s/fake-reader-token-a/2786404-1">1</a>
  `, 'https://exhentai.org/g/2786404/fake-gallery-token-main/', 10);
  assert.equal(titledGallery.gallery.title, 'English Title');
  assert.equal(titledGallery.gallery.originalTitle, '日本語タイトル');
  assert.equal(titledGallery.readerPages[0].title, 'English Title');
  assert.equal(titledGallery.readerPages[0].originalTitle, '日本語タイトル');

  const fallbackGallery = parseGalleryHtml('<a href="/s/fake-reader-token-a/2786404-1">1</a>', 'https://exhentai.org/g/2786404/fake-gallery-token-main/', 10);
  assert.equal(fallbackGallery.gallery.title, '2786404');
  assert.equal(fallbackGallery.gallery.originalTitle, '2786404');
});

test('reader preload follows real next reader links instead of reusing the current token', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map(),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-a/2786404-1', '<html><body><img id="img" src="https://example.test/1.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Next</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-b/2786404-2', '<html><body><img id="img" src="https://example.test/2.jpg"><script>var nexturl="https://exhentai.org/s/fake-reader-token-c/2786404-3";</script></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-c/2786404-3', '<html><body><img id="img" src="https://example.test/3.jpg"></body></html>']
  ]);
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    const html = htmlByUrl.get(value);
    if (!html) throw new Error(`unexpected URL ${value}`);
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return html;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 2,
    settings: {
      blobCacheEnabled: true
    },
    now: () => 1234
  });

  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.records.map((record) => [record.pageKey, record.pageUrl, record.nextReaderUrl]), [
    ['2786404:2', 'https://exhentai.org/s/fake-reader-token-b/2786404-2', 'https://exhentai.org/s/fake-reader-token-c/2786404-3'],
    ['2786404:3', 'https://exhentai.org/s/fake-reader-token-c/2786404-3', null]
  ]);
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/2.jpg',
    'https://exhentai.org/s/fake-reader-token-c/2786404-3',
    'https://example.test/3.jpg'
  ]);
});

test('reader preload alternates next and previous reader links', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-c/2786404-3');
  const calls = [];
  const db = {
    records: new Map(),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-c/2786404-3', '<html><body><img id="img" src="https://example.test/3.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-d/2786404-4">Next</a><a id="prev" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Prev</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-d/2786404-4', '<html><body><img id="img" src="https://example.test/4.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-e/2786404-5">Next</a><a id="prev" href="https://exhentai.org/s/fake-reader-token-c/2786404-3">Prev</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-b/2786404-2', '<html><body><img id="img" src="https://example.test/2.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-c/2786404-3">Next</a><a id="prev" href="https://exhentai.org/s/fake-reader-token-a/2786404-1">Prev</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-e/2786404-5', '<html><body><img id="img" src="https://example.test/5.jpg"></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-a/2786404-1', '<html><body><img id="img" src="https://example.test/1.jpg"></body></html>']
  ]);
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    const html = htmlByUrl.get(value);
    if (!html) throw new Error(`unexpected URL ${value}`);
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return html;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 4,
    settings: {
      blobCacheEnabled: true,
      globalConcurrency: 1
    },
    now: () => 1234
  });

  assert.equal(result.completed, 4);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.records.map((record) => record.pageKey), [
    '2786404:4',
    '2786404:2',
    '2786404:5',
    '2786404:1'
  ]);
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-c/2786404-3',
    'https://exhentai.org/s/fake-reader-token-d/2786404-4',
    'https://example.test/4.jpg',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/2.jpg',
    'https://exhentai.org/s/fake-reader-token-e/2786404-5',
    'https://example.test/5.jpg',
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://example.test/1.jpg'
  ]);
});

test('reader preload uses global concurrency for adjacent directions', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-c/2786404-3');
  let activeReaderFetches = 0;
  let maxActiveReaderFetches = 0;
  const db = {
    records: new Map(),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-c/2786404-3', '<html><body><img id="img" src="https://example.test/3.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-d/2786404-4">Next</a><a id="prev" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Prev</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-d/2786404-4', '<html><body><img id="img" src="https://example.test/4.jpg"></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-b/2786404-2', '<html><body><img id="img" src="https://example.test/2.jpg"></body></html>']
  ]);
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    if (value !== context.url) {
      activeReaderFetches += 1;
      maxActiveReaderFetches = Math.max(maxActiveReaderFetches, activeReaderFetches);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeReaderFetches -= 1;
    }
    const html = htmlByUrl.get(value);
    if (!html) throw new Error(`unexpected URL ${value}`);
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return html;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 2,
    settings: {
      blobCacheEnabled: true,
      globalConcurrency: 2
    }
  });

  assert.equal(result.completed, 2);
  assert.equal(maxActiveReaderFetches, 2);
  assert.deepEqual(result.records.map((record) => record.pageKey), ['2786404:4', '2786404:2']);
});

test('reader preload fills metadata-only existing reader records', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map([
      ['2786404:1', {
        pageKey: '2786404:1',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
        nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
      }],
      ['2786404:2', {
        pageKey: '2786404:2',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
        imageUrl: 'https://example.test/2.jpg',
        hasImageBlob: false,
        imageBytes: 0
      }]
    ]),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return '<html><body><img id="img" src="https://example.test/2.jpg"></body></html>';
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 1,
    settings: {
      blobCacheEnabled: true
    },
    now: () => 1234
  });

  const stored = db.records.get('2786404:2');
  assert.equal(result.completed, 1);
  assert.equal(stored.hasImageBlob, true);
  assert.equal(stored.imageBytes, 11);
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/2.jpg'
  ]);
});

test('reader preload retries failed image fetches through EH nl replacement pages', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map([
      ['2786404:1', {
        pageKey: '2786404:1',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
        nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
      }]
    ]),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const readerHtml = '<html><body><img id="img" src="https://example.test/stale.jpg" onerror="return nl(\'retry-one\')"></body></html>';
  const retryHtml = '<html><body><div id="loadfail" onclick="return nl(\'retry-two\')"></div><img id="img" src="https://example.test/replaced.jpg"></body></html>';
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === 'https://example.test/stale.jpg') {
      return {
        ok: false,
        status: 503,
        headers: new Map()
      };
    }
    if (value === 'https://example.test/replaced.jpg') {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['replacement-image'], { type: 'image/jpeg' });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        if (value.includes('nl=retry-one')) return retryHtml;
        return readerHtml;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 1,
    settings: {
      blobCacheEnabled: true,
      logDebugEnabled: true
    },
    now: () => 1234
  });

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.records[0].imageUrl, 'https://example.test/replaced.jpg');
  assert.equal(result.records[0].hasImageBlob, true);
  assert.equal(result.requestDetails.length, 3);
  assert.equal(result.requestDetails[2].url, 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one');
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/stale.jpg',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one',
    'https://example.test/replaced.jpg'
  ]);
});

test('reader preload replaces existing EH nl token between retry pages', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map([
      ['2786404:1', {
        pageKey: '2786404:1',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
        nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
      }]
    ]),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const readerHtml = '<html><body><img id="img" src="https://example.test/stale.jpg" onerror="return nl(\'retry-one\')"></body></html>';
  const firstRetryHtml = '<html><body><div id="loadfail" onclick="return nl(\'retry-two\')"></div><img id="img" src="https://example.test/still-stale.jpg"></body></html>';
  const secondRetryHtml = '<html><body><img id="img" src="https://example.test/replaced.jpg"></body></html>';
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === 'https://example.test/stale.jpg' || value === 'https://example.test/still-stale.jpg') {
      return {
        ok: false,
        status: 503,
        headers: new Map()
      };
    }
    if (value === 'https://example.test/replaced.jpg') {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['replacement-image'], { type: 'image/jpeg' });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        if (value === 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one') return firstRetryHtml;
        if (value === 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-two') return secondRetryHtml;
        return readerHtml;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 1,
    settings: {
      blobCacheEnabled: true
    },
    now: () => 1234
  });

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.records[0].imageUrl, 'https://example.test/replaced.jpg');
  assert.ok(!calls.some((url) => url.includes('nl=retry-one&nl=retry-two')));
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/stale.jpg',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one',
    'https://example.test/still-stale.jpg',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-two',
    'https://example.test/replaced.jpg'
  ]);
});

test('reader preload caps chained EH nl replacement retries without growing URLs', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map([
      ['2786404:1', {
        pageKey: '2786404:1',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
        nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
      }]
    ]),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const readerHtml = '<html><body><img id="img" src="https://example.test/stale.jpg" onerror="return nl(\'retry-one\')"></body></html>';
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.startsWith('https://example.test/')) {
      return {
        ok: false,
        status: 503,
        headers: new Map()
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        if (value === 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one') {
          return '<html><body><div id="loadfail" onclick="return nl(\'retry-two\')"></div><img id="img" src="https://example.test/still-stale-1.jpg"></body></html>';
        }
        if (value === 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-two') {
          return '<html><body><div id="loadfail" onclick="return nl(\'retry-three\')"></div><img id="img" src="https://example.test/still-stale-2.jpg"></body></html>';
        }
        if (value === 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-three') {
          return '<html><body><div id="loadfail" onclick="return nl(\'retry-four\')"></div><img id="img" src="https://example.test/still-stale-3.jpg"></body></html>';
        }
        return readerHtml;
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 1,
    settings: {
      blobCacheEnabled: true
    },
    now: () => 1234
  });

  const retryPageCalls = calls.filter((url) => url.includes('?nl='));
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(retryPageCalls.length, 3);
  assert.ok(!retryPageCalls.some((url) => url.includes('&nl=')));
  assert.ok(!retryPageCalls.some((url) => url.includes('retry-four')));
  assert.deepEqual(retryPageCalls, [
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-two',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-three'
  ]);
});

test('reader preload keeps image fetch failure when no EH nl token is available', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = {
    records: new Map([
      ['2786404:1', {
        pageKey: '2786404:1',
        pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1',
        nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
      }]
    ]),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('.jpg')) {
      return {
        ok: false,
        status: 503,
        headers: new Map()
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return '<html><body><img id="img" src="https://example.test/stale.jpg"></body></html>';
      }
    };
  };

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl,
    limit: 1,
    settings: {
      blobCacheEnabled: true
    }
  });

  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.match(result.records[0].error, /HTTP 503/);
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/stale.jpg'
  ]);
});

test('preload page count accepts integers above the visible matrix limit', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const records = new Map([
    ['2786404:1', { pageKey: '2786404:1', pageUrl: 'https://exhentai.org/s/fake-reader-token-a/2786404-1', nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2' }],
    ['2786404:2', { pageKey: '2786404:2', pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2', imageUrl: 'https://example.test/2.jpg', nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-c/2786404-3', hasImageBlob: true, imageBytes: 11 }],
    ['2786404:3', { pageKey: '2786404:3', pageUrl: 'https://exhentai.org/s/fake-reader-token-c/2786404-3', imageUrl: 'https://example.test/3.jpg', nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-c/2786404-3', hasImageBlob: true, imageBytes: 11 }]
  ]);
  const db = {
    transaction() {
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };

  const result = await runPreloadFromContext(context, {
    preloadEnabled: true,
    preloadAhead: 65
  }, {}, { db, fetchImpl: async () => { throw new Error('should not fetch cached pages'); } });

  assert.equal(result.queued, 2);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
});

test('preload request gate runs immediately before each fetch request', async () => {
  const events = [];
  const fetchImpl = async (url) => {
    events.push(`fetch:${url}`);
    return {
      ok: true,
      text: async () => '<html></html>',
      blob: async () => new Blob(['image'], { type: 'image/jpeg' }),
      headers: { get: () => 'text/html' }
    };
  };
  const gated = createPreloadRequestGateFetch(fetchImpl, async ({ url }) => {
    events.push(`gate:${url}`);
  });

  await gated('https://exhentai.org/s/fake-reader-token-a/2786404-1', { method: 'GET' });
  await gated('https://fake-a.hath.network/virtual/fixture/01.webp', { method: 'GET' });

  assert.deepEqual(events, [
    'gate:https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'fetch:https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'gate:https://fake-a.hath.network/virtual/fixture/01.webp',
    'fetch:https://fake-a.hath.network/virtual/fixture/01.webp'
  ]);
});

test('service worker gates each preload fetch on current page network activity only', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  // 每次预加载 fetch 仍逐个过页面网络闸门，内层再经全局并发槽（规划 §953）。
  assert.match(source, /createPreloadRequestGateFetch\(slotFetch, \(\{ url \}\) => \{/);
  assert.match(source, /createPreloadSlotAwareFetch\(fetch, \{/);
  assert.match(source, /waitForPageNetworkIdleBeforePreload\(\{ url, page: context, message, sender \}\)/);
  assert.match(source, /activity\?\.pageSessionMatched === false/);
  assert.match(source, /reason: 'stale-page-session'/);
  assert.doesNotMatch(source, /waitForAutoPagerDetection/);
  assert.doesNotMatch(source, /pendingAutoPagerDetections/);
  assert.doesNotMatch(source, /AUTOPAGER_DETECTION_TIMEOUT_MS/);
});

test('image number settings do not keep artificial upper limits', async () => {
  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(contentScript, /<input type="number" min="1" data-setting="globalConcurrency"/);
  assert.match(contentScript, /<input type="number" min="0" data-setting="pageOffset"/);
  assert.doesNotMatch(contentScript, /<input[^>]*(?:data-setting="globalConcurrency"[^>]*max=|max="[^"]*"[^>]*data-setting="globalConcurrency")/);
  assert.doesNotMatch(contentScript, /<input[^>]*(?:data-setting="pageOffset"[^>]*max=|max="[^"]*"[^>]*data-setting="pageOffset")/);

  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /globalConcurrency: normalizePositiveInteger\(settings\.globalConcurrency, DEFAULT_SETTINGS\.globalConcurrency\)/);
  assert.match(serviceWorker, /pageOffset: normalizeNonNegativeInteger\(settings\.pageOffset, DEFAULT_SETTINGS\.pageOffset\)/);
  assert.doesNotMatch(serviceWorker, /globalConcurrency: clampInteger\(settings\.globalConcurrency, 1, 64/);
  assert.doesNotMatch(serviceWorker, /pageOffset: clampInteger\(settings\.pageOffset, 0, 240/);
});

test('preload start decision respects disabled preload and auto-pager mode', () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  assert.deepEqual(shouldStartPreload({ preloadEnabled: true }, {}, context), {
    ok: true,
    reason: 'enabled'
  });
  assert.deepEqual(shouldStartPreload({ preloadEnabled: false }, {}, context), {
    ok: false,
    reason: 'preload-disabled'
  });
  assert.deepEqual(shouldStartPreload({ preloadEnabled: true }, {
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active'
  }, context), {
    ok: true,
    reason: 'enabled'
  });
  assert.deepEqual(shouldStartPreload({ preloadEnabled: true }, {
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'ehplus-autopager-continuing'
  }, context), {
    ok: false,
    reason: 'ehplus-autopager-continuing'
  });
  assert.deepEqual(shouldStartPreload({
    preloadEnabled: true,
    autoPagerEnabled: true
  }, {
    currentPagePreloadDisabled: true,
    currentPagePreloadDisabledReason: 'page-image-requests-active',
    ownAutoPagerContinuing: false
  }, context), {
    ok: true,
    reason: 'enabled'
  });
  assert.deepEqual(shouldStartPreload({
    preloadEnabled: true,
    autoPagerEnabled: true
  }, {
    ownAutoPagerContinuing: true
  }, context), {
    ok: false,
    reason: 'ehplus-autopager-continuing'
  });
});

test('preload summary counts stored Blob size when imageBytes is missing', () => {
  const summary = summarizePreloadRecords([
    {
      pageKey: '2786404:2',
      imageUrl: 'https://example.test/2.jpg',
      imageBlob: new Blob(['image-bytes'], { type: 'image/jpeg' }),
      hasImageBlob: true
    },
    {
      pageKey: '2786404:3',
      imageUrl: 'https://example.test/3.jpg'
    }
  ]);

  assert.equal(summary.imageBytes, 11);
  assert.equal(summary.imageRecords, 1);
  assert.equal(summary.metadataRecords, 2);
  assert.deepEqual(summary.readerRecords, [
    { gid: '2786404', pageNo: 2, pageKey: '2786404:2', hasImage: true },
    { gid: '2786404', pageNo: 3, pageKey: '2786404:3', hasImage: false }
  ]);
});

test('explicit non-image MIME records are not counted, hydrated, or deliverable as images', async () => {
  const record = {
    pageKey: '9001001:8',
    pageUrl: 'https://reader.example.test/s/fixture-token-a/9001001-8',
    imageUrl: 'https://cache.example.test/fixture/08.webp',
    resourceKey: 'https://cache.example.test/fixture/08.webp',
    imageBytes: 15,
    mimeType: 'text/html; charset=utf-8',
    hasImageBlob: true,
    directoryImageFile: '9001001/9001001-8.webp',
    dataUrl: 'data:text/html;base64,SW52YWxpZCByZXF1ZXN0'
  };

  const summary = summarizePreloadRecords([record]);

  assert.equal(summary.imageBytes, 0);
  assert.equal(summary.imageRecords, 0);
  assert.deepEqual(summary.readerRecords, [
    { gid: '9001001', pageNo: 8, pageKey: '9001001:8', hasImage: false }
  ]);
  const hydrated = await hydratePreloadRecord(record);
  assert.equal(hydrated.dataUrl, null);
  assert.equal(hydrated.imageBlob, null);
  assert.equal(hydrated.imageBytes, 0);
  assert.equal(hydrated.hasImageBlob, false);
  assert.equal(recordHasStoredImage(record), false);
  assert.equal(recordCanDeliver(record), false);
});

test('preload hydration preserves non-image gallery metadata', async () => {
  const record = {
    galleryKey: '9001002:fake-gallery-token-b',
    galleryUrl: 'https://gallery.example.test/g/9001002/fixture-token-b/',
    dataUrl: 'data:application/json;base64,e30=',
    mimeType: 'application/json',
    galleryBytes: 2,
    storageClass: CACHE_STORAGE_CLASSES.PERMANENT
  };

  const hydrated = await hydratePreloadRecord(record);

  assert.strictEqual(hydrated, record);
  assert.equal(hydrated.dataUrl, 'data:application/json;base64,e30=');
});

test('directory preload store writes image files and record indexes', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const store = await createDirectoryPreloadStore(root);
  await store.put({
    pageKey: '2786404:2',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    imageUrl: 'https://example.test/2.webp',
    resourceKey: 'https://example.test/2.webp',
    imageName: 'Reader Title',
    imageBlob: new Blob(['image-bytes'], { type: 'image/webp' }),
    imageBytes: 11,
    mimeType: 'image/webp',
    hasImageBlob: true,
    updatedAt: 1234
  });

  const recordsDir = root.children.get('records');
  const gidRecordsDir = recordsDir.children.get('gid');
  const urlRecordsDir = recordsDir.children.get('url');
  const imagesDir = root.children.get('images');
  const galleryImagesDir = imagesDir.children.get('2786404');
  assert.ok(gidRecordsDir.children.has('gid-2786404.json'));
  assert.ok(urlRecordsDir.children.has('url-https%3A%2F%2Fexample.test%2F2.webp.json'));
  const galleryRecord = JSON.parse(await (await gidRecordsDir.children.get('gid-2786404.json').getFile()).text());
  assert.equal(galleryRecord.directoryGroupKind, 'gid-pages');
  assert.equal(galleryRecord.title, 'Reader Title');
  assert.equal(galleryRecord.originalTitle, '');
  assert.deepEqual(Object.keys(galleryRecord.pages), ['2786404:2']);
  assert.equal(galleryRecord.pages['2786404:2'].title, 'Reader Title');
  assert.equal(galleryRecord.pages['2786404:2'].originalTitle, '');
  assert.equal(galleryImagesDir?.kind, 'directory');
  assert.ok(galleryImagesDir.children.has('2786404-2.webp'));
  const imageHandle = galleryImagesDir.children.get('2786404-2.webp');

  const byPageKey = await store.get('2786404:2');
  assert.equal(byPageKey.pageKey, '2786404:2');
  assert.equal(byPageKey.title, 'Reader Title');
  assert.equal(byPageKey.originalTitle, '');
  assert.equal(byPageKey.directoryImageFile, '2786404/2786404-2.webp');
  assert.equal(byPageKey.dataUrl, null);
  assert.equal(imageHandle.getFileCalls, 0);

  const byResourceKey = await store.getByResourceKey('https://example.test/2.webp');
  assert.equal(byResourceKey.pageKey, '2786404:2');
  assert.equal(byResourceKey.directoryImageFile, '2786404/2786404-2.webp');
  assert.equal(byResourceKey.dataUrl, null);
  assert.equal(imageHandle.getFileCalls, 0);

  assert.equal(recordCanDeliver(byPageKey), true);
  const selected = findCooperativeCacheHit([byPageKey], normalizeCooperativeCacheQuery({
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    imageUrl: 'https://example.test/2.webp'
  }));
  assert.equal(selected, byPageKey);

  const hydrated = await store.hydrate(selected);
  assert.equal(imageHandle.getFileCalls, 1);
  assert.match(hydrated.dataUrl, /^data:image\/webp;base64,/);

  const response = buildCooperativeCacheResponse([hydrated], {
    type: COOPERATIVE_CACHE_QUERY_TYPE,
    pageKey: '2786404:2',
    imageUrl: 'https://example.test/2.webp'
  });
  assert.equal(response.hit, true);
  assert.equal(response.delivery.url, hydrated.dataUrl);

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].pageKey, '2786404:2');
  assert.equal(records[0].imageBytes, 11);
  assert.equal(records[0].hasImageBlob, true);
  assert.equal(records[0].dataUrl, null);
  assert.equal(imageHandle.getFileCalls, 1);
});

test('directory preload store does not hydrate legacy non-image files', async () => {
  const root = new FakeDirectoryHandle('fixture-cache');
  const store = await createDirectoryPreloadStore(root);
  await store.put({
    pageKey: '9001001:8',
    pageUrl: 'https://reader.example.test/s/fixture-token-a/9001001-8',
    imageUrl: 'https://cache.example.test/fixture/08.webp',
    resourceKey: 'https://cache.example.test/fixture/08.webp',
    imageBlob: new Blob(['Invalid request'], { type: 'text/html' }),
    imageBytes: 15,
    mimeType: 'text/html',
    hasImageBlob: true
  });

  const imagesDir = root.children.get('images');
  const galleryImagesDir = imagesDir.children.get('9001001');
  const imageHandle = galleryImagesDir.children.get('9001001-8.webp');
  const stored = await store.get('9001001:8');
  const hydrated = await store.hydrate(stored);

  assert.ok(imageHandle);
  assert.equal(imageHandle.getFileCalls, 0);
  assert.equal(hydrated.dataUrl, null);
  assert.equal(hydrated.imageBlob, null);
  assert.equal(hydrated.imageBytes, 0);
  assert.equal(hydrated.hasImageBlob, false);
  assert.ok(galleryImagesDir.children.has('9001001-8.webp'));
});

test('directory preload store stores multiple pages for the same gid in one record file', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const store = await createDirectoryPreloadStore(root);
  await store.put({
    pageKey: '2786404:2',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    imageUrl: 'https://example.test/2.webp',
    resourceKey: 'https://example.test/2.webp',
    imageName: 'Shared Gallery Title',
    imageBlob: new Blob(['page-2'], { type: 'image/webp' }),
    mimeType: 'image/webp',
    hasImageBlob: true
  });
  await store.put({
    pageKey: '2786404:3',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-c/2786404-3',
    imageUrl: 'https://example.test/3.webp',
    resourceKey: 'https://example.test/3.webp',
    imageName: 'Shared Gallery Title',
    imageBlob: new Blob(['page-3'], { type: 'image/webp' }),
    mimeType: 'image/webp',
    hasImageBlob: true
  });

  const recordsDir = root.children.get('records');
  const gidRecordsDir = recordsDir.children.get('gid');
  assert.ok(gidRecordsDir.children.has('gid-2786404.json'));
  assert.equal(recordsDir.children.has('page-2786404-2.json'), false);
  assert.equal(recordsDir.children.has('page-2786404-3.json'), false);
  const galleryRecord = JSON.parse(await (await gidRecordsDir.children.get('gid-2786404.json').getFile()).text());
  assert.equal(galleryRecord.title, 'Shared Gallery Title');
  assert.equal(galleryRecord.originalTitle, '');
  assert.deepEqual(Object.keys(galleryRecord.pages), ['2786404:2', '2786404:3']);
  assert.equal(galleryRecord.pages['2786404:2'].title, 'Shared Gallery Title');
  assert.equal(galleryRecord.pages['2786404:3'].title, 'Shared Gallery Title');
  assert.equal(galleryRecord.pages['2786404:2'].originalTitle, '');
  assert.equal(galleryRecord.pages['2786404:3'].originalTitle, '');

  assert.equal((await store.get('2786404:2')).imageUrl, 'https://example.test/2.webp');
  assert.equal((await store.get('2786404:3')).imageUrl, 'https://example.test/3.webp');
  assert.equal((await store.getByResourceKey('https://example.test/3.webp')).pageKey, '2786404:3');
  assert.deepEqual((await store.list()).map((record) => record.pageKey), ['2786404:2', '2786404:3']);
});

test('directory preload store serializes concurrent initialization for one directory', async () => {
  const baselineRoot = new FakeDirectoryHandle('baseline-cache');
  await createDirectoryPreloadStore(baselineRoot);
  const baselineScans = directoryEntryScanCount(baselineRoot);

  const concurrentRoot = new FakeDirectoryHandle('concurrent-cache');
  await Promise.all([
    createDirectoryPreloadStore(concurrentRoot),
    createDirectoryPreloadStore(concurrentRoot)
  ]);

  assert.equal(directoryEntryScanCount(concurrentRoot), baselineScans);
});

test('directory preload store serializes concurrent writes for pages in the same gid', async () => {
  const root = new FakeDirectoryHandle('fixture-cache');
  const store = await createDirectoryPreloadStore(root);

  await Promise.all([
    store.put({
      pageKey: '9002001:2',
      pageUrl: 'https://reader.example.test/s/fixture-token-b/9002001-2',
      imageUrl: 'https://cache.example.test/2.webp',
      resourceKey: 'https://cache.example.test/2.webp',
      imageBlob: new Blob(['page-2'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      hasImageBlob: true
    }),
    store.put({
      pageKey: '9002001:3',
      pageUrl: 'https://reader.example.test/s/fixture-token-c/9002001-3',
      imageUrl: 'https://cache.example.test/3.webp',
      resourceKey: 'https://cache.example.test/3.webp',
      imageBlob: new Blob(['page-3'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      hasImageBlob: true
    })
  ]);

  assert.deepEqual((await store.list()).map((record) => record.pageKey), ['9002001:2', '9002001:3']);
});

test('directory preload store keeps unclassified images in images fallback folder', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const store = await createDirectoryPreloadStore(root);
  await store.put({
    resourceKey: 'https://cdn.example.test/orphan.webp',
    imageUrl: 'https://cdn.example.test/orphan.webp',
    imageBlob: new Blob(['orphan-image'], { type: 'image/webp' }),
    imageBytes: 12,
    mimeType: 'image/webp',
    hasImageBlob: true,
    updatedAt: 1234
  });

  const imagesDir = root.children.get('images');
  const stored = await store.getByResourceKey('https://cdn.example.test/orphan.webp');
  assert.equal(stored.directoryImageFile.includes('/'), false);
  assert.ok(stored.directoryImageFile.startsWith('url-'));
  assert.ok(imagesDir.children.has(stored.directoryImageFile));

  const hydrated = await store.hydrate(stored);
  assert.match(hydrated.dataUrl, /^data:image\/webp;base64,/);
});

test('directory preload store treats URL records with reader identity as page records', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const store = await createDirectoryPreloadStore(root);
  await store.put({
    gid: '2786404',
    pageNo: 2,
    resourceKey: 'https://cdn.example.test/2786404/2.webp',
    imageUrl: 'https://cdn.example.test/2786404/2.webp',
    imageName: 'URL Reader Title',
    originalTitle: 'URL Original Title',
    imageBlob: new Blob(['image-bytes'], { type: 'image/webp' }),
    imageBytes: 11,
    mimeType: 'image/webp',
    hasImageBlob: true,
    updatedAt: 1234
  });

  const recordsDir = root.children.get('records');
  const gidRecordsDir = recordsDir.children.get('gid');
  const urlRecordsDir = recordsDir.children.get('url');
  const imagesDir = root.children.get('images');
  const galleryImagesDir = imagesDir.children.get('2786404');
  assert.ok(gidRecordsDir.children.has('gid-2786404.json'));
  assert.ok(urlRecordsDir.children.has('url-https%3A%2F%2Fcdn.example.test%2F2786404%2F2.webp.json'));
  assert.equal(galleryImagesDir?.kind, 'directory');
  assert.ok(galleryImagesDir.children.has('2786404-2.webp'));

  const byPageKey = await store.get('2786404:2');
  assert.equal(byPageKey.pageKey, '2786404:2');
  assert.equal(byPageKey.title, 'URL Reader Title');
  assert.equal(byPageKey.originalTitle, 'URL Original Title');
  assert.equal(byPageKey.directoryImageFile, '2786404/2786404-2.webp');

  const byResourceKey = await store.getByResourceKey('https://cdn.example.test/2786404/2.webp');
  assert.equal(byResourceKey.pageKey, '2786404:2');
  assert.equal(byResourceKey.directoryImageFile, '2786404/2786404-2.webp');
});

test('directory preload store migrates existing flat image files into gallery folders', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const recordsDir = await root.getDirectoryHandle('records', { create: true });
  const imagesDir = await root.getDirectoryHandle('images', { create: true });
  const record = {
    pageKey: '2786404:2',
    gid: '2786404',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    imageUrl: 'https://example.test/2.webp',
    resourceKey: 'https://example.test/2.webp',
    imageName: 'Migrated Reader Title',
    directoryImageFile: 'page-2786404-2.webp',
    imageBytes: 11,
    mimeType: 'image/webp',
    hasImageBlob: true
  };
  await writeFakeJsonFile(recordsDir, 'page-2786404-2.json', record);
  await writeFakeJsonFile(recordsDir, 'url-https%3A%2F%2Fexample.test%2F2.webp.json', {
    ...record,
    directoryIndexOnly: true,
    directoryPrimaryKey: 'page-2786404-2'
  });
  await writeFakeBlobFile(imagesDir, 'page-2786404-2.webp', new Blob(['image-bytes'], { type: 'image/webp' }));

  const store = await createDirectoryPreloadStore(root);
  const galleryImagesDir = imagesDir.children.get('2786404');
  assert.equal(imagesDir.children.has('page-2786404-2.webp'), false);
  assert.equal(galleryImagesDir?.children.has('2786404-2.webp'), true);

  assert.equal(recordsDir.children.has('page-2786404-2.json'), false);
  assert.equal(recordsDir.children.has('url-https%3A%2F%2Fexample.test%2F2.webp.json'), false);
  const gidRecordsDir = recordsDir.children.get('gid');
  const urlRecordsDir = recordsDir.children.get('url');
  const migratedRecord = JSON.parse(await (await gidRecordsDir.children.get('gid-2786404.json').getFile()).text());
  const migratedIndex = JSON.parse(await (await urlRecordsDir.children.get('url-https%3A%2F%2Fexample.test%2F2.webp.json').getFile()).text());
  assert.equal(migratedRecord.directoryGroupKind, 'gid-pages');
  assert.equal(migratedRecord.title, 'Migrated Reader Title');
  assert.equal(migratedRecord.originalTitle, '');
  assert.equal(migratedRecord.pages['2786404:2'].directoryImageFile, '2786404/2786404-2.webp');
  assert.equal(migratedRecord.pages['2786404:2'].title, 'Migrated Reader Title');
  assert.equal(migratedRecord.pages['2786404:2'].originalTitle, '');
  assert.equal(migratedIndex.directoryImageFile, '2786404/2786404-2.webp');
  assert.equal(migratedIndex.directoryPrimaryKey, 'gid-2786404');
  assert.equal(migratedIndex.directoryPageKey, '2786404:2');

  const byPageKey = await store.get('2786404:2');
  const hydrated = await store.hydrate(byPageKey);
  assert.match(hydrated.dataUrl, /^data:image\/webp;base64,/);
});

test('directory preload store renames old page-prefixed files inside gallery folders', async () => {
  const root = new FakeDirectoryHandle('E站缓存');
  const recordsDir = await root.getDirectoryHandle('records', { create: true });
  const imagesDir = await root.getDirectoryHandle('images', { create: true });
  const galleryImagesDir = await imagesDir.getDirectoryHandle('2786404', { create: true });
  const record = {
    pageKey: '2786404:2',
    gid: '2786404',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    imageUrl: 'https://example.test/2.webp',
    resourceKey: 'https://example.test/2.webp',
    imageName: 'Migrated Reader Title',
    directoryImageFile: '2786404/page-2786404-2.webp',
    imageBytes: 11,
    mimeType: 'image/webp',
    hasImageBlob: true
  };
  await writeFakeJsonFile(recordsDir, 'gid-2786404.json', {
    directoryGroupKind: 'gid-pages',
    gid: '2786404',
    pages: {
      '2786404:2': record
    }
  });
  await writeFakeJsonFile(recordsDir, 'url-https%3A%2F%2Fexample.test%2F2.webp.json', {
    ...record,
    directoryIndexOnly: true,
    directoryPrimaryKey: 'gid-2786404',
    directoryPageKey: '2786404:2'
  });
  await writeFakeBlobFile(galleryImagesDir, 'page-2786404-2.webp', new Blob(['image-bytes'], { type: 'image/webp' }));

  const store = await createDirectoryPreloadStore(root);
  assert.equal(galleryImagesDir.children.has('page-2786404-2.webp'), false);
  assert.equal(galleryImagesDir.children.has('2786404-2.webp'), true);

  assert.equal(recordsDir.children.has('gid-2786404.json'), false);
  assert.equal(recordsDir.children.has('url-https%3A%2F%2Fexample.test%2F2.webp.json'), false);
  const gidRecordsDir = recordsDir.children.get('gid');
  const urlRecordsDir = recordsDir.children.get('url');
  const migratedRecord = JSON.parse(await (await gidRecordsDir.children.get('gid-2786404.json').getFile()).text());
  const migratedIndex = JSON.parse(await (await urlRecordsDir.children.get('url-https%3A%2F%2Fexample.test%2F2.webp.json').getFile()).text());
  assert.equal(migratedRecord.pages['2786404:2'].directoryImageFile, '2786404/2786404-2.webp');
  assert.equal(migratedIndex.directoryImageFile, '2786404/2786404-2.webp');

  const byPageKey = await store.get('2786404:2');
  const hydrated = await store.hydrate(byPageKey);
  assert.match(hydrated.dataUrl, /^data:image\/webp;base64,/);
});

test('external image cache-fill stores known image URL without fetching reader page', async () => {
  const calls = [];
  const record = await buildExternalImageCacheFillRecord({
    pageKey: '2786404:2',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    imageUrl: 'https://fake-a.hath.network/virtual/fixture/02.webp'
  }, {
    now: () => 1234,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/webp']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/webp' });
        }
      };
    }
  });

  assert.equal(record.pageKey, '2786404:2');
  assert.equal(record.pageUrl, 'https://exhentai.org/s/fake-reader-token-b/2786404-2');
  assert.equal(record.imageUrl, 'https://fake-a.hath.network/virtual/fixture/02.webp');
  assert.equal(record.title, '2786404');
  assert.equal(record.originalTitle, '2786404');
  assert.equal(record.source, 'external-image-cache-fill');
  assert.equal(record.hasImageBlob, true);
  assert.deepEqual(calls, [
    'https://fake-a.hath.network/virtual/fixture/02.webp'
  ]);
});

test('external image cache-fill rejects successful non-image responses', async () => {
  await assert.rejects(() => buildExternalImageCacheFillRecord({
    pageKey: '9001001:8',
    pageUrl: 'https://reader.example.test/s/fixture-token-a/9001001-8',
    imageUrl: 'https://cache.example.test/fixture/08.webp'
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
      async blob() {
        return new Blob(['Invalid request'], { type: 'text/html' });
      }
    })
  }), /Non-image response \(text\/html\)/);
});

test('external image cache-fill does not treat metadata-only records as cached images', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(source, /if \(existing && recordHasStoredImage\(existing\)\) \{/);
  assert.doesNotMatch(source, /existing\?\.hasImageBlob \|\| existing\?\.imageUrl/);
});

test('preload debug text logging records HTML details without storing image bodies in logs', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const currentHtml = '<html><body><img id="img" src="https://example.test/1.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Next</a></body></html>';
  const nextHtml = '<html><head><title>Reader 2</title></head><body><img id="img" src="https://example.test/2.jpg"></body></html>';
  const calls = [];
  const db = {
    records: new Map(),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        redirected: false,
        url: String(url),
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: String(url),
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return String(url).includes('/2786404-1') ? currentHtml : nextHtml;
      }
    };
  };

  const result = await runPreloadFromContext(context, {
    preloadEnabled: true,
    preloadAhead: 1,
    blobCacheEnabled: true,
    logDebugEnabled: true
  }, {}, { db, fetchImpl });

  assert.equal(result.completed, 1);
  assert.equal(result.requestDetails.length, 2);
  assert.equal(result.requestDetails[0].debugText, currentHtml);
  assert.equal(result.requestDetails[1].debugText, nextHtml);
  assert.equal(result.requestDetails[0].contentType, 'text/html');
  assert.equal(result.records[0].requestDetails, undefined);
  assert.equal(result.records[0].hasImageBlob, true);
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    'https://example.test/2.jpg'
  ]);
});

test('plans low-priority cache-fill only for external uncached images', () => {
  let now = 1000;
  const state = createExternalImageCacheFillState({ ttlMs: 5000, now: () => now });
  const url = 'https://fake-a.hath.network/virtual/fixture/02.webp#frag';
  const pageKey = '2786404:2';

  assert.deepEqual(planExternalImageCacheFill(state, {
    url,
    at: now,
    source: 'external'
  }, {
    blobCacheEnabled: true,
    externalImageCacheFillEnabled: true
  }), {
    action: 'cache-fill',
    key: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    pageKey: null,
    url: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    resourceKey: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    storageClass: CACHE_STORAGE_CLASSES.TEMPORARY,
    mode: 'low-priority-cache-first'
  });

  completeExternalImageCacheFill(state, { url }, { cached: true }, now + 1);
  assert.equal(planExternalImageCacheFill(state, { url, at: now + 2 }).reason, 'cached');

  assert.deepEqual(planExternalImageCacheFill(state, {
    url,
    at: now + 3,
    source: 'external',
    pageKey
  }, {
    blobCacheEnabled: true,
    externalImageCacheFillEnabled: true
  }), {
    action: 'cache-fill',
    key: pageKey,
    pageKey,
    url: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    resourceKey: 'https://fake-a.hath.network/virtual/fixture/02.webp',
    storageClass: CACHE_STORAGE_CLASSES.PERMANENT,
    mode: 'low-priority-cache-first'
  });

  assert.equal(planExternalImageCacheFill(state, { url, pageKey, at: now + 4 }).reason, 'pending');
  completeExternalImageCacheFill(state, { url, pageKey }, { cached: true }, now + 5);
  assert.equal(planExternalImageCacheFill(state, { url, pageKey, at: now + 6 }).reason, 'cached');

  const ownUrl = 'https://exhentai.org/fullimg.php?gid=1002&page=2';
  markOwnResourceRequest(state, ownUrl, now + 4);
  assert.equal(planExternalImageCacheFill(state, { url: ownUrl, pageKey: '1002:2', at: now + 5 }).reason, 'own-request');

  now += 6000;
  assert.equal(planExternalImageCacheFill(state, {
    url: 'https://e-hentai.org/fullimg.php?gid=1003&page=3',
    at: now
  }, {
    blobCacheEnabled: true,
    externalImageCacheFillEnabled: false
  }).reason, 'disabled');

  markCachedResource(state, { pageKey: '1004:4', url: 'https://e-hentai.org/fullimg.php?gid=1004&page=4' }, now + 1);
  assert.equal(planExternalImageCacheFill(state, {
    url: 'https://e-hentai.org/fullimg.php?gid=1004&page=4',
    gid: 1004,
    pageNo: 4,
    at: now + 2
  }).reason, 'cached');
});

test('reader cache-first main script skips interception when disabled', async () => {
  const source = await readFile(join(root, 'extension', 'reader-cache-first-main.js'), 'utf8');
  const img = {
    id: 'img',
    tagName: 'IMG',
    dataset: {},
    src: 'https://example.hath.network/image.webp',
    currentSrc: 'https://example.hath.network/image.webp',
    getAttribute(name) {
      return this[name] ?? '';
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    removeAttribute(name) {
      delete this[name];
    }
  };
  const html = { dataset: {} };
  const sandbox = {
    window: {
      addEventListener() {},
      __EHPLUS_READER_CACHE_FIRST__: undefined
    },
    document: {
      documentElement: html,
      addEventListener() {},
      querySelector(selector) {
        return selector === '#img' ? img : null;
      },
      querySelectorAll() {
        return [img];
      }
    },
    location: {
      href: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
      origin: 'https://exhentai.org'
    },
    URL,
    localStorage: {
      getItem(key) {
        return key === 'EHPLUS_READER_CACHE_FIRST_ENABLED_V2' ? '0' : null;
      }
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    HTMLImageElement: function HTMLImageElement() {},
    Element: function Element() {}
  };
  sandbox.HTMLImageElement.prototype = {};
  sandbox.Element.prototype = {
    setAttribute(name, value) {
      this[name] = value;
    }
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.location = sandbox.location;

  vm.runInNewContext(source, sandbox);

  assert.equal(html.dataset.ehplusCacheFirstState, 'disabled');
  assert.equal(html.dataset.ehplusCacheFirstReason, 'setting-disabled');
  assert.equal(img.src, 'https://example.hath.network/image.webp');
  assert.equal(img.dataset.ehplusCacheFirstPending, undefined);
  assert.equal(sandbox.window.__EHPLUS_READER_CACHE_FIRST__?.installed, true);
  assert.equal(html.dataset.ehplusCacheFirstMainNlGuard, '1');
});

test('reader cache-first main script normalizes EH nl retry URLs', async () => {
  const source = await readFile(join(root, 'extension', 'reader-cache-first-main.js'), 'utf8');
  const img = {
    id: 'img',
    tagName: 'IMG',
    dataset: {},
    src: 'https://example.hath.network/image.webp',
    currentSrc: 'https://example.hath.network/image.webp',
    getAttribute(name) {
      return this[name] ?? '';
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    removeAttribute(name) {
      delete this[name];
    }
  };
  const html = { dataset: {} };
  const loadfailAttrs = { onclick: "return nl('retry-two')" };
  const loadfail = {
    id: 'loadfail',
    dataset: {},
    onclick: () => {},
    getAttribute(name) {
      return loadfailAttrs[name] ?? null;
    },
    setAttribute(name, value) {
      loadfailAttrs[name] = value;
    },
    removeAttribute(name) {
      delete loadfailAttrs[name];
    }
  };
  const location = {
    href: 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=old-token&nl=retry-one',
    origin: 'https://exhentai.org',
    replace(url) {
      this.href = String(url);
    }
  };
  const fetchCalls = [];
  const sandbox = {
    window: {
      addEventListener() {},
      __EHPLUS_READER_CACHE_FIRST__: undefined
    },
    document: {
      title: 'reader',
      documentElement: html,
      addEventListener() {},
      querySelector(selector) {
        if (selector === '#img') return img;
        if (selector === '#loadfail') return loadfail;
        return null;
      },
      querySelectorAll() {
        return [img];
      }
    },
    location,
    history: {
      state: null,
      replaceState(_state, _title, url) {
        location.href = String(url);
      }
    },
    URL,
    WeakMap,
    Date,
    localStorage: {
      getItem(key) {
        return key === 'EHPLUS_READER_CACHE_FIRST_ENABLED_V2' ? '1' : null;
      }
    },
    fetch: async (url) => {
      fetchCalls.push(String(url));
      const retryToken = new URL(String(url)).searchParams.get('nl') || 'missing';
      return {
        ok: true,
        status: 200,
        async text() {
          return `<html><body><div id="loadfail" onclick="return nl('next-${retryToken}')"></div><img id="img" src="/replaced-${retryToken}.jpg"></body></html>`;
        }
      };
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    HTMLImageElement: function HTMLImageElement() {},
    Element: function Element() {}
  };
  sandbox.HTMLImageElement.prototype = {};
  sandbox.Element.prototype = {
    setAttribute(name, value) {
      this[name] = value;
    }
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.location = sandbox.location;

  vm.runInNewContext(source, sandbox);

  assert.equal(location.href, 'https://exhentai.org/s/fake-reader-token-b/2786404-2');
  assert.equal(html.dataset.ehplusCacheFirstMainNlGuard, '1');
  assert.equal(html.dataset.ehplusCacheFirstMainNlRetryOriginal, '1');
  assert.equal(html.dataset.ehplusCacheFirstMainNlRetryToken, 'retry-one');
  assert.equal(html.dataset.ehplusCacheFirstState, 'nl-retry-bypass');
  assert.equal(html.dataset.ehplusCacheFirstReason, 'nl-retry');
  assert.equal(img.dataset.ehplusCacheFirstPending, undefined);
  assert.equal(loadfail.onclick, null);
  assert.equal(loadfail.getAttribute('onclick'), null);
  assert.match(html.dataset.ehplusCacheFirstMainNlGuardStatus, /cleaned-install|installed/);

  sandbox.window.nl = (token) => {
    location.href += `${location.href.includes('?') ? '&' : '?'}nl=${token}`;
  };
  sandbox.window.nl('retry-one');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(location.href, 'https://exhentai.org/s/fake-reader-token-b/2786404-2');
  assert.equal(fetchCalls.at(-1), 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-one');
  assert.equal(img.src, 'https://exhentai.org/replaced-retry-one.jpg');

  sandbox.window.nl('retry-two');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(location.href, 'https://exhentai.org/s/fake-reader-token-b/2786404-2');
  assert.equal(fetchCalls.at(-1), 'https://exhentai.org/s/fake-reader-token-b/2786404-2?nl=retry-two');
  assert.equal(img.src, 'https://exhentai.org/replaced-retry-two.jpg');
  assert.equal(html.dataset.ehplusCacheFirstMainNlRetryToken, 'next-retry-two');
  assert.equal(new URL(location.href).searchParams.getAll('nl').length, 0);
});

test('reader cache-first network gate is wired through manifest and runtime messages', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('declarativeNetRequest'));
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.ok(JSON.stringify(manifest.web_accessible_resources).includes('images/cache-first-placeholder.svg'));
  const readerMainScripts = manifest.content_scripts
    .find((script) => script.world === 'MAIN' && script.matches.includes('https://exhentai.org/s/*'))
    .js;
  assert.deepEqual(readerMainScripts.slice(0, 2), ['reader-nl-guard-main.js', 'reader-cache-first-main.js']);

  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /EHPLUS_READER_CACHE_FIRST_BLOCK/);
  assert.match(serviceWorker, /updateSessionRules/);
  assert.match(serviceWorker, /READER_CACHE_FIRST_PLACEHOLDER_PATH/);
  assert.match(serviceWorker, /onBeforeNavigate/);
  assert.match(serviceWorker, /regexFilter: '\^https:\/\/\[\^\/:\]\+\\\\\.hath\\\\\.network\(\?::\[0-9\]\+\)\?\/'/);
  assert.match(serviceWorker, /FAST_CACHE_STORE_TIMEOUT_MS/);
  assert.match(serviceWorker, /FAST_CACHE_RECORD_TIMEOUT_MS/);
  assert.match(serviceWorker, /FAST_CACHE_RESPONSE_TIMEOUT_MS = 2400/);
  assert.match(serviceWorker, /READER_CACHE_FIRST_BLOCK_AUTO_RELEASE_MS = 30000/);
  assert.match(serviceWorker, /const readerCacheFirstBlockReleaseTimers = new Map\(\)/);
  assert.match(serviceWorker, /PRELOAD_CACHE_SYNC_TIMEOUT_MS/);
  assert.match(serviceWorker, /indexReadMs/);
  assert.match(serviceWorker, /imageLoadMs/);
  assert.match(serviceWorker, /totalMs/);
  assert.match(serviceWorker, /internalMessageResponseTimeoutMs/);
  assert.match(serviceWorker, /internalMessageTimeoutFallback/);
  assert.match(serviceWorker, /message-timeout-fallback/);
  assert.match(serviceWorker, /fallback: 'message-timeout'/);
  assert.match(serviceWorker, /releaseReaderCacheFirstBlock\(tabId\)\.catch/);
  assert.match(serviceWorker, /ensureReaderCacheFirstBlock\(tabId, effectiveState\)\.catch/);
  assert.doesNotMatch(serviceWorker, /isReaderPageUrlForCacheFirst\(details\.url\)[\s\S]{0,120}\? ensureReaderCacheFirstBlock\(details\.tabId\)/);
  assert.match(serviceWorker, /scheduleReaderCacheFirstBlockAutoRelease\(tabId\)/);
  assert.match(serviceWorker, /clearReaderCacheFirstBlockAutoRelease\(tabId\)/);
  assert.match(serviceWorker, /withTimeout\(getState\(\), 150, \{ settings: \{ readerCacheFirstEnabled: true \} \}\)/);
  assert.match(serviceWorker, /accepted: true/);
  assert.match(serviceWorker, /deferred: state === null/);
  assert.match(serviceWorker, /&& !parsed\.searchParams\.has\('nl'\)/);

  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(contentScript, /EHPLUS_READER_CACHE_FIRST_BLOCK/);
  assert.match(contentScript, /EHPLUS_READER_CACHE_FIRST_NL_RETRY/);
  assert.match(contentScript, /handleLocalReaderCacheFirstNlRetryMessage/);
  assert.match(contentScript, /cancelLocalReaderCacheFirstStateForNlRetry/);
  assert.match(contentScript, /ensureLocalReaderCacheFirstNetworkBlock/);
  assert.match(contentScript, /releaseLocalReaderCacheFirstNetworkBlock/);
  assert.match(contentScript, /ehplusCacheFirstNetworkBlock/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_SOFT_TIMEOUT_MS = 5000/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_HARD_TIMEOUT_MS = 20000/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_RELEASE_TIMEOUT_MS = 5000/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_QUERY_TIMEOUT_MS = 3500/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_MESSAGE_TIMEOUT_MS = 1500/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_PAGEKEY_WATCH_MS = 250/);
  assert.match(contentScript, /promiseWithTimeout/);
  assert.match(contentScript, /localReaderCacheFirstFallbackReason\(response\)/);
  assert.match(contentScript, /response\?\.reason === 'runtime-timeout'\) return 'timeout'/);
  assert.match(contentScript, /state\.queryFallbackReason \|\| 'miss'/);
  assert.match(contentScript, /function isReaderNlRetryPageUrl\(url\)/);
  assert.match(contentScript, /function isReaderNlRetryBypassPage\(url = location\.href\)/);
  assert.match(contentScript, /ehplusCacheFirstMainNlRetryOriginal === '1'/);
  assert.match(contentScript, /setLocalReaderCacheFirstStatus\('nl-retry-bypass'/);
  assert.match(contentScript, /scheduleLocalReaderCacheFirstNetworkBlockRelease\(pageKey, 'nl-retry'\)/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_COUNT = 5/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_RELEASE_RETRY_DELAY_MS = 1200/);
  assert.match(contentScript, /EHPLUS_READER_CACHE_FIRST_TIMING/);
  assert.match(contentScript, /reportLocalReaderCacheFirstTiming/);
  assert.match(contentScript, /installLocalReaderCacheFirstUrlWatcher/);
  assert.match(contentScript, /handleLocalReaderCacheFirstPageKeyChange/);
  assert.match(contentScript, /cancelLocalReaderCacheFirstState\(localReaderCacheFirstState, 'page-key-changed'\)/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_HTTP_URL_PATTERN\.test\(state\.originalSrc\)/);
  assert.match(contentScript, /timeout-waiting/);
  assert.match(contentScript, /kept-for-timeout-waiting/);
  assert.match(contentScript, /release-timeout-restore/);
  assert.match(contentScript, /waitForLocalReaderCacheFirstNetworkBlockRelease/);
  assert.match(contentScript, /clearTimeout\(timer\)/);
  assert.match(contentScript, /img\.getAttribute\(LOCAL_READER_CACHE_FIRST_ORIGINAL_SRC_ATTR\)\s+\|\| state\?\.originalSrc/);
  assert.match(contentScript, /LOCAL_READER_CACHE_FIRST_PLACEHOLDER_PATH = 'images\/cache-first-placeholder\.svg'/);
  assert.match(contentScript, /localReaderCacheFirstPlaceholderUrl/);

  const nlGuardScript = await readFile(join(root, 'extension', 'reader-nl-guard-main.js'), 'utf8');
  assert.match(nlGuardScript, /EHPLUS_READER_CACHE_FIRST_NL_RETRY/);
  assert.match(nlGuardScript, /parsed\.searchParams\.set\('nl', token\)/);
  assert.match(nlGuardScript, /history\.replaceState\(history\.state, document\.title, parsed\.href\)/);
  assert.match(nlGuardScript, /window\.addEventListener\('error'/);
  assert.match(nlGuardScript, /fetch\(retryUrl, \{/);
  assert.match(nlGuardScript, /credentials: 'include'/);

  const mainScript = await readFile(join(root, 'extension', 'reader-cache-first-main.js'), 'utf8');
  assert.match(mainScript, /img\.getAttribute\('src'\) \|\| img\.src \|\| img\.currentSrc/);
  assert.match(mainScript, /PLACEHOLDER_SVG/);
  assert.match(mainScript, /正在读取本地缓存/);
  assert.match(mainScript, /HARD_RESTORE_TIMEOUT_MS = 32000/);
  assert.match(mainScript, /restoreOriginal\('main-hard-timeout'\)/);
  assert.match(mainScript, /clearTimeout\(state\.hardRestoreTimer\)/);
  assert.match(mainScript, /function localPlaceholderUrl\(\)/);
  assert.match(mainScript, /encodeURIComponent\(PLACEHOLDER_SVG\)/);
  assert.match(mainScript, /function refreshPageKey\(source\)/);
  assert.match(mainScript, /function keepCachedImageApplied\(source\)/);
  assert.match(mainScript, /function keepCachedUrlIfSettled\(img, value, kind, source\)/);
  assert.match(mainScript, /setStatus\('cached-url-kept'/);
  assert.doesNotMatch(mainScript, /applyCachedUrl\(url\)[\s\S]*?state\.observer\?\.disconnect\(\)/);
  assert.match(mainScript, /message\.pageKey !== state\.pageKey/);
  assert.match(mainScript, /html\.dataset\.ehplusCacheFirstPageKey = state\.pageKey/);
  assert.match(mainScript, /installNlRetryUrlGuard\(\)/);
  assert.match(mainScript, /normalizeCurrentNlUrl\('install'\)/);
  assert.match(mainScript, /function isNlRetryPageUrl\(url\)/);
  assert.match(mainScript, /installRetryHandlerStripObserver\(\)/);
  assert.match(mainScript, /attributeFilter: \['id', 'onerror', 'onclick'\]/);
  assert.match(mainScript, /setStatus\('nl-retry-bypass', \{ reason: 'nl-retry' \}\)/);
  assert.match(mainScript, /installCurrentPageNlRetryHandlers\(\)/);
  assert.match(mainScript, /EHPLUS_READER_CACHE_FIRST_NL_RETRY/);
  assert.match(mainScript, /notifyNlRetryBypass\(token, retryUrl\)/);
  assert.match(mainScript, /function retryNlReplacementImage\(img, token, pageUrl\)/);
  assert.match(mainScript, /fetch\(retryUrl, \{/);
  assert.match(mainScript, /credentials: 'include'/);
  assert.match(mainScript, /function parseNlRetryPage\(html, pageUrl\)/);
  assert.match(mainScript, /img\.src = data\.src/);
  assert.match(mainScript, /html\.dataset\.ehplusCacheFirstMainNlRetryOriginal = '1'/);
  assert.match(mainScript, /parsed\.searchParams\.delete\('nl'\)/);
  assert.match(mainScript, /markNlGuard\('suppressed-token'\)/);
  assert.match(mainScript, /history\.replaceState\(history\.state, document\.title, nextUrl\)/);
  assert.match(mainScript, /html\.dataset\.ehplusCacheFirstMainNlGuard = '1'/);
  assert.match(mainScript, /if \(!hasHttpSrcset && !hasHttpSrc\) return false/);
  assert.match(mainScript, /img\.dataset\.ehplusCacheFirstPending === 'true' && !hasHttpSrcset && !hasHttpSrc/);
  assert.match(mainScript, /stripCurrentReaderInlineRetryHandlers\(\)/);
  assert.match(mainScript, /stripCurrentReaderInlineRetryHandlers\(img\)/);
  assert.match(mainScript, /function stripCurrentReaderInlineRetryHandlers\(img = document\.querySelector\('#img'\)\)/);
  assert.match(mainScript, /document\.querySelector\('#loadfail'\)/);
  assert.match(mainScript, /function stripInlineImageRetryHandler\(img\)/);
  assert.match(mainScript, /img\.removeAttribute\('onerror'\)/);
  assert.match(mainScript, /img\.onerror = null/);
  assert.match(mainScript, /function stripInlineLoadfailRetryHandler\(node\)/);
  assert.match(mainScript, /node\.removeAttribute\('onclick'\)/);
  assert.match(mainScript, /node\.onclick = null/);
});

test('reader cache-first placeholder is visible and animated', async () => {
  const source = await readFile(join(root, 'extension', 'images', 'cache-first-placeholder.svg'), 'utf8');
  assert.match(source, /width="960" height="1361"/);
  assert.match(source, /正在读取本地缓存/);
  assert.match(source, /<tspan>…<\/tspan>/);
  assert.match(source, /repeatCount="indefinite"/);
  assert.match(source, /keyTimes="0;0\.32;0\.33;1"/);
  assert.match(source, /keyTimes="0;0\.65;0\.66;1"/);
});

test('extension runtime exposes reader cache-first interception controls', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(source, /const readerCacheFirstToggle = `/);
  assert.match(source, /function scheduleLocalCacheConsumer\(\) \{\s+if \(!isExtensionRuntime\(\)\) return;/);
  assert.match(source, /function installLocalReaderCacheFirstController\(\) \{\s+if \(!isExtensionRuntime\(\)\) return;/);
  assert.match(source, /function sendLocalReaderCacheFirstNetworkBlockMessage\(action, pageKey, reason = ''\) \{\s+if \(!isExtensionRuntime\(\)\) return Promise\.resolve/);
  assert.match(source, /localReaderCacheFirstNetworkBlockMessageId/);
  assert.match(source, /ehplusCacheFirstNetworkBlockMessageId/);
  assert.match(source, /isLatestMessage/);
  assert.match(source, /async function applyLocalCacheToCurrentPage\(\) \{\s+if \(!isExtensionRuntime\(\)\) return;/);
  assert.match(source, /function syncReaderCacheFirstSetting\(settings\) \{\s+if \(!isExtensionRuntime\(\)\) return;/);
  assert.match(source, /EHPLUS_READER_CACHE_FIRST_ENABLED_V2/);
  assert.match(source, /localStorage\.setItem\(LOCAL_READER_CACHE_FIRST_LEGACY_ENABLED_STORAGE_KEY, '0'\)/);
  assert.doesNotMatch(source, /function syncReaderCacheFirstSetting[\s\S]*?if \(enabled\) \{\s*ensureLocalReaderCacheFirstNetworkBlock/);
  assert.match(source, /readerCacheFirstEnabled: quickCheckedOr\(root, 'reader-cache-first', stateSettings\.readerCacheFirstEnabled === true\)/);
  assert.match(source, /readerCacheFirstHitStatus: '已命中缓存 \{target\}'/);
  assert.match(source, /bindPanelCacheFirstStatusObserver\(root\)/);
  assert.match(source, /function updatePanelStatusLine\(root, state = root\.__ehplusState\)/);
  assert.match(source, /function readerCacheFirstHitStatusText\(root\)/);
  assert.match(source, /img\.dataset\.ehplusCacheHit !== 'true'/);
  assert.match(source, /t\(root, 'readerCacheFirstHitStatus', \{\s+target: readerCacheFirstHitTarget\(img, pageKey\)\s+\}\)/);
  assert.match(source, /function readerCacheFirstHitTarget\(img, pageKey\)/);
  assert.doesNotMatch(source, /pageKey\/url√|pageKey\/url √/);
});

test('built-in auto pager settings and internal cache path are wired', async () => {
  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(contentScript, /const autoPagerToggle = `/);
  assert.match(contentScript, /data-role="auto-pager"/);
  assert.match(contentScript, /data-tab="autopager"/);
  assert.match(contentScript, /data-panel="autopager"/);
  assert.doesNotMatch(contentScript, /data-setting="autoPagerEnabled"/);
  assert.match(contentScript, /data-setting="autoPagerRemain"/);
  assert.match(contentScript, /data-setting="autoPagerMaxPages"/);
  assert.match(contentScript, /data-setting="autoPagerImmediateEnabled"/);
  assert.match(contentScript, /data-setting="autoPagerImmediatePages"/);
  assert.match(contentScript, /data-setting="autoPagerSeparatorEnabled"/);
  assert.match(contentScript, /data-setting="autoPagerAplus"/);
  assert.match(contentScript, /function installBuiltInAutoPager\(pageSessionId\)/);
  assert.match(contentScript, /autoPagerEnabled: quickCheckedOr\(root, 'auto-pager', stateSettings\.autoPagerEnabled === true\)/);
  assert.match(contentScript, /\['auto-pager', settings\.autoPagerEnabled === true, 'checked'\]/);
  assert.match(contentScript, /className: 'sp-sp-gotop'/);
  assert.match(contentScript, /className: 'sp-sp-gopre'/);
  assert.match(contentScript, /className: 'sp-sp-gonext'/);
  assert.match(contentScript, /className: 'sp-sp-gobottom'/);
  assert.match(contentScript, /sp-span-someinfo/);
  assert.match(contentScript, /function builtInAutoPagerSeparatorText\(pageNo\)/);
  assert.doesNotMatch(contentScript, /color\s*:\s*red\s*!important/i);
  assert.match(contentScript, /images\/autopager\/to_top\.png/);
  assert.match(contentScript, /images\/autopager\/up\.png/);
  assert.match(contentScript, /images\/autopager\/up_gray\.png/);
  assert.match(contentScript, /images\/autopager\/donw\.png/);
  assert.match(contentScript, /images\/autopager\/down_gray\.png/);
  assert.match(contentScript, /images\/autopager\/to_bottom\.png/);
  assert.match(contentScript, /type: INTERNAL_CACHE_QUERY_TYPE/);
  assert.match(contentScript, /id = `sp-exhentai-img-\$\{pageIndex\}-\$\{index\}`/);
  assert.match(contentScript, /sanitizeBuiltInAutoPagerInlineHandlers\(root\)/);
  assert.match(contentScript, /function sanitizeBuiltInAutoPagerInlineHandlers\(root\)/);
  assert.match(contentScript, /stripInlineImageRetryHandler\(node\)/);
  assert.match(contentScript, /stripInlineLoadfailRetryHandler\(node\)/);
  assert.match(contentScript, /data-ehplus-original-id="loadfail"/);
  assert.match(contentScript, /readerNextUrlFromDocument\(pageDoc, pageUrl, html\)/);
  assert.match(contentScript, /function tryLocalReaderCacheFirstImage\(state\)[\s\S]*?stripCurrentReaderInlineRetryHandlers\(img\)/);
  assert.match(contentScript, /function restoreLocalReaderOriginalImage\(img, state\)[\s\S]*?stripCurrentReaderInlineRetryHandlers\(img\)/);
  assert.match(contentScript, /function stripCurrentReaderInlineRetryHandlers\(img = document\.querySelector\(LOCAL_READER_CACHE_FIRST_IMG_SELECTOR\)\)/);
  assert.match(contentScript, /document\.querySelector\('#loadfail'\)/);
  assert.match(contentScript, /function stripInlineImageRetryHandler\(img\)/);
  assert.match(contentScript, /img\.removeAttribute\('onerror'\)/);
  assert.match(contentScript, /img\.onerror = null/);
  assert.match(contentScript, /function stripInlineLoadfailRetryHandler\(node\)/);
  assert.match(contentScript, /node\.removeAttribute\('onclick'\)/);
  assert.match(contentScript, /node\.onclick = null/);

  const contentStyle = await readFile(join(root, 'extension', 'content-style.css'), 'utf8');
  assert.match(contentStyle, /\.ehplus-autopager-separator\.sp-separator/);
  assert.match(contentStyle, /background-color: #ffffff !important/);
  assert.match(contentStyle, /border-top: 1px solid #cccccc !important/);
  assert.match(contentStyle, /border-bottom: 1px solid #cccccc !important/);
  assert.match(contentStyle, /span\.sp-span-someinfo/);
  assert.match(contentStyle, /width: auto;\s+height: auto;/);

  const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const resource of [
    'images/autopager/to_top.png',
    'images/autopager/up.png',
    'images/autopager/up_gray.png',
    'images/autopager/donw.png',
    'images/autopager/down_gray.png',
    'images/autopager/to_bottom.png'
  ]) {
    assert.ok(resources.includes(resource), `${resource} is web-accessible`);
  }

  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /const SETTINGS_VERSION = 15/);
  assert.match(serviceWorker, /autoPagerEnabled: false/);
  assert.match(serviceWorker, /autoPagerRemain: 1/);
  assert.match(serviceWorker, /autoPagerMaxPages: 99/);
  assert.match(serviceWorker, /if \(message\?\.type === INTERNAL_CACHE_QUERY_TYPE\)/);
  assert.match(serviceWorker, /handleInternalCacheQuery/);
  assert.match(serviceWorker, /page-image-activity/);
});

test('content script exposes reader cache-first query debug dataset fields', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  for (const field of [
    'ehplusCacheFirstControllerQueryState',
    'ehplusCacheFirstControllerQueryStartedAt',
    'ehplusCacheFirstControllerQueryElapsedMs',
    'ehplusCacheFirstControllerQueryResult',
    'ehplusCacheFirstControllerResponseHit',
    'ehplusCacheFirstControllerResponseReason',
    'ehplusCacheFirstControllerResponseDeliveryKind',
    'ehplusCacheFirstControllerResponseHasUrl',
    'ehplusCacheFirstControllerResponseTimingUnit',
    'ehplusCacheFirstControllerResponseIndexReadMs',
    'ehplusCacheFirstControllerResponsePageIndexReadMs',
    'ehplusCacheFirstControllerResponseResourceIndexReadMs',
    'ehplusCacheFirstControllerResponseImageLoadMs',
    'ehplusCacheFirstControllerImageLoadMs',
    'ehplusCacheFirstControllerFallbackRequestMs'
  ]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /runtime-timeout/);
  assert.match(source, /content-timeout/);
  assert.match(source, /send-start/);
  assert.match(source, /send-resolve/);
  assert.match(source, /send-error/);
  assert.match(source, /response-hit/);
  assert.match(source, /response-miss/);
});

test('reader cache-first timing report is persisted to logs', async () => {
  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(serviceWorker, /EHPLUS_READER_CACHE_FIRST_TIMING/);
  assert.match(serviceWorker, /handleReaderCacheFirstTiming/);
  assert.match(serviceWorker, /reader-cache-first\.timing/);
  assert.match(serviceWorker, /normalizeTimingPayload/);
  assert.match(serviceWorker, /fallbackRequestMs/);
  assert.match(serviceWorker, /durationMs/);
  assert.match(serviceWorker, /const LOGS_KEY = 'ehplus_live_logs'/);
  assert.match(serviceWorker, /const SERVICE_WORKER_PROBE_KEY = 'ehplus_service_worker_probe'/);
  assert.match(serviceWorker, /writeServiceWorkerProbe\('top-level'\)/);
  assert.match(serviceWorker, /delete normalized\.logs/);
  assert.match(serviceWorker, /async function writeRuntimeState/);
  // 2026-07-07：状态落盘改为内存缓存 + 防抖批量写（schedulePersistRuntimeState），
  // 持久化语句从 writeRuntimeState 内联移到防抖回调中。
  assert.match(serviceWorker, /function schedulePersistRuntimeState/);
  assert.match(serviceWorker, /chrome\.storage\.local\.set\(\{ \[STATE_KEY\]: pending \}\)/);
  assert.match(contentScript, /const LOGS_KEY = 'ehplus_live_logs'/);
  assert.match(contentScript, /const SERVICE_WORKER_PROBE_KEY = 'ehplus_service_worker_probe'/);
  assert.match(contentScript, /readServiceWorkerProbeForDebug/);
  assert.match(contentScript, /ehplusServiceWorkerProbe/);
  assert.match(contentScript, /cleanupEmbeddedRuntimeStateLogs/);
  assert.match(contentScript, /function writeLocalReaderSplitStateAndLogs/);
  assert.match(contentScript, /delete next\.logs/);
  assert.match(contentScript, /chrome\.storage\.local\.set\(\{ \[STATE_KEY\]: next, \[LOGS_KEY\]: Array\.isArray\(logs\) \? logs : \[\] \}\)/);
});

test('directory log snapshots are split into daily files', async () => {
  const source = await readFile(join(root, 'extension', 'directory-storage.js'), 'utf8');
  assert.equal(directoryLogDate({ at: new Date(2024, 5, 9, 23, 30).getTime() }), '2024-06-09');
  assert.ok(source.includes('const DAILY_LOG_FILE_PATTERN = /^\\d{4}-\\d{2}-\\d{2}\\.json$/;'));
  assert.match(source, /writeJsonFile\(logsDir, `\$\{date\}\.json`, items\)/);
  assert.doesNotMatch(source, /writeJsonFile\([^)]*'logs\.json'/);
  assert.match(source, /removeEntry\(logsDir, 'logs\.json'\)/);

  const directory = new FakeDirectoryHandle('E站缓存');
  const logsDir = await directory.getDirectoryHandle('logs', { create: true });
  await logsDir.getFileHandle('logs.json', { create: true });
  await logsDir.getFileHandle('2024-06-08.json', { create: true });
  await writeDirectoryLogsSnapshot(directory, [
    { at: new Date(2024, 5, 9, 8, 0).getTime(), message: 'first' },
    { at: new Date(2024, 5, 10, 9, 0).getTime(), message: 'second' },
    { at: new Date(2024, 5, 9, 10, 0).getTime(), message: 'third' }
  ]);

  assert.equal(logsDir.children.has('logs.json'), false);
  assert.equal(logsDir.children.has('2024-06-08.json'), false);
  assert.equal(logsDir.children.has('2024-06-09.json'), true);
  assert.equal(logsDir.children.has('2024-06-10.json'), true);
  const june9 = JSON.parse(await (await logsDir.children.get('2024-06-09.json').getFile()).text());
  assert.deepEqual(june9.map((log) => log.message), ['first', 'third']);
});

test('directory authorization returns before migration and cache sync finish', async () => {
  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /const DIRECTORY_SELECTION_BACKGROUND_DELAY_MS = 0/);
  assert.match(serviceWorker, /type: 'EHPLUS_DIRECTORY_SELECTION_FINALIZE'/);
  assert.match(serviceWorker, /type: 'EHPLUS_DIRECTORY_SWITCH_FINALIZE'/);
  assert.match(serviceWorker, /migrationPending: true/);
  assert.match(serviceWorker, /accepted: true/);
  assert.match(serviceWorker, /scheduleBackgroundTask\(\{\s+type: 'EHPLUS_DIRECTORY_SELECTION_FINALIZE'[\s\S]*?\}, sender, \(\) => finalizeDirectorySelection/);
  assert.match(serviceWorker, /scheduleBackgroundTask\(\{\s+type: 'EHPLUS_DIRECTORY_SWITCH_FINALIZE'[\s\S]*?async \(\) => \{\s+const migrationResult = await migrateDirectoryCacheToDirectory/);
});

test('directory authorization runtime keeps custom preference while temporarily falling back', () => {
  assert.equal(typeof directoryStorage.applyDirectoryAuthorizationRuntime, 'function');
  assert.equal(typeof directoryStorage.dismissDirectoryAuthorizationNotice, 'function');
  assert.equal(typeof directoryStorage.shouldShowDirectoryAuthorizationNotice, 'function');

  const lost = directoryStorage.applyDirectoryAuthorizationRuntime({}, {
    requestedMode: 'directory',
    directoryLabel: 'fixture-cache',
    writable: false
  });
  assert.equal(lost.effectiveStorageMode, 'indexeddb');
  assert.equal(lost.directoryAuthorizationRequired, true);
  assert.equal(lost.directoryAuthorizationIncident, 1);
  assert.equal(directoryStorage.shouldShowDirectoryAuthorizationNotice(lost), true);

  const repeated = directoryStorage.applyDirectoryAuthorizationRuntime(lost, {
    requestedMode: 'directory',
    directoryLabel: 'fixture-cache',
    writable: false
  });
  assert.equal(repeated.directoryAuthorizationIncident, 1);

  const dismissed = directoryStorage.dismissDirectoryAuthorizationNotice(repeated);
  assert.equal(directoryStorage.shouldShowDirectoryAuthorizationNotice(dismissed), false);

  const restored = directoryStorage.applyDirectoryAuthorizationRuntime(dismissed, {
    requestedMode: 'directory',
    directoryLabel: 'fixture-cache',
    writable: true
  });
  assert.equal(restored.effectiveStorageMode, 'directory');
  assert.equal(restored.directoryAuthorizationRequired, false);

  const lostAgain = directoryStorage.applyDirectoryAuthorizationRuntime(restored, {
    requestedMode: 'directory',
    directoryLabel: 'fixture-cache',
    writable: false
  });
  assert.equal(lostAgain.directoryAuthorizationIncident, 2);
  assert.equal(directoryStorage.shouldShowDirectoryAuthorizationNotice(lostAgain), true);
});

test('directory authorization fallback is wired into backend selection and restoration', async () => {
  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  assert.match(serviceWorker, /applyDirectoryAuthorizationRuntime/);
  assert.match(serviceWorker, /effectiveStorageMode:\s*'indexeddb'/);
  assert.match(serviceWorker, /syncDirectoryAuthorizationRuntime\(activeSettings, false\)/);
  assert.match(serviceWorker, /EHPLUS_DISMISS_DIRECTORY_AUTHORIZATION_NOTICE/);
  assert.match(serviceWorker, /loadWritableDirectoryHandle\(\{\s*refresh:\s*true\s*\}\)/);
});

test('directory authorization reminder shows fallback status and supports both close paths', async () => {
  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  const contentStyle = await readFile(join(root, 'extension', 'content-style.css'), 'utf8');

  assert.match(contentScript, /data-role="directory-authorization-modal"/);
  assert.match(contentScript, /data-action="directory-authorization-confirm"/);
  assert.match(contentScript, /directoryAuthorizationRequiredFallback/);
  assert.match(contentScript, /event\.target === authorizationModal/);
  assert.match(contentScript, /document\.documentElement\.appendChild\(authorizationModal\)/);
  assert.match(contentScript, /EHPLUS_DISMISS_DIRECTORY_AUTHORIZATION_NOTICE/);
  assert.match(contentStyle, /^\.ehplus-directory-authorization-modal \{/m);
});

test('preload cache sync does not clear counts when store listing times out', async () => {
  const serviceWorker = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.match(serviceWorker, /records = await withTimeout\(store\.list\(\), PRELOAD_CACHE_SYNC_TIMEOUT_MS, null\)/);
  assert.match(serviceWorker, /if \(!Array\.isArray\(records\)\) return null/);
  assert.doesNotMatch(serviceWorker, /records = await withTimeout\(store\.list\(\), PRELOAD_CACHE_SYNC_TIMEOUT_MS, \[\]\)/);
});

function responseBodyForUrl(url) {
  if (url.endsWith('/home.php')) {
    return '<html><head><title>Home</title></head><body>Image Limits: 1 / 50,000 Reset Quota: 2 GP</body></html>';
  }
  if (url.endsWith('/exchange.php?t=hath')) {
    return '<html><head><title>The Hath Exchange</title></head><body>Credits: 10 Hath: 3</body></html>';
  }
  if (url.endsWith('/exchange.php?t=gp')) {
    return '<html><head><title>The GP Exchange</title></head><body>GP: 20</body></html>';
  }
  if (url.endsWith('/news.php')) {
    return '<div id="eventpane">It is the dawn of a new day! You gain 1 EXP, 2 Credits, 3 GP and 4 Hath!</div>';
  }
  return '<html><head><title>Unknown</title></head><body></body></html>';
}

async function fixtureText(relativePath) {
  return readFile(join(root, 'fixtures', relativePath), 'utf8');
}

async function fixtureJson(relativePath) {
  return JSON.parse(await fixtureText(relativePath));
}

function idbSuccess(result) {
  const request = { result };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

class FakeDirectoryHandle {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
    this.entriesCalls = 0;
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === 'directory') return existing;
    if (!options.create) throw domNotFound();
    const next = new FakeDirectoryHandle(name);
    this.children.set(name, next);
    return next;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === 'file') return existing;
    if (!options.create) throw domNotFound();
    const next = new FakeFileHandle(name);
    this.children.set(name, next);
    return next;
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw domNotFound();
  }

  async *entries() {
    this.entriesCalls += 1;
    yield* this.children.entries();
  }
}

function directoryEntryScanCount(directoryHandle) {
  let count = directoryHandle.entriesCalls;
  for (const child of directoryHandle.children.values()) {
    if (child?.kind === 'directory') count += directoryEntryScanCount(child);
  }
  return count;
}

async function writeFakeJsonFile(directoryHandle, name, value) {
  await writeFakeBlobFile(directoryHandle, name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
}

async function writeFakeBlobFile(directoryHandle, name, blob) {
  const handle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

class FakeFileHandle {
  constructor(name) {
    this.kind = 'file';
    this.name = name;
    this.blob = new Blob([]);
    this.getFileCalls = 0;
  }

  async createWritable() {
    return {
      write: async (blob) => {
        this.blob = blob instanceof Blob ? blob : new Blob([blob]);
      },
      close: async () => {}
    };
  }

  async getFile() {
    this.getFileCalls += 1;
    return new File([this.blob], this.name, { type: this.blob.type });
  }
}

function domNotFound() {
  const error = new Error('not found');
  error.name = 'NotFoundError';
  return error;
}

function fakeAutoPagerRoot({ anchors = [], images = [] } = {}) {
  const anchorNodes = anchors.map((item) => fakeNode('a', item));
  const imageNodes = images.map((item) => fakeNode('img', item));
  const allNodes = [...anchorNodes, ...imageNodes];

  return {
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === 'img[src]') return imageNodes.filter((node) => Boolean(node.src));
      if (selector === 'a[href*="/s/"]') return anchorNodes.filter((node) => node.href.includes('/s/'));
      return allNodes.filter((node) => node.matches?.(selector));
    }
  };
}

function fakeNode(tagName, attributes) {
  return {
    tagName: tagName.toUpperCase(),
    ...attributes,
    getAttribute(name) {
      return this[name] ?? null;
    },
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return String(this.className ?? '').split(/\s+/).includes(selector.slice(1));
      if (selector === '[id^="sp-exhentai-img-"]') return String(this.id ?? '').startsWith('sp-exhentai-img-');
      if (selector === '[data-pagetual]') return this.dataPagetual != null;
      return false;
    }
  };
}

// —— 2026-07-07 预加载队列去重 / 迁移校验 / UI 细节修复 ——

function fakeReaderChainDb(seedRecords = []) {
  const db = {
    records: new Map(),
    transaction() {
      const records = this.records;
      return {
        objectStore() {
          return {
            get(key) {
              return idbSuccess(records.get(key));
            },
            put(record) {
              records.set(record.pageKey, record);
              return idbSuccess(record);
            }
          };
        }
      };
    }
  };
  for (const record of seedRecords) db.records.set(record.pageKey, record);
  return db;
}

function fakeReaderChainFetch(htmlByUrl, calls) {
  return async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/jpeg']]),
        async blob() {
          return new Blob(['image-bytes'], { type: 'image/jpeg' });
        }
      };
    }
    const html = htmlByUrl.get(value);
    if (!html) throw new Error(`unexpected URL ${value}`);
    return {
      ok: true,
      status: 200,
      redirected: false,
      url: value,
      headers: new Map([['content-type', 'text/html']]),
      async text() {
        return html;
      }
    };
  };
}

test('reader preload skips image fetch for records stored as directory image files', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = fakeReaderChainDb([{
    pageKey: '2786404:2',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2',
    directoryImageFile: '2786404/2.jpg',
    nextReaderUrl: 'https://exhentai.org/s/fake-reader-token-c/2786404-3',
    prevReaderUrl: null
  }]);
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-a/2786404-1', '<html><body><img id="img" src="https://example.test/1.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Next</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-c/2786404-3', '<html><body><img id="img" src="https://example.test/3.jpg"></body></html>']
  ]);

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl: fakeReaderChainFetch(htmlByUrl, calls),
    limit: 2,
    settings: { blobCacheEnabled: true }
  });

  assert.equal(result.failed, 0);
  // 目录模式记录（directoryImageFile、无 imageBytes 元数据）视为已缓存：
  // 不重复抓第 2 页图片与 HTML，仍沿 nextReaderUrl 链到第 3 页。
  assert.deepEqual(calls, [
    'https://exhentai.org/s/fake-reader-token-a/2786404-1',
    'https://exhentai.org/s/fake-reader-token-c/2786404-3',
    'https://example.test/3.jpg'
  ]);
});

test('reader preload reconcile marks page-loaded candidates as link-only and keeps chain', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = fakeReaderChainDb();
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-a/2786404-1', '<html><body><img id="img" src="https://example.test/1.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Next</a></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-b/2786404-2', '<html><body><img id="img" src="https://example.test/2.jpg"><script>var nexturl="https://exhentai.org/s/fake-reader-token-c/2786404-3";</script></body></html>'],
    ['https://exhentai.org/s/fake-reader-token-c/2786404-3', '<html><body><img id="img" src="https://example.test/3.jpg"></body></html>']
  ]);

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl: fakeReaderChainFetch(htmlByUrl, calls),
    limit: 2,
    settings: { blobCacheEnabled: true },
    // 模拟 SW 对账结论：第 2 页已在页面中加载 → 只解析续接链接，不抓图。
    reconcileQueue: async (queue) => queue.map((candidate) => (
      candidate.page.pageKey === '2786404:2'
        ? { ...candidate, externalSkipImage: true }
        : candidate
    ))
  });

  assert.equal(result.failed, 0);
  assert.ok(!calls.includes('https://example.test/2.jpg'), 'page-loaded image must not be re-fetched');
  assert.ok(calls.includes('https://exhentai.org/s/fake-reader-token-b/2786404-2'), 'link-only fetch keeps the chain');
  assert.ok(calls.includes('https://example.test/3.jpg'), 'later pages still preload');
});

test('reader preload reconcile can drain the queue for stale page sessions', async () => {
  const context = classifyEhPage('https://exhentai.org/s/fake-reader-token-a/2786404-1');
  const calls = [];
  const db = fakeReaderChainDb();
  const htmlByUrl = new Map([
    ['https://exhentai.org/s/fake-reader-token-a/2786404-1', '<html><body><img id="img" src="https://example.test/1.jpg"><a id="next" href="https://exhentai.org/s/fake-reader-token-b/2786404-2">Next</a></body></html>']
  ]);

  const result = await preloadReaderChain(context, {
    db,
    fetchImpl: fakeReaderChainFetch(htmlByUrl, calls),
    limit: 2,
    settings: { blobCacheEnabled: true },
    reconcileQueue: async () => []
  });

  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, ['https://exhentai.org/s/fake-reader-token-a/2786404-1']);
});

test('service worker shares preload slots across pages with focus priority', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  assert.match(source, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(source, /chrome\.windows\.onFocusChanged\.addListener/);
  assert.match(source, /function acquirePreloadSlot\(/);
  assert.match(source, /function releasePreloadSlot\(/);
  assert.match(source, /PRELOAD_SLOT_WAIT_FAILSAFE_MS/);
  assert.match(source, /function createPreloadSlotAwareFetch\(/);
  assert.match(source, /reconcileReaderPreloadQueueWithTab/);
  assert.match(source, /reconcilePreloadQueueWithExternalActivity/);
  // “最后会话独占”门已移除：多开页面都可预加载，聚焦页优先（规划 §953）。
  assert.doesNotMatch(source, /current\.runtime\.activePageSessionId !== \(message\?\.pageSessionId \?\? ''\)/);
});

test('page network activity response carries reader image observations', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /observations: collectReaderImageObservations\(\)/);
  assert.match(source, /function collectReaderImageObservations\(\)/);
  assert.match(source, /state = 'loading';/);
  assert.match(source, /state = 'loaded';/);
});

test('migration verifies entries, resumes, reports progress and supports cancel', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  assert.match(source, /function migratePreloadRecordsToStore|async function migratePreloadRecordsToStore/);
  assert.match(source, /verify-index-missing/);
  assert.match(source, /verify-image-unreadable/);
  assert.match(source, /verify-bytes-mismatch/);
  assert.match(source, /source-image-unreadable/);
  assert.match(source, /source\.hydrate\(record\)/);
  assert.match(source, /status: 'skipped', pageKey \}/);
  assert.match(source, /EHPLUS_CANCEL_MIGRATION/);
  assert.match(source, /function requestMigrationCancel\(/);
  assert.match(source, /function writeMigrationProgress|async function writeMigrationProgress/);
  assert.match(source, /'cancelled'/);

  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(contentScript, /data-action="migration-cancel"/);
  assert.match(contentScript, /scheduleMigrationProgressPoll/);
  assert.match(contentScript, /migrationProgressValue/);
});

test('cleanup preview button is disabled together with confirm on invalid days', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /const preview = root\.querySelector\('\[data-action="cleanup-preview"\]'\);/);
  assert.match(source, /if \(preview\) preview\.disabled = true;/);
  assert.match(source, /if \(preview\) preview\.disabled = false;/);
});

test('reader cache-first adopts storage setting when localStorage hint is missing', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /adoptReaderCacheFirstSettingFromStorage\(\);/);
  assert.match(source, /localStorage\.getItem\(LOCAL_READER_CACHE_FIRST_ENABLED_STORAGE_KEY\) === null/);
  assert.match(source, /storage-hint-adopted/);
});

test('floating panel exposes live reader image loading status line', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /data-role="live-status"/);
  assert.match(source, /bindReaderImageLiveStatus\(root\);/);
  assert.match(source, /liveLoading: '正在加载第 \{n\} 页…'/);
  assert.match(source, /liveFailed: '第 \{n\} 页加载失败，换源重试中…'/);
  assert.match(source, /liveLoading: 'Loading page \{n\}…'/);
  assert.match(source, /liveRetryOk/);
});

test('built-in reader auto-pager stops when next url resolves to an already appended page', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  // 最后一页的 #next 指回自身：按 gid:pageNo 去重后必须停止拼接。
  assert.match(source, /const seenPageKeys = new Set\(\[parseReaderPageKey\(location\.href\)\]\.filter\(Boolean\)\);/);
  assert.match(source, /const resolveNextUrl = \(candidate\) => \{/);
  assert.match(source, /if \(!pageKey \|\| seenPageKeys\.has\(pageKey\)\) return '';/);
  assert.match(source, /nextUrl: resolveNextUrl\(readerNextUrlFromDocument\(document, location\.href\)\)/);
  assert.match(source, /if \(insertedPageKey\) seenPageKeys\.add\(insertedPageKey\);/);
  assert.match(source, /state\.nextUrl = resolveNextUrl\(prepared\.nextUrl\);/);
});

test('auto-pager scroll trigger appends the configured immediate page count', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  // 滚动触发与立即翻页共用同一批量页数（立即翻页页数设置）。
  const matches = source.match(/: state\.appendedPages \+ Math\.max\(1, state\.settings\.immediatePages\)/g) ?? [];
  assert.equal(matches.length, 2, 'both /s/ and /g/ controllers use immediatePages as scroll batch size');
  assert.doesNotMatch(source, /: state\.appendedPages \+ 1;/);
  const loopMatches = source.match(/\} while \(shouldContinue\(\) && state\.appendedPages < targetPages\);/g) ?? [];
  assert.equal(loopMatches.length, 2);
});

test('image cache size-limit eviction exempts protected images and metadata-only records', () => {
  const protection = { protectHighReadImages: true, highReadThreshold: 3 };
  const records = [
    { pageKey: '1:1', imageBytes: 50, readCount: 9, lastAccess: 1 },
    { pageKey: '1:2', imageBytes: 40, readCount: 0, lastAccess: 2 },
    { pageKey: '1:3', imageBytes: 0, readCount: 0, lastAccess: 0 },
    { pageKey: '1:4', imageBytes: 40, readCount: 0, lastAccess: 3 }
  ];

  const plan = planImageCacheLimitCleanup(records, { maxImageBytes: 60, protection });
  assert.equal(plan.action, 'cleanup');
  // 受保护的 1:1 与纯元数据的 1:3 不进淘汰序；按最旧优先淘汰 1:2、1:4。
  assert.deepEqual(plan.records.map((record) => record.pageKey), ['1:2', '1:4']);
});

test('new image cache stop-write reason is formatted in MB units', () => {
  const records = [
    { pageKey: '1:1', imageBytes: 3 * 1024 * 1024, readCount: 9 }
  ];
  const decision = shouldAllowNewImageCache(records, {
    maxImageBytes: 2 * 1024 * 1024,
    protection: { protectHighReadImages: true, highReadThreshold: 3 }
  });

  assert.equal(decision.allow, false);
  assert.match(decision.reason, /访问次数超过 3 次的图片总大小已经超过 2\.0 MB/);
  assert.doesNotMatch(decision.reason, /字节/);
});

test('cleanup by days strips image bodies while keeping metadata records', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  // 规划 §8：按天清理只删图片体；全部清理仍整条删除。
  assert.match(source, /const stripImagesOnly = request\.mode === 'olderThanDays';/);
  assert.match(source, /await stripStoreImages\(store, plan\.recordsToDelete\.images\);/);
  assert.match(source, /async function stripStoreImages\(store, records = \[\]\)/);
  assert.match(source, /stripped: stripImagesOnly/);
  assert.match(source, /const removedImageRecords = result\.images\.stripped \? 0 : result\.images\.success;/);

  const engine = await readFile(join(root, 'extension', 'preload-engine.js'), 'utf8');
  assert.match(engine, /async stripImages\(records = \[\]\) \{/);
  assert.match(engine, /export function stripImageFromRecord\(record, at = Date\.now\(\)\)/);

  const directory = await readFile(join(root, 'extension', 'directory-storage.js'), 'utf8');
  assert.match(directory, /async function stripDirectoryRecordImages\(recordsDir, imagesDir, records\)/);
  assert.match(directory, /directoryImageFile: null/);
});

test('size-limit enforcement budgets image bytes from total allocated storage', async () => {
  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');

  // 规划 §953：分配上限按总占用口径，日志与其他缓存字节从预算中扣除。
  assert.match(source, /maxImageBytes = Math\.max\(0, allocatedBytes - logBytes - computeOtherBytes\(records\)\);/);
  assert.match(source, /planImageCacheLimitCleanup\(records, \{\s*maxImageBytes,\s*protection: protectionSettings\(settings\)\s*\}\)/);
});

test('external cache-fill stores keyless H@H images as temporary url records', async () => {
  const record = await buildExternalResourceCacheFillRecord({
    url: 'https://fake-a.hath.network/virtual/fixture/07.webp',
    pageUrl: 'https://exhentai.org/s/fake-reader-token-b/2786404-2'
  }, {
    now: () => 4321,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/webp']]),
      async blob() {
        return new Blob(['image-bytes'], { type: 'image/webp' });
      }
    })
  });

  assert.equal(record.pageKey, 'url:https://fake-a.hath.network/virtual/fixture/07.webp');
  assert.equal(record.resourceKey, 'https://fake-a.hath.network/virtual/fixture/07.webp');
  assert.equal(record.storageClass, 'temporary');
  assert.equal(record.recordKind, 'resource-only');
  assert.equal(record.gid, null);
  assert.equal(record.hasImageBlob, true);

  const source = await readFile(join(root, 'extension', 'service-worker.js'), 'utf8');
  assert.doesNotMatch(source, /reason: 'missing-page-key'/);
  assert.match(source, /buildExternalResourceCacheFillRecord/);
  assert.match(source, /: await store\.getByResourceKey\(plan\.resourceKey \?\? plan\.url\);/);

  const contentScript = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');
  assert.match(contentScript, /const dedupeKey = candidate\.pageKey \|\| `url:\$\{imageUrl\}`;/);
});

test('storage group shows migration cache bytes from migration state', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /formatBytes\(state\?\.migration\?\.oldCacheBytes \?\? 0\)/);
  assert.doesNotMatch(source, /storage\.migrationBytes/);
});

test('migration progress numerator counts only actually migrated entries', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /done: formatNumber\(root, migration\.migratedCount \?\? 0\)/);
  assert.doesNotMatch(source, /done: formatNumber\(root, \(migration\.migratedCount \?\? 0\) \+ \(migration\.skippedCount \?\? 0\)\)/);
});

test('reader hit rate field renders hits over reads detail line', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /\$\{formatNumber\(root, readerHits\)\} \/ \$\{formatNumber\(root, readerReads\)\}/);
  assert.match(source, /ehplus-account-field-multiline/);

  const css = await readFile(join(root, 'extension', 'content-style.css'), 'utf8');
  assert.match(css, /\.ehplus-account-field-multiline \{\s*white-space: pre-line;/);
});

test('quota reset button carries nominal cost and confirm box hides on account refresh', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /resetQuotaWithCost: '重置 \{cost\} GP'/);
  assert.match(source, /resetQuotaWithCost: 'Reset \{cost\} GP'/);
  assert.match(source, /t\(root, 'resetQuotaWithCost', \{ cost: formatNumber\(root, account\.resetCostGp\) \}\)/);
  assert.match(source, /confirm\.dataset\.accountUpdatedAt = String\(accountUpdatedAt \?\? 0\);/);
  assert.match(source, /confirmBox\.dataset\.accountUpdatedAt !== String\(account\.updatedAt \?\? 0\)/);
});

test('dawn settings tab shows mechanism description paragraph', async () => {
  const source = await readFile(join(root, 'extension', 'content-script.js'), 'utf8');

  assert.match(source, /data-i18n="dawnIntro"/);
  assert.match(source, /dawnIntro: '每天 UTC 00:00（北京时间 08:00）后/);
  assert.match(source, /dawnIntro: 'After UTC 00:00 each day \(08:00 Beijing time\)/);
});

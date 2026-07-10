import { CLEANUP_SCOPES } from './constants.js';
import { formatBytes } from './format.js';
import { parseNonNegativeIntegerDays } from './validation.js';

export const TEMPORARY_CACHE_CLASSES = new Set(['temporary', 'resource-only', 'orphan']);

export function isProtectedImage(record, settings = {}) {
  if (!settings.protectHighReadImages) {
    return false;
  }

  const threshold = settings.highReadThreshold ?? 3;
  return (record.readCount ?? 0) > threshold;
}

export function isProtectedGallery(record, settings = {}) {
  if (!settings.protectHighReadGalleries) {
    return false;
  }

  const threshold = settings.highReadGalleryThreshold ?? 3;
  return (record.readCount ?? 0) > threshold;
}

export function planCleanup(input) {
  const {
    records = [],
    galleries = [],
    logs = [],
    other = [],
    scope = CLEANUP_SCOPES.ALL,
    mode = 'all',
    days,
    now = Date.now(),
    includeProtected = false,
    includeProtectedGalleries = false,
    protection = {}
  } = input;

  const cutoff = mode === 'olderThanDays' ? parseDaysToCutoff(days, now) : null;
  const selectedRecords = shouldIncludeScope(scope, CLEANUP_SCOPES.IMAGES)
    ? records.filter((record) => shouldCleanRecord(record, { mode, cutoff, includeProtected, protection }))
    : [];
  const selectedLogs = shouldIncludeScope(scope, CLEANUP_SCOPES.LOGS)
    ? logs.filter((log) => shouldCleanDatedItem(log, mode, cutoff))
    : [];
  const selectedOther = shouldIncludeScope(scope, CLEANUP_SCOPES.OTHER)
    ? [
      ...other.filter((item) => shouldCleanDatedItem(item, mode, cutoff)),
      ...galleries.filter((gallery) => shouldCleanGallery(gallery, { mode, cutoff, includeProtectedGalleries, protection }))
    ]
    : [];

  return {
    scope,
    mode,
    records: selectedRecords,
    logs: selectedLogs,
    other: selectedOther,
    skippedProtected: records.filter((record) => {
      return shouldIncludeScope(scope, CLEANUP_SCOPES.IMAGES)
        && shouldCleanDatedItem(record, mode, cutoff)
        && isProtectedImage(record, protection)
        && !includeProtected
        && mode !== 'all';
    }),
    skippedProtectedGalleries: galleries.filter((gallery) => {
      return shouldIncludeScope(scope, CLEANUP_SCOPES.OTHER)
        && shouldCleanDatedItem(gallery, mode, cutoff)
        && isProtectedGallery(gallery, protection)
        && !includeProtectedGalleries
        && mode !== 'all';
    }),
    releaseBytes: selectedRecords.reduce((total, record) => total + imageBytesFromRecord(record), 0)
      + selectedLogs.reduce((total, log) => total + byteLengthOfString(String(log.message ?? '')), 0)
      + selectedOther.reduce((total, item) => total + byteLengthOfString(JSON.stringify(item)), 0)
  };
}

export function shouldAllowNewImageCache(records, { maxImageBytes, protection = {} }) {
  if (!Number.isFinite(maxImageBytes)) {
    return { allow: true, protectedBytes: 0 };
  }

  const protectedBytes = records
    .filter((record) => isProtectedImage(record, protection))
    .reduce((total, record) => total + imageBytesFromRecord(record), 0);

  if (protectedBytes > maxImageBytes) {
    return {
      allow: false,
      protectedBytes,
      reason: `访问次数超过 ${protection.highReadThreshold ?? 3} 次的图片总大小已经超过 ${formatBytes(maxImageBytes)}，按照规则新图片不做缓存，请及时清理。`
    };
  }

  return { allow: true, protectedBytes };
}

export function isTemporaryImageRecord(record) {
  return TEMPORARY_CACHE_CLASSES.has(record?.storageClass)
    || record?.temporary === true
    || record?.isTemporary === true;
}

export function planTemporaryCacheCleanup({ records = [], openEhPageCount = 0 } = {}) {
  if (openEhPageCount > 0) {
    return {
      action: 'keep',
      records: [],
      reason: 'eh-pages-open',
      openEhPageCount
    };
  }

  const temporaryRecords = records.filter(isTemporaryImageRecord);
  return {
    action: temporaryRecords.length > 0 ? 'cleanup' : 'keep',
    records: temporaryRecords,
    reason: temporaryRecords.length > 0 ? 'all-eh-pages-closed' : 'no-temporary-cache',
    openEhPageCount
  };
}

export function planImageCacheLimitCleanup(records = [], { maxImageBytes, protection = {} } = {}) {
  if (!Number.isFinite(maxImageBytes)) {
    return { action: 'keep', records: [], totalBytes: totalImageBytes(records), releaseBytes: 0 };
  }

  const totalBytes = totalImageBytes(records);
  if (totalBytes <= maxImageBytes) {
    return { action: 'keep', records: [], totalBytes, releaseBytes: 0 };
  }

  // 大小上限淘汰不删除受保护图片（规划 §9）；只挑真正持有图片字节的
  // 记录进淘汰序，纯元数据记录删了也释放不出空间。
  const selected = [];
  let releaseBytes = 0;
  const sorted = records
    .filter((record) => imageBytesFromRecord(record) > 0)
    .filter((record) => !isProtectedImage(record, protection))
    .sort(compareCacheEvictionPriority);
  for (const record of sorted) {
    selected.push(record);
    releaseBytes += imageBytesFromRecord(record);
    if (totalBytes - releaseBytes <= maxImageBytes) break;
  }

  return {
    action: 'cleanup',
    records: selected,
    totalBytes,
    releaseBytes,
    reason: 'image-cache-size-limit'
  };
}

function parseDaysToCutoff(days, now) {
  const parsed = parseNonNegativeIntegerDays(days);
  if (!parsed.ok) {
    throw new TypeError(parsed.error);
  }

  if (parsed.value === 0) {
    return null;
  }

  return now - parsed.value * 24 * 60 * 60 * 1000;
}

function shouldIncludeScope(scope, wanted) {
  return scope === CLEANUP_SCOPES.ALL || scope === wanted;
}

function shouldCleanRecord(record, options) {
  if (!shouldCleanDatedItem(record, options.mode, options.cutoff)) {
    return false;
  }

  if (options.mode !== 'all' && isProtectedImage(record, options.protection) && !options.includeProtected) {
    return false;
  }

  return true;
}

function shouldCleanGallery(gallery, options) {
  if (!shouldCleanDatedItem(gallery, options.mode, options.cutoff)) {
    return false;
  }

  if (options.mode !== 'all' && isProtectedGallery(gallery, options.protection) && !options.includeProtectedGalleries) {
    return false;
  }

  return true;
}

function shouldCleanDatedItem(item, mode, cutoff) {
  if (mode === 'all') {
    return true;
  }

  if (mode !== 'olderThanDays') {
    throw new TypeError(`unsupported cleanup mode: ${mode}`);
  }

  if (cutoff == null) {
    return false;
  }

  const lastTouched = item.at ?? item.lastAccess ?? item.updatedAt ?? item.createdAt ?? 0;
  return lastTouched <= cutoff;
}

function totalImageBytes(records) {
  return records.reduce((total, record) => total + imageBytesFromRecord(record), 0);
}

function imageBytesFromRecord(record = {}) {
  if (Number.isFinite(record.imageBytes)) {
    return record.imageBytes;
  }

  if (record.imageBlob instanceof Uint8Array) {
    return record.imageBlob.byteLength;
  }

  if (record.imageBlob instanceof ArrayBuffer) {
    return record.imageBlob.byteLength;
  }

  if (typeof Blob !== 'undefined' && record.imageBlob instanceof Blob) {
    return record.imageBlob.size;
  }

  if (typeof record.imageBlob === 'string') {
    return byteLengthOfString(record.imageBlob);
  }

  return 0;
}

function byteLengthOfString(value) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }

  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, 'x').length;
}

function compareCacheEvictionPriority(left, right) {
  const leftTemporary = isTemporaryImageRecord(left) ? 0 : 1;
  const rightTemporary = isTemporaryImageRecord(right) ? 0 : 1;
  if (leftTemporary !== rightTemporary) return leftTemporary - rightTemporary;

  return lastTouched(left) - lastTouched(right);
}

function lastTouched(record) {
  return record.lastAccess ?? record.updatedAt ?? record.createdAt ?? 0;
}

export function protectionSettings(settings = {}) {
  return {
    protectHighReadImages: settings.protectHighReadImages === true,
    highReadThreshold: settings.highReadThreshold ?? 3,
    protectHighReadGalleries: settings.protectHighReadGalleries === true,
    highReadGalleryThreshold: settings.highReadGalleryThreshold ?? 3
  };
}

export function galleryMetadataPageKey(galleryKey) {
  return `gallery:${String(galleryKey ?? '').trim()}`;
}

export function isGalleryMetadataRecord(record) {
  return record?.recordKind === 'gallery-metadata'
    || (typeof record?.pageKey === 'string' && record.pageKey.startsWith('gallery:'));
}

export function recordHasStoredImage(record) {
  if (recordHasExplicitNonImageMime(record)) return false;
  return imageBytesFromRecord(record) > 0
    || record?.hasImageBlob === true
    || Boolean(record?.directoryImageFile);
}

function recordHasExplicitNonImageMime(record) {
  const dataUrlMimeType = (value) => typeof value === 'string'
    ? value.match(/^data:([^;,]*)(?:[;,])/i)?.[1]
    : '';
  const mimeTypes = [
    record?.mimeType,
    record?.imageBlob?.type,
    dataUrlMimeType(record?.dataUrl),
    dataUrlMimeType(record?.imageBlob)
  ].map((value) => String(value ?? '').split(';', 1)[0].trim().toLowerCase()).filter(Boolean);
  return mimeTypes.some((mimeType) => !mimeType.startsWith('image/'));
}

export function recordStoredBytes(record) {
  const bytes = Number(record?.imageBytes ?? record?.galleryBytes ?? record?.bytes);
  if (Number.isFinite(bytes) && bytes > 0) return bytes;
  return imageBytesFromRecord(record);
}

export function touchRecordAccess(record, { readInc = 1, cacheHitInc = 0, at = Date.now() } = {}) {
  return {
    ...record,
    readCount: (record?.readCount ?? 0) + readInc,
    cacheHitCount: (record?.cacheHitCount ?? 0) + cacheHitInc,
    lastAccess: at,
    updatedAt: at,
    lastReadAt: at
  };
}

export function summarizeProtectedStorage(records = [], settings = {}) {
  const protection = protectionSettings(settings);
  let protectedImages = 0;
  let protectedImageBytes = 0;
  let protectedGalleries = 0;
  let protectedGalleryBytes = 0;

  for (const record of records) {
    const bytes = recordStoredBytes(record);
    if (recordHasStoredImage(record)) {
      if (isProtectedImage(record, protection)) {
        protectedImages += 1;
        protectedImageBytes += bytes;
      }
      continue;
    }

    if (isProtectedGallery(record, protection)) {
      protectedGalleries += 1;
      protectedGalleryBytes += bytes;
    }
  }

  return {
    protectedImages,
    protectedImageBytes,
    protectedGalleries,
    protectedGalleryBytes
  };
}

function runtimeCleanupWarning(request) {
  if (request.mode !== 'olderThanDays' || request.days !== 0) {
    return '';
  }

  return '0天表示不按照时间清理缓存。';
}

export function planRuntimeCleanup({
  records = [],
  logs = [],
  settings = {},
  request,
  now = Date.now()
} = {}) {
  const protection = protectionSettings(settings);
  const cutoffAt = request.mode === 'olderThanDays'
    ? parseDaysToCutoff(request.days, now)
    : null;
  const cleanupMode = request.mode === 'all' ? 'all' : 'olderThanDays';
  const all = request.scope === 'all';
  const includeImages = all || request.scope === 'images';
  const includeLogs = all || request.scope === 'logs';
  const includeOther = all || request.scope === 'other';
  const imageRecords = [];
  const otherRecords = [];
  let skippedProtected = 0;
  let skippedProtectedGalleries = 0;

  for (const record of records) {
    if (!shouldCleanDatedItem(record, cleanupMode, cutoffAt)) continue;

    const hasImage = recordHasStoredImage(record);
    if (hasImage && includeImages) {
      if (request.mode !== 'all' && !request.includeProtected && isProtectedImage(record, protection)) {
        skippedProtected += 1;
        continue;
      }
      imageRecords.push(record);
      continue;
    }

    if (!hasImage && includeOther) {
      if (request.mode !== 'all' && !request.includeProtectedGalleries && isProtectedGallery(record, protection)) {
        skippedProtectedGalleries += 1;
        continue;
      }
      otherRecords.push(record);
    }
  }

  const logsToDelete = includeLogs
    ? logs.filter((log) => shouldCleanDatedItem(log, cleanupMode, cutoffAt))
    : [];
  const imageBytes = imageRecords.reduce((total, record) => total + recordStoredBytes(record), 0);
  const otherBytes = otherRecords.reduce((total, record) => total + recordStoredBytes(record), 0);
  const logBytes = logsToDelete.reduce((total, log) => total + logByteLength(log.message ?? log), 0);

  return {
    request,
    createdAt: now,
    cutoffAt,
    images: {
      count: imageRecords.length,
      bytes: imageBytes,
      skippedProtected,
      protectedRemoved: request.mode === 'all' || request.includeProtected
        ? imageRecords.filter((record) => isProtectedImage(record, protection)).length
        : 0
    },
    logs: {
      count: logsToDelete.length,
      bytes: logBytes
    },
    other: {
      count: otherRecords.length,
      bytes: otherBytes,
      skippedProtectedGalleries,
      protectedGalleriesRemoved: request.mode === 'all' || request.includeProtectedGalleries
        ? otherRecords.filter((record) => isProtectedGallery(record, protection)).length
        : 0
    },
    releaseBytes: imageBytes + logBytes + otherBytes,
    recordsToDelete: {
      images: imageRecords,
      other: otherRecords
    },
    logsToDelete,
    warning: runtimeCleanupWarning(request)
  };
}

function logByteLength(value) {
  return byteLengthOfString(String(value ?? ''));
}

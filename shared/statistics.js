import { PAGE_TYPES } from './constants.js';

export function createStats() {
  return {
    reads: [],
    watched: new Map()
  };
}

export function recordRead(stats, input) {
  const pageType = input.pageType;
  if (![PAGE_TYPES.READER, PAGE_TYPES.GALLERY].includes(pageType)) {
    throw new TypeError(`unsupported pageType: ${pageType}`);
  }
  const gid = String(input.gid);

  const read = {
    pageType,
    gid,
    token: input.token ? String(input.token) : undefined,
    title: displayTitle(input, null, gid),
    originalTitle: optionalText(input.originalTitle ?? input.titleJpn),
    pageNo: input.pageNo === undefined ? undefined : Number(input.pageNo),
    cacheHit: Boolean(input.cacheHit),
    galleryUrl: input.galleryUrl,
    lastPageUrl: input.lastPageUrl,
    readAt: input.readAt ?? Date.now()
  };

  stats.reads.push(read);
  updateWatched(stats, read);
  return read;
}

export function calculateReaderCacheHitRate(stats) {
  const readerReads = stats.reads.filter((read) => read.pageType === PAGE_TYPES.READER);
  const total = readerReads.length;
  const hits = readerReads.filter((read) => read.cacheHit).length;

  return {
    hits,
    total,
    rate: total === 0 ? 0 : hits / total
  };
}

export function getFrequentlyWatched(stats, { pageType = 'all', limit = 10 } = {}) {
  const items = [...stats.watched.values()].filter((item) => {
    return pageType === 'all' || item.pageType === pageType;
  });

  return items
    .sort((a, b) => b.readCount - a.readCount || b.lastReadAt - a.lastReadAt)
    .slice(0, limit);
}

function updateWatched(stats, read) {
  const key = `${read.pageType}:${read.gid}`;
  const existing = stats.watched.get(key);
  const next = {
    gid: read.gid,
    token: read.token ?? existing?.token,
    title: displayTitle(read, existing, read.gid),
    originalTitle: read.originalTitle ?? existing?.originalTitle,
    pageType: read.pageType,
    galleryUrl: read.galleryUrl ?? existing?.galleryUrl,
    lastPageUrl: read.lastPageUrl ?? existing?.lastPageUrl,
    readCount: (existing?.readCount ?? 0) + 1,
    lastReadAt: Math.max(existing?.lastReadAt ?? 0, read.readAt)
  };

  stats.watched.set(key, next);
}

export function recordFrequentWatch(stats, input) {
  const pageType = input.pageType === PAGE_TYPES.GALLERY ? PAGE_TYPES.GALLERY : PAGE_TYPES.READER;
  const gid = String(input.gid ?? '').trim();
  if (!gid) return stats ?? {};

  const frequent = Array.isArray(stats?.frequent) ? [...stats.frequent] : [];
  const key = `${pageType}:${gid}`;
  const index = frequent.findIndex((item) => `${item.pageType}:${item.gid}` === key);
  const existing = index >= 0 ? frequent[index] : null;
  const readAt = input.readAt ?? Date.now();
  const next = {
    gid,
    token: input.token ?? existing?.token,
    title: displayTitle(input, existing, gid),
    originalTitle: optionalText(input.originalTitle ?? input.titleJpn) ?? existing?.originalTitle,
    pageType,
    galleryUrl: input.galleryUrl ?? existing?.galleryUrl,
    lastPageUrl: input.lastPageUrl ?? existing?.lastPageUrl,
    readCount: (existing?.readCount ?? 0) + 1,
    lastReadAt: Math.max(existing?.lastReadAt ?? 0, readAt)
  };

  if (index >= 0) frequent[index] = next;
  else frequent.push(next);

  frequent.sort((left, right) => right.readCount - left.readCount || right.lastReadAt - left.lastReadAt);

  return {
    ...stats,
    frequent: frequent.slice(0, 100)
  };
}

export function updateFrequentWatchTitle(stats, input) {
  const pageType = input.pageType === PAGE_TYPES.GALLERY ? PAGE_TYPES.GALLERY : PAGE_TYPES.READER;
  const gid = String(input.gid ?? '').trim();
  if (!gid) return stats ?? {};

  const frequent = Array.isArray(stats?.frequent) ? [...stats.frequent] : [];
  const key = `${pageType}:${gid}`;
  const index = frequent.findIndex((item) => `${item.pageType}:${item.gid}` === key);
  if (index < 0) return stats ?? {};

  const existing = frequent[index];
  frequent[index] = {
    ...existing,
    token: input.token ?? existing.token,
    title: displayTitle(input, existing, gid),
    originalTitle: optionalText(input.originalTitle ?? input.titleJpn) ?? existing.originalTitle,
    galleryUrl: input.galleryUrl ?? existing.galleryUrl,
    lastPageUrl: input.lastPageUrl ?? existing.lastPageUrl
  };

  return {
    ...stats,
    frequent
  };
}

export function filterFrequentWatch(stats, { pageType = 'all', limit = 10 } = {}) {
  const items = (stats?.frequent ?? []).filter((item) => pageType === 'all' || item.pageType === pageType);
  return items.slice(0, limit);
}

function displayTitle(input, existing, gid) {
  const fallback = String(gid ?? '').trim();
  const inputTitle = optionalText(input?.title);
  const existingTitle = optionalText(existing?.title);
  if (inputTitle && inputTitle !== fallback) return inputTitle;
  if (existingTitle && existingTitle !== fallback) return existingTitle;
  return inputTitle
    ?? optionalText(input?.originalTitle ?? input?.titleJpn)
    ?? optionalText(input?.imageName)
    ?? existingTitle
    ?? optionalText(existing?.originalTitle ?? existing?.titleJpn)
    ?? optionalText(existing?.imageName)
    ?? fallback;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || undefined;
}

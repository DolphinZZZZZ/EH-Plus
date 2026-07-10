export const DEDUPE_POINTER_SOURCE = 'dedupe-pointer';

export function planDuplicateImageMerge(records = [], { now = Date.now() } = {}) {
  const imageRecords = records.filter((record) => hasStoredImage(record));
  const groups = connectedDuplicateGroups(imageRecords);
  const duplicateGroups = groups.filter((group) => group.length > 1);
  const canonicalUpdates = [];
  const pointerUpdates = [];
  const duplicateImageRecords = [];
  let releasedBytes = 0;

  for (const group of duplicateGroups) {
    const canonical = selectCanonicalRecord(group);
    const duplicates = group.filter((record) => record !== canonical);
    canonicalUpdates.push(mergeCanonicalRecord(canonical, duplicates, now));

    for (const duplicate of duplicates) {
      pointerUpdates.push(buildPointerRecord(duplicate, canonical, now));
      duplicateImageRecords.push(duplicate);
      releasedBytes += imageBytes(duplicate);
    }
  }

  return {
    action: duplicateGroups.length ? 'merge' : 'keep',
    scannedRecords: imageRecords.length,
    duplicateGroups: duplicateGroups.length,
    canonicalUpdates,
    pointerUpdates,
    duplicateImageRecords,
    releasedBytes
  };
}

export function isDedupePointer(record) {
  return record?.source === DEDUPE_POINTER_SOURCE
    || Boolean(record?.canonicalPageKey);
}

export function hasStoredImage(record) {
  if (!record || isDedupePointer(record)) return false;
  return Boolean(record.imageBlob)
    || Boolean(record.dataUrl)
    || Boolean(record.blobUrl)
    || Boolean(record.cacheUrl)
    || Boolean(record.deliveryUrl)
    || record.hasImageBlob === true
    || imageBytes(record) > 0;
}

function connectedDuplicateGroups(records) {
  const parents = new Map(records.map((record) => [record, record]));
  const byKey = new Map();

  for (const record of records) {
    for (const key of duplicateKeys(record)) {
      const existing = byKey.get(key);
      if (existing) {
        union(parents, existing, record);
      } else {
        byKey.set(key, record);
      }
    }
  }

  const groups = new Map();
  for (const record of records) {
    const root = find(parents, record);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  }

  return [...groups.values()];
}

function duplicateKeys(record) {
  const keys = [];
  const hash = normalizeHash(record.imageHash ?? record.contentHash ?? record.sha256);
  if (hash) keys.push(`hash:${hash}`);

  for (const url of urlCandidates(record)) {
    keys.push(`url:${url}`);
  }

  for (const pageKey of stringList(record.pageKeyAliases)) {
    keys.push(`page:${pageKey}`);
  }

  return [...new Set(keys)];
}

function urlCandidates(record) {
  return [
    record.resourceKey,
    record.imageUrl,
    record.url,
    ...stringList(record.resourceKeyAliases),
    ...stringList(record.imageUrlAliases),
    ...stringList(record.urlAliases)
  ].map(normalizeUrl).filter(Boolean);
}

function selectCanonicalRecord(group) {
  return [...group].sort(compareCanonicalRecords)[0];
}

function compareCanonicalRecords(left, right) {
  const leftScore = canonicalScore(left);
  const rightScore = canonicalScore(right);
  if (leftScore !== rightScore) return rightScore - leftScore;

  const touchedDiff = lastTouched(right) - lastTouched(left);
  if (touchedDiff !== 0) return touchedDiff;

  return String(left.pageKey ?? '').localeCompare(String(right.pageKey ?? ''));
}

function canonicalScore(record) {
  let score = 0;
  if (record.storageClass === 'permanent') score += 1000;
  if (hasStoredImage(record)) score += 500;
  score += Math.min(200, Number(record.readCount ?? 0) * 10);
  score += Math.min(200, Number(record.cacheHitCount ?? 0) * 10);
  return score;
}

function mergeCanonicalRecord(canonical, duplicates, now) {
  const pageKeys = [];
  const pageUrls = [];
  const resourceKeys = [];
  const imageUrls = [];
  const urlAliases = [];
  let readCount = Number(canonical.readCount ?? 0);
  let cacheHitCount = Number(canonical.cacheHitCount ?? 0);
  let lastAccess = Number(canonical.lastAccess ?? 0);
  let createdAt = Number(canonical.createdAt ?? now);

  for (const duplicate of duplicates) {
    pageKeys.push(duplicate.pageKey, ...stringList(duplicate.pageKeyAliases));
    pageUrls.push(duplicate.pageUrl, ...stringList(duplicate.pageUrlAliases));
    resourceKeys.push(duplicate.resourceKey, duplicate.imageUrl, duplicate.url, ...stringList(duplicate.resourceKeyAliases));
    imageUrls.push(duplicate.imageUrl, ...stringList(duplicate.imageUrlAliases));
    urlAliases.push(duplicate.url, ...stringList(duplicate.urlAliases));
    readCount += Number(duplicate.readCount ?? 0);
    cacheHitCount += Number(duplicate.cacheHitCount ?? 0);
    lastAccess = Math.max(lastAccess, Number(duplicate.lastAccess ?? duplicate.updatedAt ?? 0));
    createdAt = Math.min(createdAt, Number(duplicate.createdAt ?? createdAt));
  }

  return {
    ...canonical,
    pageKeyAliases: mergeStrings(canonical.pageKeyAliases, pageKeys, canonical.pageKey),
    pageUrlAliases: mergeStrings(canonical.pageUrlAliases, pageUrls, canonical.pageUrl),
    resourceKeyAliases: mergeStrings(canonical.resourceKeyAliases, resourceKeys, canonical.resourceKey),
    imageUrlAliases: mergeStrings(canonical.imageUrlAliases, imageUrls, canonical.imageUrl),
    urlAliases: mergeStrings(canonical.urlAliases, urlAliases, canonical.url),
    readCount,
    cacheHitCount,
    lastAccess: lastAccess || canonical.lastAccess,
    createdAt,
    updatedAt: now,
    mergedImageCount: Number(canonical.mergedImageCount ?? 1) + duplicates.length,
    duplicateImageBytesReleased: Number(canonical.duplicateImageBytesReleased ?? 0)
      + duplicates.reduce((total, record) => total + imageBytes(record), 0)
  };
}

function buildPointerRecord(duplicate, canonical, now) {
  return {
    ...duplicate,
    canonicalPageKey: canonical.pageKey,
    canonicalResourceKey: canonical.resourceKey ?? canonical.imageUrl ?? null,
    imageBlob: null,
    dataUrl: null,
    blobUrl: null,
    cacheUrl: null,
    deliveryUrl: null,
    hasImageBlob: false,
    imageBytes: 0,
    duplicateImageBytes: imageBytes(duplicate),
    duplicateImageHash: duplicate.imageHash ?? duplicate.contentHash ?? duplicate.sha256 ?? null,
    source: DEDUPE_POINTER_SOURCE,
    updatedAt: now
  };
}

function union(parents, left, right) {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
}

function find(parents, record) {
  const parent = parents.get(record);
  if (parent === record) return record;
  const root = find(parents, parent);
  parents.set(record, root);
  return root;
}

function mergeStrings(existing, incoming, selfValue) {
  const values = [
    ...stringList(existing),
    ...incoming.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean)
  ];
  const self = typeof selfValue === 'string' ? selfValue.trim() : '';
  return [...new Set(values)].filter((value) => value && value !== self);
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizeHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(hash) ? hash : null;
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function imageBytes(record) {
  const bytes = Number(record?.imageBytes);
  if (Number.isFinite(bytes) && bytes > 0) return bytes;
  const blob = record?.imageBlob;
  if (blob && Number.isFinite(Number(blob.size)) && Number(blob.size) > 0) return Number(blob.size);
  if (blob && Number.isFinite(Number(blob.byteLength)) && Number(blob.byteLength) > 0) return Number(blob.byteLength);
  if (typeof blob === 'string') return new TextEncoder().encode(blob).byteLength;
  return 0;
}

function lastTouched(record) {
  return Number(record.lastAccess ?? record.updatedAt ?? record.createdAt ?? 0);
}

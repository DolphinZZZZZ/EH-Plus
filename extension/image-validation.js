const IMAGE_MIME_TYPES_BY_EXTENSION = Object.freeze([
  [/\.png$/i, 'image/png'],
  [/\.webp$/i, 'image/webp'],
  [/\.gif$/i, 'image/gif'],
  [/\.jpe?g$/i, 'image/jpeg']
]);

export function normalizeMimeType(value) {
  return String(value ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function isImageMimeType(value) {
  return normalizeMimeType(value).startsWith('image/');
}

export function inferImageMimeType(url) {
  const path = urlPathname(url);
  for (const [pattern, mimeType] of IMAGE_MIME_TYPES_BY_EXTENSION) {
    if (pattern.test(path)) return mimeType;
  }
  return '';
}

export function recordHasExplicitNonImageMime(record) {
  return recordMimeTypes(record).some((mimeType) => !isImageMimeType(mimeType));
}

export function recordRequiresImageMime(record) {
  const pageKey = String(record?.pageKey ?? '').trim();
  return Boolean(
    /^\d+:\d+$/.test(pageKey)
    || pageKey.startsWith('url:')
    || String(record?.imageUrl ?? '').trim()
    || String(record?.resourceKey ?? '').trim()
    || record?.recordKind === 'resource-only'
    || record?.directoryImageFile
    || record?.hasImageBlob === true
    || Number(record?.imageBytes) > 0
    || record?.imageBlob
  );
}

export function resolveRecordImageMimeType(record, fallbackMimeType = '') {
  const fallback = normalizeMimeType(fallbackMimeType);
  if (recordHasExplicitNonImageMime(record) || (fallback && !isImageMimeType(fallback))) {
    return '';
  }

  const explicitImageType = [
    record?.mimeType,
    record?.imageBlob?.type,
    dataUrlMimeType(record?.dataUrl),
    fallback
  ].map(normalizeMimeType).find(isImageMimeType);

  return explicitImageType
    || inferImageMimeType(record?.imageUrl ?? record?.resourceKey ?? record?.directoryImageFile);
}

export function resolveImageResponseMimeType({ contentType, blobType, url } = {}) {
  const responseMimeType = normalizeMimeType(contentType);
  const responseBlobType = normalizeMimeType(blobType);
  const rejectedMimeType = [responseMimeType, responseBlobType]
    .find((mimeType) => mimeType && !isImageMimeType(mimeType));

  if (rejectedMimeType) {
    return { ok: false, mimeType: '', rejectedMimeType };
  }

  const mimeType = [responseBlobType, responseMimeType, inferImageMimeType(url)]
    .find(isImageMimeType) ?? '';
  return {
    ok: Boolean(mimeType),
    mimeType,
    rejectedMimeType: mimeType ? '' : 'unknown'
  };
}

function recordMimeTypes(record) {
  return [
    record?.mimeType,
    record?.imageBlob?.type,
    dataUrlMimeType(record?.dataUrl),
    dataUrlMimeType(record?.imageBlob)
  ].map(normalizeMimeType).filter(Boolean);
}

function dataUrlMimeType(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/^data:([^;,]*)(?:[;,])/i);
  return normalizeMimeType(match?.[1]);
}

function urlPathname(value) {
  try {
    return new URL(String(value ?? ''), 'https://example.invalid').pathname;
  } catch {
    return String(value ?? '').split(/[?#]/, 1)[0];
  }
}

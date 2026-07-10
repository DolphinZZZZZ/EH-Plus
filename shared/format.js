const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError('bytes must be a non-negative finite number');
  }

  if (bytes < MB) {
    return `${(bytes / KB).toFixed(1)} KB`;
  }

  if (bytes < GB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }

  if (bytes < TB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }

  return `${(bytes / TB).toFixed(1)} TB`;
}

export function parsePositiveStorageLimit(value, unit = 'MB') {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new TypeError('storage limit must be a non-negative finite number');
  }

  const normalizedUnit = String(unit).toUpperCase();
  if (normalizedUnit === 'KB') return numericValue * KB;
  if (normalizedUnit === 'MB') return numericValue * MB;
  if (normalizedUnit === 'GB') return numericValue * GB;

  throw new TypeError(`unsupported storage unit: ${unit}`);
}


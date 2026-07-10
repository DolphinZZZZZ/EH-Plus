import { imageBytesFromRecord } from './fake-storage.js';
import { isTemporaryImageRecord } from './cleanup.js';

export function summarizeStorage({ records = [], logs = [], other = [] } = {}) {
  const imageBytes = records.reduce((total, record) => total + imageBytesFromRecord(record), 0);
  const temporaryImageBytes = records
    .filter(isTemporaryImageRecord)
    .reduce((total, record) => total + imageBytesFromRecord(record), 0);
  const logBytes = logs.reduce((total, log) => total + byteLength(log.message ?? log), 0);
  const otherBytes = other.reduce((total, item) => total + byteLength(JSON.stringify(item)), 0);

  return {
    totalBytes: imageBytes + logBytes + otherBytes,
    imageBytes,
    temporaryImageBytes,
    logBytes,
    otherBytes
  };
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''));
}

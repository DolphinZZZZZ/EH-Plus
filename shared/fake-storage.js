import { createHash } from 'node:crypto';

export class FakeStorage {
  constructor(records = []) {
    this.records = new Map();
    for (const record of records) {
      this.put(record);
    }
  }

  put(record) {
    const key = record.pageKey ?? buildPageKey(record.gid, record.pageNo);
    const normalized = {
      ...record,
      pageKey: key,
      updatedAt: record.updatedAt ?? Date.now()
    };
    this.records.set(key, normalized);
    return normalized;
  }

  get(pageKey) {
    return this.records.get(pageKey) ?? null;
  }

  delete(pageKey) {
    return this.records.delete(pageKey);
  }

  list() {
    return [...this.records.values()];
  }

  clear() {
    this.records.clear();
  }
}

export function buildPageKey(gid, pageNo) {
  if (gid === undefined || gid === null || pageNo === undefined || pageNo === null) {
    throw new TypeError('gid and pageNo are required');
  }

  return `${gid}:${pageNo}`;
}

export function imageBytesFromRecord(record) {
  if (Number.isFinite(record.imageBytes)) {
    return record.imageBytes;
  }

  if (record.imageBlob instanceof Uint8Array || Buffer.isBuffer(record.imageBlob)) {
    return record.imageBlob.byteLength;
  }

  if (typeof record.imageBlob === 'string') {
    return Buffer.byteLength(record.imageBlob);
  }

  return 0;
}

export function hashRecordImage(record) {
  const blob = record.imageBlob;
  if (!blob) return null;

  const data = blob instanceof Uint8Array || Buffer.isBuffer(blob)
    ? Buffer.from(blob)
    : Buffer.from(String(blob));

  return createHash('sha256').update(data).digest('hex');
}


import { hashRecordImage, imageBytesFromRecord } from './fake-storage.js';

export async function migrateImages({ source, target, deleteSourceAfterSuccess = false }) {
  const migrated = [];
  const failed = [];

  for (const record of source.list()) {
    if (!record.imageBlob) {
      continue;
    }

    const expectedHash = hashRecordImage(record);
    const expectedBytes = imageBytesFromRecord(record);

    try {
      const copied = target.put({
        ...record,
        migratedAt: Date.now(),
        sourcePageKey: record.pageKey
      });

      const actualHash = hashRecordImage(copied);
      const actualBytes = imageBytesFromRecord(copied);
      if (actualHash !== expectedHash || actualBytes !== expectedBytes) {
        throw new Error('migration verification failed');
      }

      migrated.push({
        pageKey: record.pageKey,
        bytes: expectedBytes,
        hash: expectedHash
      });

      if (deleteSourceAfterSuccess) {
        source.delete(record.pageKey);
      }
    } catch (error) {
      failed.push({
        pageKey: record.pageKey,
        error: error.message
      });
    }
  }

  return {
    migrated,
    failed,
    deletedSource: deleteSourceAfterSuccess ? migrated.length : 0
  };
}


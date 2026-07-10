import {
  recordHasExplicitNonImageMime,
  resolveRecordImageMimeType
} from './image-validation.js';

export const DIRECTORY_STORAGE_DB_NAME = 'ehplus-directory-storage';
export const DIRECTORY_STORAGE_DB_VERSION = 1;
export const DIRECTORY_HANDLE_STORE = 'handles';
export const DIRECTORY_HANDLE_KEY = 'cache-root';

const RECORDS_DIR = 'records';
const RECORDS_GID_DIR = 'gid';
const RECORDS_URL_DIR = 'url';
const IMAGES_DIR = 'images';
const STATE_DIR = 'state';
const LOGS_DIR = 'logs';
const STATS_DIR = 'stats';
const SETTINGS_DIR = 'settings';
const DAILY_LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
const DIRECTORY_GID_GROUP_KIND = 'gid-pages';
const directoryInitializationPromises = new WeakMap();
let directoryMutationTail = Promise.resolve();
let cachedDirectoryHandleRecord = null;

export async function saveDirectoryHandle(handle, options = {}) {
  if (!isDirectoryHandle(handle)) {
    throw new TypeError('directory handle required');
  }

  if (typeof handle.requestPermission === 'function') {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      throw new Error('directory permission not granted');
    }
  }

  const record = {
    id: DIRECTORY_HANDLE_KEY,
    handle,
    label: normalizeDirectoryLabel(options.label ?? handle.name),
    savedAt: Date.now()
  };
  const db = await openDirectoryStorageDb();
  await idbRequest(db.transaction(DIRECTORY_HANDLE_STORE, 'readwrite').objectStore(DIRECTORY_HANDLE_STORE).put(record));
  cachedDirectoryHandleRecord = record;
  return record;
}

export async function loadDirectoryHandleRecord(options = {}) {
  if (options.refresh !== true && cachedDirectoryHandleRecord?.handle) {
    return cachedDirectoryHandleRecord;
  }
  const db = await openDirectoryStorageDb();
  const record = await idbRequest(db.transaction(DIRECTORY_HANDLE_STORE, 'readonly').objectStore(DIRECTORY_HANDLE_STORE).get(DIRECTORY_HANDLE_KEY));
  cachedDirectoryHandleRecord = record?.handle ? record : null;
  return record;
}

export async function loadWritableDirectoryHandle(options = {}) {
  const record = await loadDirectoryHandleRecord(options);
  const handle = record?.handle;
  if (!isDirectoryHandle(handle)) return null;
  if (typeof handle.queryPermission === 'function') {
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return null;
  }
  return handle;
}

export function applyDirectoryAuthorizationRuntime(runtime = {}, options = {}) {
  const requestedMode = options.requestedMode === 'directory' && options.directoryLabel
    ? 'directory'
    : 'indexeddb';
  const directoryAuthorizationRequired = requestedMode === 'directory' && options.writable !== true;
  const wasRequired = runtime.directoryAuthorizationRequired === true;
  const previousIncident = Math.max(0, Number(runtime.directoryAuthorizationIncident) || 0);
  const directoryAuthorizationIncident = directoryAuthorizationRequired && !wasRequired
    ? previousIncident + 1
    : previousIncident;

  return {
    ...runtime,
    requestedStorageMode: requestedMode,
    effectiveStorageMode: requestedMode === 'directory' && options.writable === true ? 'directory' : 'indexeddb',
    directoryAuthorizationRequired,
    directoryAuthorizationIncident,
    directoryAuthorizationNoticeDismissedIncident: Math.max(0, Number(runtime.directoryAuthorizationNoticeDismissedIncident) || 0)
  };
}

export function dismissDirectoryAuthorizationNotice(runtime = {}) {
  return {
    ...runtime,
    directoryAuthorizationNoticeDismissedIncident: Math.max(0, Number(runtime.directoryAuthorizationIncident) || 0)
  };
}

export function shouldShowDirectoryAuthorizationNotice(runtime = {}) {
  return runtime.directoryAuthorizationRequired === true
    && Math.max(0, Number(runtime.directoryAuthorizationIncident) || 0)
      > Math.max(0, Number(runtime.directoryAuthorizationNoticeDismissedIncident) || 0);
}

export async function createDirectoryPreloadStore(rootHandle) {
  if (!isDirectoryHandle(rootHandle)) {
    throw new TypeError('directory handle required');
  }
  const recordsDir = await rootHandle.getDirectoryHandle(RECORDS_DIR, { create: true });
  await recordsDir.getDirectoryHandle(RECORDS_GID_DIR, { create: true });
  await recordsDir.getDirectoryHandle(RECORDS_URL_DIR, { create: true });
  const imagesDir = await rootHandle.getDirectoryHandle(IMAGES_DIR, { create: true });
  await initializeDirectoryStore(rootHandle, recordsDir, imagesDir);

  return {
    kind: 'directory',
    rootHandle,
    async get(pageKey) {
      return getDirectoryRecord(recordsDir, { pageKey });
    },
    async getByResourceKey(resourceKey) {
      return getDirectoryRecord(recordsDir, { resourceKey });
    },
    async hydrate(record) {
      return hydrateDirectoryRecord(record, imagesDir);
    },
    async put(record) {
      return runDirectoryMutation(() => putDirectoryRecord(recordsDir, imagesDir, record));
    },
    async list() {
      return listDirectoryRecords(recordsDir, imagesDir);
    },
    async deleteMany(records = []) {
      await runDirectoryMutation(() => deleteDirectoryRecords(recordsDir, imagesDir, records));
    },
    async stripImages(records = []) {
      await runDirectoryMutation(() => stripDirectoryRecordImages(recordsDir, imagesDir, records));
    },
    async clear() {
      await runDirectoryMutation(async () => {
        await clearDirectory(recordsDir);
        await clearDirectory(imagesDir);
      });
    }
  };
}

async function initializeDirectoryStore(rootHandle, recordsDir, imagesDir) {
  let initialization = directoryInitializationPromises.get(rootHandle);
  if (!initialization) {
    initialization = runDirectoryMutation(async () => {
      await migrateDirectoryImageLayout(recordsDir, imagesDir);
      await migrateDirectoryRecordGroups(recordsDir);
      await migrateDirectoryRecordBuckets(recordsDir);
    });
    directoryInitializationPromises.set(rootHandle, initialization);
  }

  try {
    await initialization;
  } catch (error) {
    if (directoryInitializationPromises.get(rootHandle) === initialization) {
      directoryInitializationPromises.delete(rootHandle);
    }
    throw error;
  }
}

function runDirectoryMutation(operation) {
  const result = directoryMutationTail.then(operation);
  directoryMutationTail = result.catch(() => {});
  return result;
}

async function getDirectoryRecord(recordsDir, keyRecord) {
  const entries = recordLookupEntries(keyRecord);
  if (entries.length === 0) return null;

  for (const entry of entries) {
    const record = await readDirectoryRecord(recordsDir, entry.key);
    if (!record) continue;
    const resolved = await resolveDirectoryRecord(recordsDir, record, entry);
    if (resolved) return resolved;
  }

  return null;
}

async function resolveDirectoryRecord(recordsDir, record, entry) {
  const pageKey = normalizeDirectoryPageKey(entry?.pageKey)
    || normalizeDirectoryPageKey(record?.directoryPageKey)
    || normalizeDirectoryPageKey(record?.pageKey);
  if (isDirectoryPageGroup(record)) {
    return pageKey ? record.pages?.[pageKey] ?? null : null;
  }

  const primaryKey = safeDirectoryRecordKey(record.directoryPrimaryKey);
  if (record.directoryIndexOnly === true && primaryKey && primaryKey !== entry?.key) {
    const primaryRecord = await readDirectoryRecord(recordsDir, primaryKey);
    if (primaryRecord) return resolveDirectoryRecord(recordsDir, primaryRecord, { key: primaryKey, pageKey }) ?? record;
  }

  return record;
}

async function readDirectoryRecord(recordsDir, key) {
  const bucketDir = await getDirectoryRecordBucket(recordsDir, key);
  if (bucketDir && bucketDir !== recordsDir) {
    const record = await readJsonRecordFile(bucketDir, key);
    if (record) return record;
  }
  return readJsonRecordFile(recordsDir, key);
}

async function readJsonRecordFile(directoryHandle, key) {
  try {
    const file = await (await directoryHandle.getFileHandle(`${key}.json`)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeDirectoryRecordFile(recordsDir, key, value) {
  const bucketDir = await getDirectoryRecordBucket(recordsDir, key, { create: true });
  await writeJsonFile(bucketDir ?? recordsDir, `${key}.json`, value);
  if (bucketDir && bucketDir !== recordsDir) {
    await removeEntry(recordsDir, `${key}.json`);
  }
}

async function removeDirectoryRecordFile(recordsDir, key) {
  const bucketDir = await getDirectoryRecordBucket(recordsDir, key);
  if (bucketDir && bucketDir !== recordsDir) {
    await removeEntry(bucketDir, `${key}.json`);
  }
  await removeEntry(recordsDir, `${key}.json`);
}

export async function writeDirectoryStateSnapshot(rootHandle, state) {
  if (!isDirectoryHandle(rootHandle) || !state) return;
  await runDirectoryMutation(async () => {
    await writeJsonFile(await rootHandle.getDirectoryHandle(STATE_DIR, { create: true }), 'ehplus-state.json', state);
    await writeJsonFile(await rootHandle.getDirectoryHandle(SETTINGS_DIR, { create: true }), 'settings.json', state.settings ?? {});
    await writeJsonFile(await rootHandle.getDirectoryHandle(STATS_DIR, { create: true }), 'stats.json', state.stats ?? {});
  });
}

export async function writeDirectoryLogsSnapshot(rootHandle, logs) {
  if (!isDirectoryHandle(rootHandle)) return;
  await runDirectoryMutation(async () => {
    const logsDir = await rootHandle.getDirectoryHandle(LOGS_DIR, { create: true });
    await clearDirectoryLogSnapshotFiles(logsDir);
    const groupedLogs = groupLogsByDate(logs);
    await Promise.all([...groupedLogs].map(([date, items]) => writeJsonFile(logsDir, `${date}.json`, items)));
  });
}

export function directoryLogDate(log) {
  const date = new Date(Number(log?.at) || 0);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function groupLogsByDate(logs) {
  const grouped = new Map();
  for (const log of Array.isArray(logs) ? logs : []) {
    const date = directoryLogDate(log);
    const items = grouped.get(date) ?? [];
    items.push(log);
    grouped.set(date, items);
  }
  return grouped;
}

async function clearDirectoryLogSnapshotFiles(logsDir) {
  await removeEntry(logsDir, 'logs.json');
  for await (const [name, handle] of directoryEntries(logsDir)) {
    if (handle.kind === 'file' && DAILY_LOG_FILE_PATTERN.test(name)) {
      await removeEntry(logsDir, name);
    }
  }
}

export function normalizeDirectoryLabel(value) {
  return String(value ?? '').trim().slice(0, 260);
}

async function putDirectoryRecord(recordsDir, imagesDir, record) {
  const specialKey = specialDirectoryRecordKey(record?.pageKey);
  if (specialKey) {
    // history:{gid} / gallery:{gid}:{token} 等非 reader pageKey 存为独立记录文件（规划 §592）。
    const stored = {
      ...record,
      imageBlob: null,
      dataUrl: null,
      directoryStoredAt: Date.now()
    };
    await writeDirectoryRecordFile(recordsDir, specialKey, stored);
    return stored;
  }

  const key = recordStorageKey(record);
  if (!key) throw new Error('directory cache record requires pageKey or resourceKey');

  const now = Date.now();
  const pageKey = resolveDirectoryPageKey(record);
  const existingGroup = pageKey ? normalizeDirectoryPageGroup(await readDirectoryRecord(recordsDir, key), gidFromPageKey(pageKey)) : null;
  const existingPage = pageKey ? existingGroup?.pages?.[pageKey] : await readDirectoryRecord(recordsDir, key);
  const image = await recordImageBlob(record);
  const previousImageFile = record.directoryImageFile ?? existingPage?.directoryImageFile ?? null;
  let imageFile = record.directoryImageFile ?? existingPage?.directoryImageFile ?? null;
  let imageBytes = Number(record?.imageBytes) || Number(existingPage?.imageBytes) || 0;
  let hasImageBlob = typeof record?.hasImageBlob === 'boolean' ? record.hasImageBlob : Boolean(existingPage?.hasImageBlob);

  if (image) {
    imageFile = directoryImagePath(record, recordImageStorageKey(record, key));
    await writeBlobPath(imagesDir, imageFile, image);
    if (previousImageFile && previousImageFile !== imageFile) {
      await removePath(imagesDir, previousImageFile);
    }
    imageBytes = image.size;
    hasImageBlob = image.size > 0;
  }

  const stored = {
    ...record,
    pageKey: pageKey || record.pageKey,
    title: directoryRecordTitle(record),
    originalTitle: directoryRecordOriginalTitle(record),
    imageBlob: null,
    dataUrl: null,
    directoryImageFile: imageFile,
    directoryStoredAt: now,
    imageBytes,
    hasImageBlob,
    deliveryKind: hasImageBlob ? 'data-url' : record.deliveryKind ?? existingPage?.deliveryKind
  };

  if (pageKey) {
    const group = existingGroup ?? createDirectoryPageGroup(gidFromPageKey(pageKey));
    group.pages[pageKey] = stored;
    group.directoryStoredAt = now;
    group.updatedAt = Math.max(Number(group.updatedAt) || 0, Number(stored.updatedAt) || now);
    syncDirectoryPageGroupTitles(group);
    await writeDirectoryRecordFile(recordsDir, key, group);
    await removeDirectoryRecordFile(recordsDir, pageRecordStorageKey(pageKey));
  } else {
    await writeDirectoryRecordFile(recordsDir, key, stored);
  }

  await writeDirectoryResourceIndex(recordsDir, stored, key);
  return stored;
}

async function writeDirectoryResourceIndex(recordsDir, record, primaryKey) {
  const resourceKey = normalizeDirectoryResourceKey(record);
  if (!resourceKey) return;

  const resourceStorageKey = resourceStorageKeys(resourceKey)[0] ?? '';
  if (!resourceStorageKey || resourceStorageKey === primaryKey) return;

  await writeDirectoryRecordFile(recordsDir, resourceStorageKey, {
    ...record,
    imageBlob: null,
    dataUrl: null,
    directoryIndexOnly: true,
    directoryPrimaryKey: primaryKey,
    directoryPageKey: resolveDirectoryPageKey(record) || null
  });
}

async function listDirectoryRecords(recordsDir, imagesDir) {
  const records = [];
  for (const { record } of await readDirectoryRecordIndex(recordsDir)) {
    try {
      if (record?.directoryIndexOnly === true) continue;
      if (isDirectoryPageGroup(record)) {
        records.push(...directoryGroupPages(record));
      } else {
        records.push(record);
      }
    } catch {
      // Ignore partial or manually edited index files.
    }
  }
  return records;
}

async function migrateDirectoryImageLayout(recordsDir, imagesDir) {
  const indexedRecords = await readDirectoryRecordIndex(recordsDir);
  const recordsByKey = new Map(indexedRecords.map((item) => [item.key, item.record]));

  for (const { key, record } of indexedRecords) {
    if (record?.directoryIndexOnly === true) continue;
    if (isDirectoryPageGroup(record)) {
      let groupChanged = false;
      const nextGroup = {
        ...record,
        pages: { ...record.pages }
      };

      for (const [pageKey, pageRecord] of Object.entries(record.pages ?? {})) {
        const nextRecord = await migrateDirectoryRecordImage(imagesDir, {
          ...pageRecord,
          pageKey: resolveDirectoryPageKey(pageRecord) || pageKey
        }, key);
        if (!nextRecord || nextRecord === pageRecord) continue;
        nextGroup.pages[pageKey] = nextRecord;
        groupChanged = true;
      }

      if (groupChanged) {
        await writeDirectoryRecordFile(recordsDir, key, nextGroup);
        recordsByKey.set(key, nextGroup);
      }
      continue;
    }

    const nextRecord = await migrateDirectoryRecordImage(imagesDir, record, key);
    if (!nextRecord || nextRecord === record) continue;
    await writeDirectoryRecordFile(recordsDir, key, nextRecord);
    recordsByKey.set(key, nextRecord);
  }

  for (const { key, record } of indexedRecords) {
    if (record?.directoryIndexOnly !== true) continue;
    const primaryKey = safeDirectoryRecordKey(record.directoryPrimaryKey);
    if (!primaryKey) continue;
    const primaryRecord = directoryPrimaryRecordForIndex(recordsByKey.get(primaryKey), record);
    if (!primaryRecord?.directoryImageFile) continue;
    if (record.directoryImageFile === primaryRecord.directoryImageFile) continue;

    await writeDirectoryRecordFile(recordsDir, key, {
      ...record,
      directoryImageFile: primaryRecord.directoryImageFile,
      imageBytes: primaryRecord.imageBytes,
      hasImageBlob: primaryRecord.hasImageBlob,
      deliveryKind: primaryRecord.deliveryKind,
      directoryImageLayoutMigratedAt: primaryRecord.directoryImageLayoutMigratedAt
    });
  }
}

async function migrateDirectoryRecordImage(imagesDir, record, fallbackKey) {
  const previousPath = normalizeDirectoryImagePath(record?.directoryImageFile);
  if (!previousPath) return null;

  const nextPath = directoryImagePath(record, recordImageStorageKey(record, fallbackKey));
  if (!nextPath || nextPath === previousPath) return record;

  const migrated = await migrateDirectoryImageFile(imagesDir, previousPath, nextPath);
  if (!migrated) return null;

  return {
    ...record,
    directoryImageFile: nextPath,
    directoryImageLayoutMigratedAt: Date.now()
  };
}

function directoryPrimaryRecordForIndex(primaryRecord, indexRecord) {
  if (!isDirectoryPageGroup(primaryRecord)) return primaryRecord;
  const pageKey = normalizeDirectoryPageKey(indexRecord?.directoryPageKey)
    || resolveDirectoryPageKey(indexRecord);
  return pageKey ? primaryRecord.pages?.[pageKey] : null;
}

async function readDirectoryRecordIndex(recordsDir) {
  const recordsByKey = new Map();
  await readDirectoryRecordIndexFrom(recordsDir, recordsByKey);
  for (const bucket of [RECORDS_GID_DIR, RECORDS_URL_DIR]) {
    try {
      await readDirectoryRecordIndexFrom(await recordsDir.getDirectoryHandle(bucket), recordsByKey);
    } catch {
      // Older stores do not have bucket folders yet.
    }
  }
  return [...recordsByKey.values()];
}

async function readDirectoryRecordIndexFrom(directoryHandle, recordsByKey) {
  for await (const [name, handle] of directoryEntries(directoryHandle)) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const key = safeDirectoryRecordKey(name.slice(0, -5));
    if (!key) continue;
    try {
      const file = await handle.getFile();
      recordsByKey.set(key, { key, record: JSON.parse(await file.text()) });
    } catch {
      // Ignore partial or manually edited index files.
    }
  }
}

async function migrateDirectoryRecordGroups(recordsDir) {
  const indexedRecords = await readDirectoryRecordIndex(recordsDir);
  const groups = new Map();
  const migratedPrimaryKeys = new Map();

  for (const { key, record } of indexedRecords) {
    if (record?.directoryIndexOnly === true || isDirectoryPageGroup(record)) continue;
    const pageKey = resolveDirectoryPageKey(record);
    if (!pageKey) continue;

    const groupKey = gidGroupStorageKey(gidFromPageKey(pageKey));
    const group = groups.get(groupKey)
      ?? normalizeDirectoryPageGroup(await readDirectoryRecord(recordsDir, groupKey), gidFromPageKey(pageKey))
      ?? createDirectoryPageGroup(gidFromPageKey(pageKey));
    const stored = {
      ...record,
      pageKey,
      title: directoryRecordTitle(record),
      originalTitle: directoryRecordOriginalTitle(record),
      imageBlob: null,
      dataUrl: null
    };
    group.pages[pageKey] = stored;
    group.directoryStoredAt = Math.max(Number(group.directoryStoredAt) || 0, Number(stored.directoryStoredAt) || 0);
    group.updatedAt = Math.max(Number(group.updatedAt) || 0, Number(stored.updatedAt) || 0);
    groups.set(groupKey, group);
    migratedPrimaryKeys.set(key, { groupKey, pageKey });
  }

  for (const [groupKey, group] of groups) {
    syncDirectoryPageGroupTitles(group);
    await writeDirectoryRecordFile(recordsDir, groupKey, group);
  }

  for (const [key, { groupKey }] of migratedPrimaryKeys) {
    if (key !== groupKey) await removeDirectoryRecordFile(recordsDir, key);
  }

  for (const { key, record } of indexedRecords) {
    if (record?.directoryIndexOnly !== true) continue;
    const mapped = migratedPrimaryKeys.get(safeDirectoryRecordKey(record.directoryPrimaryKey));
    if (!mapped) continue;
    const pageRecord = groups.get(mapped.groupKey)?.pages?.[mapped.pageKey];
    await writeDirectoryRecordFile(recordsDir, key, {
      ...record,
      directoryIndexOnly: true,
      directoryPrimaryKey: mapped.groupKey,
      directoryPageKey: mapped.pageKey,
      directoryImageFile: pageRecord?.directoryImageFile ?? record.directoryImageFile,
      imageBytes: pageRecord?.imageBytes ?? record.imageBytes,
      hasImageBlob: pageRecord?.hasImageBlob ?? record.hasImageBlob,
      deliveryKind: pageRecord?.deliveryKind ?? record.deliveryKind
    });
  }
}

async function migrateDirectoryRecordBuckets(recordsDir) {
  for await (const [name, handle] of directoryEntries(recordsDir)) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const key = safeDirectoryRecordKey(name.slice(0, -5));
    if (!key || !directoryRecordBucketName(key)) continue;
    try {
      const file = await handle.getFile();
      await writeDirectoryRecordFile(recordsDir, key, JSON.parse(await file.text()));
      await removeEntry(recordsDir, name);
    } catch {
      // Ignore partial or manually edited legacy files.
    }
  }
}

async function migrateDirectoryImageFile(imagesDir, previousPath, nextPath) {
  try {
    const file = await readFilePath(imagesDir, previousPath);
    await writeBlobPath(imagesDir, nextPath, file);
    await removePath(imagesDir, previousPath);
    return true;
  } catch {
    if (await fileExistsPath(imagesDir, nextPath)) return true;
    return false;
  }
}

async function hydrateDirectoryRecord(record, imagesDir) {
  const imageFile = typeof record?.directoryImageFile === 'string' ? record.directoryImageFile : '';
  if (!imageFile) return record;
  if (recordHasExplicitNonImageMime(record)) return withoutNonImagePayload(record);

  try {
    const file = await readFilePath(imagesDir, imageFile);
    if (recordHasExplicitNonImageMime({ ...record, imageBlob: file })) {
      return withoutNonImagePayload(record);
    }
    const mimeType = resolveRecordImageMimeType(record, file.type) || record.mimeType || file.type;
    const dataUrl = await blobToDataUrl(file, mimeType);
    return {
      ...record,
      imageBlob: file,
      dataUrl,
      imageBytes: file.size,
      hasImageBlob: file.size > 0,
      deliveryKind: 'data-url'
    };
  } catch {
    return {
      ...record,
      imageBytes: 0,
      hasImageBlob: false,
      dataUrl: null
    };
  }
}

function withoutNonImagePayload(record) {
  return {
    ...record,
    imageBlob: null,
    dataUrl: null,
    imageBytes: 0,
    hasImageBlob: false,
    deliveryKind: null
  };
}

async function deleteDirectoryRecords(recordsDir, imagesDir, records) {
  for (const record of records) {
    const specialKey = specialDirectoryRecordKey(record?.pageKey);
    if (specialKey) {
      await removeDirectoryRecordFile(recordsDir, specialKey);
      continue;
    }

    const key = recordStorageKey(record);
    if (!key) continue;
    const pageKey = resolveDirectoryPageKey(record);
    if (pageKey) {
      const group = normalizeDirectoryPageGroup(await readDirectoryRecord(recordsDir, key), gidFromPageKey(pageKey));
      if (group?.pages?.[pageKey]) {
        delete group.pages[pageKey];
        if (Object.keys(group.pages).length > 0) {
          syncDirectoryPageGroupTitles(group);
          await writeDirectoryRecordFile(recordsDir, key, group);
        } else {
          await removeDirectoryRecordFile(recordsDir, key);
        }
      }
      await removeDirectoryRecordFile(recordsDir, pageRecordStorageKey(pageKey));
    } else {
      await removeDirectoryRecordFile(recordsDir, key);
    }
    await removeDirectoryResourceIndex(recordsDir, record, key);
    if (record?.directoryImageFile) {
      await removePath(imagesDir, record.directoryImageFile);
    } else {
      await removePath(imagesDir, directoryImagePath(record, recordImageStorageKey(record, key)));
    }
  }
}

// 按天清理图片只删 images/ 下的图片文件并更新索引，保留页面元数据与
// 统计字段（规划 §8）；URL 查询索引同步改写为无图片体状态。
async function stripDirectoryRecordImages(recordsDir, imagesDir, records) {
  const strippedFields = {
    imageBlob: null,
    dataUrl: null,
    directoryImageFile: null,
    imageBytes: 0,
    hasImageBlob: false,
    deliveryKind: null,
    imageStrippedAt: Date.now()
  };

  for (const record of records) {
    const key = recordStorageKey(record);
    if (!key) continue;

    if (record?.directoryImageFile) {
      await removePath(imagesDir, record.directoryImageFile);
    } else {
      await removePath(imagesDir, directoryImagePath(record, recordImageStorageKey(record, key)));
    }

    const pageKey = resolveDirectoryPageKey(record);
    if (pageKey) {
      const group = normalizeDirectoryPageGroup(await readDirectoryRecord(recordsDir, key), gidFromPageKey(pageKey));
      const page = group?.pages?.[pageKey];
      if (!page) continue;
      group.pages[pageKey] = { ...page, ...strippedFields };
      await writeDirectoryRecordFile(recordsDir, key, group);
      await writeDirectoryResourceIndex(recordsDir, group.pages[pageKey], key);
    } else {
      const existing = await readDirectoryRecord(recordsDir, key);
      if (!existing) continue;
      await writeDirectoryRecordFile(recordsDir, key, { ...existing, ...strippedFields });
    }
  }
}

async function removeDirectoryResourceIndex(recordsDir, record, primaryKey) {
  const resourceKey = normalizeDirectoryResourceKey(record);
  for (const resourceStorageKey of resourceStorageKeys(resourceKey)) {
    if (resourceStorageKey && resourceStorageKey !== primaryKey) {
      await removeDirectoryRecordFile(recordsDir, resourceStorageKey);
    }
  }
}

async function clearDirectory(directoryHandle) {
  for await (const [name] of directoryEntries(directoryHandle)) {
    await removeEntry(directoryHandle, name, { recursive: true });
  }
}

async function writeJsonFile(directoryHandle, name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  await writeBlobFile(directoryHandle, name, blob);
}

async function writeBlobFile(directoryHandle, name, blob) {
  const handle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

async function writeBlobPath(directoryHandle, path, blob) {
  const { directory, name } = await resolveDirectoryPath(directoryHandle, path, { create: true });
  await writeBlobFile(directory, name, blob);
}

async function readFilePath(directoryHandle, path) {
  const { directory, name } = await resolveDirectoryPath(directoryHandle, path);
  return (await directory.getFileHandle(name)).getFile();
}

async function fileExistsPath(directoryHandle, path) {
  try {
    await readFilePath(directoryHandle, path);
    return true;
  } catch {
    return false;
  }
}

async function removeEntry(directoryHandle, name, options = {}) {
  try {
    await directoryHandle.removeEntry(name, options);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

async function removePath(directoryHandle, path) {
  const parts = safePathParts(path);
  if (parts.length === 0) return;
  if (parts.length === 1) {
    await removeEntry(directoryHandle, parts[0]);
    return;
  }

  try {
    const directory = await getExistingPathDirectory(directoryHandle, parts.slice(0, -1));
    await removeEntry(directory, parts[parts.length - 1]);
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

async function resolveDirectoryPath(directoryHandle, path, options = {}) {
  const parts = safePathParts(path);
  if (parts.length === 0) throw new Error('invalid directory file path');
  const name = parts[parts.length - 1];
  let directory = directoryHandle;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: options.create === true });
  }
  return { directory, name };
}

async function getExistingPathDirectory(directoryHandle, parts) {
  let directory = directoryHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory;
}

function safePathParts(path) {
  return String(path ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /^[A-Za-z0-9_.%,-]+$/.test(part) && part !== '.' && part !== '..');
}

function normalizeDirectoryImagePath(value) {
  const parts = safePathParts(value);
  return parts.join('/');
}

async function recordImageBlob(record) {
  if (record?.imageBlob instanceof Blob) return record.imageBlob;
  if (typeof record?.dataUrl === 'string') return dataUrlToBlob(record.dataUrl, record.mimeType);
  if (record?.imageBlob instanceof ArrayBuffer || ArrayBuffer.isView(record?.imageBlob)) {
    return new Blob([record.imageBlob], { type: record.mimeType || 'application/octet-stream' });
  }
  if (typeof record?.imageBlob === 'string') {
    return new Blob([record.imageBlob], { type: record.mimeType || 'application/octet-stream' });
  }
  return null;
}

function directoryImagePath(record, key) {
  const name = `${key}${extensionForRecord(record)}`;
  const folder = directoryImageFolder(record);
  return folder ? `${folder}/${name}` : name;
}

function recordImageStorageKey(record, fallbackKey) {
  const pageKey = resolveDirectoryPageKey(record);
  return pageKey ? imagePageStorageKey(pageKey) : fallbackKey;
}

function directoryImageFolder(record) {
  return safeDirectoryFolderName(
    record?.gid
      ?? gidFromPageKey(resolveDirectoryPageKey(record))
      ?? gidFromPageKey(record?.pageKey)
      ?? gidFromGalleryKey(record?.galleryKey)
      ?? gidFromEhUrl(record?.pageUrl)
      ?? gidFromEhUrl(record?.imageUrl)
      ?? gidFromEhUrl(record?.resourceKey)
      ?? gidFromEhUrl(record?.galleryUrl)
  );
}

function resolveDirectoryPageKey(record) {
  const explicit = normalizeDirectoryPageKey(record?.pageKey);
  if (explicit) return explicit;

  const gid = String(record?.gid ?? '').trim();
  const pageNo = Number(record?.pageNo);
  if (/^\d+$/.test(gid) && Number.isSafeInteger(pageNo) && pageNo >= 1) {
    return `${gid}:${pageNo}`;
  }

  return pageKeyFromEhUrl(record?.pageUrl)
    ?? pageKeyFromEhUrl(record?.imageUrl)
    ?? pageKeyFromEhUrl(record?.resourceKey)
    ?? '';
}

function normalizeDirectoryPageKey(value) {
  const key = String(value ?? '').trim();
  const match = key.match(/^(\d+):(\d+)$/);
  if (!match) return '';
  const pageNo = Number(match[2]);
  return Number.isSafeInteger(pageNo) && pageNo >= 1 ? `${match[1]}:${pageNo}` : '';
}

function gidFromPageKey(value) {
  const key = String(value ?? '').trim();
  return key.match(/^(\d+):\d+$/)?.[1]
    ?? key.match(/^gallery:(\d+):/)?.[1]
    ?? key.match(/^history:(\d+)$/)?.[1]
    ?? '';
}

function gidFromGalleryKey(value) {
  return String(value ?? '').trim().match(/^(\d+):/)?.[1] ?? '';
}

function gidFromEhUrl(value) {
  return gidFromPageKey(pageKeyFromEhUrl(value)) || galleryGidFromEhUrl(value);
}

function pageKeyFromEhUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const readerMatch = url.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
    if (readerMatch) return `${readerMatch[1]}:${Number(readerMatch[2])}`;

    const gid = url.searchParams.get('gid');
    const pageNo = Number(url.searchParams.get('page'));
    if (/^\d+$/.test(String(gid ?? '')) && Number.isSafeInteger(pageNo) && pageNo >= 1) {
      return `${gid}:${pageNo}`;
    }
  } catch {
  }
  return '';
}

function galleryGidFromEhUrl(value) {
  try {
    return new URL(String(value ?? '')).pathname.match(/^\/g\/(\d+)\//)?.[1] ?? '';
  } catch {
    return '';
  }
}

function safeDirectoryFolderName(value) {
  const folder = String(value ?? '').trim();
  return /^\d{1,32}$/.test(folder) ? folder : '';
}

function recordStorageKey(record) {
  return recordStorageKeys(record)[0] ?? '';
}

function recordStorageKeys(record) {
  const pageKey = resolveDirectoryPageKey(record);
  if (pageKey) return [gidGroupStorageKey(gidFromPageKey(pageKey))];
  const resourceKey = normalizeDirectoryResourceKey(record);
  if (resourceKey) return resourceStorageKeys(resourceKey);
  return [];
}

function recordLookupEntries(record) {
  const entries = [];
  const specialKey = specialDirectoryRecordKey(record?.pageKey);
  if (specialKey) {
    entries.push({ key: specialKey, pageKey: null });
  }

  const pageKey = resolveDirectoryPageKey(record);
  if (pageKey) {
    entries.push({ key: gidGroupStorageKey(gidFromPageKey(pageKey)), pageKey });
    entries.push({ key: pageRecordStorageKey(pageKey), pageKey });
  }

  const resourceKey = normalizeDirectoryResourceKey(record);
  for (const key of resourceStorageKeys(resourceKey)) {
    entries.push({ key, pageKey });
  }

  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry.key || seen.has(`${entry.key}:${entry.pageKey ?? ''}`)) return false;
    seen.add(`${entry.key}:${entry.pageKey ?? ''}`);
    return true;
  });
}

function gidGroupStorageKey(gid) {
  const value = safeDirectoryFolderName(gid);
  return value ? `gid-${value}` : '';
}

function specialDirectoryRecordKey(pageKey) {
  const key = String(pageKey ?? '').trim();
  const historyMatch = key.match(/^history:(\d+)$/);
  if (historyMatch) return `history-${historyMatch[1]}`;

  const galleryMatch = key.match(/^gallery:(\d+):([A-Za-z0-9_-]+)$/);
  if (galleryMatch) return safeDirectoryRecordKey(`gallery-${galleryMatch[1]}-${escapeDirectoryFileNameComponent(galleryMatch[2])}`);

  return '';
}

function pageRecordStorageKey(pageKey) {
  const normalized = normalizeDirectoryPageKey(pageKey);
  return normalized ? `page-${normalized.replace(':', '-')}` : '';
}

function imagePageStorageKey(pageKey) {
  const normalized = normalizeDirectoryPageKey(pageKey);
  return normalized ? normalized.replace(':', '-') : '';
}

function directoryRecordBucketName(key) {
  const value = String(key ?? '');
  if (value.startsWith('gid-') || value.startsWith('page-')) return RECORDS_GID_DIR;
  if (value.startsWith('history-') || value.startsWith('gallery-')) return RECORDS_GID_DIR;
  if (value.startsWith('url-') || value.startsWith('resource-')) return RECORDS_URL_DIR;
  return '';
}

async function getDirectoryRecordBucket(recordsDir, key, options = {}) {
  const bucket = directoryRecordBucketName(key);
  if (!bucket) return recordsDir;
  try {
    return await recordsDir.getDirectoryHandle(bucket, { create: options.create === true });
  } catch {
    if (options.create === true) throw new Error(`failed to open records/${bucket}`);
    return null;
  }
}

function createDirectoryPageGroup(gid) {
  return {
    directoryGroupKind: DIRECTORY_GID_GROUP_KIND,
    gid: String(gid ?? ''),
    title: String(gid ?? ''),
    originalTitle: String(gid ?? ''),
    pages: {},
    directoryStoredAt: Date.now()
  };
}

function normalizeDirectoryPageGroup(record, gid) {
  if (!isDirectoryPageGroup(record)) return null;
  const group = {
    ...record,
    directoryGroupKind: DIRECTORY_GID_GROUP_KIND,
    gid: String(record.gid ?? gid ?? ''),
    title: String(record.title ?? '').trim(),
    originalTitle: String(record.originalTitle ?? '').trim(),
    pages: { ...record.pages }
  };
  syncDirectoryPageGroupTitles(group);
  return group;
}

function isDirectoryPageGroup(record) {
  return record?.directoryGroupKind === DIRECTORY_GID_GROUP_KIND
    && record?.pages
    && typeof record.pages === 'object'
    && !Array.isArray(record.pages);
}

function directoryGroupPages(group) {
  return Object.entries(group.pages ?? {})
    .filter(([pageKey, record]) => normalizeDirectoryPageKey(pageKey) && record)
    .sort(([left], [right]) => {
      const [leftGid, leftPage] = left.split(':');
      const [rightGid, rightPage] = right.split(':');
      return leftGid.localeCompare(rightGid) || Number(leftPage) - Number(rightPage);
    })
    .map(([pageKey, record]) => ({
      ...record,
      pageKey,
      title: directoryRecordTitle(record),
      originalTitle: directoryRecordOriginalTitle(record)
    }));
}

function syncDirectoryPageGroupTitles(group) {
  const pages = directoryGroupPages(group);
  const fallback = String(group.gid ?? '').trim();
  const preferred = pages.find((record) => {
    return directoryRecordTitle(record) && directoryRecordTitle(record) !== fallback;
  }) ?? pages[0];
  group.title = preferred ? directoryRecordTitle(preferred) : fallback;
  group.originalTitle = preferred ? directoryRecordOriginalTitle(preferred) : fallback;
  if (!group.title && !group.originalTitle) {
    group.title = fallback;
    group.originalTitle = fallback;
  }
}

function directoryRecordTitle(record) {
  const title = String(record?.title ?? record?.imageName ?? '').trim();
  const originalTitle = String(record?.originalTitle ?? '').trim();
  return title || originalTitle || String(record?.gid ?? gidFromPageKey(record?.pageKey) ?? '').trim();
}

function directoryRecordOriginalTitle(record) {
  const originalTitle = String(record?.originalTitle ?? '').trim();
  if (originalTitle) return originalTitle;
  const title = String(record?.title ?? record?.imageName ?? '').trim();
  return title ? '' : String(record?.gid ?? gidFromPageKey(record?.pageKey) ?? '').trim();
}

function resourceStorageKeys(resourceKey) {
  if (!resourceKey) return [];
  const key = `url-${escapeDirectoryFileNameComponent(resourceKey)}`;
  const legacyKey = `resource-${hashString(resourceKey)}`;
  return key === legacyKey ? [key] : [key, legacyKey];
}

function normalizeDirectoryResourceKey(record) {
  const resourceKey = String(record?.resourceKey ?? record?.imageUrl ?? '').trim();
  if (!resourceKey) return '';

  try {
    const parsed = new URL(resourceKey);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return resourceKey;
  }
}

function safeDirectoryRecordKey(value) {
  const key = String(value ?? '').trim();
  return key && isSafeDirectoryFileName(`${key}.json`) ? key : '';
}

function escapeDirectoryFileNameComponent(value) {
  return String(value).replace(/[%<>:"/\\|?*\u0000-\u001F]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function isSafeDirectoryFileName(name) {
  const value = String(name ?? '').trim();
  return value !== ''
    && value !== '.'
    && value !== '..'
    && !/[<>:"/\\|?*\u0000-\u001F]/.test(value);
}

function extensionForRecord(record) {
  const mime = String(record?.mimeType ?? '').toLowerCase();
  const url = String(record?.imageUrl ?? record?.resourceKey ?? '').toLowerCase().split('?')[0];
  if (mime.includes('png') || url.endsWith('.png')) return '.png';
  if (mime.includes('webp') || url.endsWith('.webp')) return '.webp';
  if (mime.includes('gif') || url.endsWith('.gif')) return '.gif';
  if (mime.includes('jpeg') || mime.includes('jpg') || /\.jpe?g$/.test(url)) return '.jpg';
  return '.bin';
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function isDirectoryHandle(handle) {
  return handle?.kind === 'directory'
    && typeof handle.getDirectoryHandle === 'function'
    && typeof handle.getFileHandle === 'function';
}

async function openDirectoryStorageDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DIRECTORY_STORAGE_DB_NAME, DIRECTORY_STORAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
        db.createObjectStore(DIRECTORY_HANDLE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function* directoryEntries(directoryHandle) {
  if (typeof directoryHandle.entries === 'function') {
    yield* directoryHandle.entries();
    return;
  }
  for await (const name of directoryHandle.keys()) {
    let handle = null;
    try {
      handle = await directoryHandle.getFileHandle(name);
    } catch {
      handle = await directoryHandle.getDirectoryHandle(name);
    }
    yield [name, handle];
  }
}

async function blobToDataUrl(blob, mimeType) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${mimeType || blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function dataUrlToBlob(value, fallbackMimeType) {
  const match = String(value ?? '').match(/^data:([^,;]+)?(?:;base64)?,(.+)$/i);
  if (!match) return new Blob([String(value ?? '')], { type: fallbackMimeType || 'application/octet-stream' });
  const mimeType = match[1] || fallbackMimeType || 'application/octet-stream';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

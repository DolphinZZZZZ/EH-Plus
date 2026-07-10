// 原 Page Preload 用户脚本与 0.x 版本使用的库名，仅作历史参考；
// 1.0.0 起插件自身使用 ehplus-preload-cache（见 preload-engine.js）。
export const ORIGINAL_DB_NAME = 'ehp-preload-cache';
export const ORIGINAL_STORE_NAME = 'pages';
export const SCHEMA_VERSION = 1;

export const CLEANUP_SCOPES = Object.freeze({
  ALL: 'all',
  IMAGES: 'images',
  LOGS: 'logs',
  OTHER: 'other'
});

export const PAGE_TYPES = Object.freeze({
  READER: 's',
  GALLERY: 'g'
});

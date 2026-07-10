const I18N = {
  'zh-CN': {
    pageTitle: '浏览历史',
    pageFilter: '来源',
    filterAll: '全部',
    filterGallery: '画廊页 /g/',
    filterReader: '阅读页 /s/',
    sortLastVisited: '按最近观看',
    sortVisitCount: '按观看次数',
    clearAll: '清空历史',
    clearConfirm: '确认清空？',
    empty: '暂无浏览历史',
    emptyHint: '打开 E-Hentai / ExHentai 的画廊页或阅读页后，这里会自动记录。',
    countSummary: '{count} / 上限 {limit}',
    visitTimes: '观看 <strong>{count}</strong> 次',
    lastPage: '继续阅读 P{pageNo}',
    lastPageUnknown: '继续阅读',
    deleteEntry: '删除',
    noGalleryUrl: '缺少画廊链接',
    pagesUnit: '{pages} 页',
    loadFailed: '读取浏览历史失败：{message}',
    documentTitle: '浏览历史 - EH＋'
  },
  'en-US': {
    pageTitle: 'Browsing History',
    pageFilter: 'Source',
    filterAll: 'All',
    filterGallery: 'Gallery /g/',
    filterReader: 'Reader /s/',
    sortLastVisited: 'By last visited',
    sortVisitCount: 'By visit count',
    clearAll: 'Clear all',
    clearConfirm: 'Confirm clear?',
    empty: 'No browsing history yet',
    emptyHint: 'Open an E-Hentai / ExHentai gallery or reader page and it will be recorded here.',
    countSummary: '{count} / limit {limit}',
    visitTimes: 'Visited <strong>{count}</strong> times',
    lastPage: 'Continue P{pageNo}',
    lastPageUnknown: 'Continue reading',
    deleteEntry: 'Delete',
    noGalleryUrl: 'No gallery link recorded',
    pagesUnit: '{pages} pages',
    loadFailed: 'Failed to load browsing history: {message}',
    documentTitle: 'Browsing History - EH＋'
  }
};

// EhViewer 分类色板（EhUtils）。
const CATEGORY_COLORS = {
  doujinshi: '#f44336',
  manga: '#ff9800',
  'artist cg': '#fbc02d',
  'artistcg': '#fbc02d',
  'game cg': '#4caf50',
  'gamecg': '#4caf50',
  western: '#8bc34a',
  'non-h': '#2196f3',
  'image set': '#3f51b5',
  'imageset': '#3f51b5',
  cosplay: '#9c27b0',
  'asian porn': '#9575cd',
  'asianporn': '#9575cd',
  misc: '#f06292',
  private: '#5f5f5f'
};

let language = 'zh-CN';
let sortBy = 'lastVisited';
let pageFilter = 'all';
let loadedEntries = [];
let loadedLimit = 100;
let clearConfirmTimer = null;

// /s/ 访问产生的历史没有 /g/ 封面时，回退用本地缓存的第一页（gid:1）图片；
// 只读扩展本地缓存，未命中不发起任何页面/图片请求（规划 §10 浏览历史）。
const FIRST_PAGE_COVER_CONCURRENCY = 4;
const firstPageCoverCache = new Map();
const firstPageCoverQueue = [];
let firstPageCoverActive = 0;

document.addEventListener('DOMContentLoaded', () => {
  bindActions();
  refresh();
});

function bindActions() {
  document.querySelectorAll('.sort-btn').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.sort === sortBy) return;
      sortBy = button.dataset.sort === 'visitCount' ? 'visitCount' : 'lastVisited';
      document.querySelectorAll('.sort-btn').forEach((item) => {
        item.classList.toggle('active', item.dataset.sort === sortBy);
      });
      refresh();
    });
  });

  document.querySelector('[data-role="history-page-filter"]')?.addEventListener('change', (event) => {
    pageFilter = ['g', 's'].includes(event.target.value) ? event.target.value : 'all';
    render(loadedEntries, loadedLimit);
  });

  const clearButton = document.querySelector('[data-role="clear"]');
  clearButton.addEventListener('click', async () => {
    if (!clearButton.classList.contains('confirm')) {
      clearButton.classList.add('confirm');
      clearButton.textContent = t('clearConfirm');
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = setTimeout(() => resetClearButton(clearButton), 5000);
      return;
    }

    clearTimeout(clearConfirmTimer);
    resetClearButton(clearButton);
    await chrome.runtime.sendMessage({ type: 'EHPLUS_HISTORY_CLEAR' }).catch(() => null);
    refresh();
  });
}

function resetClearButton(button) {
  button.classList.remove('confirm');
  button.textContent = t('clearAll');
}

async function refresh() {
  const errorNode = document.querySelector('[data-role="error"]');
  errorNode.hidden = true;

  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'EHPLUS_HISTORY_LIST', sortBy });
  } catch (error) {
    response = { ok: false, error: error?.message ?? String(error) };
  }

  if (!response?.ok) {
    errorNode.hidden = false;
    errorNode.textContent = t('loadFailed', { message: response?.error ?? 'unknown' });
    return;
  }

  language = response.language === 'en-US' ? 'en-US' : 'zh-CN';
  applyLanguage();
  loadedEntries = response.entries ?? [];
  loadedLimit = response.limit ?? 100;
  render(loadedEntries, loadedLimit);
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('documentTitle');
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
}

function render(entries, limit) {
  const list = document.querySelector('[data-role="list"]');
  const empty = document.querySelector('[data-role="empty"]');
  const count = document.querySelector('[data-role="count"]');
  const visibleEntries = filterEntries(entries);

  count.textContent = t('countSummary', { count: String(visibleEntries.length), limit: String(limit) });
  empty.hidden = visibleEntries.length > 0;
  list.replaceChildren(...visibleEntries.map(buildCard));
}

function filterEntries(entries) {
  if (pageFilter === 'all') return entries;
  return entries.filter((entry) => entry.sourcePageType === pageFilter);
}

function buildCard(entry) {
  const item = document.createElement('li');
  const card = document.createElement('article');
  card.className = 'history-card';

  card.append(buildThumb(entry), buildBody(entry));
  item.appendChild(card);
  return item;
}

function buildThumb(entry) {
  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';

  if (entry.thumbUrl) {
    thumb.appendChild(buildThumbImage(entry.thumbUrl, thumb));
  } else {
    thumb.appendChild(thumbFallback());
    queueFirstPageCover(entry.gid, thumb);
  }

  return thumb;
}

function buildThumbImage(url, thumb) {
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    img.remove();
    thumb.appendChild(thumbFallback());
  }, { once: true });
  return img;
}

function queueFirstPageCover(gid, thumb) {
  if (!/^\d+$/.test(String(gid ?? ''))) return;
  const cached = firstPageCoverCache.get(gid);
  if (cached !== undefined) {
    if (cached) applyFirstPageCover(thumb, cached);
    return;
  }
  firstPageCoverQueue.push({ gid, thumb });
  drainFirstPageCoverQueue();
}

function drainFirstPageCoverQueue() {
  while (firstPageCoverActive < FIRST_PAGE_COVER_CONCURRENCY && firstPageCoverQueue.length > 0) {
    const { gid, thumb } = firstPageCoverQueue.shift();
    firstPageCoverActive += 1;
    queryFirstPageCover(gid)
      .then((url) => {
        firstPageCoverCache.set(gid, url);
        if (url) applyFirstPageCover(thumb, url);
      })
      .catch(() => {})
      .finally(() => {
        firstPageCoverActive -= 1;
        drainFirstPageCoverQueue();
      });
  }
}

async function queryFirstPageCover(gid) {
  const response = await chrome.runtime.sendMessage({
    type: 'EHPLUS_INTERNAL_CACHE_QUERY',
    pageKey: `${gid}:1`,
    responseMode: 'url'
  }).catch(() => null);
  const url = response?.hit === true ? response?.delivery?.url : '';
  return typeof url === 'string' && /^(data:|blob:|chrome-extension:)/.test(url) ? url : '';
}

function applyFirstPageCover(thumb, url) {
  thumb.querySelector('.thumb-fallback')?.remove();
  thumb.appendChild(buildThumbImage(url, thumb));
}

function thumbFallback() {
  const fallback = document.createElement('span');
  fallback.className = 'thumb-fallback';
  fallback.textContent = 'EH';
  return fallback;
}

function buildBody(entry) {
  const body = document.createElement('div');
  body.className = 'card-body';

  // 点击标题始终打开画廊页；无画廊链接时禁用（规划 §584-§588）。
  const title = entry.galleryUrl ? document.createElement('a') : document.createElement('p');
  title.className = 'card-title';
  title.textContent = entry.title || entry.titleJpn || entry.gid;
  if (entry.galleryUrl) {
    title.href = entry.galleryUrl;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  } else {
    title.classList.add('disabled');
    title.title = t('noGalleryUrl');
  }
  body.appendChild(title);

  if (entry.titleJpn && entry.titleJpn !== entry.title) {
    const subtitle = document.createElement('div');
    subtitle.className = 'card-subtitle';
    subtitle.textContent = entry.titleJpn;
    body.appendChild(subtitle);
  }

  if (entry.uploader) {
    const uploader = document.createElement('div');
    uploader.className = 'card-uploader';
    uploader.textContent = entry.uploader;
    body.appendChild(uploader);
  }

  const ratingRow = buildRatingRow(entry);
  if (ratingRow) body.appendChild(ratingRow);
  body.appendChild(buildMetaRow(entry));
  body.appendChild(buildActions(entry));
  return body;
}

function buildRatingRow(entry) {
  if (!Number.isFinite(entry.rating)) return null;

  const row = document.createElement('div');
  row.className = 'card-rating-row';

  const stars = document.createElement('span');
  stars.className = 'stars';
  stars.textContent = '★★★★★';
  const fill = document.createElement('span');
  fill.className = 'stars-fill';
  fill.textContent = '★★★★★';
  fill.style.width = `${Math.max(0, Math.min(1, entry.rating / 5)) * 100}%`;
  stars.appendChild(fill);

  const number = document.createElement('span');
  number.className = 'rating-number';
  number.textContent = entry.rating.toFixed(2);

  row.append(stars, number);
  return row;
}

function buildMetaRow(entry) {
  const row = document.createElement('div');
  row.className = 'card-meta-row';

  if (entry.category) {
    const chip = document.createElement('span');
    chip.className = 'category-chip';
    chip.textContent = entry.category;
    chip.style.background = CATEGORY_COLORS[entry.category.toLowerCase()] ?? '#5f5f5f';
    row.appendChild(chip);
  }

  if (Number.isFinite(entry.pages) && entry.pages > 0) {
    const pages = document.createElement('span');
    pages.className = 'meta-text';
    pages.textContent = t('pagesUnit', { pages: String(entry.pages) });
    row.appendChild(pages);
  }

  const visits = document.createElement('span');
  visits.className = 'visit-badge';
  visits.innerHTML = t('visitTimes', { count: escapeHtml(String(entry.historyVisitCount)) });
  row.appendChild(visits);

  const time = document.createElement('span');
  time.className = 'meta-text';
  time.textContent = formatDateTime(entry.historyLastVisitedAt);
  row.appendChild(time);

  return row;
}

function buildActions(entry) {
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // “最后阅读页”独立入口；没有 lastPageUrl 时隐藏（规划 §587-§588）。
  if (entry.lastPageUrl) {
    const lastPage = document.createElement('a');
    lastPage.className = 'last-page-btn';
    lastPage.href = entry.lastPageUrl;
    lastPage.target = '_blank';
    lastPage.rel = 'noopener noreferrer';
    lastPage.textContent = Number.isFinite(entry.lastPageNo) && entry.lastPageNo > 0
      ? t('lastPage', { pageNo: String(entry.lastPageNo) })
      : t('lastPageUnknown');
    actions.appendChild(lastPage);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete-btn';
  remove.textContent = t('deleteEntry');
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    await chrome.runtime.sendMessage({ type: 'EHPLUS_HISTORY_DELETE', gid: entry.gid }).catch(() => null);
    refresh();
  });
  actions.appendChild(remove);

  return actions;
}

function formatDateTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time);
  const pad = (input) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function t(key, params = {}) {
  let text = I18N[language]?.[key] ?? I18N['zh-CN'][key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

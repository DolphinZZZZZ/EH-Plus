export const AUTOPAGER_COMPATIBILITY_MODE = 'auto-pager-compat';

const DETECTION_RULES = [
  {
    id: 'super-preloader-container',
    name: 'Super-preloader',
    confidence: 0.95,
    selectors: ['#sp-fw-container', '.sp-separator', '.sp-sp-nextlink', '[id^="sp-exhentai-img-"]']
  },
  {
    id: 'super-preloader-event',
    name: 'Super-preloader',
    confidence: 0.9,
    events: ['Super_preloaderPageLoaded']
  },
  {
    id: 'pagetual-markers',
    name: 'Pagetual',
    confidence: 0.9,
    selectors: ['#pagetual-sideController', '#pagetual-preload', '.pagetual_pageBar', '[data-pagetual]']
  },
  {
    id: 'pagetual-message',
    name: 'Pagetual',
    confidence: 0.9,
    messages: [
      { command: 'pagetual' },
      { source: 'pagetual' }
    ]
  },
  {
    id: 'autopagerize-markers',
    name: 'AutoPagerize',
    confidence: 0.86,
    selectors: ['.autopagerize_page_separator', '.autopagerize_page_info', '#autopagerize_icon']
  },
  {
    id: 'infy-scroll-markers',
    name: 'Infy Scroll',
    confidence: 0.86,
    selectors: ['#infy-scroll-current-page', '#infy-scroll-pages', '.infy-scroll-page', '.infy-scroll-separator']
  },
  {
    id: 'generic-next-page-inserts',
    name: 'Generic auto-pager',
    confidence: 0.72,
    minInsertedReaderPages: 2
  },
  {
    id: 'generic-fast-reader-requests',
    name: 'Generic auto-pager',
    confidence: 0.68,
    minRecentReaderRequests: 2,
    requestWindowMs: 1500
  }
];

export function detectAutoPagerCompatibility(input = {}, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.72;
  const matches = DETECTION_RULES
    .map((rule) => matchDetectionRule(rule, input))
    .filter(Boolean);
  const confidence = matches.reduce((max, match) => Math.max(max, match.confidence), 0);

  return {
    detected: confidence >= threshold,
    mode: confidence >= threshold ? AUTOPAGER_COMPATIBILITY_MODE : 'normal',
    shouldYieldNextPageRequests: confidence >= threshold,
    confidence,
    matches
  };
}

export function summarizeDomForAutoPagerDetection(root = globalThis.document) {
  if (!root?.querySelectorAll) {
    return {
      selectors: [],
      insertedReaderPages: 0
    };
  }

  const selectors = [];
  for (const selector of knownSelectors()) {
    if (root.querySelector(selector)) selectors.push(selector);
  }

  return {
    selectors,
    insertedReaderPages: countInsertedReaderPages(root)
  };
}

function matchDetectionRule(rule, input) {
  if (rule.selectors && !rule.selectors.some((selector) => inputHasSelector(input, selector))) {
    return null;
  }

  if (rule.events && !rule.events.some((event) => inputHasEvent(input, event))) {
    return null;
  }

  if (rule.messages && !rule.messages.some((message) => inputHasMessage(input, message))) {
    return null;
  }

  if (rule.minInsertedReaderPages && Number(input.insertedReaderPages ?? 0) < rule.minInsertedReaderPages) {
    return null;
  }

  if (rule.minRecentReaderRequests) {
    const count = countRecentReaderRequests(input.recentRequests, rule.requestWindowMs, input.now);
    if (count < rule.minRecentReaderRequests) return null;
  }

  return {
    id: rule.id,
    name: rule.name,
    confidence: rule.confidence
  };
}

function inputHasSelector(input, selector) {
  if (Array.isArray(input.selectors) && input.selectors.includes(selector)) return true;
  if (input.selectorCounts?.[selector] > 0) return true;
  if (input.dom?.querySelector) return Boolean(input.dom.querySelector(selector));
  return false;
}

function inputHasEvent(input, type) {
  return (input.events ?? []).some((event) => {
    const value = typeof event === 'string' ? event : event?.type;
    return value === type;
  });
}

function inputHasMessage(input, expected) {
  return (input.messages ?? []).some((message) => {
    const detail = message?.detail ?? message?.data ?? message;
    return Object.entries(expected).every(([key, value]) => detail?.[key] === value);
  });
}

function countRecentReaderRequests(requests = [], requestWindowMs = 1500, now = null) {
  const normalized = requests
    .map((request) => ({
      at: Number(request?.at),
      url: String(request?.url ?? '')
    }))
    .filter((request) => Number.isFinite(request.at) && isReaderPageUrl(request.url))
    .sort((a, b) => b.at - a.at);

  if (normalized.length === 0) return 0;

  const reference = Number.isFinite(Number(now)) ? Number(now) : normalized[0].at;
  return normalized.filter((request) => reference - request.at <= requestWindowMs).length;
}

function countInsertedReaderPages(root) {
  const images = root.querySelectorAll('img[src]');
  let insertedImages = 0;

  for (const img of images) {
    if (img?.id === 'img') continue;
    if (!isLikelyReaderImageUrl(readUrl(img, 'src'))) continue;
    insertedImages += 1;
  }

  return insertedImages;
}

function isLikelyReaderImageUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url, globalThis.location?.href);
    return parsed.hostname.endsWith('.hath.network')
      || parsed.pathname.includes('/fullimg.php');
  } catch {
    return false;
  }
}

function readUrl(element, name) {
  if (!element) return '';
  if (typeof element[name] === 'string') return element[name];
  if (typeof element.getAttribute === 'function') return element.getAttribute(name) ?? '';
  return '';
}

function isReaderPageUrl(url) {
  return parseReaderPageKey(url) !== null;
}

function parseReaderPageKey(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  try {
    const parsed = new URL(url, globalThis.location?.href);
    const match = parsed.pathname.match(/^\/s\/[^/]+\/(\d+)-(\d+)\/?$/);
    if (!match) return null;
    return `${match[1]}:${Number(match[2])}`;
  } catch {
    return null;
  }
}

function knownSelectors() {
  return [...new Set(DETECTION_RULES.flatMap((rule) => rule.selectors ?? []))];
}

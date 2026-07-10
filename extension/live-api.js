export const RESET_QUOTA_BODY = 'reset_imagelimit=Reset+Quota';

const ACCOUNT_ORIGIN = 'https://e-hentai.org';
const EH_ORIGINS = new Set(['https://e-hentai.org', 'https://exhentai.org']);

export function resolveEhOrigin(sender) {
  const candidates = [
    sender?.tab?.url,
    sender?.url,
    sender?.origin
  ];

  for (const candidate of candidates) {
    try {
      const origin = new URL(candidate).origin;
      if (EH_ORIGINS.has(origin)) return origin;
    } catch {
      // Ignore malformed sender values.
    }
  }

  return 'https://e-hentai.org';
}

export async function readLiveAccountStatus(sender, options = {}) {
  const origin = resolveAccountOrigin();
  const { texts, requestDetails } = await fetchRequiredTexts([
    { source: 'home', url: `${origin}/home.php` },
    { source: 'exchange-hath', url: `${origin}/exchange.php?t=hath` },
    { source: 'exchange-gp', url: `${origin}/exchange.php?t=gp` }
  ], 'EH account refresh failed', options);

  const quota = parseHomeQuota(texts.home);
  const hathBalances = parseExchangeBalances(texts['exchange-hath']);
  const gpBalances = parseExchangeBalances(texts['exchange-gp']);
  const balances = mergeBalances(hathBalances, gpBalances);

  return {
    quotaUsed: quota.used,
    quotaLimit: quota.limit,
    resetCostGp: quota.resetCostGp,
    credits: balances.credits,
    gp: balances.gp,
    hath: balances.hath,
    quotaTone: quotaColor({ used: quota.used, limit: quota.limit }),
    updatedAt: Date.now(),
    origin,
    sources: [
      `${origin}/home.php`,
      `${origin}/exchange.php?t=hath`,
      `${origin}/exchange.php?t=gp`
    ],
    requestDetails
  };
}

export async function readLiveDawnEvent(sender, options = {}) {
  const origin = resolveAccountOrigin();
  const url = `${origin}/news.php`;
  const { text: html, detail } = await fetchText(url, { source: 'news' }, options);
  const event = parseDawnEvent(html);
  return {
    ...(event.type === 'unknown' && detail?.ok ? {
      ...event,
      type: 'alreadyClaimed'
    } : event),
    checkedAt: Date.now(),
    origin,
    sourceUrl: url,
    requestDetails: [detail]
  };
}

export async function postLiveQuotaReset(sender, options = {}) {
  const origin = resolveAccountOrigin();
  const url = `${origin}/home.php`;
  const { detail } = await fetchText(url, {
    source: 'quota-reset-post',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: RESET_QUOTA_BODY
  }, options);

  return { ok: true, url, body: RESET_QUOTA_BODY, requestDetails: [detail] };
}

function resolveAccountOrigin() {
  return ACCOUNT_ORIGIN;
}

async function fetchRequiredTexts(requests, failureMessage, options = {}) {
  const results = await Promise.allSettled(requests.map((request) => fetchText(request.url, {
    source: request.source,
    method: request.method,
    headers: request.headers,
    body: request.body
  }, options)));
  const requestDetails = results.flatMap((result) => {
    if (result.status === 'fulfilled') return [result.value.detail];
    return result.reason?.requestDetails ?? [];
  });
  const failed = results.find((result) => result.status === 'rejected');

  if (failed) {
    throw new EhRequestError(`${failureMessage}: ${failed.reason?.message ?? 'unknown error'}`, requestDetails, {
      cause: failed.reason
    });
  }

  return {
    texts: Object.fromEntries(requests.map((request, index) => [request.source, results[index].value.text])),
    requestDetails
  };
}

async function fetchText(url, init = {}, options = {}) {
  const startedAt = Date.now();
  const method = init.method ?? 'GET';
  let response = null;
  let text = '';

  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      cache: 'no-store'
    });
    text = await response.text();
  } catch (error) {
    const detail = buildRequestDetail({
      source: init.source,
      url,
      method,
      startedAt,
      response,
      text,
      error,
      debugTextEnabled: options.debugTextEnabled
    });
    throw new EhRequestError(`EH request failed: ${error.message} ${url}`, [detail], { cause: error });
  }

  const detail = buildRequestDetail({
    source: init.source,
    url,
    method,
    startedAt,
    response,
    text,
    debugTextEnabled: options.debugTextEnabled
  });

  if (!response.ok) {
    throw new EhRequestError(`EH request failed: HTTP ${response.status} ${url}`, [detail]);
  }

  return { text, detail };
}

class EhRequestError extends Error {
  constructor(message, requestDetails = [], options = {}) {
    super(message, options);
    this.name = 'EhRequestError';
    this.requestDetails = requestDetails;
  }
}

export function buildRequestDetail({ source, url, method, startedAt, response, text, error, debugTextEnabled }) {
  const contentType = response?.headers?.get?.('content-type') ?? '';
  const detail = {
    source: source ?? 'eh-request',
    method,
    url,
    finalUrl: response?.url || url,
    status: response?.status ?? null,
    ok: Boolean(response?.ok),
    redirected: Boolean(response?.redirected),
    contentType,
    durationMs: Math.max(0, Date.now() - startedAt),
    title: extractTitle(text),
    textChars: String(text ?? '').length,
    textSample: sampleText(text),
    error: error ? String(error.message ?? error) : null
  };

  if (debugTextEnabled === true && isTextContentType(contentType)) {
    detail.debugText = String(text ?? '');
    detail.debugTextChars = detail.debugText.length;
    detail.debugTextCapturedAt = Date.now();
  }

  return detail;
}

function isTextContentType(contentType) {
  const type = String(contentType ?? '').toLowerCase();
  if (!type) return true;
  return type.startsWith('text/')
    || type.includes('html')
    || type.includes('xml')
    || type.includes('json')
    || type.includes('javascript')
    || type.includes('x-www-form-urlencoded');
}

function extractTitle(html) {
  const match = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeText(match[1]).slice(0, 120) : '';
}

function sampleText(html) {
  return normalizeText(html).slice(0, 240);
}

function parseHomeQuota(html) {
  const text = normalizeText(html);
  const quotaMatch = text.match(/Image\s+Limits?\s*:?\s*([\d,]+)\s*\/\s*([\d,]+)/i)
    ?? text.match(/currently\s+at\s+([\d,]+)\s+towards\s+your\s+account\s+limit\s+of\s+([\d,]+)/i)
    ?? text.match(/限额\s*:?\s*([\d,]+)\s*\/\s*([\d,]+)/);
  const resetMatch = text.match(/Reset\s+(?:Quota|Cost)\s*:?\s*([\d,]+)\s*GP/i)
    ?? text.match(/reset\s+your\s+image\s+quota\s+by\s+spending\s+([\d,]+)\s*GP/i)
    ?? text.match(/重置\s*:?\s*([\d,]+)\s*GP/i);

  return {
    used: quotaMatch ? parseInteger(quotaMatch[1]) : null,
    limit: quotaMatch ? parseInteger(quotaMatch[2]) : null,
    resetCostGp: resetMatch ? parseInteger(resetMatch[1]) : null
  };
}

function parseExchangeBalances(html) {
  const text = normalizeText(html);
  return {
    credits: readAvailableAmount(text, 'Credits'),
    hath: readAvailableAmount(text, 'Hath'),
    gp: readAvailableAmount(text, 'kGP', 1000)
  };
}

function parseDawnEvent(html) {
  const text = normalizeEventText(html);
  const links = extractLinks(html);

  if (!text) {
    return { type: 'empty', rewards: {}, message: '' };
  }

  if (/It is the dawn of a new day!/i.test(text)) {
    return {
      type: 'dawn',
      rewards: parseRewards(text),
      message: text,
      links
    };
  }

  if (/already\s+(claimed|collected|received)|claimed\s+today|today'?s\s+Dawn/i.test(text)) {
    return {
      type: 'alreadyClaimed',
      rewards: {},
      message: text,
      links
    };
  }

  if (/You have encountered a monster!/i.test(text) || links.some((link) => /hentaiverse\.org/i.test(link.href))) {
    return {
      type: 'alreadyClaimed',
      rewards: {},
      message: text,
      links
    };
  }

  return {
    type: 'unknown',
    rewards: {},
    message: text,
    links
  };
}

function quotaColor({ used, limit }) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return 'unknown';
  }

  if (used > limit) return 'red';
  if (used / limit >= 0.5) return 'yellow';
  return 'green';
}

function mergeBalances(...items) {
  const result = {};
  for (const key of ['credits', 'gp', 'hath']) {
    const value = items.map((item) => item?.[key]).find((item) => Number.isFinite(item));
    result[key] = value ?? null;
  }
  return result;
}

function normalizeText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEventText(html) {
  const eventPaneMatch = String(html).match(/<div[^>]+id=["']eventpane["'][^>]*>([\s\S]*?)<\/div>/i);
  return normalizeText(eventPaneMatch ? eventPaneMatch[1] : html);
}

function readAvailableAmount(text, unit, multiplier = 1) {
  const pattern = new RegExp(`Available\\s*:?\\s*([\\d,]+)\\s*${escapeRegExp(unit)}\\b`, 'i');
  const match = text.match(pattern);
  return match ? parseInteger(match[1]) * multiplier : null;
}

function parseRewards(text) {
  const rewards = {};
  const patterns = [
    ['exp', /([\d,]+)\s+EXP/i],
    ['credits', /([\d,]+)\s+Credits?/i],
    ['gp', /([\d,]+)\s+GP/i],
    ['hath', /([\d,]+)\s+Hath/i]
  ];

  for (const [key, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) {
      rewards[key] = parseInteger(match[1]);
    }
  }

  return rewards;
}

function extractLinks(html) {
  return [...String(html).matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: match[1],
    text: match[2].replace(/<[^>]+>/g, '').trim()
  }));
}

function parseInteger(value) {
  return Number(String(value).replace(/,/g, ''));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

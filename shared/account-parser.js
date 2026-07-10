export function parseHomeQuota(html) {
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

export function parseExchangeBalances(html) {
  const text = normalizeText(html);
  return {
    credits: readAvailableAmount(text, 'Credits'),
    hath: readAvailableAmount(text, 'Hath'),
    gp: readAvailableAmount(text, 'kGP', 1000)
  };
}

export function quotaColor({ used, limit }) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return 'unknown';
  }

  if (used > limit) return 'red';
  if (used / limit >= 0.5) return 'yellow';
  return 'green';
}

function normalizeText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readAvailableAmount(text, unit, multiplier = 1) {
  const pattern = new RegExp(`Available\\s*:?\\s*([\\d,]+)\\s*${escapeRegExp(unit)}\\b`, 'i');
  const match = text.match(pattern);
  return match ? parseInteger(match[1]) * multiplier : null;
}

function parseInteger(value) {
  return Number(String(value).replace(/,/g, ''));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

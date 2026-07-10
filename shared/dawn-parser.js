export function parseDawnEvent(html) {
  const text = normalizeText(html);
  const links = extractLinks(html);

  if (!text) {
    return { type: 'empty', rewards: {}, message: '' };
  }

  if (/It is the dawn of a new day!/i.test(text)) {
    return {
      type: 'dawn',
      rewards: parseRewards(text),
      message: text
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
      rewards[key] = Number(match[1].replace(/,/g, ''));
    }
  }

  return rewards;
}

function normalizeText(html) {
  const eventPaneMatch = String(html).match(/<div[^>]+id=["']eventpane["'][^>]*>([\s\S]*?)<\/div>/i);
  const scoped = eventPaneMatch ? eventPaneMatch[1] : String(html);

  return scoped
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html) {
  return [...String(html).matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: match[1],
    text: match[2].replace(/<[^>]+>/g, '').trim()
  }));
}

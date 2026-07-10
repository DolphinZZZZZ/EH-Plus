const EH_READER_OR_GALLERY_PATTERN = /^https:\/\/(?:e-hentai|exhentai)\.org\/(?:g|s)\//i;
export const MAX_ACCOUNT_REFRESH_ACTIVE_TABS = 80;
const MAX_FALLBACK_TAB_URL_LENGTH = 240;

export function isAccountRefreshPageUrl(url) {
  return typeof url === 'string' && EH_READER_OR_GALLERY_PATTERN.test(url);
}

export function summarizeAccountRefreshTabs(tabs = []) {
  const activeTabs = tabs
    .filter((tab) => isAccountRefreshPageUrl(tab?.url))
    .slice(0, MAX_ACCOUNT_REFRESH_ACTIVE_TABS)
    .map((tab) => ({
      id: tab.id ?? null,
      url: summarizeAccountRefreshTabUrl(tab.url)
    }));

  return {
    activeCount: activeTabs.length,
    activeTabs,
    hasActivePages: activeTabs.length > 0
  };
}

export function summarizeAccountRefreshTabUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, MAX_FALLBACK_TAB_URL_LENGTH);
  }
}

export function shouldRefreshAccountOnTabTransition(previousActiveCount, nextActiveCount) {
  return normalizeCount(previousActiveCount) === 0 && normalizeCount(nextActiveCount) > 0;
}

function normalizeCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

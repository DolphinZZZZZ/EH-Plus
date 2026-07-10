export const RESET_QUOTA_URL = 'https://e-hentai.org/home.php';
export const RESET_QUOTA_BODY = 'reset_imagelimit=Reset+Quota';

export function buildResetQuotaRequest() {
  return {
    method: 'POST',
    url: RESET_QUOTA_URL,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: RESET_QUOTA_BODY
  };
}

export function calculateBalanceDelta(before, after) {
  const keys = ['credits', 'gp', 'hath'];
  const delta = {};

  for (const key of keys) {
    const beforeValue = before?.[key] ?? 0;
    const afterValue = after?.[key] ?? 0;
    const diff = afterValue - beforeValue;
    if (diff !== 0) {
      delta[key] = diff;
    }
  }

  return delta;
}

export function shouldShowActualCost({ nominalGp, delta }) {
  const entries = Object.entries(delta ?? {});
  if (entries.length === 0) {
    return false;
  }

  return !(entries.length === 1 && delta.gp === -nominalGp);
}


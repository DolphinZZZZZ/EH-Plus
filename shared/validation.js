export function parseNonNegativeIntegerDays(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return { ok: false, error: '请输入非负整数天数' };
    }
    return { ok: true, value };
  }

  const text = String(value ?? '').trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    return { ok: false, error: '请输入非负整数天数' };
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, error: '请输入非负整数天数' };
  }

  return { ok: true, value: parsed };
}

export function imageCleanupZeroDayMessage() {
  return '0天表示不按照时间清理缓存。';
}

/** Same rules as the backend's normalize_number and the Kotlin screening service. */
export function normalizeNumber(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

/**
 * True when the phone/carrier attached a scam or spam label as the caller's name
 * (e.g. "Scam Likely", "Potential Scam", "Suspected spam").
 */
export function isScamLabel(name: string | null | undefined): boolean {
  return /scam|spam|fraud/i.test(name ?? '');
}

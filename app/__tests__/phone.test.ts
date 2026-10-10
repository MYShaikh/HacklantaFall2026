import { isScamLabel, normalizeNumber } from '../src/phone';

// These cases mirror backend/blocking/tests.py so the app, API and screening service agree.
describe('normalizeNumber', () => {
  it('adds +1 to US numbers', () => {
    expect(normalizeNumber('(404) 555-0100')).toBe('+14045550100');
    expect(normalizeNumber('1-404-555-0100')).toBe('+14045550100');
  });
  it('keeps international numbers', () => {
    expect(normalizeNumber('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('returns empty for junk', () => {
    expect(normalizeNumber('abc')).toBe('');
    expect(normalizeNumber(null)).toBe('');
  });
});

describe('isScamLabel', () => {
  it('matches common carrier and dialer labels', () => {
    ['Scam Likely', 'SCAM LIKELY', 'Potential Scam', 'Suspected spam', 'Spam Risk', 'Fraud Alert'].forEach(l =>
      expect(isScamLabel(l)).toBe(true),
    );
  });
  it('ignores normal names', () => {
    ['Mom', 'Dr. Smith', '', null, undefined].forEach(l => expect(isScamLabel(l)).toBe(false));
  });
});

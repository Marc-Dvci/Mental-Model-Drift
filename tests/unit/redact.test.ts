/**
 * Redaction runs on ambient audio transcripts. People read tokens aloud during
 * pairing and narrate what they are pasting, so the scan happens before an
 * utterance is stored or sent anywhere -- in addition to, never instead of,
 * keeping as little transcript as possible.
 */
import { describe, expect, it } from 'vitest';
import { hasSecret, redact } from '#engine/redact';

describe('redact', () => {
  const secrets: [string, string][] = [
    ['aws-access-key-id', 'the key is AKIAIOSFODNN7EXAMPLE and it expired'],
    ['github-token', 'try ghp_1234567890abcdefghijklmnopqrstuvwx now'],
    ['slack-token', 'xoxb-123456789012-abcdefghijklmno is the bot token'],
    ['anthropic-key', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa was rotated'],
    ['jwt', 'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['bearer-token', 'send Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['connection-string', 'postgres://app:hunter2hunter2@db.internal:5432/checkout'],
    ['password-assignment', 'password: hunter2hunter2'],
  ];

  for (const [kind, text] of secrets) {
    it(`removes a ${kind}`, () => {
      const r = redact(text);
      expect(r.hits.map((h) => h.kind)).toContain(kind);
      expect(r.text).toContain(`[redacted:${kind}]`);
    });
  }

  it('leaves ordinary engineering speech untouched', () => {
    for (const text of [
      'The checkout worker retries three times before the DLQ.',
      'We are still running 4.12 in production.',
      'The events table stores the source IP.',
    ]) {
      expect(redact(text)).toEqual({ text, hits: [] });
      expect(hasSecret(text)).toBe(false);
    }
  });

  it('keeps the surrounding sentence, so the claim in it is still readable', () => {
    const r = redact('I exported AKIAIOSFODNN7EXAMPLE and then the checkout worker retried three times.');
    expect(r.text).toMatch(/the checkout worker retried three times/);
  });

  it('removes several secrets from one utterance', () => {
    const r = redact('key AKIAIOSFODNN7EXAMPLE and token ghp_1234567890abcdefghijklmnopqrstuvwx');
    expect(r.hits).toHaveLength(2);
    expect(r.text).not.toMatch(/AKIA|ghp_/);
  });
});

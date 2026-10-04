/**
 * Deterministic secret redaction, applied before any utterance leaves the
 * machine and before any source content is stored.
 *
 * This runs on ambient audio transcripts. People read tokens aloud during
 * pairing sessions and paste keys into terminals while narrating what they are
 * doing. Redaction here is a pattern scan, not a classifier: it can only catch
 * shapes it knows, and it is applied in addition to -- never instead of --
 * storing as little transcript as possible.
 */

export interface RedactionHit {
  kind: string;
  at: number;
  length: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'aws-access-key-id', re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[0-9A-Z]{16})\b/g },
  { kind: 'aws-secret-access-key', re: /\b(?:aws_)?secret(?:_access)?_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi },
  { kind: 'github-token', re: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/g },
  { kind: 'slack-token', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: 'anthropic-key', re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g },
  { kind: 'openai-key', re: /\b(sk-[A-Za-z0-9]{32,})\b/g },
  { kind: 'jwt', re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g },
  { kind: 'bearer-token', re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{20,})/g },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: 'password-assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*["']?([^\s"',;]{8,})["']?/gi },
  { kind: 'connection-string', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+)/gi },
];

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

export function redact(input: string): RedactionResult {
  let text = input;
  const hits: RedactionHit[] = [];
  for (const { kind, re } of PATTERNS) {
    text = text.replace(new RegExp(re.source, re.flags), (match, captured?: string) => {
      const secret = captured ?? match;
      hits.push({ kind, at: 0, length: secret.length });
      return match.replace(secret, `[redacted:${kind}]`);
    });
  }
  return { text, hits };
}

export function hasSecret(input: string): boolean {
  return redact(input).hits.length > 0;
}

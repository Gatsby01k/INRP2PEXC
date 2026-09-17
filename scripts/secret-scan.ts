/**
 * Repository secret scan (SECURITY §5): private keys, seed phrases, raw 64-hex keys, cloud tokens.
 * Runs on tracked files; CI fails on any finding. Test fixtures use obviously fake values only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES: { name: string; re: RegExp }[] = [
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'raw 64-hex secret (possible wallet private key)', re: /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { name: 'BIP-39 style seed phrase', re: /\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse)(?:\s+[a-z]{3,8}){11,23}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'generic assigned secret', re: /(?:secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/i },
];

const ALLOW = [/^docs\/source\//, /pnpm-lock\.yaml$/, /^brand\//, /\.png$/];
/** Lines explicitly marked as test-only fixtures. */
const ALLOW_LINE = /secret-scan:allow/;

export function scanText(path: string, text: string): string[] {
  const findings: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (ALLOW_LINE.test(line)) return;
    for (const r of RULES) if (r.re.test(line)) findings.push(`${path}:${i + 1}: ${r.name}`);
  });
  return findings;
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const findings = files.filter((f) => !ALLOW.some((a) => a.test(f))).flatMap((f) => {
    try {
      return scanText(f, readFileSync(f, 'utf8'));
    } catch {
      return [];
    }
  });
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exit(1);
  }
  console.log(`secret scan: ${files.length} files clean`);
}

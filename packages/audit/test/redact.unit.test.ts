import { describe, expect, it } from 'vitest';
import { Money } from '@inrp2p/kernel';
import { REDACTED, redact } from '../src/redact.ts';

describe('audit redaction', () => {
  it('masks bank data, UTRs, contact details and drops secrets', () => {
    const out = redact({
      account_number: '50100123458219', utr: 'HDFCR52026091612345', email: 'alex@acmepay.in', phone: '+919812345678',
      password: 'hunter2hunter2', secret: 'JBSWY3DPEHPK3PXP', otp: '123456', token: 'abc', nested: { accessToken: 'x', ifsc: 'HDFC0001234' },
      amount: Money.parse('10200000', 'INR'), big: 9007199254740993n,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      account_number: '••••8219', utr: '••••2345', email: 'a•••@acmepay.in', phone: '••••5678',
      password: REDACTED, secret: REDACTED, otp: REDACTED, token: REDACTED,
      amount: { amount: '10200000.00', currency: 'INR' }, big: '9007199254740993',
    });
    expect((out.nested as Record<string, unknown>).ifsc).toBe('HDFC0001234');
    expect(JSON.stringify(out)).not.toMatch(/50100123458219|HDFCR52026091612345|hunter2|JBSWY3DP|123456/);
  });
});

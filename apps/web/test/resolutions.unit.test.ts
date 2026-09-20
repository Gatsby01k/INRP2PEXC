import { describe, expect, it } from 'vitest';
import { EXCEPTION_TYPES, NON_FINANCIAL_RESOLUTIONS } from '@inrp2p/settlement';
import { FALLBACK, RESOLUTIONS, resolutionsFor } from '../src/components/panels/resolutions.ts';

/**
 * Every exception type must be closable from the desk.
 *
 * A blocking case holds its trade, and a trade on hold pays nobody. So a case type the desk cannot resolve is
 * not a gap in the UI — it is a client whose money has stopped moving with no one able to start it again. This
 * test is what keeps that from happening quietly when the domain grows a new case.
 */
describe('exception resolutions', () => {
  it.each(EXCEPTION_TYPES)('%s offers a resolution the domain accepts', (type) => {
    const choices = RESOLUTIONS[type];
    expect(choices, `${type} has no entry in the desk's resolution table`).toBeDefined();
    expect(choices.resolutions.length).toBeGreaterThan(0);
    for (const option of choices.resolutions) {
      expect(NON_FINANCIAL_RESOLUTIONS).toContain(option.value);
      expect(option.label.length).toBeGreaterThan(3);
    }
  });

  it('never resolves a live case through the unknown-type fallback', () => {
    for (const type of EXCEPTION_TYPES) expect(resolutionsFor(type)).not.toBe(FALLBACK);
    expect(resolutionsFor('SOMETHING_NEW')).toBe(FALLBACK);
  });

  it('lists no exception type the domain does not have', () => {
    for (const type of Object.keys(RESOLUTIONS)) expect(EXCEPTION_TYPES).toContain(type);
  });

  it('offers more than escalation wherever the domain has a real way out', () => {
    // Escalation alone is honest only where the case closes by itself or by another screen's command.
    const escalationOnly = EXCEPTION_TYPES.filter((t) => RESOLUTIONS[t].resolutions.every((o) => o.value === 'escalate'));
    expect(escalationOnly).toEqual(['TX_NOT_FINAL', 'INR_PAYOUT_DELAYED', 'TRADE_CANCELLATION']);
    for (const type of escalationOnly) {
      expect(RESOLUTIONS[type].voidable || RESOLUTIONS[type].financial !== null).toBe(true);
    }
  });
});

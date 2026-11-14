import { describe, expect, it } from 'vitest';
import { maskVpa, requireRegisteredVpa } from '../src/index.ts';

/** A UPI ID a person registers (ADR 0029): a real `name@handle`, never an address made up from an account number. */
describe('requireRegisteredVpa', () => {
  it('takes a UPI ID as apps print it, lower-cased and trimmed', () => {
    expect(requireRegisteredVpa(' Rahul.Sharma@OKHDFCBANK ')).toBe('rahul.sharma@okhdfcbank');
    expect(requireRegisteredVpa('9876543210@ybl')).toBe('9876543210@ybl');
    expect(requireRegisteredVpa('meera-textiles@icici')).toBe('meera-textiles@icici');
  });

  it('refuses the account-and-IFSC address registered UPI IDs replace, and anything that is not a UPI ID', () => {
    expect(() => requireRegisteredVpa('50100123458219@hdfc0001234.ifsc.npci')).toThrow(/not one made from an account number/);
    expect(() => requireRegisteredVpa('9876543210@mmid.npci')).toThrow(/not one made from an account number/);
    for (const bad of ['rahul', '@okaxis', 'rahul@', 'rahul@@okaxis', 'ra hul@okaxis', 'rahul@1bank', '', null, 42]) {
      expect(() => requireRegisteredVpa(bad), String(bad)).toThrow(/UPI ID/);
    }
  });
});

describe('maskVpa', () => {
  it('keeps the handle and two letters: enough to recognise, not to pay', () => {
    expect(maskVpa('rahul.sharma@okhdfcbank')).toBe('ra•••@okhdfcbank');
    expect(maskVpa('ab@ybl')).toBe('ab•••@ybl');
    expect(maskVpa('nonsense')).toBe('•••');
  });
});

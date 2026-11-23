import { describe, expect, it } from 'vitest';
import { decimalToMicro, extraRupees, fixFor, formatDay, formatPremium, parseEcbDollar, premiumHundredths, toPaisa } from '../src/server/premium-math.ts';

/** The ECB's answer to `EXR/D.USD+INR.EUR.SP00.A?format=csvdata&detail=dataonly`, as it came on 2026-11-22. */
const ECB = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,2026-11-18,102.4905
EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,2026-11-19,102.55
EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,2026-11-20,101.85
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-18,1.0968
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-19,1.0992
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-20,1.099
`;

describe('India USDT premium arithmetic', () => {
  it('reads decimals as micro-units, rounding past the sixth place', () => {
    expect(decimalToMicro('101.85')).toBe(101_850_000n);
    expect(decimalToMicro('1.0968')).toBe(1_096_800n);
    expect(decimalToMicro('92.6751595')).toBe(92_675_160n);
    expect(decimalToMicro('92.6751594')).toBe(92_675_159n);
    expect(decimalToMicro('7')).toBe(7_000_000n);
    for (const bad of ['', 'NaN', '-1', '1,5', '1.2.3']) expect(decimalToMicro(bad)).toBeNull();
  });

  it('takes the dollar in rupees as the ECB cross rate, day by day, oldest first', () => {
    const fixes = parseEcbDollar(ECB);
    expect(fixes.map((f) => f.date)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    // 101.85 rupees per euro over 1.099 dollars per euro: ₹92.675159 a dollar.
    expect(fixes[2]!.micro).toBe(92_675_159n);
    expect(fixes[0]!.micro).toBe(93_445_022n);
  });

  it('keeps only the days both currencies were published, and skips what it cannot read', () => {
    const csv = `${ECB}EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,2026-11-21,101.9\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-21,NaN\ngarbage\n`;
    expect(parseEcbDollar(csv).map((f) => f.date)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(parseEcbDollar('')).toEqual([]);
    expect(parseEcbDollar('A,B\n1,2')).toEqual([]);
  });

  it('measures a day against the last fix published for it, so a weekend keeps Friday’s', () => {
    const fixes = parseEcbDollar(ECB);
    expect(fixFor('2026-11-20', fixes)?.date).toBe('2026-11-20');
    expect(fixFor('2026-11-22', fixes)?.date).toBe('2026-11-20');
    expect(fixFor('2026-11-17', fixes)).toBeNull();
  });

  it('works the premium out in hundredths of a percent, rounded half away from zero', () => {
    // ₹103.71 against ₹93.2951 a dollar: +11.16 %.
    expect(premiumHundredths(103_710_000n, 93_295_100n)).toBe(1116n);
    expect(premiumHundredths(100_000_000n, 100_000_000n)).toBe(0n);
    expect(premiumHundredths(100_005_000n, 100_000_000n)).toBe(1n);
    expect(premiumHundredths(99_995_000n, 100_000_000n)).toBe(-1n);
    expect(premiumHundredths(99_600_000n, 100_000_000n)).toBe(-40n);
  });

  it('shows the premium with its sign and two places', () => {
    expect(formatPremium(1127n)).toBe('+11.27%');
    expect(formatPremium(5n)).toBe('+0.05%');
    expect(formatPremium(0n)).toBe('0.00%');
    expect(formatPremium(-40n)).toBe('−0.40%');
  });

  it('says what the premium comes to on a round amount, in whole rupees', () => {
    // ₹104.43 against ₹92.675159, on USDT worth a thousand dollars: ₹11,754.84 → ₹11,755.
    expect(extraRupees(104_430_000n, 92_675_159n, 1_000)).toBe(11_755n);
    expect(extraRupees(92_000_000n, 92_675_159n, 1_000)).toBe(-675n);
  });

  it('rounds a rate to the paisa, and writes a day the way the page does', () => {
    expect(toPaisa(92_675_159n)).toBe(92_680_000n);
    expect(toPaisa(92_674_999n)).toBe(92_670_000n);
    expect(formatDay('2026-11-20')).toBe('20 Nov');
    expect(formatDay('2026-01-05', true)).toBe('5 Jan 2026');
  });
});

import type { Meta, StoryObj } from '@storybook/react-vite';
import { COLOR, CONTRAST_REQUIREMENTS, FONT_SIZE, RADIUS, SPACE } from '../tokens/tokens.ts';
import { contrastRatio } from '../tokens/contrast.ts';
import { formatInr, formatInrCompact, formatRate, formatUsdt, formatUsdtHeadline } from '../format/money.ts';
import { CANONICAL_BUY, CANONICAL_SELL, clientRate, inr, routeRate, usdt } from '../fixtures.ts';

const meta = { title: 'Foundations/Tokens', parameters: { surface: 'surface' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Colors: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--space-4)' }}>
      {Object.entries(COLOR).map(([name, value]) => (
        <figure key={name} style={{ margin: 0 }}>
          <div style={{ height: 56, borderRadius: 'var(--radius-control)', border: '1px solid var(--border-default)', background: `var(--${name})` }} />
          <figcaption style={{ fontSize: 'var(--font-size-meta)', marginTop: 'var(--space-1)' }}>
            <strong style={{ fontWeight: 500 }}>--{name}</strong>
            <br />
            <span className="ix-num" style={{ color: 'var(--text-secondary)' }}>{value}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  ),
};

export const ContrastPairs: Story = {
  render: () => (
    <table style={{ borderCollapse: 'collapse', fontSize: 'var(--font-size-table)' }}>
      <caption style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 'var(--space-2)' }}>WCAG AA pairs used by components</caption>
      <thead>
        <tr>
          {['Sample', 'Foreground', 'Background', 'Ratio', 'Required', 'Use'].map((h) => (
            <th key={h} scope="col" style={{ textAlign: 'left', padding: 'var(--space-1) var(--space-3)', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CONTRAST_REQUIREMENTS.filter((r) => r.min === 4.5).map((r) => {
          const ratio = contrastRatio(COLOR[r.fg], COLOR[r.bg]);
          return (
            <tr key={`${r.fg}-${r.bg}`}>
              <td style={{ padding: 'var(--space-1) var(--space-3)' }}>
                <span style={{ display: 'inline-block', padding: '0 var(--space-2)', color: `var(--${r.fg})`, background: `var(--${r.bg})`, borderRadius: 'var(--radius-control)' }}>₹10,200,000</span>
              </td>
              <td style={{ padding: 'var(--space-1) var(--space-3)' }}>--{r.fg}</td>
              <td style={{ padding: 'var(--space-1) var(--space-3)' }}>--{r.bg}</td>
              <td className="ix-num" style={{ padding: 'var(--space-1) var(--space-3)' }}>{ratio.toFixed(2)}:1</td>
              <td className="ix-num" style={{ padding: 'var(--space-1) var(--space-3)' }}>{r.min}:1</td>
              <td style={{ padding: 'var(--space-1) var(--space-3)', color: 'var(--text-secondary)' }}>{r.use}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  ),
};

export const Typography: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {Object.entries(FONT_SIZE).map(([name, px]) => (
        <div key={name} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', alignItems: 'baseline', gap: 'var(--space-4)' }}>
          <span style={{ fontSize: 'var(--font-size-meta)', color: 'var(--text-muted)' }}>--font-size-{name} · {px}</span>
          <span className="ix-num" style={{ fontSize: `var(--font-size-${name})`, fontWeight: 500, lineHeight: 1.1 }}>₹10,200,000 · 100,000 USDT</span>
        </div>
      ))}
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-body-sm)', margin: 0 }}>Geist Mono · UTR HDFCR52026091617118 · tx 7c1e…a90b</p>
    </div>
  ),
};

export const SpacingAndRadii: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {Object.entries(SPACE).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--font-size-meta)' }}>
          <span style={{ width: 120, color: 'var(--text-muted)' }}>--space-{k} · {v}</span>
          <span style={{ height: 12, width: `var(--space-${k})`, background: 'var(--brand-primary)' }} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-4)' }}>
        {Object.entries(RADIUS).map(([k, v]) => (
          <div key={k} style={{ width: 96, height: 56, border: '1px solid var(--border-strong)', borderRadius: `var(--radius-${k})`, display: 'grid', placeItems: 'center', fontSize: 'var(--font-size-micro)' }}>
            {k} {v}
          </div>
        ))}
      </div>
    </div>
  ),
};

export const FinancialFormatting: Story = {
  render: () => {
    const rows: [string, string][] = [
      ['Client payout (SELL)', formatInr(CANONICAL_SELL.clientInr)],
      ['Route value (operator)', formatInr(CANONICAL_SELL.routeInr)],
      ['Gross margin', formatInr(CANONICAL_SELL.grossMargin, { sign: 'always' })],
      ['Receipt evidence', formatInr(CANONICAL_SELL.clientInr, { fraction: 'always' })],
      ['BUY client pays', formatInr(CANONICAL_BUY.clientInr)],
      ['Client rate', formatRate(clientRate('102.00'), { unit: true })],
      ['Route rate', formatRate(routeRate('104.20'), { unit: true })],
      ['USDT headline', formatUsdtHeadline(usdt('100000'))],
      ['USDT summary', formatUsdt(usdt('1840220'))],
      ['USDT deposit (exact)', formatUsdt(usdt('100000'), { precision: 'exact' })],
      ['Summary received', `${formatInrCompact(inr('6500000'))} received`],
      ['Capacity', formatInrCompact(inr('800000'))],
    ];
    return (
      <table style={{ borderCollapse: 'collapse' }}>
        <caption style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 'var(--space-2)' }}>Locale-independent formatting · international grouping (D-11)</caption>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: '1px solid var(--border-default)' }}>
              <th scope="row" style={{ textAlign: 'left', fontWeight: 400, padding: 'var(--space-2) var(--space-6) var(--space-2) 0', color: 'var(--text-secondary)' }}>{k}</th>
              <td className="ix-num" style={{ textAlign: 'right', padding: 'var(--space-2) 0', fontSize: 'var(--font-size-body-lg)', fontWeight: 500 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
};

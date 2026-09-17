import type { Meta, StoryObj } from '@storybook/react-vite';
import { RateDisplay } from './RateDisplay.tsx';
import { RateComparison } from '../RateComparison/RateComparison.tsx';
import { MarginDisplay } from '../MarginDisplay/MarginDisplay.tsx';
import { CANONICAL_SELL, clientRate, inr, routeRate } from '../../fixtures.ts';

const meta = { title: 'Pricing/RateDisplay', component: RateDisplay } satisfies Meta<typeof RateDisplay>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClientFirm: Story = { args: { rate: clientRate('102.00'), size: 'lg' } };
export const ClientIndicative: Story = { args: { rate: clientRate('102.00'), state: 'indicative', size: 'lg' } };
export const RouteRateOperator: Story = { args: { rate: routeRate('104.20'), size: 'lg' } };
export const HighPrecisionRate: Story = { args: { rate: clientRate('102.125'), size: 'md' } };
export const RouteVsClientComparison: Story = {
  args: { rate: clientRate('102.00') },
  render: () => (
    <div style={{ maxWidth: 520 }}>
      <RateComparison audience="operator" clientRate={clientRate('102.00')} routeRate={routeRate('104.20')} economics={CANONICAL_SELL} />
    </div>
  ),
  parameters: { density: 'compact' },
};
export const MarginRealizedExpectedNegative: Story = {
  args: { rate: clientRate('102.00') },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 420 }}>
      <MarginDisplay amount={inr('220000')} kind="realized" size="lg" />
      <MarginDisplay amount={inr('220000')} kind="expected" />
      <MarginDisplay amount={inr('-800')} kind="expected" label="Potential margin" />
    </div>
  ),
};

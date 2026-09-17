import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettlementLegList, SettlementLegRow } from './SettlementLegRow.tsx';
import { SettlementProgress } from '../SettlementProgress/SettlementProgress.tsx';
import { at, inr } from '../../fixtures.ts';

const meta = { title: 'Settlement/SettlementLegs', component: SettlementLegRow } satisfies Meta<typeof SettlementLegRow>;
export default meta;
type Story = StoryObj<typeof meta>;

const clientLegs = (
  <SettlementLegList>
    <SettlementLegRow audience="client" amount={inr('2000000')} status="COMPLETED" utr="HDFCR52026091617118" at={at(1200)} />
    <SettlementLegRow audience="client" amount={inr('2500000')} status="COMPLETED" utr="ICICR52026091614412" at={at(1500)} />
    <SettlementLegRow audience="client" amount={inr('2500000')} status="PROCESSING" />
    <SettlementLegRow audience="client" amount={inr('2000000')} status="PENDING" />
    <SettlementLegRow audience="client" amount={inr('1200000')} status="PENDING" />
  </SettlementLegList>
);

export const ClientPartialSettlement: Story = {
  args: { audience: 'client', amount: inr('2000000'), status: 'COMPLETED' },
  render: () => (
    <div style={{ maxWidth: 640, display: 'grid', gap: 'var(--space-4)' }}>
      <SettlementProgress received={inr('4500000')} total={inr('10200000')} />
      {clientLegs}
    </div>
  ),
};
export const ClientPartialSettlementMobile: Story = { ...ClientPartialSettlement };
export const CompactSummary: Story = {
  args: { audience: 'client', amount: inr('2000000'), status: 'COMPLETED' },
  render: () => <div style={{ maxWidth: 480 }}><SettlementProgress received={inr('6500000')} total={inr('10200000')} compact /></div>,
  tags: ['motion'],
};
export const OperatorMixedPayers: Story = {
  args: { audience: 'client', amount: inr('2000000'), status: 'COMPLETED' },
  render: () => (
    <div style={{ maxWidth: 960, display: 'grid', gap: 'var(--space-4)' }}>
      <SettlementProgress received={inr('10000000')} inFlight={inr('200000')} total={inr('10200000')} />
      <SettlementLegList>
        <SettlementLegRow audience="operator" legRef="IX-…-L1" payer="ROUTE" amount={inr('10000000')} status="COMPLETED" utr="AXISR52026091600091" at={at(1100)} />
        <SettlementLegRow audience="operator" legRef="IX-…-L2" payer="EXCHANGE_ACCOUNT" sourceLabel="HDFC · Company A" amount={inr('200000')} status="PROCESSING" />
        <SettlementLegRow audience="operator" legRef="IX-…-L3" payer="EXCHANGE_ACCOUNT" sourceLabel="ICICI · Company B" amount={inr('250000')} status="FAILED" />
        <SettlementLegRow audience="operator" legRef="IX-…-L4" payer="EXCHANGE_ACCOUNT" sourceLabel="ICICI · Company B" amount={inr('150000')} status="CANCELLED" />
      </SettlementLegList>
    </div>
  ),
  parameters: { density: 'compact' },
};

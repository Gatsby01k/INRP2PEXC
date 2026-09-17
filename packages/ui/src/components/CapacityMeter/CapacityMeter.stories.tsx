import type { Meta, StoryObj } from '@storybook/react-vite';
import { CapacityMeter } from './CapacityMeter.tsx';
import { inr } from '../../fixtures.ts';

const meta = { title: 'Operator/CapacityMeter', component: CapacityMeter, args: { accountLabel: 'HDFC · Company A', capacity: inr('2500000'), used: inr('1700000'), reserved: inr('0'), status: 'ACTIVE' }, parameters: { density: 'compact' } } satisfies Meta<typeof CapacityMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
export const WithReservation: Story = { args: { accountLabel: 'ICICI · Company B', capacity: inr('10000000'), used: inr('2400000'), reserved: inr('1500000') } };
export const ExactFigures: Story = { args: { compact: false, reserved: inr('300000') } };
export const Paused: Story = { args: { status: 'PAUSED', used: inr('900000') } };
export const OverCommittedAfterReduction: Story = { args: { accountLabel: 'Axis · Company C', capacity: inr('1000000'), used: inr('800000'), reserved: inr('500000') } };
export const Unavailable: Story = { args: { status: 'UNAVAILABLE', used: inr('0') } };

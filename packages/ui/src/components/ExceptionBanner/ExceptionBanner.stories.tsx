import type { Meta, StoryObj } from '@storybook/react-vite';
import { ExceptionBanner } from './ExceptionBanner.tsx';
import { EmptyState } from '../EmptyState/EmptyState.tsx';
import { Button } from '../Button/Button.tsx';

const meta = { title: 'Core/Feedback', component: ExceptionBanner, args: { severity: 'blocking', title: 'Short by 50 USDT', description: 'Received 99,950.000000 USDT on a 100,000 USDT trade. Payout is on hold.', action: <Button intent="secondary" size="sm">Resolve</Button> } } satisfies Meta<typeof ExceptionBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BlockingException: Story = {};
export const Warning: Story = { args: { severity: 'warning', title: 'INR payout delayed', description: 'L3 ₹2,500,000 has been processing for 45 minutes.' } };
export const BlockingMobile: Story = {};
export const Empty: Story = { render: () => <EmptyState title="No trades yet" body="Accepted quotes appear here with their settlement progress." action={<Button intent="primary">Request quote</Button>} /> };

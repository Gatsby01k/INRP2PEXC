import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button.tsx';

const meta = { title: 'Core/Button', component: Button, args: { children: 'Accept quote' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { intent: 'primary', size: 'lg' } };
export const Secondary: Story = { args: { intent: 'secondary', children: 'Change' } };
export const Ghost: Story = { args: { intent: 'ghost', children: 'Decline' } };
export const Danger: Story = { args: { intent: 'danger', children: 'Mark exception' } };
export const Loading: Story = { args: { intent: 'primary', loading: true, children: 'Accepting…' } };
export const Disabled: Story = { args: { intent: 'primary', disabled: true, children: 'Accept quote' } };
export const OperatorCompactWithShortcut: Story = { args: { intent: 'secondary', size: 'sm', shortcut: 'Q', children: 'Quote' }, parameters: { density: 'compact' } };
export const FullWidthMobile: Story = { args: { intent: 'primary', size: 'lg', fullWidth: true, children: 'Sell USDT' }, parameters: { viewport: 'mobile' } };

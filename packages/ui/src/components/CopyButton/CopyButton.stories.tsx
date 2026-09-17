import type { Meta, StoryObj } from '@storybook/react-vite';
import { CopyButton } from './CopyButton.tsx';

const meta = {
  title: 'Core/CopyButton',
  component: CopyButton,
  args: { value: 'TQ7wX2m9Lk4bP8sN3vR6yH1cJ5dF0gZaEu', label: 'deposit address' },
} satisfies Meta<typeof CopyButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Copied: Story = { args: { defaultCopied: true } };
export const UtrValue: Story = { args: { value: 'HDFCR52026091612345678', label: 'UTR' } };

import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusGlyph } from './StatusGlyph.tsx';

const meta = { title: 'Core/StatusGlyph', component: StatusGlyph, args: { state: 'partial' } } satisfies Meta<typeof StatusGlyph>;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--font-size-body)', color: 'var(--text-primary)' }}>
      <li><StatusGlyph state="pending" /> Not started</li>
      <li style={{ color: 'var(--brand-primary)' }}><StatusGlyph state="partial" /> <span style={{ color: 'var(--text-primary)' }}>In progress</span></li>
      <li style={{ color: 'var(--status-success)' }}><StatusGlyph state="done" /> <span style={{ color: 'var(--text-primary)' }}>Done</span></li>
      <li style={{ color: 'var(--text-muted)' }}><StatusGlyph state="closed" /> Cancelled</li>
    </ul>
  ),
};

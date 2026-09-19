import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button/Button.tsx';
import { StepUpMark } from './StepUpMark.tsx';

const meta = { title: 'Operator/StepUpMark', component: StepUpMark } satisfies Meta<typeof StepUpMark>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The marker the desk puts on an action that will ask for an authenticator code. Drawn, not written as `⧗`:
 * that character is not in Geist and would be rendered by whatever font the machine happens to have.
 */
export const OnAnAction: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--space-3)', justifyItems: 'start', fontSize: 'var(--font-size-body)', color: 'var(--text-primary)' }}>
      <Button intent="primary" shortcut={<StepUpMark label="needs your authenticator code" />}>
        Confirm
      </Button>
      <span>
        <StepUpMark /> Needs step-up verification
      </span>
    </div>
  ),
};

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { OtpInput } from './OtpInput.tsx';
import { NumericCell } from '../NumericCell/NumericCell.tsx';

const meta = { title: 'Core/Inputs', component: OtpInput, args: { value: '', onChange: () => {} } } satisfies Meta<typeof OtpInput>;
export default meta;
type Story = StoryObj<typeof meta>;

function Controlled({ initial, invalid }: { initial: string; invalid?: boolean }) {
  const [v, setV] = useState(initial);
  return <OtpInput value={v} onChange={setV} {...(invalid ? { invalid } : {})} />;
}

export const OtpPartial: Story = { render: () => <Controlled initial="482" /> };
export const OtpInvalid: Story = { render: () => <Controlled initial="482199" invalid /> };
export const NumericCells: Story = {
  render: () => (
    <table style={{ borderCollapse: 'collapse' }}>
      <caption className="ix-visually-hidden">Numeric alignment</caption>
      <tbody>
        {[['₹10,200,000', 'default'], ['₹220,000', 'positive'], ['₹4,599,000', 'strong'], ['−₹800', 'negative'], ['₹0', 'muted']].map(([v, e]) => (
          <tr key={v}>
            <th scope="row" style={{ textAlign: 'left', fontWeight: 400, padding: '0 var(--space-3)' }}>{e}</th>
            <NumericCell emphasis={e as 'default'}>{v}</NumericCell>
          </tr>
        ))}
      </tbody>
    </table>
  ),
  parameters: { density: 'compact' },
};

import type { Preview } from '@storybook/react-vite';
import '../src/styles/index.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
  globalTypes: {
    density: {
      description: 'Density mode',
      toolbar: { title: 'Density', items: ['comfortable', 'compact'], dynamicTitle: true },
    },
  },
  initialGlobals: { density: 'comfortable' },
  decorators: [
    (Story, context) => {
      const density = (context.parameters['density'] as string | undefined) ?? (context.globals['density'] as string);
      const surface = (context.parameters['surface'] as string | undefined) ?? 'app';
      return (
        <div data-density={density} data-testid="story-surface" style={{ background: surface === 'surface' ? 'var(--bg-surface)' : surface === 'ivory' ? 'var(--ivory)' : 'var(--bg-app)', padding: 'var(--space-6)' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default preview;

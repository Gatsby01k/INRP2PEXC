import { writeFileSync } from 'node:fs';
import { tokensToCss } from '../src/tokens/tokens.ts';

writeFileSync(new URL('../src/styles/tokens.css', import.meta.url), tokensToCss());
console.log('wrote src/styles/tokens.css');

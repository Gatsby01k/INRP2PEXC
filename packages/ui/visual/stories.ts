import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  tags: string[];
}

/** Reads the built Storybook index so every story is covered automatically. */
export function loadStories(): StoryEntry[] {
  const index = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'storybook-static', 'index.json'), 'utf8')) as {
    entries: Record<string, { id: string; title: string; name: string; type: string; tags?: string[] }>;
  };
  return Object.values(index.entries)
    .filter((e) => e.type === 'story')
    .map((e) => ({ id: e.id, title: e.title, name: e.name, tags: e.tags ?? [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Stories named "... Mobile" render at 375px; operator-desk stories at 1440px; everything else at 1024px. */
export function viewportFor(story: StoryEntry): { width: number; height: number } {
  if (/mobile/i.test(story.name)) return { width: 375, height: 812 };
  if (/desk|queue|table/i.test(`${story.title} ${story.name}`)) return { width: 1440, height: 900 };
  return { width: 1024, height: 768 };
}

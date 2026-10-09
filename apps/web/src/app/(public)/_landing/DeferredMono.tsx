'use client';

import { useEffect } from 'react';

/**
 * Lets the home page take Geist Mono once it has loaded.
 *
 * The page sets only text below its first screen in Geist Mono — the story's figures and the footer — on a phone
 * and on a desktop alike. But a face a stylesheet uses is fetched as soon as any laid-out text needs it, at the
 * browser's highest priority, so the two Geist Mono files (about 100 KB) were downloaded beside the first
 * screen's styles and image. On Lighthouse's mobile profile that was the measured difference between a first
 * paint at 2.0 s and at 2.7 s, and a performance score of 89 and of 82.
 *
 * Until `load`, the story carries `data-deferred-fonts="pending"` and the site's monospace is the system's
 * (public.module.css). Then this marks it ready, and text nobody has scrolled to yet takes Geist Mono.
 */
export function DeferredMono() {
  useEffect(() => {
    const story = document.querySelector<HTMLElement>("[data-deferred-fonts='pending']");
    if (!story) return;
    const ready = () => story.setAttribute('data-deferred-fonts', 'ready');
    if (document.readyState === 'complete') {
      ready();
      return;
    }
    window.addEventListener('load', ready, { once: true });
    return () => window.removeEventListener('load', ready);
  }, []);
  return null;
}

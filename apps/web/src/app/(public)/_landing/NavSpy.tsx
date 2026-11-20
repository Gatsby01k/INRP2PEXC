'use client';

import { useEffect } from 'react';

/**
 * Which section of the home page the visitor is reading, shown in the masthead: the link to it carries the visor pill
 * the workspace's own bar uses for the page it is on. It writes two things and renders nothing — the link's
 * `aria-current` and the pill's place on the navigation (`--thumb-x`, `--thumb-w`) — so the masthead stays server
 * markup. On a page without those sections (the guides) nothing is current and no pill is drawn.
 */
export function NavSpy() {
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('[data-nav]');
    if (!nav) return;
    const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[data-section]')];
    const sections = links
      .map((a) => ({ link: a, section: document.getElementById(a.dataset.section ?? '') }))
      .filter((x): x is { link: HTMLAnchorElement; section: HTMLElement } => x.section !== null);
    if (sections.length === 0) return;

    let current: HTMLAnchorElement | null = null;
    const place = () => {
      if (!current) {
        nav.removeAttribute('data-current');
        return;
      }
      nav.style.setProperty('--thumb-x', `${current.offsetLeft}px`);
      nav.style.setProperty('--thumb-w', `${current.offsetWidth}px`);
      nav.setAttribute('data-current', '');
    };
    const pick = () => {
      // The section whose top has passed a third of the way down the viewport, and whose end has not.
      const line = window.innerHeight * 0.34;
      let next: HTMLAnchorElement | null = null;
      for (const { link, section } of sections) {
        const box = section.getBoundingClientRect();
        if (box.top <= line && box.bottom > line) next = link;
      }
      if (next === current) return;
      current?.removeAttribute('aria-current');
      next?.setAttribute('aria-current', 'location');
      current = next;
      place();
    };

    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          pick();
        });
    };
    pick();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', place);
    };
  }, []);
  return null;
}

'use client';

import { useEffect } from 'react';
import { ACQUISITION_EVENT_PATH, SEGMENTS, SEGMENT_PARAM, type Segment, segmentOf } from '../../../server/acquisition.ts';

type Kind = 'VIEW' | 'SEGMENT' | 'ESTIMATE' | 'CTA' | 'CONTACT' | 'SIGN_IN' | 'FAQ';

/** What this page view has already reported: kept outside the effect, so an effect that runs twice reports once. */
const sent = new Set<string>();

/**
 * The page's one script that is not a drawing. It renders nothing; the page is server markup, and this makes three things
 * of it once it is in the browser:
 *
 * - **The side switch.** Every side's words are already in the page; choosing one sets `data-for` on the page (the
 *   stylesheet shows that side's words), moves the switch's thumb, puts the side in every call to action's address — so
 *   the application starts on that side — and in the page's own address, so a reload or a shared link keeps it.
 * - **The count** (migration 0053). It tells `ACQUISITION_EVENT_PATH` only what was done — the page was seen, a side
 *   chosen, the earnings example tried, a call to action, a contact or a question opened — and on which side. Who the
 *   visitor is and which campaign they came with are the server's to read from the page's own cookie; the example's
 *   figures never leave the page. A beacon, so leaving the page never waits for it, and nothing here waits for an answer.
 * - **The sticky way in** on a phone: once the hero's own buttons have scrolled away, until the closing's arrive.
 */
export function TradersIsland() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-traders-page]');
    if (!root) return;
    // A side counts once the visitor chose it, or their link named it — not the side shown to someone who did neither.
    let chosen = root.dataset.forChosen === '';

    const send = (kind: Kind, extra: { segment?: Segment; placement?: string } = {}) => {
      const segment = extra.segment ?? (chosen ? (segmentOf(root.dataset.for) ?? undefined) : undefined);
      // Once per page view for each thing done, but every press of a call to action.
      const key = `${kind}:${extra.placement ?? ''}:${kind === 'SEGMENT' ? segment : ''}`;
      if (kind !== 'CTA' && sent.has(key)) return;
      sent.add(key);
      const body = JSON.stringify({ kind, ...(segment ? { segment } : {}), ...(extra.placement ? { placement: extra.placement } : {}) });
      try {
        if (navigator.sendBeacon?.(ACQUISITION_EVENT_PATH, new Blob([body], { type: 'application/json' }))) return;
      } catch {
        // Fall through to a plain request.
      }
      void fetch(ACQUISITION_EVENT_PATH, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => undefined);
    };

    send('VIEW');

    const radios = [...root.querySelectorAll<HTMLButtonElement>('[data-segment]')];
    const switcher = root.querySelector<HTMLElement>('[data-segment-switch]');

    const choose = (seg: Segment, focus: boolean) => {
      for (const r of radios) {
        const on = r.dataset.segment === seg;
        r.setAttribute('aria-checked', String(on));
        r.tabIndex = on ? 0 : -1;
        if (on && focus) r.focus();
      }
      if (root.dataset.for === seg) return;
      chosen = true;
      root.dataset.for = seg;
      switcher?.style.setProperty('--at', String(SEGMENTS.indexOf(seg)));
      for (const a of root.querySelectorAll<HTMLAnchorElement>('a[data-cta]')) {
        const to = new URL(a.href);
        to.searchParams.set(SEGMENT_PARAM, seg);
        a.href = to.toString();
      }
      const here = new URL(window.location.href);
      here.searchParams.set(SEGMENT_PARAM, seg);
      window.history.replaceState(window.history.state, '', here);
      send('SEGMENT', { segment: seg });
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const radio = target.closest<HTMLElement>('[data-segment]');
      if (radio) {
        const seg = segmentOf(radio.dataset.segment);
        if (seg) choose(seg, false);
        return;
      }
      const cta = target.closest<HTMLAnchorElement>('a[data-cta]');
      if (cta) return send('CTA', { placement: cta.dataset.cta ?? 'unknown' });
      const contact = target.closest<HTMLAnchorElement>('a[data-contact]');
      if (contact) return send('CONTACT', { placement: contact.dataset.contact ?? 'unknown' });
      const signIn = target.closest<HTMLAnchorElement>('a[data-signin]');
      if (signIn) return send('SIGN_IN', { placement: signIn.dataset.signin ?? 'unknown' });
      if (target.closest('[data-estimate]') && target.closest('label, input')) send('ESTIMATE');
    };

    // The switch is a radio group: the arrows move the choice, as they do in any other.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const at = target?.dataset.segment ? SEGMENTS.indexOf(target.dataset.segment as Segment) : -1;
      if (at < 0) return;
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      choose(SEGMENTS[(at + step + SEGMENTS.length) % SEGMENTS.length]!, true);
    };

    // `toggle` does not bubble; it is caught on its way down.
    const onToggle = (e: Event) => {
      const d = e.target instanceof HTMLDetailsElement ? e.target : null;
      if (d?.open && d.dataset.faq) send('FAQ', { placement: d.dataset.faq });
    };

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('toggle', onToggle, true);

    const heroActions = document.getElementById('hero-actions');
    const closing = document.getElementById('closing');
    const bar = root.querySelector<HTMLElement>('[data-sticky-bar]');
    let pastHero = false;
    let atClosing = false;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === heroActions) pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        if (entry.target === closing) atClosing = entry.isIntersecting;
      }
      const on = pastHero && !atClosing;
      root.dataset.sticky = on ? 'on' : 'off';
      if (bar) bar.inert = !on;
    });
    if (heroActions) io.observe(heroActions);
    if (closing) io.observe(closing);

    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('toggle', onToggle, true);
      io.disconnect();
    };
  }, []);
  return null;
}

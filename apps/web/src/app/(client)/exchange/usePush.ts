'use client';

import { useCallback, useEffect, useState } from 'react';
import { subscribePushAction } from '../../../server/actions/peer.ts';

/**
 * ADR 0033 §2.6: notifications in this browser — the person's instant channel when it has no Telegram. The browser asks
 * the person; once allowed, its subscription is the person's (`push.subscribe`) and it is told what Telegram would be.
 * Says `unsupported` where the browser has no push (an iPhone outside an installed app, an old browser) and the option is
 * simply not offered.
 */
export type PushState = 'unsupported' | 'off' | 'asking' | 'on' | 'denied';

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function usePush(publicKey: string | null): { state: PushState; turnOn: () => Promise<void> } {
  const [state, setState] = useState<PushState>('unsupported');

  useEffect(() => {
    if (!publicKey || typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    let live = true;
    void navigator.serviceWorker.getRegistration('/').then(async (reg) => {
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (live) setState(sub ? 'on' : 'off');
    }).catch(() => {
      if (live) setState('off');
    });
    return () => {
      live = false;
    };
  }, [publicKey]);

  const turnOn = useCallback(async () => {
    if (!publicKey) return;
    setState('asking');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('no subscription');
      const out = await subscribePushAction({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, userAgent: navigator.userAgent.slice(0, 200) }, crypto.randomUUID());
      setState(out.ok ? 'on' : 'off');
    } catch {
      setState('off');
    }
  }, [publicKey]);

  return { state, turnOn };
}

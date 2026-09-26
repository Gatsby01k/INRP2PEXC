import type { ReactNode } from 'react';
import { ACTIONS, ONBOARDING, SITE_NAME, type SitePage } from '../../content/site.ts';
import { appOrigin, onboardingHref, publicOrigin, requestNonce } from '../../server/site.ts';
import styles from './public.module.css';

/**
 * Structured data for one page.
 *
 * Organization, WebSite and WebPage — the three that describe what this is — and nothing that would require a
 * number. No `aggregateRating`, no `review`, no `offers`, no `priceRange`: every one of those would be a figure
 * we invented, which is exactly what PRODUCT §7.4 forbids. A price exists only inside a quote issued to a
 * client, so there is nothing here to mark up as one.
 */
function structuredData(page: SitePage, origin: string): string {
  const url = `${origin}${page.path === '/' ? '' : page.path}`;
  const graph: unknown[] = [
    { '@type': 'Organization', '@id': `${origin}#organization`, name: SITE_NAME, url: origin },
    { '@type': 'WebSite', '@id': `${origin}#website`, name: SITE_NAME, url: origin, publisher: { '@id': `${origin}#organization` }, inLanguage: 'en-IN' },
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: page.title,
      description: page.description,
      isPartOf: { '@id': `${origin}#website` },
      about: { '@id': `${origin}#organization` },
    },
  ];
  if (page.path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: origin },
        { '@type': 'ListItem', position: 2, name: page.h1, item: url },
      ],
    });
  }
  // JSON.stringify escapes nothing that matters inside a JSON-LD script except `<`, which would end the element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll('<', '\\u003c');
}

/**
 * One public page. A page may bring its own first screen as `hero` — the home page does — in place of the plain
 * heading, lede and actions every SEO page opens with, and a `story` told between that screen and its sections.
 * Both are passed in rather than imported here so that only the page that shows them loads their code: everything
 * this component imports is shipped to all six pages.
 */
export async function SitePageView({ page, hero, story }: { page: SitePage; hero?: ReactNode; story?: ReactNode }) {
  const [origin, nonce] = await Promise.all([publicOrigin(), requestNonce()]);
  const app = appOrigin();
  const onboarding = onboardingHref();

  return (
    <>
      <script
        type="application/ld+json"
        {...(nonce ? { nonce } : {})}
        dangerouslySetInnerHTML={{ __html: structuredData(page, origin) }}
      />

      {hero}
      {story}

      {/* The reading column: every SEO page's heading and sections. A page that brings its own first screen and
          story (the home page) has neither, and draws no empty column after its story. */}
      {hero && page.sections.length === 0 ? null : (
        <div className={styles.column}>
          {hero ? null : (
            <section className={styles.hero}>
              <h1 className={styles.h1}>{page.h1}</h1>
              <p className={styles.lede}>{page.lede}</p>
              <div className={styles.actions}>
                {ACTIONS.map((a) => (
                  <a key={a.label} className={a.kind === 'primary' ? styles.actionPrimary : styles.actionSecondary} href={`${app}${a.appPath}`}>
                    {a.label}
                  </a>
                ))}
              </div>
              <p className={styles.actionNote}>
                {ONBOARDING.requirement}
                {onboarding ? (
                  <>
                    {' '}
                    <a className={styles.actionLink} href={onboarding}>
                      {ONBOARDING.label}
                    </a>
                  </>
                ) : null}
              </p>
            </section>
          )}

          {page.sections.map((s) => (
            <section key={s.heading} className={styles.section}>
              <h2 className={styles.h2}>{s.heading}</h2>
              {s.body.map((p) => (
                <p key={p.slice(0, 40)} className={styles.body}>
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

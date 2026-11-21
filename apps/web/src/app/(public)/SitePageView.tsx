import type { ReactNode } from 'react';
import Link from 'next/link';
import { ACTIONS, FAQ, GUIDES, HERO, ONBOARDING, SITE_NAME, SITE_PAGES, type SitePage, TELEGRAM, telegramUrl, withTerms } from '../../content/site.ts';
import { GuideRobot } from './_landing/guide/GuideRobot.tsx';
import { MarketCard } from './_landing/guide/MarketCard.tsx';
import guide from './_landing/guide/guide.module.css';
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
    { '@type': 'Organization', '@id': `${origin}#organization`, name: SITE_NAME, url: origin, sameAs: TELEGRAM.channels.map((c) => telegramUrl(c.handle)) },
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
  // The questions the page answers, as the page shows them: the home page's FAQ, or a guide's own.
  const questions = page.path === '/' ? FAQ.items : (page.faq ?? []);
  if (questions.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: questions.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: withTerms(q.answer) } })),
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
      {/* A guide (every page but home): its first screen in the home page's room — the sunrise, the display face, the
          orange action — then its sections as numbered sheets. The home page brings its own first screen and story. */}
      {hero && page.sections.length === 0 ? null : (
        <div className={styles.guide}>
          {hero ? null : (
            <section className={styles.hero}>
              <div className={`${styles.heroInner} ${page.led ? styles.heroGrid : ''}`}>
                <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>{HERO.eyebrow}</p>
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
                  {ONBOARDING.requirement}{' '}
                  <a className={styles.actionLink} href={onboarding}>
                    {ONBOARDING.label}
                  </a>
                </p>
                </div>
                {page.led ? (
                  <div className={guide.art}>
                    <GuideRobot say={page.led} />
                    {page.rate ? <MarketCard /> : null}
                  </div>
                ) : null}
              </div>
            </section>
          )}

          <div className={styles.sections}>
            {page.sections.map((s, i) => (
              <section key={s.heading} className={styles.section}>
                <span className={styles.sectionIndex} aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h2 className={styles.h2}>{s.heading}</h2>
                {s.body.map((p) => (
                  <p key={p.slice(0, 40)} className={styles.body}>
                    {p}
                  </p>
                ))}
              </section>
            ))}
          </div>

          {!hero && page.faq && page.faq.length > 0 ? (
            <section className={guide.block} aria-labelledby="guide-faq">
              <h2 id="guide-faq" className={guide.blockTitle}>
                {GUIDES.faq}
              </h2>
              <div className={guide.faq}>
                {page.faq.map((q, i) => (
                  <details key={q.question} className={guide.item} name="guide-faq" open={i === 0}>
                    <summary className={guide.question}>{q.question}</summary>
                    <p className={guide.answer}>{q.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          {hero ? null : (
            <nav className={guide.block} aria-labelledby="guide-more">
              <h2 id="guide-more" className={guide.blockTitle}>
                {GUIDES.more}
              </h2>
              <div className={guide.guides}>
                {SITE_PAGES.filter((p) => p.path !== '/' && p.path !== page.path).map((p) => (
                  <Link key={p.path} href={p.path} className={guide.guideLink} prefetch={false}>
                    <b>{p.h1}</b>
                    <span>{p.lede}</span>
                  </Link>
                ))}
              </div>
            </nav>
          )}
        </div>
      )}
    </>
  );
}

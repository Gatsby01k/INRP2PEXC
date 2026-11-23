import { type ReactNode, Suspense } from 'react';
import Link from 'next/link';
import mark from '../../../../../brand/inrp2p-mark.png';
import { ACTIONS, FAQ, GUIDES, HERO, ONBOARDING, SITE_NAME, SITE_PAGES, type SitePage, TAGLINE, TELEGRAM, TRADER_ENTRY, plainTerms, telegramUrl, withTerms } from '../../content/site.ts';
import { GuideRobot } from './_landing/guide/GuideRobot.tsx';
import { MarketCard } from './_landing/guide/MarketCard.tsx';
import { PremiumBoard, PremiumLine } from './_landing/guide/Premium.tsx';
import { RateLine, RateTable } from './_landing/guide/RateNow.tsx';
import guide from './_landing/guide/guide.module.css';
import { appOrigin, onboardingHref, publicOrigin, requestNonce } from '../../server/site.ts';
import { PREMIUM_LICENSE_URL } from '../../server/premium.ts';
import { PREMIUM_CSV_PATH } from '../../server/surface.ts';
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
    {
      '@type': 'Organization',
      '@id': `${origin}#organization`,
      name: SITE_NAME,
      alternateName: 'INRP2P',
      url: origin,
      // The supplied mark, square, as a search engine's knowledge panel and an assistant's answer show the brand.
      logo: { '@type': 'ImageObject', url: `${origin}${mark.src}`, width: mark.width, height: mark.height },
      slogan: TAGLINE,
      sameAs: [...TELEGRAM.channels, TELEGRAM.ceo].map((c) => telegramUrl(c.handle)),
      contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', url: telegramUrl(TELEGRAM.ceo.handle), areaServed: 'IN' },
    },
    { '@type': 'WebSite', '@id': `${origin}#website`, name: SITE_NAME, url: origin, publisher: { '@id': `${origin}#organization` }, inLanguage: 'en-IN' },
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: plainTerms(page.title),
      description: plainTerms(page.description),
      inLanguage: page.lang ?? 'en-IN',
      isPartOf: { '@id': `${origin}#website` },
      about: { '@id': `${origin}#organization` },
    },
  ];
  if (page.path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: origin },
        { '@type': 'ListItem', position: 2, name: plainTerms(page.h1), item: url },
      ],
    });
  }
  // The premium page publishes a dataset: what it measures, how, and where to download it. Described, not quoted — the
  // figures themselves are on the page and in the CSV, and a description that held them would be stale in minutes.
  if (page.premium) {
    graph.push({
      '@type': 'Dataset',
      '@id': `${url}#dataset`,
      name: GUIDES.premium.dataset.name,
      description: GUIDES.premium.dataset.description,
      url,
      // Named in full rather than by reference alone: a dataset's creator is read on its own by dataset search.
      creator: { '@type': 'Organization', '@id': `${origin}#organization`, name: SITE_NAME, url: origin },
      isAccessibleForFree: true,
      // The licence the page states and links (`rel="license"`): free to use, with a link back.
      license: PREMIUM_LICENSE_URL,
      spatialCoverage: { '@type': 'Place', name: 'India' },
      variableMeasured: [
        { '@type': 'PropertyValue', name: 'USDT/INR market rate, day average (IST)', unitCode: 'INR' },
        { '@type': 'PropertyValue', name: 'USD/INR, ECB reference rate', unitCode: 'INR' },
        { '@type': 'PropertyValue', name: 'Premium of USDT over USD', unitText: 'percent' },
      ],
      measurementTechnique: GUIDES.premium.method,
      distribution: [{ '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${origin}${PREMIUM_CSV_PATH}` }],
    });
  }
  // The questions the page answers, as the page shows them: the home page's FAQ, or a guide's own.
  const questions = page.path === '/' ? FAQ.items : (page.faq ?? []);
  if (questions.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: questions.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: plainTerms(q.answer) } })),
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
        <div className={styles.guide} lang={page.lang}>
          {hero ? null : (
            <section className={styles.hero}>
              <div className={`${styles.heroInner} ${page.led ? styles.heroGrid : ''}`}>
                <div className={styles.heroCopy}>
                <p className={styles.eyebrow}>{HERO.eyebrow}</p>
                <h1 className={styles.h1}>{withTerms(page.h1)}</h1>
                <p className={styles.lede}>{withTerms(page.lede)}</p>
                {/* The figure a rate search is for, in the HTML; streamed in, so the page never waits on it. */}
                {page.rate ? (
                  <Suspense fallback={null}>
                    <RateLine direction={page.rate} />
                  </Suspense>
                ) : null}
                {page.premium ? (
                  <Suspense fallback={null}>
                    <PremiumLine />
                  </Suspense>
                ) : null}
                {page.audience === 'trader' ? (
                  <>
                    <div className={styles.actions}>
                      <a className={styles.actionPrimary} href={`${app}${TRADER_ENTRY.appPath}`}>
                        {TRADER_ENTRY.label}
                      </a>
                      <Link className={styles.actionSecondary} href="/#own-desk" prefetch={false}>
                        {GUIDES.trader.earn}
                      </Link>
                    </div>
                    <p className={styles.actionNote}>{GUIDES.trader.note}</p>
                  </>
                ) : (
                  <>
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
                  </>
                )}
                </div>
                {page.led ? (
                  <div className={guide.art}>
                    <GuideRobot say={page.led} />
                    {page.rate || page.premium ? <MarketCard /> : null}
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {/* The amounts people search for, at the market's rate now: a table in the HTML, after the first screen. */}
          {!hero && page.rate ? (
            <Suspense fallback={null}>
              <RateTable direction={page.rate} />
            </Suspense>
          ) : null}
          {/* India's USDT premium, now and day by day, with the CSV to cite it from. */}
          {!hero && page.premium ? (
            <Suspense fallback={null}>
              <PremiumBoard />
            </Suspense>
          ) : null}

          <div className={styles.sections}>
            {page.sections.map((s, i) => (
              <section key={s.heading} className={styles.section}>
                <span className={styles.sectionIndex} aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h2 className={styles.h2}>{withTerms(s.heading)}</h2>
                {s.body.map((p) => (
                  <p key={p.slice(0, 40)} className={styles.body}>
                    {withTerms(p)}
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
                    <p className={guide.answer}>{withTerms(q.answer)}</p>
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
                    <b>{withTerms(p.h1)}</b>
                    <span>{withTerms(p.lede)}</span>
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

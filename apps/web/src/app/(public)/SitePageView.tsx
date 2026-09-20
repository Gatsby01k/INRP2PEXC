import { ACTIONS, STEPS, SITE_NAME, type SitePage } from '../../content/site.ts';
import { appOrigin, publicOrigin, requestNonce } from '../../server/site.ts';
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

export async function SitePageView({ page }: { page: SitePage }) {
  const [origin, nonce] = await Promise.all([publicOrigin(), requestNonce()]);
  const app = appOrigin();
  const home = page.path === '/';

  return (
    <>
      <script
        type="application/ld+json"
        {...(nonce ? { nonce } : {})}
        dangerouslySetInnerHTML={{ __html: structuredData(page, origin) }}
      />

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
          Trading needs a client record with its settlement destinations registered in advance. The desk sets that up; there is no form here that can.
        </p>
      </section>

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

      {home ? (
        <section className={styles.section} aria-labelledby="how">
          <h2 className={styles.h2} id="how">
            How a trade runs
          </h2>
          <ol className={styles.steps}>
            {STEPS.map((s) => (
              <li key={s.title} className={styles.step}>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <p className={styles.body}>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

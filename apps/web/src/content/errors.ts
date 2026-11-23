/**
 * The page a mistyped or retired address gets, on every host: what happened, in the robot's words, and the ways back. On
 * the public site it also offers the guides people most often came for.
 */
export const NOT_FOUND = {
  title: 'Page not found',
  eyebrow: 'Wrong turn',
  heading: 'This page isn’t here.',
  body: 'The address may be mistyped, or the page has moved. Everything on INRP2P starts from its home page.',
  home: 'Go to the home page',
  traders: 'For traders',
  guides: 'Or read a guide',
  /** The guides offered, by path; each is linked with its own headline. */
  guidePaths: ['/usdt-to-inr', '/inr-to-usdt', '/usdt-premium-india', '/is-inrp2p-safe'],
  /** On the app's and the desk's hosts, where the home page is the workspace's own. */
  back: 'Back to the start',
} as const;

/** The page a failure on our side gets, in place of the browser's bare error: what to do, and who answers. */
export const SERVER_ERROR = {
  /** The site's name, as `SITE_NAME` (a test holds them equal): the error page imports nothing else. */
  brand: 'INRP2P Exchange',
  title: 'Something went wrong',
  heading: 'That didn’t load.',
  body: 'Something went wrong on our side, not yours. Loading the page again usually brings it back.',
  retry: 'Load the page again',
  home: 'Go to the home page',
} as const;

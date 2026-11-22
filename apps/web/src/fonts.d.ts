/** A font file imported from code is the address it is served at (Turbopack), the same one the stylesheet uses. */
declare module '*.woff2' {
  const href: string;
  export default href;
}

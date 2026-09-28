/**
 * The kernel's `node:crypto`, in the film's browser page. The kernel imports it to mint ids and to check TRON
 * addresses; the film does neither, so these exist only to be imported, and say so if anything ever calls them.
 */
const unavailable = (name: string) => (): never => {
  throw new Error(`node:crypto.${name} is not available in the film`);
};

export const randomBytes = unavailable('randomBytes');
export const createHash = unavailable('createHash');

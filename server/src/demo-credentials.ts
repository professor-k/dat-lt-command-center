/**
 * The demo administrator, as printed in the README.
 *
 * These are not a secret and are not meant to be one: they exist so that a database on
 * somebody's own machine is usable a minute after cloning. They live here rather than
 * inline so that the seed can recognise them and refuse to create a real deployment's
 * first administrator with a password anyone can look up.
 */
export const DEMO_ADMIN_EMAIL = 'ops@dat-lt.aero';
export const DEMO_ADMIN_PASSWORD = 'CommandCenter2026!';

/**
 * Whether the credentials the seed is about to use are the published ones.
 *
 * Deliberately checks the password alone: a deployment that changed the address but kept
 * the password has changed nothing that matters.
 */
export const isPublishedDemoCredential = (password: string): boolean => password === DEMO_ADMIN_PASSWORD;

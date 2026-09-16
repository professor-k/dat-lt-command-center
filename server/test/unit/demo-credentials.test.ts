import { describe, expect, it } from 'vitest';
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, isPublishedDemoCredential } from '../../src/demo-credentials.js';

/**
 * The demo administrator's password is printed in the README, so it must not become a real
 * deployment's way in. The check belongs where the credential is about to be used — see
 * the seed guard in seed-guard.test.ts — and this is the recognition it rests on.
 */
describe('published demo credentials', () => {
  it('recognises the password from the README', () => {
    expect(isPublishedDemoCredential(DEMO_ADMIN_PASSWORD)).toBe(true);
  });

  it("does not recognise a password of someone else's choosing", () => {
    expect(isPublishedDemoCredential('a-password-nobody-published')).toBe(false);
  });

  it('judges the password alone', () => {
    // Changing the address while keeping the published password changes nothing that
    // matters, so the address is not part of the test.
    expect(isPublishedDemoCredential(DEMO_ADMIN_PASSWORD)).toBe(true);
    expect(DEMO_ADMIN_EMAIL).toContain('@');
  });

  it('is not fooled by something merely similar', () => {
    expect(isPublishedDemoCredential(DEMO_ADMIN_PASSWORD + ' ')).toBe(false);
    expect(isPublishedDemoCredential(DEMO_ADMIN_PASSWORD.toLowerCase())).toBe(false);
  });
});

import { PermanentError } from '@fisio/domain';
import { describe, expect, it } from 'vitest';
import { renderTemplate, TEMPLATE_NAMES } from '../src/templates';

const invitation = {
  name: 'Giulia Bianchi',
  email: 'giulia@example.test',
  appUrl: 'https://fisio.example/accedi',
};

describe('T7 Manage clients: the invitation email (architecture §3.5)', () => {
  // Value: protects=the invited client learns where to go and how to sign in (email, then a one-time code, no password), in Italian, in both bodies; fails_when=the link, the address or the sign-in steps are dropped from one body; why_new=first template; seam=none; no_claim=delivery (notifier specs)
  it('names the client, links the app and explains the code sign-in, in text and HTML', () => {
    const email = renderTemplate('invitation', invitation);
    expect(email.subject).toBe('Il tuo invito a Fisio Calendar');
    for (const body of [email.text, email.html]) {
      expect(body).toContain('Giulia Bianchi');
      expect(body).toContain('https://fisio.example/accedi');
      expect(body).toContain('giulia@example.test');
      expect(body).toContain('codice di accesso');
    }
    expect(email.html).toContain('<a href="https://fisio.example/accedi">');
    expect(email.html).toMatch(/^<!doctype html>/);
  });

  // Value: protects=a client name typed by the therapist cannot inject markup into the HTML email; fails_when=a param reaches the HTML unescaped; why_new=first template; seam=none; no_claim=the mail client's own sanitising
  it('escapes params in the HTML body and keeps them verbatim in the text body', () => {
    const email = renderTemplate('invitation', { ...invitation, name: 'Anna <b>"&\'</b>' });
    expect(email.html).toContain('Anna &lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
    expect(email.html).not.toContain('<b>');
    expect(email.text).toContain('Anna <b>"&\'</b>');
  });

  // Value: protects=a stored item whose params no longer fit its template fails at once instead of being retried five times, and the error carries paths, never values; fails_when=a ZodError or TypeError escapes (classified retryable) or the message echoes the address; why_new=first template; seam=none; no_claim=how the notifier records it (notifier specs)
  it('unknown template or invalid params → PermanentError naming paths, not values', () => {
    expect(TEMPLATE_NAMES).toEqual(['invitation']);
    expect(() => renderTemplate('reminder', invitation)).toThrow(PermanentError);
    const bad = () =>
      renderTemplate('invitation', { ...invitation, email: 'secret-address', appUrl: 'ftp://x' });
    expect(bad).toThrow(PermanentError);
    expect(bad).toThrow('template invitation: invalid params email, appUrl');
    expect(bad).not.toThrow('secret-address');
    expect(() => renderTemplate('invitation', undefined)).toThrow(PermanentError);
  });
});

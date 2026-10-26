import { stringsIt } from '@fisio/contracts';
import { mailpitMessage, mailpitMessageIdsTo } from '@fisio/testkit/mailpit';
import { expect, test } from '@playwright/test';

/**
 * Binding journey (docs/architecture.md §10.5, layer E): the sign-in page enters a code and
 * lands on the client's home. A seeded client (`pnpm seed`) signs in with the one-time code the
 * auth emulator sent to Mailpit; the page shows the greeting from `GET /me` and the calendar's
 * place.
 */
const CLIENT = { name: 'Giulia Bianchi', email: 'giulia.bianchi@fisio.test' };
const { auth, home } = stringsIt;

async function codeSentTo(address: string, since: Date): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const [latest] = await mailpitMessageIdsTo(address, since);
        if (!latest) return undefined;
        code = /\b(\d{8})\b/.exec((await mailpitMessage(latest)).text)?.[1];
        return code;
      },
      { timeout: 10_000 },
    )
    .toMatch(/^\d{8}$/);
  return code as string;
}

test('sign-in page: email, code from the email, client home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: auth.title })).toBeVisible();

  const since = new Date(Date.now() - 1_000);
  await page.getByLabel(auth.emailLabel).fill(CLIENT.email);
  await page.getByRole('button', { name: auth.requestCode }).click();
  await expect(page.getByText(auth.codeSent)).toBeVisible();

  await page.getByLabel(auth.codeLabel).fill(await codeSentTo(CLIENT.email, since));
  await page.getByRole('button', { name: auth.confirmCode }).click();

  await expect(
    page.getByRole('heading', { name: `${home.greeting}, ${CLIENT.name}` }),
  ).toBeVisible();
  await expect(page.getByText(home.client.calendarSoon)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

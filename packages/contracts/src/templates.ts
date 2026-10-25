import { PermanentError } from '@fisio/domain';
import { z } from 'zod';
import { EmailSchema } from './schemas';

/**
 * Message templates (docs/architecture.md §3.5, §5.4): typed render functions from the params a
 * NOTIFICATION item stores to an Italian email with a plain-text body and a minimal HTML body.
 * Params are validated when a message is rendered, so an item whose params no longer fit its
 * template fails with a `PermanentError` (retrying cannot fix it). WP0.6 has the invitation;
 * confirmation, cancellation, reminder and digest arrive with M2.
 */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const WebUrlSchema = z.url({ protocol: /^https?$/ });

export const InvitationParamsSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: EmailSchema,
    /** The SPA's sign-in page. */
    appUrl: WebUrlSchema,
  })
  .strict();
export type InvitationParams = z.infer<typeof InvitationParamsSchema>;

interface Step {
  readonly text: string;
  readonly href?: string;
}

function stepHtml(step: Step): string {
  const link = step.href ? ` <a href="${escapeHtml(step.href)}">${escapeHtml(step.href)}</a>` : '';
  return `<li>${escapeHtml(step.text)}${link}</li>`;
}

function renderInvitation(params: InvitationParams): RenderedEmail {
  const subject = 'Il tuo invito a Fisio Calendar';
  const intro =
    'ti diamo il benvenuto in Fisio Calendar, dove prenoti e gestisci i tuoi appuntamenti.';
  // One list for both bodies; a step's `href` follows its text, as a link in the HTML body.
  const steps: readonly Step[] = [
    { text: 'Apri', href: params.appUrl },
    { text: `Inserisci il tuo indirizzo email: ${params.email}` },
    { text: 'Riceverai per email un codice di accesso: inseriscilo e sei dentro.' },
  ];
  const outro = 'Non serve nessuna password. Se non aspettavi questo messaggio, puoi ignorarlo.';
  const text = [
    `Ciao ${params.name},`,
    '',
    intro,
    '',
    'Per accedere:',
    ...steps.map(
      (step, index) => `${index + 1}. ${step.href ? `${step.text} ${step.href}` : step.text}`,
    ),
    '',
    outro,
  ].join('\n');
  const html = layout(subject, [
    `<p>Ciao ${escapeHtml(params.name)},</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    '<p>Per accedere:</p>',
    `<ol>${steps.map(stepHtml).join('')}</ol>`,
    `<p>${escapeHtml(outro)}</p>`,
  ]);
  return { subject, text, html };
}

const TEMPLATES = {
  invitation: { params: InvitationParamsSchema, render: renderInvitation },
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as readonly TemplateName[];
export type TemplateParams<T extends TemplateName> = z.input<(typeof TEMPLATES)[T]['params']>;

/**
 * The email for a stored notification. Throws `PermanentError` for an unknown template or params
 * that do not fit it; the error names the template and the rejected paths, never their values.
 */
export function renderTemplate(template: string, params: unknown): RenderedEmail {
  if (!Object.hasOwn(TEMPLATES, template)) {
    throw new PermanentError(`unknown template "${template.slice(0, 40)}"`);
  }
  const definition = TEMPLATES[template as TemplateName];
  const parsed = definition.params.safeParse(params);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new PermanentError(
      `template ${template}: invalid params ${[...new Set(paths)].join(', ')}`,
    );
  }
  return definition.render(parsed.data);
}

/** The minimal HTML layout every email shares: one column, system fonts, no images. */
function layout(title: string, blocks: readonly string[]): string {
  return [
    '<!doctype html>',
    '<html lang="it">',
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:24px;font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a">',
    '<div style="max-width:560px;margin:0 auto">',
    ...blocks,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

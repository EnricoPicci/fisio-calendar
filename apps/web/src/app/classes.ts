/**
 * The few Tailwind class strings every page composes from (docs/architecture.md §7.2:
 * mobile-first, large touch targets). One module so the forms of later work packages do not
 * drift in padding, radius or colour. Templates import these; they carry no logic.
 */
export const FORM = 'mt-6 flex flex-col gap-4';
export const FIELD = 'flex flex-col gap-1';
export const INPUT =
  'rounded-md border border-stone-300 px-3 py-3 text-lg focus:border-teal-700 focus:outline-2 focus:outline-teal-700';
export const BUTTON =
  'rounded-md bg-teal-700 px-4 py-3 text-lg font-medium text-white hover:bg-teal-800 active:bg-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50';
/** Secondary actions keep the underlined-text look with a 44 px touch target. */
export const LINK =
  'inline-flex min-h-11 items-center px-2 -mx-2 text-teal-800 underline hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700';
export const ALERT = 'mt-4 text-red-700';

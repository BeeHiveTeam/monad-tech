import { redirect } from 'next/navigation';

/**
 * /delegate redirects to /validators?view=delegator (audit 2026-05-21).
 *
 * The picker was originally a separate page but it duplicated /validators data
 * with only a Pick column + filters as differentiation. Merged into /validators
 * as a view-mode toggle for a cleaner architecture (single source for table
 * rendering, fewer pages, URL-shareable view state).
 *
 * Old external links continue to work via this redirect.
 */
export default function DelegateRedirect() {
  redirect('/validators?view=delegator');
}

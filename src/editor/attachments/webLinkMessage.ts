/**
 * Turn a `code:message` failure from the web fetch into something a student
 * can act on. Shared by the save dialog and the viewer's "Fetch again", so a
 * page that was refused once is refused in the same words the second time.
 */
export function webLinkFailureMessage(raw: string, t: (key: string) => string): string {
  const code = raw.split(':', 1)[0] ?? '';
  if (code === 'refused_host' || code === 'refused_scheme')
    return t('editor.linkRefusedHost');
  if (code === 'not_html') return t('editor.linkNotHtml');
  if (code === 'blocked') return t('editor.linkBlocked');
  if (code === 'too_large') return t('editor.linkTooLarge');
  if (code === 'empty_page') return t('editor.linkEmpty');
  // The browser build cannot fetch at all, and "could not save" would send
  // someone hunting for a fault that is not there.
  if (code === 'unsupported') return t('editor.linkNeedsDesktop');
  return t('editor.linkFailed');
}

/**
 * Inline script injected in <head> to apply the stored theme BEFORE
 * React hydrates. Running after the first paint would flash the
 * wrong theme on navigation/reload, which is jarring.
 *
 * Default: `dark` (per ui-style-guide §2). The toggle writes
 * `localStorage.setItem('theme', 'dark' | 'light')` and this script
 * reads it back on every page load.
 */
const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

export function ThemeBootScript(): JSX.Element {
  return <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />;
}

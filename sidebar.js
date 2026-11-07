/** Desktop collapse preference is independent of the temporary mobile drawer. */
export function createSidebar({ sidebar, collapseButton, expandButton, mobileButton, overlay }) {
  const mobile = window.matchMedia('(max-width: 768px)');
  let collapsed = false, mobileOpen = false;
  try { collapsed = localStorage.getItem('catchup_sidebar_collapsed') === 'true'; } catch { /* Storage is optional. */ }

  function render(restoreFocus = false) {
    const visible = mobile.matches ? mobileOpen : !collapsed;
    const focusWasInside = sidebar.contains(document.activeElement);
    document.body.classList.toggle('sidebar-collapsed', !mobile.matches && collapsed);
    sidebar.classList.toggle('open', mobile.matches && mobileOpen);
    sidebar.inert = !visible;
    sidebar.setAttribute('aria-hidden', String(!visible));
    collapseButton.setAttribute('aria-label', mobile.matches ? 'Close sidebar' : 'Collapse sidebar');
    collapseButton.title = mobile.matches ? 'Close sidebar' : 'Collapse sidebar';
    collapseButton.setAttribute('aria-expanded', String(visible));
    expandButton.classList.toggle('hidden', mobile.matches || !collapsed);
    expandButton.setAttribute('aria-expanded', String(visible));
    overlay.classList.toggle('hidden', !mobile.matches || !mobileOpen);
    mobileButton.setAttribute('aria-expanded', String(mobile.matches && mobileOpen));
    mobileButton.setAttribute('aria-label', mobileOpen ? 'Close menu' : 'Open menu');
    if (restoreFocus && focusWasInside && !visible) {
      (mobile.matches ? mobileButton : expandButton).focus({ preventScroll: true });
    }
  }
  function close() { mobileOpen = false; render(true); }
  collapseButton.addEventListener('click', () => {
    if (mobile.matches) { close(); return; }
    collapsed = true;
    try { localStorage.setItem('catchup_sidebar_collapsed', 'true'); } catch { /* Still works without persistence. */ }
    render(); expandButton.focus({ preventScroll: true });
  });
  expandButton.addEventListener('click', () => {
    collapsed = false;
    try { localStorage.setItem('catchup_sidebar_collapsed', 'false'); } catch { /* Still works without persistence. */ }
    render(); collapseButton.focus({ preventScroll: true });
  });
  mobileButton.addEventListener('click', () => {
    mobileOpen = !mobileOpen; render();
    if (mobileOpen) collapseButton.focus({ preventScroll: true });
  });
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && mobileOpen) close(); });
  mobile.addEventListener('change', () => { mobileOpen = false; render(true); });
  render();
  return { close };
}

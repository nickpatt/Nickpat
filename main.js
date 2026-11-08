(() => {
  const rows = document.querySelector('.rows');
  const detail = document.querySelector('.detail');
  if (!rows || !detail) return;

  // "now" marker: months since Aug 2023, clamped to the axis (Aug 2023 – May 2028).
  const d = new Date();
  const m = (d.getFullYear() - 2023) * 12 + d.getMonth() - 7 + (d.getDate() - 1) / 30;
  rows.style.setProperty('--now', Math.max(0, Math.min(57, m)).toFixed(2));

  // Detail line reads the hovered / focused span.
  // Pointer: a 150ms blur crossfade so the two texts read as one changing line.
  // Keyboard: swap instantly; never animate keyboard-driven changes.
  const spanRows = [...rows.querySelectorAll('.row')];
  let inner = detail.querySelector('.detail-in');
  const defaultHTML = inner.innerHTML;
  const motionOK = window.matchMedia('(prefers-reduced-motion: no-preference)');
  let viaKeyboard = false;
  let current = null;
  let swapTimer = 0;

  document.addEventListener('keydown', (e) => { if (e.key === 'Tab' || e.key.startsWith('Arrow')) viaKeyboard = true; }, true);
  document.addEventListener('pointerdown', () => { viaKeyboard = false; }, true);
  document.addEventListener('pointermove', () => { viaKeyboard = false; }, { capture: true, passive: true });

  const render = (row) => {
    if (!row) { inner.innerHTML = defaultHTML; return; }
    const t = document.createElement('strong');
    t.textContent = row.dataset.title;
    const s = document.createElement('span');
    s.className = 'detail-sub';
    s.textContent = row.dataset.detail;
    inner.replaceChildren(t, s);
  };

  const show = (row) => {
    if (row === current) return;
    current = row;
    spanRows.forEach((r) => r.classList.toggle('is-active', r === row));
    clearTimeout(swapTimer);
    if (viaKeyboard || !motionOK.matches) { inner.classList.remove('is-swapping'); render(row); return; }
    inner.classList.add('is-swapping');
    swapTimer = setTimeout(() => {
      render(row);
      inner.classList.remove('is-swapping');
    }, 110);
  };

  spanRows.forEach((row) => {
    row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(row); });
    row.addEventListener('focus', () => show(row));
  });
  rows.addEventListener('pointerleave', () => { if (!rows.contains(document.activeElement)) show(null); });
  rows.addEventListener('focusout', (e) => { if (!rows.contains(e.relatedTarget)) show(null); });

  // Anchor jumps: move focus to the target so keyboard and screen-reader users land there too.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || a.classList.contains('skip')) return;
    const id = a.getAttribute('href').slice(1);
    const target = id && id !== 'top' && document.getElementById(id);
    if (!target) return;
    // Pointer clicks glide; keyboard activation (detail 0) and reduced motion jump instantly.
    e.preventDefault();
    const glide = e.detail > 0 && motionOK.matches;
    target.scrollIntoView({ behavior: glide ? 'smooth' : 'auto', block: 'start' });
    history.pushState(null, '', '#' + id);
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });
})();

// TraceForge sampler replay. Plays a recorded run (traceforge-replay.json): real traces arrive in
// the order they started, and each gets the decision the tail sampler actually made. Never autoplays.
// Same model as the CodeSession replay: one position number drives every state, so scrubbing,
// pausing and playing all land in the same place. Any arrived trace can be opened as a waterfall.
(() => {
  const root = document.getElementById('tf-replay');
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const playBtn = $('[data-play]'), playLabel = $('[data-play-label]'), restartBtn = $('[data-restart]');
  const scrub = $('[data-scrub]'), list = $('[data-list]'), idle = $('[data-idle]'), count = $('[data-count]');
  const wf = $('[data-wf]'), wfTitle = $('[data-wf-title]'), chip = $('[data-chip]'), meta = $('[data-meta]'), run = $('[data-run]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const STEP = 1100, HOLD = 1500, DECIDE_AT = 0.55; // playback pace, not real time (the meta line says so)
  const colours = { frontend: '#2563eb', api: '#16a34a', auth: '#0d9488', db: '#d97706', cache: '#db2777' };
  const fallback = ['#0891b2', '#64748b', '#b45309'];
  const colourOf = (svc) => colours[svc] || (colours[svc] = fallback[Object.keys(colours).length % fallback.length]);
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtMs = (ms) => ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms >= 10 ? ms.toFixed(0) + ' ms' : ms >= 1 ? ms.toFixed(1) + ' ms' : Math.max(1, Math.round(ms * 1000)) + ' µs';
  const label = { error: 'kept: error', slow: 'kept: slow', probabilistic: 'kept: 5% sample', dropped: 'dropped' };
  const why = (d, p) => ({
    error: 'Kept: a span in it failed, and every failed trace is kept.',
    slow: `Kept: the request took ${fmtMs(d.rootMs)}, over the ${p.slowMs} ms slow threshold.`,
    probabilistic: `Kept by the ${Math.round(p.baseRate * 100)}% random sample of ordinary traces.`,
    dropped: `Dropped: no error, under ${p.slowMs} ms, and not in the ${Math.round(p.baseRate * 100)}% sample.`,
  }[d.reason]);

  let data = null, total = 0, pos = 0, playing = false, last = 0, raf = 0, picked = -1;
  let lastKey = '', wfKey = '';

  function build(d) {
    data = d;
    total = d.traces.length * STEP + HOLD;
    const when = new Date(d.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const spanS = (d.traces[d.traces.length - 1].arrivedMs / 1000).toFixed(1);
    meta.textContent = `Recorded ${when} from a local run: ${d.traces.length} real traces (${d.window.replace('Traces ', '').replace(', in the order they started', '')}) that started within ${spanS} s. The sampler decides each trace 2 s after its last span; playback is paced for reading.`;
    const r = d.run, kept = r.kept.error + r.kept.slow + r.kept.probabilistic;
    run.textContent = `Across the whole run: ${r.traces} traces, ${kept} kept (${r.kept.error} with errors, ${r.kept.slow} slow, ${r.kept.probabilistic} random) and ${r.dropped} dropped, ${Math.round((r.dropped / r.traces) * 100)}% of traces.`;
    list.replaceChildren(...d.traces.map((t, i) => {
      const max = Math.max(...d.traces.map((x) => x.rootMs));
      const w = Math.max(3, (Math.log10(t.rootMs) / Math.log10(max)) * 100);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tfr-row';
      b.dataset.reason = t.reason;
      b.innerHTML = `<span class="tfr-route">${esc(t.route)}</span><span class="tfr-ms">${fmtMs(t.rootMs)}</span><span class="tfr-bar" aria-hidden="true"><i style="width:${w}%"></i></span><span class="tfr-dec" data-dec></span>`;
      b.addEventListener('click', () => { if (playing) setPlaying(false); picked = i; render(true); });
      const li = document.createElement('li');
      li.hidden = true;
      li.append(b);
      return li;
    }));
    [playBtn, restartBtn, scrub].forEach((el) => { el.disabled = false; });
  }

  const at = (t) => Math.min(data.traces.length - 1, Math.floor(t / STEP));

  function waterfall(t) {
    const end = Math.max(...t.spans.map((s) => s.startMs + s.ms));
    const depth = t.spans.map(() => 0);
    t.spans.forEach((s, k) => { let p = s.parent, d = 0; while (p >= 0 && d < 10) { d++; p = t.spans[p].parent; } depth[k] = d; });
    return '<ol class="tfr-spans">' + t.spans.map((s, k) => {
      const left = (s.startMs / end) * 100, width = Math.max(0.6, (s.ms / end) * 100);
      // Label after the bar if it fits, else before it, else inside the bar's right end.
      const pos = left + width <= 72 ? `left:calc(${left + width}% + 4px)` : left >= 24 ? `right:calc(${100 - left}% + 4px)` : `right:calc(${100 - left - width}% + 5px)`;
      const inside = left + width > 72 && left < 24;
      return `<li class="tfr-span${s.error ? ' is-err' : ''}" style="--c:${colourOf(s.service)};--d:${depth[k]}"><span class="tfr-sl"><i aria-hidden="true"></i><span class="tfr-svc">${esc(s.service)}</span> ${esc(s.name)}${s.error ? ' <b>error</b>' : ''}</span><span class="tfr-track" aria-hidden="true"><span class="tfr-sb" style="left:${left}%;width:${width}%"></span><span class="tfr-sd${inside ? ' is-in' : ''}" style="${pos}">${fmtMs(s.ms)}</span></span><span class="sr-only">: starts at ${fmtMs(s.startMs)}, takes ${fmtMs(s.ms)}</span></li>`;
    }).join('') + '</ol>';
  }

  function render(instant) {
    if (!data) return;
    root.classList.toggle('is-instant', !!instant || reduce.matches);
    const started = pos > 0 || playing || picked >= 0;
    const i = at(pos), p = (pos - i * STEP) / STEP;
    const arrived = started ? (pos >= total - HOLD ? data.traces.length - 1 : i) : -1;
    const decidedUpTo = pos >= total - HOLD ? arrived : (p >= DECIDE_AT ? i : i - 1);

    const key = `${arrived}|${decidedUpTo}|${picked}`;
    if (key !== lastKey) {
      lastKey = key;
      idle.hidden = started;
      let kept = 0, dropped = 0;
      [...list.children].forEach((li, k) => {
        const t = data.traces[k], show = k <= arrived, decided = k <= decidedUpTo, b = li.firstChild;
        li.hidden = !show;
        b.classList.toggle('is-decided', decided);
        b.querySelector('[data-dec]').textContent = decided ? label[t.reason] : 'waiting for late spans';
        b.setAttribute('aria-label', `${t.route}, ${fmtMs(t.rootMs)}: ${decided ? label[t.reason] : 'waiting for the sampler'}`);
        b.setAttribute('aria-pressed', String(k === (picked >= 0 ? picked : arrived)));
        if (show && decided) t.kept ? kept++ : dropped++;
      });
      count.textContent = started ? `${kept} kept · ${dropped} dropped` : '';
      const focusRow = list.children[picked >= 0 ? picked : arrived];
      if (focusRow && !focusRow.hidden) {
        const top = focusRow.offsetTop, bottom = top + focusRow.offsetHeight;
        if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, bottom - list.clientHeight + 8);
      }
    }

    // Waterfall: the trace you picked, else the one arriving now.
    const show = picked >= 0 ? picked : arrived;
    const decided = show >= 0 && show <= decidedUpTo;
    const wk = `${show}|${decided}`;
    if (wk !== wfKey) {
      wfKey = wk;
      if (show < 0) { wf.innerHTML = ''; chip.hidden = true; wfTitle.textContent = 'Waterfall'; }
      else {
        const t = data.traces[show];
        wfTitle.textContent = `${t.route} · ${fmtMs(t.rootMs)}`;
        if (!wf.dataset.trace || wf.dataset.trace !== String(show)) { wf.innerHTML = waterfall(t); wf.dataset.trace = String(show); }
        const note = wf.querySelector('.tfr-why') || Object.assign(document.createElement('p'), { className: 'tfr-why' });
        note.textContent = decided ? why(t, data.policy) : 'Buffered by trace ID until no new spans arrive for 2 s.';
        wf.append(note);
        chip.hidden = !decided;
        if (decided) { chip.textContent = label[t.reason]; chip.dataset.state = t.kept ? (t.reason === 'error' ? 'fail' : 'pass') : 'drop'; }
      }
    }
    scrub.value = total ? Math.round((pos / total) * 1000) : 0;
    scrub.setAttribute('aria-valuetext', started ? `Trace ${Math.max(0, arrived) + 1} of ${data.traces.length}` : 'Not started');
  }

  function setPlaying(on) {
    playing = on;
    root.classList.toggle('is-playing', on);
    playLabel.textContent = on ? 'Pause' : (pos >= total && total ? 'Replay' : 'Play');
    playBtn.setAttribute('aria-label', on ? 'Pause replay' : 'Play replay');
    cancelAnimationFrame(raf);
    if (on) {
      // Analytics: count starts only (this button also pauses). No-op when Umami is absent.
      try { window.umami?.track('replay-play', { project: root.dataset.project }); } catch {}
      picked = -1; last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function tick(now) {
    pos = Math.min(total, pos + (now - last));
    last = now;
    render(false);
    if (pos >= total) { setPlaying(false); return; }
    raf = requestAnimationFrame(tick);
  }

  let loading = null;
  const load = () => loading || (loading = fetch(root.dataset.src)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(build)
    .catch(() => { meta.textContent = 'The recording could not be loaded.'; [playBtn, restartBtn, scrub].forEach((el) => { el.disabled = true; }); }));

  playBtn.addEventListener('click', async () => {
    await load(); if (!data) return;
    if (playing) { setPlaying(false); return; }
    if (pos >= total) pos = 0;
    setPlaying(true);
  });
  restartBtn.addEventListener('click', async () => {
    await load(); if (!data) return;
    pos = 0; picked = -1; render(true); setPlaying(true);
  });
  scrub.addEventListener('input', async () => {
    await load(); if (!data) return;
    if (playing) setPlaying(false);
    picked = -1;
    pos = (scrub.value / 1000) * total;
    render(true);
    playLabel.textContent = pos >= total ? 'Replay' : 'Play';
  });

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load().then(() => render(true)); } }, { rootMargin: '600px 0px' });
    io.observe(root);
  } else load().then(() => render(true));
})();

// CodeSession agent replay. Plays a recorded run (codesession-replay.json) step by step.
// Never autoplays. Time is derived from one number (pos), so scrubbing, restarting and
// pausing mid-step all land on the same state as playing through to that point.
(() => {
  const root = document.getElementById('replay');
  if (!root) return;
  const $ = (s) => root.querySelector(s);
  const playBtn = $('[data-play]'), playLabel = $('[data-play-label]'), restartBtn = $('[data-restart]');
  const scrub = $('[data-scrub]'), code = $('[data-code]'), out = $('[data-out]'), chip = $('[data-chip]');
  const stepsEl = $('[data-steps]'), live = $('[data-live]'), meta = $('[data-meta]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Playback pace per step kind (ms). The recorded run is shorter than this; real timings are
  // shown in the meta line and on the model step, so the pacing is never passed off as real time.
  const pace = { prompt: 1400, read: 1700, think: 2000, edit: 3200, note: 1400, done: 2400, failed: 2400 };
  const runPace = (n) => Math.min(3000, 900 + 260 * n);

  let data = null, timeline = [], total = 0, pos = 0, playing = false, last = 0, raf = 0;
  let shownKey = '', outKey = '', announced = -1, lastStepKey = '';

  const fmtS = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function build(d) {
    data = d;
    let at = 0;
    timeline = d.steps.map((s) => {
      const dur = s.kind === 'run' ? runPace(s.output.length) : (pace[s.kind] || 1400);
      const item = { ...s, start: at, dur };
      at += dur;
      return item;
    });
    total = at;
    const when = new Date(d.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const mock = /mock/i.test(d.model) ? ' Its edit decision is scripted; the shared-document edit, the Docker sandbox and the pytest output are real.' : '';
    meta.textContent = `Recorded ${when} with ${d.model}.${mock} The real run took ${fmtS(d.realDurationMs)}; playback is paced for reading.`;
    stepsEl.replaceChildren(...timeline.map((s) => {
      const li = document.createElement('li');
      li.textContent = s.kind === 'think' && s.modelMs != null ? `${s.label}. The model answered in ${fmtS(s.modelMs)}.`
        : s.kind === 'run' ? `${s.label}: ${summary(s) || (s.exitCode === 0 ? 'passed' : 'failed')}`
        : s.label;
      return li;
    }));
    [playBtn, restartBtn, scrub].forEach((el) => { el.disabled = false; });
  }

  function summary(run) {
    const m = run.output.join('').match(/(\d+ (?:passed|failed)(?:, \d+ (?:passed|failed))?)/g);
    return m ? m[m.length - 1] : '';
  }

  function stepAt(t) {
    let i = 0;
    while (i < timeline.length - 1 && t >= timeline[i + 1].start) i++;
    return i;
  }

  function render(instant) {
    if (!data) return;
    root.classList.toggle('is-instant', !!instant || reduce.matches);
    const i = stepAt(pos), s = timeline[i];
    const p = Math.min(1, Math.max(0, (pos - s.start) / s.dur));
    const started = pos > 0 || playing;

    // Editor: last edit at or before this step decides the text.
    let text = data.files['src/calc.py'], mark = 0, phase = '';
    for (let k = 0; k <= i; k++) {
      const st = timeline[k];
      if (st.kind !== 'edit' || st.path !== 'src/calc.py') continue;
      if (k < i) { text = st.after; continue; }
      mark = st.line;
      if (p < 0.3) { text = st.before; phase = 'old'; } else { text = st.after; phase = 'new'; }
    }
    const codeKey = `${text}|${mark}|${phase}`;
    if (codeKey !== shownKey) {
      shownKey = codeKey;
      code.innerHTML = text.replace(/\n$/, '').split('\n').map((ln, n) => {
        const num = n + 1, cls = num === mark ? ` is-${phase}` : '';
        const caret = num === mark && phase === 'new' ? '<span class="rp-caret"><span><span class="rp-full">CodeSession </span>Agent</span></span>' : '';
        return `<span class="ln${cls}"><i>${num}</i>${esc(ln)}${caret}</span>`;
      }).join('');
      const hit = mark && code.querySelector(`.ln:nth-child(${mark})`);
      if (hit) code.scrollTop = Math.max(0, hit.offsetTop - code.clientHeight / 2);
    }

    // Terminal: the latest pytest run so far, its chunks revealed across the step.
    let r = -1;
    for (let k = i; k >= 0; k--) if (timeline[k].kind === 'run') { r = k; break; }
    if (!started || r < 0) {
      if (outKey !== 'idle') { outKey = 'idle'; out.innerHTML = '<span class="rp-idle">Press play to watch the run: pytest fails, the agent edits the file as a collaborator, pytest passes.</span>'; chip.hidden = true; }
    } else {
      const run = timeline[r], n = run.output.length;
      const shown = r < i ? n : Math.min(n, Math.ceil(Math.max(0, p - 0.12) / 0.7 * n));
      const key = `${r}`;
      if (outKey.split(':')[0] !== key || +outKey.split(':')[1] > shown) { out.innerHTML = ''; outKey = `${key}:0`; }
      const have = +outKey.split(':')[1];
      for (let c = have; c < shown; c++) {
        const span = document.createElement('span');
        span.className = 'rp-chunk';
        span.textContent = run.output[c];
        out.append(span);
      }
      outKey = `${key}:${shown}`;
      out.scrollTop = out.scrollHeight;
      const done = shown >= n;
      chip.hidden = !done;
      if (done) {
        chip.textContent = summary(run) || (run.exitCode === 0 ? 'passed' : 'failed');
        chip.dataset.state = run.exitCode === 0 ? 'pass' : 'fail';
      }
    }

    // Steps list and announcements: only when the step (or started state) changes.
    scrub.value = total ? Math.round((pos / total) * 1000) : 0;
    const stepKey = `${started}|${i}|${pos >= total}`;
    if (stepKey === lastStepKey) return;
    lastStepKey = stepKey;
    [...stepsEl.children].forEach((li, k) => {
      li.classList.toggle('is-done', started && (k < i || (k === i && pos >= total)));
      if (started && k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    const label = stepsEl.children[i]?.textContent || '';
    scrub.setAttribute('aria-valuetext', started ? `Step ${i + 1} of ${timeline.length}: ${label}` : 'Not started');
    if (playing && announced !== i) { announced = i; live.textContent = label; }
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
      last = performance.now(); raf = requestAnimationFrame(tick); }
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
    await load();
    if (!data) return;
    if (playing) { setPlaying(false); return; }
    if (pos >= total) { pos = 0; announced = -1; }
    setPlaying(true);
  });
  restartBtn.addEventListener('click', async () => {
    await load();
    if (!data) return;
    pos = 0; announced = -1;
    render(true);
    setPlaying(true);
  });
  scrub.addEventListener('input', async () => {
    await load();
    if (!data) return;
    if (playing) setPlaying(false);
    pos = (scrub.value / 1000) * total;
    render(true);
    playLabel.textContent = pos >= total ? 'Replay' : 'Play';
  });

  // Fetch the small recording when the player comes near the viewport, so the step list is
  // the real one before anyone presses play (and for screen readers that never press it).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load().then(() => render(true)); }
    }, { rootMargin: '600px 0px' });
    io.observe(root);
  } else load().then(() => render(true));
})();

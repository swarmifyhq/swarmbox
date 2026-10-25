// A run's report: one HTML page beside its screenshots and traces, readable offline and publishable as a
// folder anywhere that serves one. Every value from the world or the agent is escaped: an AI tester
// can type anything into a screen, and the page must not run it.

import type { RunRecord, Severity } from './run.ts';

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, note: 3 };

const minutes = (a: string, b: string) =>
  Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 6000) / 10);

export function renderReport(r: RunRecord): string {
  const checks = r.checks?.results ?? [];
  const bad = checks.filter((c) => c.outcome === 'fail' || c.outcome === 'error');
  const findings = [...r.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.n - b.n);
  const verdict =
    findings.some((f) => f.severity === 'blocker' || f.severity === 'major') || bad.length
      ? 'Problems found'
      : findings.length
        ? 'Minor findings'
        : 'Nothing wrong found';
  const unsettled = Object.entries(r.checks?.settled ?? {}).filter(([, s]) => !s.settled);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.scenario.title)}: ${esc(r.product)} run</title>
<style>
  :root { --bg:#f6f5f2; --panel:#fff; --ink:#1c1b19; --muted:#6b6860; --line:#e2dfd8;
    --red:#a8321e; --red-bg:#fbe5df; --amber:#8a5a00; --amber-bg:#fbefd5; --green:#2f6f4f; --green-bg:#e3f0e8;
    --grey-bg:#eceae5; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1d1c1a; --ink:#ece9e2; --muted:#9a968c;
    --line:#2e2d2a; --red:#f08a73; --red-bg:#3a1d16; --amber:#e8b85a; --amber-bg:#33270f; --green:#7fc8a1;
    --green-bg:#1d3328; --grey-bg:#2a2926; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont,
    "Segoe UI", system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 32px 0 10px; }
  .muted { color: var(--muted); }
  .verdict { display:inline-block; margin: 12px 0 4px; font-weight: 650; padding: 4px 12px; border-radius: 999px; }
  .v-bad { color: var(--red); background: var(--red-bg); } .v-minor { color: var(--amber); background: var(--amber-bg); }
  .v-ok { color: var(--green); background: var(--green-bg); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  ul { margin: 6px 0; padding-left: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
  .finding { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 14px; }
  .finding .head { padding: 12px 16px; display:flex; gap:10px; align-items: baseline; flex-wrap: wrap; }
  .finding .body { padding: 0 16px 14px; }
  .finding img { display:block; width:100%; border-top: 1px solid var(--line); }
  .sev { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 6px; }
  .sev-blocker, .sev-major { color: var(--red); background: var(--red-bg); }
  .sev-minor { color: var(--amber); background: var(--amber-bg); } .sev-note { color: var(--muted); background: var(--grey-bg); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; font-size: 14px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: 13px; }
  .o-pass { color: var(--green); } .o-fail, .o-error { color: var(--red); font-weight: 650; }
  .o-known-red { color: var(--amber); } .o-nothing-to-check { color: var(--muted); }
  code, .mono { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="muted">${esc(r.product)} run · ${esc(r.id)}</div>
  <h1>${esc(r.scenario.title)}</h1>
  <div class="verdict ${verdict === 'Problems found' ? 'v-bad' : verdict === 'Minor findings' ? 'v-minor' : 'v-ok'}">${esc(verdict)}</div>
  <p>${esc(r.scenario.goal)}</p>
  ${r.summary ? `<div class="panel"><strong>Summary.</strong> ${esc(r.summary)}</div>` : ''}
  <p class="muted">${esc(r.provenance)}<br>
    ${esc(r.startedAt)} → ${esc(r.endedAt ?? 'still running')} · ${r.endedAt ? minutes(r.startedAt, r.endedAt) : '?'} minutes
    of ${r.scenario.budgetMinutes} · ${r.browserMinutes ?? '?'} browser-minutes</p>

  <h2>The scenario</h2>
  <div class="grid">
    <div class="panel"><strong>Cast</strong><ul>${r.cast
      .map(
        (c) =>
          `<li>${esc(c.persona.name)}, ${esc(c.role)}${c.part ? ` (${esc(c.part)})` : ''} · screen ${esc(c.screen)}</li>`,
      )
      .join('')}</ul></div>
    <div class="panel"><strong>What to try</strong><ul>${r.scenario.try.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div class="panel"><strong>What good looks like</strong><ul>${r.scenario.expect.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    ${r.scenario.conditions.length ? `<div class="panel"><strong>Conditions</strong><ul>${r.scenario.conditions.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
  </div>

  <h2>Findings (${findings.length})</h2>
  ${
    findings.length === 0
      ? '<p class="muted">None logged.</p>'
      : findings
          .map(
            (
              f,
            ) => `<div class="finding"><div class="head"><span class="sev sev-${f.severity}">${f.severity}</span>
      <strong>${esc(f.title)}</strong><span class="muted">#${f.n}${f.screen ? ` · ${esc(f.screen)}` : ''} · ${esc(f.at.slice(11, 19))}${f.filed ? ` · ${esc(f.filed)}` : ''}</span></div>
      <div class="body"><div>${esc(f.what)}</div>${f.expected ? `<div class="muted">Expected: ${esc(f.expected)}</div>` : ''}
      ${f.url ? `<div class="mono muted">${esc(f.url)}</div>` : ''}</div>
      ${f.screenshot ? `<img src="${esc(f.screenshot)}" alt="Screen ${esc(f.screen)} when this was logged">` : ''}</div>`,
          )
          .join('\n')
  }

  <h2>Checks on the data (${checks.length})</h2>
  ${unsettled.length ? `<p class="o-fail">The worker had not caught up in ${unsettled.map(([k]) => esc(k)).join(', ')} when the checks ran.</p>` : ''}
  <div class="table-wrap"><table><thead><tr><th>Check</th><th>Where</th><th>Result</th><th>Looked at</th></tr></thead><tbody>
  ${[...checks]
    .sort(
      (a, b) =>
        Number(b.outcome === 'fail' || b.outcome === 'error') -
        Number(a.outcome === 'fail' || a.outcome === 'error'),
    )
    .map(
      (c) => `<tr><td>${esc(c.title)}<div class="mono muted">${esc(c.id)}</div>${c.violations
        .map(
          (v) =>
            `<pre>${esc(v.summary)}${v.rows ? `\n${esc(JSON.stringify(v.rows.slice(0, 5), null, 1))}` : ''}</pre>`,
        )
        .join(
          '',
        )}${c.error ? `<pre>${esc(c.error)}</pre>` : ''}${c.knownRed ? `<pre>known: ${esc(c.knownRed.ref)}</pre>` : ''}</td>
      <td>${esc(c.where)}</td><td class="o-${esc(c.outcome)}">${esc(c.outcome)}</td><td>${c.examined} ${esc(c.unit)}</td></tr>`,
    )
    .join('\n')}
  </tbody></table></div>

  <h2>What the browsers saw go wrong (${r.signals?.length ?? 0})</h2>
  ${
    (r.signals?.length ?? 0) === 0
      ? '<p class="muted">No console errors, uncaught errors, server errors or failed requests.</p>'
      : `
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Screen</th><th>Kind</th><th>What</th></tr></thead><tbody>
  ${r
    .signals!.slice(0, 200)
    .map(
      (
        s,
      ) => `<tr><td class="mono">${esc(s.at.slice(11, 19))}</td><td>${esc(s.screen)}</td><td>${esc(s.kind)}</td>
      <td>${esc(s.text)}${s.url ? `<div class="mono muted">${esc(s.url)}</div>` : ''}</td></tr>`,
    )
    .join('\n')}
  </tbody></table></div>`
  }

  <h2>Traces</h2>
  <p class="muted">Every action, request and frame of each screen. Open one with <code>npx playwright show-trace &lt;file&gt;</code> from this folder.</p>
  <ul>${(r.traces ?? []).map((t) => `<li><code>${esc(t.file)}</code> · screen ${esc(t.screen)}</li>`).join('')}</ul>
</main>
</body>
</html>
`;
}

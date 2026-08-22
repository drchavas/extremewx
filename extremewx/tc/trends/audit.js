/*
 * Compare tccard.html against audit_ref.json, the from-scratch re-derivation in
 * audit.py.  Two levels:
 *
 *   1. the page's own functions  -- cellMetrics, zonalMetrics, totalValue,
 *      seasonValue, smoothField
 *   2. what is actually DRAWN    -- every map cell's value parsed back out of
 *      the rendered SVG tooltips, which is the end of the whole chain
 *
 * The second matters because a correct computation can still be drawn wrong.
 *
 *     node audit.js [dir]
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');
const topojson = require('topojson-client');

const DIR = process.argv[2] || '.';
let checks = 0, fails = 0;
const bad = [];

function ok(name, cond, got, want) {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; bad.push(name); console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`); }
}
function near(name, got, want, tol) {
  ok(name, Math.abs(got - want) <= tol, got, `${want} ± ${tol}`);
}
/* The page accumulates in Float32Array (eps ~1.2e-7) while audit.py works in
   float64, so agreement is bounded by float32 precision, not by method.  A
   relative tolerance of 1e-6 is an order of magnitude above that and still far
   tighter than anything that could matter. */
const REL = 1e-6;
const relErr = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

async function load(hash) {
  const html = fs.readFileSync(path.join(DIR, 'tccard.html'), 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com\/topojson-client[^>]*><\/script>/, '');
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('jsdom error:', e.message));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    url: 'http://localhost/extremewx/tc/trends/tccard.html' + (hash ? '#' + hash : '')
  });
  const w = dom.window;
  w.topojson = topojson;
  w.fetch = async (url) => {
    const buf = fs.readFileSync(path.join(DIR, url.replace(/^\.?\//, '')));
    return { ok: true, status: 200,
             json: async () => JSON.parse(buf.toString('utf8')),
             arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  w.DecompressionStream = class {};
  w.Blob = class { constructor(p) { this.parts = p; } stream() { return { pipeThrough: () => this.parts[0] }; } };
  w.Response = class { constructor(ab) { this.ab = ab; }
                       async text() { return zlib.gunzipSync(Buffer.from(this.ab)).toString('utf8'); } };
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1]
    + '\n;window.__state=()=>({IX,S,A,G,NLAT,NLON,NCELL,NY,GRID,Y0,VARS,THEME,CMAP});';
  w.eval(script);
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (w.document.getElementById('card').style.display === 'block') break;
  }
  w.st = w.__state();
  return w;
}

const hashOf = c =>
  `v=${c.v}&s=${c.stat}&t=${c.thr}&b=${c.b}&p=${c.y0}-${c.y1}&g=${c.stage}&sm=off`;

/* Pull every drawn cell value back out of the SVG.  Tooltips read
   "<lat>°, <lon>°E: <value> <unit>", with the box's own number in parentheses
   when smoothing has moved it. */
function drawnValues(svg, whichPanel) {
  const titles = [...svg.matchAll(/<title>(-?[\d.]+)°, ([\d.]+)°E: ([^<]*)<\/title>/g)];
  const out = new Map();
  const half = Math.ceil(titles.length / 2);
  const slice = whichPanel === 0 ? titles.slice(0, half) : titles.slice(half);
  for (const m of slice) {
    const lat = +m[1], lon = +m[2], body = m[3];
    if (/grey/.test(body)) continue;
    const raw = /this box (-?[\d.]+)/.exec(body);
    const txt = raw ? raw[1] : (/^\s*(-?[\d.]+)/.exec(body) || [])[1];
    const v = parseFloat(txt);
    if (!isFinite(v)) continue;
    // a tooltip is rounded for display; compare at the precision it printed
    const dp = (txt.split('.')[1] || '').length;
    const li = Math.round((lat + 90 - 2.5) / 5), ki = Math.round((lon - 2.5) / 5);
    out.set(li * 72 + ((ki % 72) + 72) % 72, { v, tol: 0.5 * Math.pow(10, -dp) + 1e-9 });
  }
  return out;
}

(async () => {
  const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'audit_ref.json'), 'utf8'));

  console.log('grid and basin partition');
  {
    const w = await load('');
    const IX = w.st.IX;
    ok('grid and extent match', IX.grid === REF.grid && IX.nlat === REF.nlat
       && IX.nlon === REF.nlon && IX.y0 === REF.y0,
       `${IX.grid}/${IX.nlat}/${IX.nlon}/${IX.y0}`,
       `${REF.grid}/${REF.nlat}/${REF.nlon}/${REF.y0}`);
    for (const [b, n] of Object.entries(REF.partition))
      ok(`  ${b} cell count`, IX.basin_cells[b].length === n,
         IX.basin_cells[b].length, n);
  }

  for (const c of REF.cases) {
    const cfg = c.cfg;
    const tag = `${cfg.v}/${cfg.stat} ${cfg.b} ${cfg.thr} ${cfg.stage} ${cfg.y0}-${cfg.y1}`;
    console.log(`\n${tag}`);
    const w = await load(hashOf(cfg));
    const cm = w.cellMetrics(), cells = w.basinCells();
    const NYy = w.st.NY, Y0y = w.st.Y0;

    // ---- per-cell climatology ------------------------------------------
    {
      const mine = new Map(), theirs = new Map(Object.entries(c.mean).map(([k, v]) => [+k, v]));
      for (const x of cells) if (isFinite(cm.mean[x])) mine.set(x, cm.mean[x]);
      let miss = 0, extra = 0, worst = 0, worstAt = null;
      for (const [k, v] of theirs) {
        if (!mine.has(k)) { miss++; continue; }
        const e = relErr(mine.get(k), v);
        if (e > worst) { worst = e; worstAt = k; }
      }
      for (const k of mine.keys()) if (!theirs.has(k)) extra++;
      ok(`  climatology: same ${theirs.size} cells`, miss === 0 && extra === 0,
         `${miss} missing, ${extra} extra`, '0 / 0');
      ok(`  climatology: values agree`, worst < REL,
         `worst rel ${worst.toExponential(2)} at cell ${worstAt}`, `< ${REL}`);
    }

    // ---- per-cell trend --------------------------------------------------
    {
      const mine = new Map(), theirs = new Map(Object.entries(c.trend).map(([k, v]) => [+k, v]));
      for (const x of cells) if (isFinite(cm.trend[x])) mine.set(x, cm.trend[x]);
      let miss = 0, extra = 0, worst = 0, worstAt = null;
      for (const [k, v] of theirs) {
        if (!mine.has(k)) { miss++; continue; }
        const e = relErr(mine.get(k), v);
        if (e > worst) { worst = e; worstAt = k; }
      }
      for (const k of mine.keys()) if (!theirs.has(k)) extra++;
      ok(`  trend: same ${theirs.size} cells pass the gates`, miss === 0 && extra === 0,
         `${miss} missing, ${extra} extra`, '0 / 0');
      ok(`  trend: slopes agree`, worst < REL,
         `worst rel ${worst.toExponential(2)} at cell ${worstAt}`, `< ${REL}`);
    }

    // ---- zonal profile ---------------------------------------------------
    {
      const Z = w.zonalMetrics().filter(r => isFinite(r.mean));
      ok(`  zonal: ${c.zonal.length} bands`, Z.length === c.zonal.length, Z.length, c.zonal.length);
      let wm = 0, ws = 0;
      for (const r of c.zonal) {
        const z = Z.find(x => Math.abs(x.lat - r.lat) < 1e-9);
        if (!z) { wm = Infinity; break; }
        wm = Math.max(wm, relErr(z.mean, r.mean));
        if (r.slope !== null && isFinite(z.slope)) ws = Math.max(ws, relErr(z.slope, r.slope));
      }
      ok(`  zonal: band means agree`, wm < REL, wm.toExponential(2), `< ${REL}`);
      ok(`  zonal: band slopes agree`, ws < REL, ws.toExponential(2), `< ${REL}`);
    }

    // ---- region annual series and its trend ------------------------------
    {
      let worst = 0, n = 0;
      for (let i = 0; i < c.series.length; i++) {
        const yr = cfg.y0 + i;
        const got = w.totalValue(cells, yr - Y0y), want = c.series[i];
        if (want === null) { if (isFinite(got)) worst = Infinity; continue; }
        if (!isFinite(got)) { worst = Infinity; continue; }
        worst = Math.max(worst, relErr(got, want)); n++;
      }
      ok(`  region series: ${n} years agree`, worst < REL, worst.toExponential(2), `< ${REL}`);
      if (c.series_trend) {
        const xs = [], ys = [];
        c.series.forEach((v, i) => { if (v !== null) { xs.push(cfg.y0 + i); ys.push(v); } });
        const f = w.fit(xs, ys);
        ok(`  region trend slope/decade`, relErr(f.slope * 10, c.series_trend.slope) < REL,
           f.slope * 10, c.series_trend.slope);
        near(`  region trend p`, f.p, c.series_trend.p, 1e-7);
      }
    }

    // ---- seasonal cycle --------------------------------------------------
    {
      let worst = 0, mism = 0;
      for (let m = 0; m < 12; m++) {
        const got = w.seasonValue(m, cfg.y0 - Y0y, cfg.y1 - Y0y), want = c.seasonal[m];
        if (want === null) { if (isFinite(got)) mism++; continue; }
        if (!isFinite(got)) { mism++; continue; }
        worst = Math.max(worst, relErr(got, want));
      }
      ok(`  seasonal cycle: 12 months agree`, worst < REL && mism === 0,
         `${mism} mismatched, worst rel ${worst.toExponential(2)}`, `0 / < ${REL}`);
    }

    // ---- what is actually drawn -----------------------------------------
    {
      const g = w.document.getElementById('card').innerHTML;
      const drawn = drawnValues(g, 0);
      let missing = 0, off = 0, worstBy = 0;
      for (const [k, v] of Object.entries(c.mean)) {
        const d = drawn.get(+k);
        if (d === undefined) { missing++; continue; }
        const over = Math.abs(d.v - v) - d.tol;
        if (over > 0) { off++; worstBy = Math.max(worstBy, over); }
      }
      ok(`  drawn cells: all ${Object.keys(c.mean).length} present in the SVG`,
         missing === 0, `${missing} absent`, 0);
      ok(`  every drawn value equals the reference at its printed precision`,
         off === 0, `${off} cells off, worst by ${worstBy.toExponential(2)}`, '0 cells off');
    }
  }

  // ---- the smoother ------------------------------------------------------
  console.log('\ngaussian smoother');
  {
    const cfg = REF.smooth_case.cfg;
    const w = await load(hashOf(cfg).replace('sm=off', 'sm=on'));
    const cells = w.basinCells();
    const raw = w.cellMetrics().mean;
    const sm = w.smoothField(raw, cells);
    let worst = 0, miss = 0, worstAt = null;
    for (const [k, v] of Object.entries(REF.smooth_case.smoothed)) {
      const got = sm[+k];
      if (!isFinite(got)) { miss++; continue; }
      const e = relErr(got, v);
      if (e > worst) { worst = e; worstAt = k; }
    }
    let extra = 0;
    for (const x of cells)
      if (isFinite(sm[x]) && !(String(x) in REF.smooth_case.smoothed)) extra++;
    ok('  same cells survive the blur', miss === 0 && extra === 0,
       `${miss} missing, ${extra} extra`, '0 / 0');
    ok('  smoothed values agree with an independent convolution',
       worst < REL, `worst rel ${worst.toExponential(2)} at cell ${worstAt}`, `< ${REL}`);
  }

  console.log(`\n${checks - fails}/${checks} audit checks passed`);
  if (fails) { console.log('failed:'); bad.forEach(b => console.log('  - ' + b)); }
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

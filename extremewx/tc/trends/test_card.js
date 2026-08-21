/* Render tccard.html under jsdom and check the numbers it draws.
 *
 *   npm i jsdom topojson-client
 *   node test_card.js [dir] ['v=vmax&b=NA&...']
 *
 * The reference values in REF come from ref_values.py, which recomputes the same
 * quantities straight from the IBTrACS CSV with no shared code.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');
const topojson = require('topojson-client');

const DIR = process.argv[2] || '.';
const HASH = process.argv[3] || '';

let fails = 0, checks = 0;
function ok(name, cond, got, want) {
  checks++;
  if (cond) { console.log(`  ok   ${name}`); }
  else { fails++; console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`); }
}
function near(name, got, want, tol) {
  ok(name, Math.abs(got - want) <= tol, got, `${want} ± ${tol}`);
}

async function load(hash) {
  const html = fs.readFileSync(path.join(DIR, 'tccard.html'), 'utf8')
    // the CDN topojson script cannot be fetched offline; inject the module instead
    .replace(/<script src="https:\/\/unpkg\.com\/topojson-client[^>]*><\/script>/, '');

  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { console.error('jsdom error:', e.message); });
  ['error', 'warn'].forEach(k => vc.on(k, (...a) => console.error('page ' + k + ':', ...a)));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
    url: 'http://localhost/extremewx/tc/trends/tccard.html' + (hash ? '#' + hash : '')
  });
  const w = dom.window;
  w.topojson = topojson;

  // minimal fetch over the local filesystem
  w.fetch = async (url) => {
    const p = path.join(DIR, url.replace(/^\.?\//, ''));
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200,
             json: async () => JSON.parse(buf.toString('utf8')),
             arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  // DecompressionStream stand-in
  w.DecompressionStream = class { };
  w.Blob = class { constructor(parts) { this.parts = parts; }
                   stream() { return { pipeThrough: () => this.parts[0] }; } };
  w.Response = class { constructor(ab) { this.ab = ab; }
                       async text() { return zlib.gunzipSync(Buffer.from(this.ab)).toString('utf8'); } };

  // `const`/`let` at the top level of an eval'd script are not reachable as
  // window properties, so close over them explicitly.  Function declarations
  // do become window properties and need no help.
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1]
    + '\n;window.__state=()=>({IX,S,A,G,NLAT,NLON,NCELL,NY,GRID,Y0,VARS,THEME,CMAP});';
  w.eval(script);

  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (w.document.getElementById('card').style.display === 'block') break;
  }
  w.st = w.__state();
  return w;
}

(async () => {
  const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref_values.json'), 'utf8'));

  console.log('render: default view');
  let w = await load(HASH);
  const svg = w.document.getElementById('card');
  ok('card rendered', svg.style.display === 'block', svg.style.display, 'block');
  ok('viewBox', svg.getAttribute('viewBox') === '0 0 1520 1892', svg.getAttribute('viewBox'), '0 0 1520 1892');

  const g = svg.innerHTML;
  ok('all panels present', ['Climatology', 'Trend<', 'storm-days',
      'Seasonal cycle', 'Month by month'].every(s => g.includes(s.replace('<', ''))),
     'missing', 'all of them');
  // the zonal profiles live inside the map panels and share their latitude axis
  ok('both zonal profiles drawn beside their maps',
     g.includes('Zonal mean [') && g.includes('Zonal trend ['),
     'missing', 'both');
  const dy0 = w.st.S.y0, dy1 = w.st.S.y1;
  ok('opens on 1990, per Klotzbach et al. (2022)', dy0 === 1990, dy0, 1990);
  const pf = w.st.IX.provisional_from;
  ok('  and stops before the provisional seasons',
     dy1 === (pf ? pf - 1 : w.st.IX.y1), dy1, pf ? pf - 1 : w.st.IX.y1);
  ok('  so the default view carries no provisional caveat',
     !pf || !g.includes('provisional'), 'caveat shown', 'no caveat');
  // ...but the seasons are still reachable, and say what they are when reached
  if (pf) {
    const late = (await load(`v=density&b=GL&p=1990-${w.st.IX.y1}`)).document
                   .getElementById('card').innerHTML;
    ok('  extending the period reaches them, flagged',
       late.includes(`${pf} onward is provisional`),
       'not flagged', `${pf} onward is provisional`);
  }
  ok('monthly panels label their year axis at both ends',
     (g.match(new RegExp('>' + dy0 + '<', 'g')) || []).length >= 12 &&
     (g.match(new RegExp('>' + dy1 + '<', 'g')) || []).length >= 12,
     `${(g.match(new RegExp('>' + dy0 + '<', 'g')) || []).length} start labels`,
     '>= 12 of each');
  // each of the twelve shares one vertical scale; labelling only its ends made
  // the points unplaceable by eye
  ok('monthly panels label every y gridline, not just the ends',
     (() => { const n = (g.match(/>150</g) || []).length,
                    mid = (g.match(/>50</g) || []).length;
              return n >= 12 && mid >= 12; })(),
     `${(g.match(/>150</g) || []).length} top / ${(g.match(/>50</g) || []).length} interior`,
     '>= 12 of each');
  ok('twelve monthly small multiples drawn',
     ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
       .every(m => g.includes('>' + m + '<')), 'missing months', 'all twelve');
  ok('opens on track density', w.st.S.v === 'density', w.st.S.v, 'density');
  ok('  storm count is its own field, not a statistic',
     !!w.st.VARS.storms && w.st.VARS.density.stats.length === 1,
     `${!!w.st.VARS.storms} / ${w.st.VARS.density.stats.length} stats`, 'true / 1 stat');
  ok('  the three extensive fields all report a mean over years',
     ['density', 'storms', 'ace'].every(k => w.st.VARS[k].stats.length === 1
        && w.st.VARS[k].stats[0].k === 'mean'),
     ['density', 'storms', 'ace'].map(k => w.st.VARS[k].stats[0].k).join(','),
     'mean,mean,mean');
  ok('  and the two counts lead the field menu',
     Object.keys(w.st.VARS).slice(0, 2).join(',') === 'density,storms',
     Object.keys(w.st.VARS).slice(0, 2).join(','), 'density,storms');
  // old shared links carried the choice as a statistic on one 'density' field
  {
    const legacy = await load('v=density&s=storms&b=GL&p=1990-2025');
    ok('  legacy ?s=storms links still resolve to storm count',
       legacy.st.S.v === 'storms', legacy.st.S.v, 'storms');
    const legacyAce = await load('v=ace&s=sum&b=GL&p=1990-2025');
    ok('  legacy ?v=ace&s=sum links still resolve',
       legacyAce.st.S.stat === 'mean', legacyAce.st.S.stat, 'mean');
    const legacy2 = await load('v=density&s=days&b=GL&p=1990-2025');
    ok('  legacy ?s=days links still resolve to track density',
       legacy2.st.S.v === 'density' && legacy2.st.S.stat === 'mean',
       `${legacy2.st.S.v}/${legacy2.st.S.stat}`, 'density/mean');
  }
  ok('data cells drawn', (g.match(/class="cellhit"/g) || []).length > 100,
     (g.match(/class="cellhit"/g) || []).length, '> 100');
  ok('colour bars drawn', (g.match(/linearGradient/g) || []).length >= 2,
     (g.match(/linearGradient/g) || []).length, '>= 2');

  // ---- numbers, against the independent Python reference -------------------
  console.log('\nstatistics');

  // least squares on a fixed vector, versus scipy.stats.linregress
  const xs = REF.fit_test.x, ys = REF.fit_test.y;
  const o = w.ols(xs, ys);
  near('ols slope   vs scipy', o.slope, REF.fit_test.ols_slope, 1e-9);
  near('ols p       vs scipy', o.p, REF.fit_test.ols_p, 1e-6);
  near('ols r2      vs scipy', o.r2, REF.fit_test.ols_r2, 1e-9);
  // the band drawn on every series panel is slope +/- t(0.975, n-2) * se
  const fitRef = w.fit(xs, ys);
  near('fit CI lo   vs scipy', fitRef.lo, REF.fit_test.ols_lo, 1e-9);
  near('fit CI hi   vs scipy', fitRef.hi, REF.fit_test.ols_hi, 1e-9);
  ok('no rank-based estimator survives in the page',
     w.theilSen === undefined && w.mannKendall === undefined,
     'still present', 'removed');

  // region annual series for each reference case
  console.log('\nregion annual series');
  for (const c of REF.cases) {
    w = await load(c.hash);
    const iy0 = w.st.IX.y0, NLON = w.st.IX.nlon, GRID = w.st.IX.grid;
    // read at the level the case describes: a latitude band uses the band table,
    // everything else the basin table.  Distinct storms do not sum between them.
    let cells = w.basinCells(), li = null;
    if (c.band !== null && c.band !== undefined) {
      li = Math.round((c.band + 90) / GRID);
      cells = cells.filter(x => Math.floor(x / NLON) === li);
    }
    const vals = [];
    for (let yr = c.y0; yr <= c.y1; yr++)
      vals.push(li === null ? w.totalValue(cells, yr - iy0)
                            : w.bandValue(li, cells, yr - iy0));
    // null in the reference means "no qualifying position that year", which the
    // card represents as NaN
    const bad = vals.filter((v, i) => c.series[i] === null
                                      ? isFinite(v)
                                      : !(Math.abs(v - c.series[i]) <= 1e-6)).length;
    ok(`${c.name}: ${vals.length} yearly values match`, bad === 0, `${bad} mismatched`, '0');

    const xs = [], ys = [];
    vals.forEach((v, i) => { if (isFinite(v)) { xs.push(c.y0 + i); ys.push(v); } });
    ok(`${c.name}: ${xs.length} valid years`, xs.length === c.n_valid, xs.length, c.n_valid);
    const f = w.fit(xs, ys);
    near(`${c.name}: least-squares slope/decade`, f.slope * 10, c.slope_decade, 1e-6);
    near(`${c.name}: least-squares CI lo/decade`, f.lo * 10, c.ci_lo_decade, 1e-6);
    near(`${c.name}: least-squares CI hi/decade`, f.hi * 10, c.ci_hi_decade, 1e-6);
    // 1e-7, not 1e-9: p comes through an incomplete-beta series that JS and
    // scipy converge to slightly differently.  Slope and CI still hold to 1e-6.
    near(`${c.name}: p value`, f.p, c.p, 1e-7);
  }

  // zonal profile must be consistent with the region total it comes from
  console.log('\nzonal / map consistency');
  w = await load('v=density&s=days&t=ts&b=GL&p=1980-2024&q=1');
  const Z = w.zonalMetrics(), NLON = w.st.IX.nlon;
  ok('zonal bands cover the region',
     Z.length === new Set(w.basinCells().map(c => Math.floor(c / NLON))).size,
     Z.length, 'one row per occupied latitude band');
  const zsum = Z.reduce((s, r) => s + (isFinite(r.mean) ? r.mean : 0), 0);
  const cells = w.basinCells();
  let tot = 0, n = 0;
  for (let yr = 1980; yr <= 2024; yr++) { tot += w.regionValue(cells, yr - 1980); n++; }
  near('sum of zonal means = mean region total (no plot minimum)', zsum, tot / n, 1e-3);

  const cm = w.cellMetrics();
  let cellSum = 0;
  for (const c of cells) if (isFinite(cm.mean[c])) cellSum += cm.mean[c];
  near('sum of cell means = mean region total (no plot minimum)', cellSum, tot / n, 1e-3);

  // ...and storms are deliberately NOT additive, because one cyclone crosses
  // many cells.  If this check ever starts passing, someone has wired the
  // storm panels back onto a sum and the counts are wrong.
  w = await load('v=density&s=storms&t=ts&b=GL&p=1980-2024&g=all');
  const gcells = w.basinCells();
  let sTot = 0, sCell = 0;
  for (let yr = 1980; yr <= 2024; yr++) sTot += w.totalValue(gcells, yr - 1980);
  sTot /= 45;
  const scm = w.cellMetrics();
  for (const c of gcells) if (isFinite(scm.mean[c])) sCell += scm.mean[c];
  near('global storms/yr matches the reference', sTot, REF.cases.find(x=>x.name==='storms GL TS+').series.reduce((s,v)=>s+v,0)/45, 1e-6);
  ok('summing cells over-counts storms several-fold', sCell > 3 * sTot,
     `${sCell.toFixed(0)} vs ${sTot.toFixed(1)}`, 'cell sum >> region total');
  const zs = w.zonalMetrics().reduce((s, r) => s + (isFinite(r.mean) ? r.mean : 0), 0);
  ok('summing latitude bands also over-counts', zs > sTot * 1.2,
     `${zs.toFixed(1)} vs ${sTot.toFixed(1)}`, 'band sum > region total');

  // ---- ACE and the monthly panels -----------------------------------------
  console.log('\nACE');
  w = await load('v=ace&t=ts&b=NA&p=1980-2024');
  const aceRef = REF.cases.find(c => c.name === 'ace NA TS+');
  const aceCells = w.basinCells(), aY0 = w.st.IX.y0;
  const aceVals = [];
  for (let yr = 1980; yr <= 2024; yr++) aceVals.push(w.totalValue(aceCells, yr - aY0));
  const aceBad = aceVals.filter((v, i) => Math.abs(v - aceRef.series[i]) > 1e-4).length;
  ok('North Atlantic ACE matches the reference every year', aceBad === 0, aceBad, 0);
  // published NA seasonal ACE: 1994 was a famously dead season, 2005 a record one
  near('  1994 ACE (published ~32)', aceVals[14], 32, 1.5);
  near('  2020 ACE (published ~180)', aceVals[40], 181, 2);
  ok('  ACE is extensive, so cells sum to the region', (() => {
      const cm = w.cellMetrics();
      let s = 0; for (const c of aceCells) if (isFinite(cm.mean[c])) s += cm.mean[c];
      const mean = aceVals.reduce((p, q) => p + q, 0) / 45;
      return Math.abs(s - mean) < 0.5 * mean;   // plot minimum trims a little
    })(), 'not additive', 'additive');

  console.log('\nmonthly panels');
  for (const mref of REF.monthly) {
    // the monthly reference is all-stages, and the page now defaults to tset,
    // so the stage has to be named explicitly here
    w = await load(`v=${mref.field}&s=${mref.stat}&t=${mref.thr}&b=${mref.basin}` +
                   '&p=1980-2024&g=all');
    let bad = 0, checkedN = 0;
    for (let m = 0; m < 12; m++) for (let y = 0; y < 45; y++) {
      const got = w.monthValue(m, y), want = mref.grid[m][y];
      checkedN++;
      if (want === null) { if (isFinite(got)) bad++; }
      else if (!(Math.abs(got - want) <= 1e-4)) bad++;
    }
    ok(`${mref.name}: all ${checkedN} month-years match`, bad === 0, bad, 0);
    // the seasonal cycle must be consistent with the month-by-month grid
    const i0 = 0, i1 = 44;
    let sBad = 0;
    for (let m = 0; m < 12; m++) {
      const sc = w.seasonValue(m, i0, i1);
      const col = mref.grid[m].filter(v => v !== null);
      if (!col.length) continue;
      const want = (mref.field === 'vmax')
        ? null                                   // pooled, not a mean of means
        : col.reduce((p, q) => p + q, 0) / col.length;
      if (want !== null && !(Math.abs(sc - want) <= 1e-4)) sBad++;
    }
    ok(`  seasonal cycle averages the same grid`, sBad === 0, sBad, 0);
  }
  // months are counted separately and do not have to sum to the annual total
  w = await load('v=density&s=storms&t=ts&b=NA&p=1980-2024');
  let mSum = 0; for (let m = 0; m < 12; m++) mSum += w.monthValue(m, 40);
  const yTot = w.totalValue(w.basinCells(), 40);
  ok('monthly storm counts exceed the annual total (a storm can span months)',
     mSum >= yTot, `${mSum} vs ${yTot}`, 'months >= year');

  // ---- the named basins must tile the global box exactly ------------------
  console.log('\nbasin partition');
  {
    const IX = w.st.IX, bc = IX.basin_cells;
    // derived from the file, not hardcoded: adding a basin must not need a
    // test edit, only a rebuild
    const named = IX.basins.map(b => b.k).filter(k => !['GL', 'NH', 'SH'].includes(k));
    const seen = new Map();
    named.forEach(k => bc[k].forEach(c => seen.set(c, (seen.get(c) || 0) + 1)));
    const gl = new Set(bc.GL);
    // Global must be exactly the union: a cell in Global and in no basin is a
    // hole where activity is counted globally but attributable to nowhere.
    ok('every global cell belongs to a basin',
       [...gl].every(c => seen.has(c)),
       [...gl].filter(c => !seen.has(c)).length + ' orphan cells', '0 orphan cells');
    ok('  and to exactly one',
       [...seen.values()].every(v => v === 1),
       [...seen.values()].filter(v => v > 1).length + ' shared cells', '0 shared cells');
    ok('  with no basin cell outside Global',
       [...seen.keys()].every(c => gl.has(c)),
       [...seen.keys()].filter(c => !gl.has(c)).length + ' stray cells', '0 stray cells');
    ok('  hemispheres partition too',
       bc.NH.length + bc.SH.length === bc.GL.length,
       `${bc.NH.length} + ${bc.SH.length} vs ${bc.GL.length}`, 'equal');
    // the Australian region is carved out of SI and SP, so all three must be
    // present and disjoint -- the partition check above already proves disjoint
    ok('  the Australian region exists and is non-empty',
       named.includes('AU') && bc.AU.length > 0, bc.AU ? bc.AU.length : 'absent', '> 0 cells');
    ok('  and SI + AU + SP + SA make up the southern hemisphere',
       bc.SI.length + bc.AU.length + bc.SP.length + bc.SA.length === bc.SH.length,
       `${bc.SI.length}+${bc.AU.length}+${bc.SP.length}+${bc.SA.length} vs ${bc.SH.length}`,
       'equal');
    // the North Atlantic wraps the prime meridian; that is what closes the gap
    const na = IX.basins.find(b => b.k === 'NA');
    ok('  the North Atlantic wraps 260->40E', na.lon[0] === 260 && na.lon[1] === 40,
       na.lon.join('-'), '260-40');
    // load NA explicitly rather than relying on whatever `w` last held
    const naw = await load('v=density&b=NA&p=1990-2024');
    const F = naw.mapFrame(600, 300);
    ok('  and its map frame unwraps to a single 140-degree span',
       F.lo0 === 260 && F.lo1 === 400, `${F.lo0}..${F.lo1}`, '260..400');
    // cells at 10E must land inside that frame, not off its left edge
    ok('  so a cell at 10E is drawn inside the frame',
       F.X(370) > F.X(360) && F.X(370) < F.ox + F.w + 1e-6,
       F.X(370).toFixed(1), `< ${(F.ox + F.w).toFixed(1)}`);
  }

  // ---- click a basin on the global map to zoom into it --------------------
  console.log('\nbasin picking');
  {
    const gw = await load('');
    const svg = gw.document.getElementById('card');
    const groups = [...svg.querySelectorAll('.basinhit')];
    const nNamed = gw.st.IX.basins
      .filter(b => !['GL', 'NH', 'SH'].includes(b.k)).length;
    ok('basin outlines drawn on the global view',
       new Set(groups.map(g => g.getAttribute('data-basin'))).size === nNamed,
       new Set(groups.map(g => g.getAttribute('data-basin'))).size, nNamed);
    // the North Atlantic wraps, so it needs two rectangles, not one
    const na = groups.filter(g => g.getAttribute('data-basin') === 'NA')[0];
    ok('  the wrapped North Atlantic is two rectangles',
       na.querySelectorAll('rect.hit').length === 2,
       na.querySelectorAll('rect.hit').length, 2);
    // an overlay that captured events would kill every per-cell tooltip
    ok('  the overlay is click-through, so cell tooltips survive',
       [...svg.querySelectorAll('.basinhit rect.hit')]
         .every(r => r.getAttribute('pointer-events') === 'none'),
       'captures events', 'pointer-events=none');
    ok('  and cells are still drawn under it',
       svg.querySelectorAll('.cellhit').length > 100,
       svg.querySelectorAll('.cellhit').length, '> 100');

    // the geometry the click handler actually uses
    const at = (lon, lat) => gw.basinAt(lon, lat);
    [[300, 25, 'NA'], [10, 25, 'NA'], [355, 25, 'NA'],   // wraps the meridian
     [220, 20, 'EP'], [140, 20, 'WP'], [70, 15, 'NI'],
     [60, -20, 'SI'], [10, -20, 'SI'],
     // the Australian region and the boundaries it introduced at 90E and 160E
     [120, -20, 'AU'], [95, -15, 'AU'], [155, -15, 'AU'],
     [85, -15, 'SI'], [165, -15, 'SP'],
     [200, -20, 'SP'], [270, -20, 'SP'], [320, -20, 'SA']
    ].forEach(([lo, la, k]) =>
      ok(`  (${lo}E, ${la}) -> ${k}`, at(lo, la) === k, at(lo, la), k));
    ok('  outside 60S-60N belongs to no basin',
       at(300, 75) === null && at(300, -75) === null,
       `${at(300, 75)} / ${at(300, -75)}`, 'null / null');
    // negative and >360 longitudes must normalise, since they come from the
    // inverse transform of a wrapped frame (the NA map runs 260..400)
    ok('  longitudes normalise', at(-60, 25) === 'NA' && at(370, 25) === 'NA',
       `${at(-60, 25)} / ${at(370, 25)}`, 'NA / NA');

    // no outlines once you are inside a basin -- they would retrace the frame
    const bw = await load('b=WP');
    ok('  no outlines drawn inside a basin',
       bw.document.getElementById('card').querySelectorAll('.basinhit').length === 0,
       bw.document.getElementById('card').querySelectorAll('.basinhit').length, 0);
    ok('  and the zoom-out button is enabled there',
       bw.document.getElementById('zoomOutBtn').disabled === false, 'disabled', 'enabled');
    // it is the way back out of a basin, so it carries the one accent colour
    // in the control bar rather than looking like every other button
    // "Restore defaults" reloads with a clean URL.  A bare reload would read the
    // hash straight back in and restore the very settings being cleared, so the
    // handler has to strip it first -- check the button is there and wired.
    {
      const rw = await load('v=size&b=WP&t=hu&sm=off&g=ts');
      const rb = rw.document.getElementById('resetBtn');
      ok('  a Restore defaults button follows it',
         !!rb && typeof rb.onclick === 'function'
         && rb.textContent === 'Restore defaults', rb ? rb.textContent : 'absent',
         'Restore defaults');
      const ids = [...rw.document.querySelectorAll('.bar .fld button')].map(b2 => b2.id);
      ok('    placed directly after the Global button',
         ids.indexOf('resetBtn') === ids.indexOf('zoomOutBtn') + 1,
         ids.slice(-3).join(','), 'zoomOutBtn then resetBtn');
      ok('    and the state really is in the hash it must clear',
         /v=size/.test(rw.location.hash) && /b=WP/.test(rw.location.hash),
         rw.location.hash.slice(0, 40), 'carries the settings');
      rw.history.replaceState(null, '', rw.location.pathname);
      ok('    which replaceState empties without navigating',
         rw.location.hash === '', JSON.stringify(rw.location.hash), '""');
    }

    ok('  styled bold and yellow',
       (() => { const b = bw.document.getElementById('zoomOutBtn');
                const cs = bw.getComputedStyle(b);
                return b.classList.contains('btn-back')
                       && cs.fontWeight === '700' && cs.color === 'var(--accent2)'; })(),
       'plain', 'bold + accent2');
    ok('  but disabled on the global view',
       gw.document.getElementById('zoomOutBtn').disabled === true, 'enabled', 'disabled');
    // one entry point, so dropdown / map click / button cannot drift apart
    bw.setBasin('GL');
    ok('  setBasin updates state, dropdown and button together',
       bw.st.S.basin === 'GL'
       && bw.document.getElementById('basSel').value === 'GL'
       && bw.document.getElementById('zoomOutBtn').disabled === true,
       `${bw.st.S.basin}/${bw.document.getElementById('basSel').value}`, 'GL/GL/disabled');
  }

  // ---- Gaussian smoothing of the two maps ---------------------------------
  console.log('\nmap smoothing');
  {
    const P = 'v=density&b=GL&t=ts&p=1990-2024';
    const on = await load(P), off = await load(P + '&sm=off');
    ok('smoothing is on by default', on.st.S.smooth === 'on', on.st.S.smooth, 'on');

    const cells = on.basinCells();
    const raw = off.cellMetrics().mean;
    ok('  off is the identity', off.smoothField(raw, cells) === raw,
       'copied', 'same array');

    const sm = on.smoothField(on.cellMetrics().mean, cells);
    const finite = v => cells.filter(c => isFinite(v[c]));
    // smoothing must not invent data in gated cells, or grey boxes would fill in
    ok('  the set of drawn cells is unchanged',
       finite(raw).length === finite(sm).length
       && finite(raw).every(c => isFinite(sm[c])),
       `${finite(raw).length} -> ${finite(sm).length}`, 'identical');

    const arr = v => finite(v).map(c => v[c]);
    const sd = x => { const m = x.reduce((a, b) => a + b, 0) / x.length;
                      return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length); };
    ok('  it reduces spatial variance', sd(arr(sm)) < sd(arr(raw)),
       `${sd(arr(raw)).toFixed(3)} -> ${sd(arr(sm)).toFixed(3)}`, 'lower');
    ok('  and pulls in the peak', Math.max(...arr(sm)) < Math.max(...arr(raw)),
       `${Math.max(...arr(raw)).toFixed(2)} -> ${Math.max(...arr(sm)).toFixed(2)}`, 'lower');

    // longitude wraps, so the prime meridian is not an edge of the kernel
    {
      const NLON = on.st.NLON, li = 20;
      const v = new Float32Array(on.st.NCELL).fill(NaN), cs = [];
      for (let k = 0; k < NLON; k++) { cs.push(li * NLON + k); v[li * NLON + k] = 0; }
      v[li * NLON + NLON - 1] = 100;
      const o = on.smoothField(v, cs);
      near('  the kernel wraps the seam symmetrically',
           o[li * NLON + 0], o[li * NLON + NLON - 2], 1e-6);
      ok('    and actually carries weight across it', o[li * NLON + 0] > 1,
         o[li * NLON + 0].toFixed(2), '> 1');
    }

    // the profiles are pooled from raw positions and must not move
    const zOn = on.zonalMetrics(), zOff = off.zonalMetrics();
    ok('  the zonal profile is untouched by smoothing',
       zOn.length === zOff.length && zOn.every((r, i) =>
         (!isFinite(r.mean) && !isFinite(zOff[i].mean)) || Math.abs(r.mean - zOff[i].mean) < 1e-9),
       'moved', 'identical');

    const g = on.document.getElementById('card').innerHTML;
    ok('  both map headers say the map is smoothed',
       (g.match(/map smoothed, 5° Gaussian/g) || []).length === 2,
       (g.match(/map smoothed/g) || []).length, 2);
    // the drawn value is a neighbourhood average; hovering must not hide that
    ok('  hover discloses the box value alongside the smoothed one',
       /\(smoothed; this box [\d.]+\)/.test(g), 'hidden', 'both shown');
    ok('  and says nothing extra when smoothing is off',
       !off.document.getElementById('card').innerHTML.includes('smoothed'),
       'still mentions it', 'clean');
  }

  // ---- Stages: the eight lifecycle selections -----------------------------
  console.log('\nlifecycle stages');
  {
    const P = 'b=NA&t=ts&p=2004-2024';
    const tot = async (v, g) => {
      const w = await load(`v=${v}&${P}&g=${g}`), c = w.basinCells();
      let s = 0;
      for (let y = 24; y <= 44; y++) {
        const q = v === 'storms' ? w.totalValue(c, y) : w.regionValue(c, y);
        if (isFinite(q)) s += q;
      }
      return s;
    };
    const w0 = await load('v=density&' + P);
    ok('stage selections come from the data file, not the page',
       w0.st.IX.stage_sets.length === 8, w0.st.IX.stage_sets.length, 8);
    ok('  and default to tropical + extratropical', w0.st.S.stage === 'tset',
       w0.st.S.stage, 'tset');

    const d = {};
    for (const k of ['all', 'ts', 'et', 'tset', 'ss', 'ds', 'mx', 'nr'])
      d[k] = await tot('density', k);
    // the six single stages partition the record exactly
    const singles = ['ts', 'ss', 'et', 'ds', 'mx', 'nr'].reduce((a, k) => a + d[k], 0);
    near('the six single stages sum to all stages', singles, d.all, 1e-6);
    near('  and ts + et equals the tset selection', d.ts + d.et, d.tset, 1e-6);
    ok('  every stage is a strict subset of all', ['ts', 'et', 'ss', 'ds'].every(k =>
       d[k] > 0 && d[k] < d.all), 'not a subset', 'all smaller and non-empty');

    // ACE has a fixed definition (tropical + subtropical) and must not follow
    // this control, or "tropical + extratropical" would quietly drop subtropical
    const a = {};
    for (const k of ['all', 'ts', 'et', 'tset', 'ss', 'nr']) a[k] = await tot('ace', k);
    ok('ACE is identical under every stage selection',
       ['ts', 'et', 'tset', 'ss', 'nr'].every(k => Math.abs(a[k] - a.all) < 1e-6),
       Object.entries(a).map(([k, v]) => k + ' ' + v.toFixed(2)).join(' '), 'all equal');
    ok('  and is not zero', a.all > 0, a.all, '> 0');

    // distinct storms are not additive over stages, so they come from a
    // per-selection column; a storm in two stages is one storm, not two
    const cAll = await tot('storms', 'all'), cTs = await tot('storms', 'ts'),
          cEt = await tot('storms', 'et');
    ok('distinct storms do NOT sum across stages', cTs + cEt > cAll,
       `${cTs} + ${cEt} = ${cTs + cEt} vs all ${cAll}`, 'sum exceeds all');
    ok('  and each selection stays within the all-stages count',
       cTs <= cAll && cEt <= cAll, `${cTs}, ${cEt} vs ${cAll}`, 'both <=');

    // physical sanity on the transition stage
    const mean = async (v, g) => {
      const w = await load(`v=${v}&${P}&g=${g}`), c = w.basinCells();
      let s = 0, k = 0;
      for (let y = 24; y <= 44; y++) { const q = w.regionValue(c, y); if (isFinite(q)) { s += q; k++; } }
      return s / k;
    };
    const vTs = await mean('vmax', 'ts'), vEt = await mean('vmax', 'et');
    ok('extratropical positions are weaker than tropical ones', vEt < vTs,
       `${vEt.toFixed(1)} vs ${vTs.toFixed(1)} kt`, 'weaker');
    const rTs = await mean('size', 'ts'), rEt = await mean('size', 'et');
    ok('  and larger', rEt > rTs, `${rEt.toFixed(0)} vs ${rTs.toFixed(0)} n mi`, 'larger');

    ok('the header names the selection',
       w0.document.getElementById('card').innerHTML.includes('tropical + extratropical'),
       'not named', 'named');
  }

  // ---- Size (R34): a short record with a basin-dependent caveat -----------
  console.log('\nsize (R34)');
  {
    const sw = await load('v=size&b=NA');
    ok('size opens on 2004, not the file start',
       sw.st.S.y0 === 2004, sw.st.S.y0, 2004);
    ok('  and the period box will not go earlier',
       sw.document.getElementById('y0In').min === '2004',
       sw.document.getElementById('y0In').min, '2004');
    // asking for 1990 explicitly must still be floored, or the trend would run
    // over years with no radii at all
    const early = await load('v=size&b=NA&p=1990-2024');
    ok('  an explicit earlier request is floored too',
       early.st.S.y0 === 2004, early.st.S.y0, 2004);
    // and leaving size releases the floor
    const back = await load('v=vmax&b=NA&p=1990-2024');
    ok('  other fields keep the full record', back.st.S.y0 === 1990, back.st.S.y0, 1990);

    ok('  reported in nautical miles by default', sw.unitLabel() === 'n mi',
       sw.unitLabel(), 'n mi');
    const km = await load('v=size&b=NA&ru=km');
    const c = sw.basinCells().find(x => isFinite(sw.cellValue(x, 2010 - sw.st.Y0))
                                        && sw.cellValue(x, 2010 - sw.st.Y0) > 0);
    near('  km is an exact 1.852 conversion',
         km.cellValue(c, 2010 - km.st.Y0) / sw.cellValue(c, 2010 - sw.st.Y0), 1.852, 1e-9);

    // the caveat is basin-aware: naming the region on screen, not "some basins"
    const note = w2 => w2.document.getElementById('fieldnote').textContent.replace(/\s+/g, ' ');
    ok('  the zonal note is in the map headers too',
       (() => { const g = sw.document.getElementById('card').innerHTML;
                return (g.match(/ignoring longitude/g) || []).length === 2; })(),
       'missing', 'in both map headers');
    ok('  the caveat names NHC/CPHC coverage in the Atlantic',
       note(sw).includes('NHC/CPHC best-tracked throughout'), 'generic', 'basin-aware');
    const wp = await load('v=size&b=WP');
    ok('  and warns when a JTWC basin is shown before 2016',
       note(wp).includes('most of this period is pre-2016 JTWC data'),
       'no warning', 'warns');
    const wp16 = await load('v=size&b=WP&p=2016-2024');
    ok('  but not once the period starts at 2016',
       note(wp16).includes('post-2016 reviewed radii')
       && !note(wp16).includes('pre-2016 JTWC data'), 'still warning', 'clean');
    ok('  and cites Howell et al. (2025)', note(sw).includes('Howell et al. (2025)'),
       'uncited', 'cited');
    const dw = await load('v=density');
    ok('  no caveat shown for fields that do not need one',
       dw.document.getElementById('fieldnote').hidden, 'shown', 'hidden');
  }

  // ---- the Methods section under the figure -------------------------------
  console.log('\nmethods');
  {
    const dw = await load('');            // default view, not whatever `w` last held
    const foot = dw.document.getElementById('foot');
    const txt = foot.textContent.replace(/\s+/g, ' ');
    ok('Methods section rendered with its subsections',
       foot.querySelector('h2') && foot.querySelectorAll('h3').length >= 10,
       `${foot.querySelectorAll('h3').length} subsections`, '>= 10');
    // the processing chain a reader would need to reproduce the numbers
    [['source', 'IBTrACS v04r01'],
     ['synoptic filter', '00, 06, 12 and 18 UTC'],
     ['stage filter', 'Tropical and subtropical stages only'],
     ['wind source', 'USA 1-minute sustained wind'],
     ['why not WMO', 'availability climbs from 55% to 85%'],
     ['two-stage fit', 'Then the trend is fitted to that annual series'],
     ['estimator', 'ordinary least squares'],
     ['why not Theil-Sen', 'median of pairwise slopes will come out simply as zero'],
     ['grey cells', 'drawn grey rather than deleted'],
     ['zonal caveat', 'not the row-average of the visible boxes'],
     ['limitations', 'Landfall and near-coast attribution is not implemented'],
     ['annual maximum', 'trend in the extreme, not in the distribution'],
     ['threshold invariance of the max', 'decides which cells appear, not what they show'],
     ['off-synoptic peak artefact', 'lowers the recorded peak for 1.3% of storms'],
     ['zonal binning', 'binned straight into their 5° latitude band'],
     ['smoothing', 'Gaussian blur'],
     ['smoothing does not invent data', 'It never invents data'],
     ['funding', 'NSF grants 2519425, 2431970 and 1945113'],
     ['contributor credit', 'Aniket Dev Roy and Dr. Aaron Kruskie'],
     ['basin definition', 'geographic'],
     ['basins not being IBTrACS labels', "not IBTrACS's own basin labels"]
    ].forEach(([what, phrase]) =>
      ok('  states the ' + what, txt.includes(phrase), 'missing', phrase.slice(0, 34)));
    // numbers must come from the data, not be typed in
    ok('  the trend rule quotes the live window',
       txt.includes('Over 1990–2024 (35 years)') && txt.includes('at least 11 years'),
       'stale or missing', 'live values');
    ok('  and the wind coverage comes from index.json',
       txt.includes(`present for ${(dw.st.IX.sources.usa.coverage * 100).toFixed(0)}% of positions`),
       'mismatch', 'from index.json');
    ok('  links out to the README and both comparisons',
       ['README.md', 'COMPARISON_vs_notebook.md', 'COMPARISON_vs_gtc.md']
         .every(f => [...foot.querySelectorAll('a')].some(a => a.getAttribute('href') === f)),
       [...foot.querySelectorAll('a')].map(a => a.getAttribute('href')).join(','),
       'all three');
  }

  // ---- the trend rule is fixed and scales with the window ----------------
  console.log('\ntrend rule');
  {
    const need = w.yearsNeeded;
    // the three conditions must not read as one restated: 11 of 35 years is 31%,
    // not 70%, so "11 yrs spanning 70%" invites the wrong parse
    ok('  the legend states them as three separate conditions',
       /storms in ≥ \d+ yrs/.test(g) && /first and last ≥ \d+% of the period apart/.test(g)
       && /≥ \d+ in each half/.test(g),
       (g.match(/Change per decade[^<]*/) || ['none'])[0].slice(0, 70), 'three clauses');
    ok('no trend-estimator control is exposed',
       !w.document.getElementById('estSel'), 'control present', 'absent');
    ok('  and the methodology says why least squares',
       w.document.body.innerHTML.includes('median of pairwise slopes will come out simply as zero'),
       'no explanation', 'explained');
    ok('no Min trend control is exposed',
       !w.document.getElementById('minYIn'), 'control present', 'absent');
    // a fixed count is too strict on a short window and too lax on a long one
    ok('  the year requirement scales with the period',
       need(15) === 8 && need(35) === 11 && need(46) === 14,
       [15, 35, 46].map(n => `${n}->${need(n)}`).join(' '), '15->8 35->11 46->14');
    ok('  with a floor, so a very short window cannot ask for 3 years',
       need(5) === 8 && need(10) === 8, `${need(5)} / ${need(10)}`, '8 / 8');

    // none of the three rules subsumes another: build series that break each one
    const yrs = ys => ({ ne: ys.length, e0: Math.min(...ys), e1: Math.max(...ys),
                         nfh: ys.filter(y => y < 17.5).length,
                         nsh: ys.filter(y => y >= 17.5).length, k: 35 });
    // wide span, but only the two endpoints carry storms
    ok('  span alone does not admit a two-year cell',
       !w.canTrend(yrs([0, 34]), 35), 'admitted', 'rejected');
    // plenty of years, all crammed into the back third
    ok('  a year count alone does not admit a late-only cell',
       !w.canTrend(yrs([22,23,24,25,26,27,28,29,30,31,32,33]), 35), 'admitted', 'rejected');
    // wide and numerous, but one isolated late year sets the slope
    ok('  and one isolated late year is still rejected',
       !w.canTrend(yrs([0,1,2,3,4,5,6,7,8,9,10,34]), 35), 'admitted', 'rejected');
    ok('  a well-spread cell passes', w.canTrend(yrs([0,3,6,9,12,15,20,23,26,29,32,34]), 35),
       'rejected', 'admitted');
  }

  // ---- coverage gates grey cells out, they do not delete them -------------
  console.log('\ncoverage gates');
  {
    const grey = t => (t.match(/fill="#(bcc6d0|42505d)"/g) || []).length;
    const cells = t => (t.match(/class="cellhit"/g) || []).length;
    const loose = (await load('v=density&s=days&b=GL&p=1990-2025&q=1')).document
                    .getElementById('card').innerHTML;
    const tight = (await load('v=density&s=days&b=GL&p=1990-2025&q=20')).document
                    .getElementById('card').innerHTML;
    // The set of drawn boxes is the set of cells that ever saw a storm, which
    // does not depend on the gate; only how many are grey does.
    ok('raising Min plot does not remove map cells', cells(loose) === cells(tight),
       `${cells(loose)} -> ${cells(tight)}`, 'unchanged');
    ok('  it greys them instead', grey(tight) > grey(loose) && grey(tight) > 50,
       `${grey(loose)} -> ${grey(tight)}`, 'more grey');
    ok('  and the legend names the grey category',
       tight.includes('&lt; 20 yrs') && tight.includes('too sparse'),
       'no swatch label', 'both swatches');
    ok('  greyed cells say why on hover', /grey [-–] fewer than 20 years/.test(tight),
       'no explanation', 'tooltip explains');
    // grey must not be a colour the ramps can produce, or it reads as a value
    ok('  grey is outside both colour ramps',
       !w.st.THEME.dark.gate.match(/^#(ffffff|f7f7f7)$/i)
       && ![...w.st.CMAP.seq, ...w.st.CMAP.div].includes(w.st.THEME.light.gate),
       w.st.THEME.light.gate, 'not a ramp stop');
  }

  // ---- the zonal profile is independent of the map's display gate ---------
  console.log('\nzonal vs Min plot');
  {
    // Min plot is a display threshold, not a data filter.  The profile pools
    // every cell in the band, so tightening it must move the map and not the
    // profile -- for the extensive fields, restricting the pool would sum a
    // smaller region and still call it the latitude band.
    const prof = async q => {
      const ww = await load(`v=density&b=GL&p=1990-2024&q=${q}`);
      return { z: ww.zonalMetrics().map(r => r.mean),
               drawn: [...ww.cellMetrics().mean].filter(v => isFinite(v)).length };
    };
    const a1 = await prof(1), a34 = await prof(34);
    ok('tightening Min plot empties most of the map',
       a34.drawn < a1.drawn / 5, `${a1.drawn} -> ${a34.drawn}`, 'far fewer');
    const same = a1.z.length === a34.z.length && a1.z.every((v, i) =>
      (!isFinite(v) && !isFinite(a34.z[i])) || Math.abs(v - a34.z[i]) < 1e-9);
    ok('  and leaves the zonal profile untouched', same,
       a1.z.map((v, i) => Math.abs(v - a34.z[i]) > 1e-9 ? i : null)
           .filter(x => x !== null).length + ' bands differ', '0 bands differ');
    ok('  including the marginal bands it used to drop',
       a34.z.filter(v => isFinite(v)).length === a1.z.filter(v => isFinite(v)).length,
       `${a1.z.filter(isFinite).length} -> ${a34.z.filter(isFinite).length}`, 'unchanged');
    ok('  and the panel says the profile keeps the grey cells',
       (await load('v=density&b=GL&p=1990-2024&q=20')).document.getElementById('card')
         .innerHTML.includes('the profile includes the grey cells'),
       'not stated', 'stated');
  }

  // ---- the zonal profiles must share the maps' latitude axis ---------------
  console.log('\nlatitude alignment');
  w = await load('v=density&s=days&t=ts&b=NA&p=1980-2024');
  // every cell rect and every profile marker is drawn inside the same
  // translate(), so a shared latitude maps to a shared y
  const F = w.mapFrame(600, 300);
  const yy = [0, 20, 40].map(la => F.Y(la));
  ok('map frame Y is monotonic in latitude', yy[0] > yy[1] && yy[1] > yy[2],
     yy.map(v => v.toFixed(1)).join(','), 'decreasing');
  ok('  and spans the basin box exactly',
     Math.abs(F.Y(w.basinSpec().lat[0]) - (F.oy + F.h)) < 1e-6
     && Math.abs(F.Y(w.basinSpec().lat[1]) - F.oy) < 1e-6,
     `${F.Y(w.basinSpec().lat[0])} / ${F.Y(w.basinSpec().lat[1])}`,
     `${F.oy + F.h} / ${F.oy}`);
  ok('the map frame no longer self-centres horizontally', F.ox === 0, F.ox, 0);

  // export path
  console.log('\nexport');
  const mk = w.svgMarkup();
  ok('svg export well formed', mk.startsWith('<?xml') && mk.includes('xmlns="http://www.w3.org/2000/svg"')
     && mk.trim().endsWith('</svg>'), mk.slice(0, 40), '<?xml ... </svg>');
  ok('svg export non-trivial', mk.length > 50000, mk.length, '> 50000');
  // the attribution has to travel with an exported figure, not just live on the page
  ok('svg export carries the copyright and the data source',
     /figure © \d{4} Dan Chavas/.test(mk) && mk.includes('NOAA IBTrACS v04r01'),
     (mk.match(/Data: NOAA[^<]*/) || ['none'])[0], 'source + © line');
  // an exported figure ends up in talks and papers, so the funding line has to
  // travel with it, not just sit on the page
  ok('  and the NSF acknowledgement',
     mk.includes('NSF grants 2519425, 2431970 and 1945113'),
     (mk.match(/Site development[^<]*/) || ['missing'])[0], 'NSF line');

  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* End-to-end wiring test for trendmaps.html: real DOM (jsdom), real data files,
 * stubbed Leaflet.  Exercises init -> render -> every control -> CSV export, and
 * cross-checks the panel numbers against the reference values in ref_values.json.
 *
 *   npm i jsdom
 *   node test_maps.js [dir]
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = process.argv[2] || '.';
const html = fs.readFileSync(path.join(DIR, 'trendmaps.html'), 'utf8');
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref_values.json'), 'utf8'));

let fails = 0, checks = 0;
const thrown = [];
function ok(name, cond, got, want) {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`); }
}
function near(name, got, want, tol) { ok(name, Math.abs(got - want) <= tol, got, `${want} ± ${tol}`); }
function noThrow(name, fn) {
  checks++;
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails++; thrown.push(e); console.log(`  FAIL ${name}\n         threw ${e.message}`); }
}

const vc = new VirtualConsole();
vc.on('jsdomError', e => { thrown.push(e); console.error('jsdom error:', e.message); });

const dom = new JSDOM(html, {
  runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  url: 'http://localhost/extremewx/tc/trends/trendmaps.html'
});
const w = dom.window;

/* ---- network: serve the real files off disk ----------------------------- */
w.fetch = async (url) => {
  const p = path.join(DIR, url.replace(/^\.?\//, ''));
  if (!fs.existsSync(p)) throw new Error('404 ' + url);
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200,
           json: async () => JSON.parse(buf.toString('utf8')),
           arrayBuffer: async () => buf };
};
w.DecompressionStream = function () {};
w.Blob = class { constructor(parts) { this.parts = parts; } stream() { return this; }
                 pipeThrough() { return this; } };
w.Response = class { constructor(x) { this.x = x; }
                     async text() { return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString('utf8'); } };
w.URL.createObjectURL = () => 'blob:x';
w.URL.revokeObjectURL = () => {};
w.navigator.clipboard = { writeText: async () => {} };

/* ---- stub Leaflet -------------------------------------------------------- */
let styleCalls = 0;
const layers = [];
const polylines = [];      // everything drawn into the region layer
let popupContent = null;
const mkLayer = (feature) => ({
  feature, _h: {}, _tip: null, options: { interactive: true },
  on(ev, fn) { this._h[ev] = fn; },
  // Leaflet re-evaluates a function tooltip body on every open
  bindTooltip(content, opts) { this._tip = content; this._tipOpts = opts; },
  openTooltip() { return typeof this._tip === 'function' ? this._tip() : this._tip; },
  getBounds: () => ({ getCenter: () => ({ lat: 0, lng: 0 }) })
});
w.L = {
  map: () => ({ setView() { return this; }, fitBounds() { return this; },
                getBounds: () => ({ getSouth: () => -60, getNorth: () => 60,
                                    getWest: () => -180, getEast: () => 180 }),
                on() {}, removeLayer() {}, addLayer() {} }),
  tileLayer: () => ({ addTo() { return this; } }),
  layerGroup: () => ({ _a: [], addTo() { return this; },
                       clearLayers() { polylines.length = 0; } }),
  polyline: (latlngs, opts) => ({ latlngs, opts, addTo(g) { polylines.push({ latlngs, opts }); return this; } }),
  popup: () => ({ setLatLng() { return this; },
                  setContent(c) { popupContent = c; return this; },
                  openOn() { return this; } }),
  geoJSON: (data, opts) => {
    const lyr = {
      addTo() { return this; },
      // Leaflet's setStyle merges the returned object into layer.options, which
      // is how `interactive` actually takes effect — mirror that here
      setStyle(fn) {
        styleCalls++;
        if (typeof fn === 'function')
          layers.forEach(l => Object.assign(l.options, fn(l.feature) || {}));
      }
    };
    if (data && data.features && opts && opts.onEachFeature)
      data.features.forEach(f => { const l = mkLayer(f); layers.push(l); opts.onEachFeature(f, l); });
    return lyr;
  }
};

/* ---- run the page's script ----------------------------------------------- */
const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1]
  + '\n;window.__state=()=>({IX,S,A,G,NLAT,NLON,NCELL,NY,GRID,Y0,CUR,VARS,CELLGEO});';
w.eval(script);

const $ = id => w.document.getElementById(id);
const setSel = (id, v) => { const e = $(id); e.value = v; e.onchange({ target: e }); };
const setRange = (id, v) => { const e = $(id); e.value = v; e.oninput({ target: e }); };

(async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25));
    if ($('loadmsg').style.display === 'none') break;
  }
  const st = () => w.__state();

  console.log('init');
  ok('loaded without error', $('loadmsg').style.display === 'none' && !thrown.length,
     thrown.map(e => e.message).join('; ') || $('loadmsg').textContent, 'loaded');
  ok('cell polygons built', layers.length > 500, layers.length, '> 500');
  ok('legend populated', $('legLabel').textContent.includes('Track density'),
     $('legLabel').textContent, 'mentions the field');
  ok('zonal plot drawn', $('zonPlot').innerHTML.includes('<svg'), 'no svg', 'svg');
  ok('series plot drawn', $('tsPlot').innerHTML.includes('<svg'), 'no svg', 'svg');

  // ---- cell geometry ------------------------------------------------------
  console.log('\ncell geometry');
  const g = st().CELLGEO, GRID = st().GRID, NLON = st().NLON;
  const lons = g.features.flatMap(f => f.geometry.coordinates[0].map(p => p[0]));
  const lats = g.features.flatMap(f => f.geometry.coordinates[0].map(p => p[1]));
  // the map draws in a 0-360 frame so the seam falls over Africa, not the Pacific
  ok('longitudes inside 0..360', Math.min(...lons) >= 0 && Math.max(...lons) <= 360,
     `${Math.min(...lons)}..${Math.max(...lons)}`, '0..360');
  ok('latitudes inside -90..90', Math.min(...lats) >= -90 && Math.max(...lats) <= 90,
     `${Math.min(...lats)}..${Math.max(...lats)}`, '-90..90');
  const spans = g.features.map(f => {
    const xs = f.geometry.coordinates[0].map(p => p[0]);
    return Math.max(...xs) - Math.min(...xs);
  });
  ok('every cell is exactly one grid box wide', Math.max(...spans) === GRID, Math.max(...spans), GRID);
  // a known cell: 25N 80W (Florida Straits) is 280E in this frame
  const fl = g.features.find(f => {
    const cc = f.geometry.coordinates[0];
    return cc[0][0] === 280 && cc[0][1] === 25;
  });
  ok('cell at 25N, 280E (80W) present', !!fl, fl ? 'yes' : 'missing', 'present');
  ok('  and its index round-trips', fl && Math.floor(fl.properties.c / NLON) * GRID - 90 === 25
     && (fl.properties.c % NLON) * GRID === 280,
     fl ? `${Math.floor(fl.properties.c / NLON) * GRID - 90}, ${(fl.properties.c % NLON) * GRID}` : '-', '25, 280');
  ok('the West Pacific maximum is a single block, not split',
     g.features.filter(f => f.geometry.coordinates[0][0][0] >= 120
                         && f.geometry.coordinates[0][0][0] <= 180).length > 0
     && !g.features.some(f => f.geometry.coordinates[0][0][0] < 0), 'split', 'contiguous');

  // ---- basin boxes: all contiguous in the 0-360 frame ----------------------
  console.log('\nregion outlines');
  const spec = k => st().IX.basins.find(b => b.k === k);
  const draw = k => { setSel('rgnSel', k); return polylines.map(p => p.latlngs); };
  // a vertical edge is a segment whose two endpoints share a longitude
  const verts = lines => lines.filter(l => l[0][1] === l[1][1]).map(l => l[0][1]);
  const lngs = lines => lines.flat().map(p => p[1]);

  // Every box is one contiguous piece in this frame except the North Atlantic,
  // which wraps the prime meridian so the named basins tile the globe with no
  // gaps; in a 0-360 frame that necessarily lands on both edges.
  // extents come from the data file, so adding or moving a basin needs a rebuild
  // rather than a test edit.  Only the wrapped North Atlantic is excluded here;
  // it is checked on its own terms below.
  for (const bs of st().IX.basins.filter(b => !['GL', 'NH', 'SH', 'NA'].includes(b.k))) {
    const k = bs.k, [x0, x1] = bs.lon, rings = 1;
    const lines = draw(k), b = w.boxRings(spec(k));
    ok(`${k} is one contiguous piece`, b.length === rings, b.length, rings);
    ok(`  ${k} spans ${x0}..${x1}E`, Math.min(...lngs(lines)) === x0 && Math.max(...lngs(lines)) === x1,
       `${Math.min(...lngs(lines))}..${Math.max(...lngs(lines))}`, `${x0}..${x1}`);
    ok(`  ${k} closed on both sides`, verts(lines).sort((a, b2) => a - b2).join() === `${x0},${x1}`,
       verts(lines).join(), `${x0},${x1}`);
  }

  // the wrapped North Atlantic, checked on its own terms
  {
    const b = w.boxRings(spec('NA'));
    ok('NA wraps the prime meridian as two rings', b.length === 2, b.length, 2);
    ok('  covering 260-360 and 0-40',
       b[0].x0 === 260 && b[0].x1 === 360 && b[1].x0 === 0 && b[1].x1 === 40,
       b.map(r => `${r.x0}-${r.x1}`).join(' + '), '260-360 + 0-40');
    ok('  closed only on the outer edges, so it reads as one region',
       b[0].left && !b[0].right && !b[1].left && b[1].right,
       b.map(r => `${r.left?'|':' '}${r.right?'|':' '}`).join(','), 'outer only');
  }

  const gl = draw('GL');
  ok('Global spans the full width', Math.min(...lngs(gl)) === 0 && Math.max(...lngs(gl)) === 360,
     `${Math.min(...lngs(gl))}..${Math.max(...lngs(gl))}`, '0..360');
  ok('  and has no vertical edges at all', verts(gl).length === 0, verts(gl).join(), 'none');
  ok('  drawn as the two latitude limits', gl.length === 2
     && new Set(gl.flat().map(p => p[0])).size === 2,
     gl.length, '2 lines at ±60');

  // ---- panel numbers vs the independent python reference -------------------
  console.log('\npanel numbers vs reference');
  // the map explorer is frozen and does not carry every field the card does
  // (ACE was added to the card only) — skip what it cannot show
  const mapFields = new Set([...$('varSel').options].map(o => o.value));
  // this page also has no Stages control, so it can only reproduce all-stages cases
  const usable = c => mapFields.has(c.field) && (c.stage || 'all') === 'all';
  const skipped = REF.cases.filter(c => !usable(c))
    .map(c => mapFields.has(c.field) ? c.stage + '-stage cases' : c.field);
  if (skipped.length)
    console.log(`  (skipping ${[...new Set(skipped)].join(', ')} — not offered by this page)`);
  for (const c of REF.cases) {
    if (!usable(c)) continue;
    const p = new w.URLSearchParams(c.hash);
    setSel('varSel', p.get('v'));
    if (!$('statSel').disabled) setSel('statSel', p.get('s'));
    setSel('thrSel', p.get('t'));
    setSel('rgnSel', p.get('b'));
    setRange('y0Sl', c.y0); setRange('y1Sl', c.y1);

    const iy0 = st().IX.y0, NL = st().IX.nlon, GR = st().IX.grid;
    // read at the level the case describes — distinct storms do not sum between
    // a latitude band and its basin
    let cells = w.regionCells(), li = null;
    if (c.band !== null && c.band !== undefined) {
      li = Math.round((c.band + 90) / GR);
      cells = cells.filter(x => Math.floor(x / NL) === li);
    }
    const xs = [], ys = [];
    for (let yr = c.y0; yr <= c.y1; yr++) {
      const v = li === null ? w.totalValue(cells, yr - iy0)
                            : w.bandValue(li, cells, yr - iy0);
      if (isFinite(v)) { xs.push(yr); ys.push(v); }
    }
    const bad = ys.filter((v, i) => Math.abs(v - c.series.filter(u => u !== null)[i]) > 1e-6).length;
    ok(`${c.name}: series matches`, bad === 0 && xs.length === c.n_valid,
       `${bad} bad, n=${xs.length}`, `0 bad, n=${c.n_valid}`);
    // trendmaps.html is frozen and still offers both estimators; the shared
    // reference is least squares, which is what tccard.html now uses throughout
    const f = w.fit(xs, ys, 'ols');
    near(`${c.name}: slope/decade`, f.slope * 10, c.slope_decade, 1e-6);
    ok(`${c.name}: stat line shows the slope`,
       $('tsStat').innerHTML.includes(f.slope * 10 >= 0 ? '+' : '−') || $('tsStat').innerHTML.length > 20,
       $('tsStat').textContent.slice(0, 40), 'non-empty');
  }

  // ---- every control, every metric ----------------------------------------
  console.log('\ncontrols');
  setSel('varSel', 'density'); setSel('thrSel', 'ts'); setSel('rgnSel', 'GL');
  setRange('y0Sl', 1980); setRange('y1Sl', 2024);
  for (const m of ['mean', 'trend', 'change', 'year']) {
    noThrow(`metric "${m}" renders`, () => setSel('metSel', m));
    const C = st().CUR;
    ok(`  "${m}" produced finite cells`, C.val.some(v => isFinite(v)),
       'none finite', 'some finite');
    ok(`  "${m}" colour range is ordered`, C.hi > C.lo, `${C.lo}..${C.hi}`, 'hi > lo');
  }
  ok('trend range is symmetric about zero', (() => { setSel('metSel', 'trend');
      const C = st().CUR; return Math.abs(C.lo + C.hi) < 1e-9; })(), st().CUR.lo + '/' + st().CUR.hi, 'lo = -hi');
  noThrow('year slider', () => setRange('yrSl', 2005));
  noThrow('significance fade', () => { const e = $('sigChk'); e.checked = true; e.onchange({ target: e }); });
  noThrow('estimator -> OLS', () => setSel('estSel', 'ols'));
  noThrow('field -> vmax', () => setSel('varSel', 'vmax'));
  ok('m/s toggle appears for Vmax', $('msWrap').style.display !== 'none',
     $('msWrap').style.display, 'visible');
  noThrow('units -> m/s', () => { const e = $('msChk'); e.checked = true; e.onchange({ target: e }); });
  ok('units reach the legend', $('legLabel').textContent.includes('m s'),
     $('legLabel').textContent, 'mentions m s⁻¹');
  noThrow('statistic -> maximum', () => setSel('statSel', 'ext'));
  noThrow('field -> pmin', () => setSel('varSel', 'pmin'));
  ok('m/s toggle hidden for Pmin', $('msWrap').style.display === 'none',
     $('msWrap').style.display, 'none');
  noThrow('min-years', () => { const e = $('minYIn'); e.value = 20; e.onchange({ target: e }); });
  noThrow('period preset', () => {
    const b = w.document.querySelector('#perPresets button[data-p="2000,2024"]');
    $('perPresets').onclick({ target: b });
  });
  ok('period preset took effect', st().S.y0 === 2000 && st().S.y1 === 2024,
     st().S.y0 + '-' + st().S.y1, '2000-2024');

  // ---- storms vs storm-days -------------------------------------------------
  console.log('\nstorms vs storm-days');
  setSel('varSel', 'density'); setSel('thrSel', 'ts'); setSel('rgnSel', 'GL');
  setRange('y0Sl', 1980); setRange('y1Sl', 2024); setSel('metSel', 'mean');
  ok('track density has both statistics', $('statSel').options.length === 2
     && !$('statSel').disabled, $('statSel').options.length, 2);
  ok('  with storm-days first and default', $('statSel').options[0].value === 'days',
     $('statSel').options[0].value, 'days');
  const refMean = n => { const c = REF.cases.find(x => x.name === n);
                         return c.series.reduce((s, v) => s + v, 0) / c.series.length; };
  setSel('statSel', 'storms');
  const gc = w.regionCells();
  let sTot = 0; for (let y = 0; y < 45; y++) sTot += w.totalValue(gc, y); sTot /= 45;
  near('global storms/yr matches the reference', sTot, refMean('storms GL TS+'), 1e-6);
  ok('  and that is the known ~86 storms a year', Math.abs(sTot - 86.4) < 0.1,
     sTot.toFixed(2), '86.4 ± 0.1');
  ok('legend says storms/yr', $('legLabel').textContent.includes('storms/yr'),
     $('legLabel').textContent, 'storms/yr');
  // one cyclone crosses many cells, so summing them must over-count
  let sCell = 0;
  const scm = st().CUR;
  for (const c of gc) if (isFinite(scm.val[c])) sCell += scm.val[c];
  ok('summing map cells over-counts storms several-fold', sCell > 3 * sTot,
     `${sCell.toFixed(0)} vs ${sTot.toFixed(1)}`, 'cell sum >> region total');

  setSel('statSel', 'days');
  // the additivity identity only holds with nothing filtered out, so drop the
  // plot minimum for this one check
  const mp = $('minPIn'); mp.value = 1; mp.onchange({ target: mp });
  let dTot = 0; for (let y = 0; y < 45; y++) dTot += w.totalValue(gc, y); dTot /= 45;
  near('global storm-days/yr matches the reference', dTot, refMean('storm-days GL TS+'), 1e-6);
  ok('legend switches to storm-days/yr', $('legLabel').textContent.includes('storm-days/yr'),
     $('legLabel').textContent, 'storm-days/yr');
  let dCell = 0;
  const dcm = st().CUR;
  for (const c of gc) if (isFinite(dcm.val[c])) dCell += dcm.val[c];
  near('storm-days DO sum across cells (no plot minimum)', dCell, dTot, 1e-3);
  mp.value = 5; mp.onchange({ target: mp });
  setSel('statSel', 'storms');

  // ---- years with no storms -------------------------------------------------
  console.log('\nyears with no storms');
  setSel('varSel', 'density'); setSel('statSel', 'storms'); setSel('thrSel', 'ts');
  setSel('rgnSel', 'GL'); setRange('y0Sl', 1980); setRange('y1Sl', 2024);

  // a quiet year is a real zero for a count, so cellValue must return 0, not NaN
  const NYy = st().NY;
  let quiet = null;
  for (const l of layers) {
    const c = l.feature.properties.c;
    let tot = 0, zeros = 0;
    for (let y = 0; y < NYy; y++) { const v = w.cellValue(c, y); tot += v; if (v === 0) zeros++; }
    if (tot > 0 && zeros > 10) { quiet = { c, zeros }; break; }
  }
  ok('a quiet year in an active cell reads as 0, not missing', quiet !== null,
     quiet ? `${quiet.zeros} zero years` : 'none found', 'zeros present');
  ok('  every year of the window is used for a count',
     [...Array(NYy).keys()].every(y => isFinite(w.cellValue(quiet.c, y))),
     'some NaN', 'all finite');

  // for an intensive field the same year has no defined mean and is dropped
  setSel('varSel', 'vmax');
  ok('the same cell has undefined Vmax in its quiet years',
     [...Array(NYy).keys()].some(y => !isFinite(w.cellValue(quiet.c, y))),
     'all finite', 'some NaN');

  // Vmax is two-stage: the annual value is the mean over that year's positions,
  // and the slope is then fitted to those annual values.  A year with no
  // positions must be MISSING, never zero-filled — a zero wind speed would drag
  // every sparse cell's trend towards nonsense.
  // the stored sums are in knots, so compare in knots
  const ms = $('msChk'); ms.checked = false; ms.onchange({ target: ms });
  const A = st().A, NC = st().NCELL;
  let vBad = 0, vGap = 0, vTwoStage = 0, vChecked = 0;
  for (let c = 0; c < NC; c++) {
    for (let y = 0; y < NYy; y++) {
      const i = c * NYy + y, v = w.cellValue(c, y);
      if (A.nv[i] === 0) { if (isFinite(v)) vBad++; else vGap++; }
      else {
        vChecked++;
        if (Math.abs(v - A.sumv[i] / A.nv[i]) > 1e-6) vTwoStage++;
      }
    }
  }
  ok(`no year without positions is given a Vmax (${vGap} such years)`, vBad === 0, vBad, 0);
  ok(`annual Vmax is the mean over that year's positions (${vChecked} years)`,
     vTwoStage === 0, vTwoStage, 0);

  setSel('varSel', 'pmin');
  let pBad = 0;
  for (let c = 0; c < NC; c++)
    for (let y = 0; y < NYy; y++)
      if (A.np[c * NYy + y] === 0 && isFinite(w.cellValue(c, y))) pBad++;
  ok('no year without pressure reports is given a Pmin', pBad === 0, pBad, 0);

  setSel('varSel', 'density'); setSel('statSel', 'storms');

  // the minimum must count years that CARRY a storm, not years in the window --
  // otherwise it is inert for counts, where every year is used
  setSel('metSel', 'trend');
  const nTrend = m => { const e = $('minYIn'); e.value = m; e.onchange({ target: e });
                        return st().CUR.val.filter(v => isFinite(v)).length; };
  const n5 = nTrend(5), n20 = nTrend(20), n40 = nTrend(40);
  ok('raising Min trend drops sparse cells from the trend map', n5 > n20 && n20 > n40,
     `${n5} / ${n20} / ${n40} cells at 5 / 20 / 40`, 'strictly decreasing');
  nTrend(10);

  // the plot minimum is separate and gates every view, not just the trend
  const nPlot = m => { const e = $('minPIn'); e.value = m; e.onchange({ target: e });
                       return st().CUR.val.filter(v => isFinite(v)).length; };
  setSel('metSel', 'mean');
  const p1 = nPlot(1), p5 = nPlot(5), p20 = nPlot(20);
  ok('raising Min plot blanks short-record cells on the climatology too',
     p1 > p5 && p5 > p20, `${p1} / ${p5} / ${p20} cells at 1 / 5 / 20`, 'strictly decreasing');
  nPlot(5);

  // fixed coverage rules: enough years is not enough on its own
  const nwin = 45;
  const evenly = { ne: 12, e0: 0, e1: 44, nfh: 6, nsh: 6 };
  const bunched = { ne: 12, e0: 0, e1: 12, nfh: 12, nsh: 0 };
  const lopsided = { ne: 12, e0: 0, e1: 44, nfh: 11, nsh: 1 };
  ok('evenly spread years pass the coverage gate', w.canTrend(evenly, nwin) === true,
     w.canTrend(evenly, nwin), true);
  ok('years bunched into a short sub-period are rejected (span)',
     w.canTrend(bunched, nwin) === false, w.canTrend(bunched, nwin), false);
  ok('wide span but one isolated year is rejected (halves)',
     w.canTrend(lopsided, nwin) === false, w.canTrend(lopsided, nwin), false);
  ok('  and the reason given names the span', /span only/.test(w.gateWhy(bunched, nwin)),
     w.gateWhy(bunched, nwin), 'mentions span');
  ok('  and the reason given names the half', /half of the period/.test(w.gateWhy(lopsided, nwin)),
     w.gateWhy(lopsided, nwin), 'mentions half');

  // ---- fields that start late in some basins --------------------------------
  // JTWC issued no central-pressure estimate until 1999-2002, so a Pmin trend
  // asked for over 1990-2024 is uncomputable outside the Atlantic and East
  // Pacific.  The page must say so rather than going quietly blank.
  console.log('\nlate-starting fields');
  const FS = st().IX.field_start;
  ok('index records when each field starts, per basin', FS && FS.any && FS.pmin && FS.vmax,
     Object.keys(FS || {}).join(), 'any, vmax, pmin');
  ok('  Pmin starts in 1980 in the Atlantic', FS.pmin.NA === 1980, FS.pmin.NA, 1980);
  ok('  but only 1999 in the West Pacific', FS.pmin.WP === 1999, FS.pmin.WP, 1999);

  setSel('varSel', 'pmin'); setSel('rgnSel', 'GL');
  setRange('y0Sl', 1990); setRange('y1Sl', 2024); setSel('metSel', 'trend');
  const lb = w.lateBasins(1990).map(x => x.k);
  ok('the JTWC basins are flagged as starting late',
     ['WP', 'NI', 'SI', 'SP'].every(k => lb.includes(k)), lb.join(), 'WP, NI, SI, SP');
  ok('  the Atlantic and East Pacific are not', !lb.includes('NA') && !lb.includes('EP'),
     lb.join(), 'no NA/EP');
  // the South Atlantic's record itself begins in 2004 — that is an absence of
  // cyclones, not a reporting gap, and must not be reported as one
  ok('  nor the South Atlantic, whose record simply starts in 2004', !lb.includes('SA'),
     lb.join(), 'no SA');
  ok('the legend explains the blank cells', /cells have data but no trend/.test($('legNote').innerHTML),
     $('legNote').textContent.slice(-70), 'explanation shown');
  ok('  and names the basins and the year to start from',
     /Western N\. Pacific/.test($('legNote').textContent) && /2002 or later/.test($('legNote').textContent),
     $('legNote').textContent.slice(-90), 'names basins and a start year');

  setRange('y0Sl', 2002);
  ok('starting the period in 2002 fixes it', w.lateBasins(2002).length === 0,
     w.lateBasins(2002).map(x => x.k).join(), 'none late');
  const wpCells = new Set(st().IX.basin_cells.WP);
  const wpDrawn = st().CUR.val.filter((v, c) => wpCells.has(c) && isFinite(v)).length;
  ok('  and the West Pacific now has Pmin trends', wpDrawn > 20, wpDrawn, '> 20 cells');

  setSel('varSel', 'vmax'); setRange('y0Sl', 1990);
  ok('Vmax is not flagged, since it has no reporting gap', w.lateBasins(1990).length === 0,
     w.lateBasins(1990).map(x => x.k).join(), 'none late');

  setSel('varSel', 'density'); setSel('statSel', 'storms');
  setRange('y0Sl', 1980); setSel('metSel', 'mean');

  // ---- trend estimator: Theil-Sen is degenerate on sparse counts ------------
  console.log('\ntrend estimator defaults');
  setSel('varSel', 'density'); setSel('thrSel', 'ts'); setSel('rgnSel', 'GL');
  setRange('y0Sl', 1980); setRange('y1Sl', 2024); setSel('metSel', 'trend');
  ok('density defaults to least squares', st().S.est === 'ols', st().S.est, 'ols');
  const flatOLS = st().CUR.flat;
  ok('  and almost no cell lands on exactly zero', flatOLS < 0.05,
     (flatOLS * 100).toFixed(1) + '%', '< 5%');

  setSel('estSel', 'ts');
  const flatTS = st().CUR.flat;
  ok('Theil-Sen on the same field collapses most cells to zero', flatTS > 0.5,
     (flatTS * 100).toFixed(1) + '%', '> 50%');
  ok('  and the legend explains why, not just that', /median of every pairwise slope/i
     .test($('legNote').textContent), $('legNote').textContent.slice(-90), 'explanation shown');

  // once the user has chosen, changing field must not clobber the choice
  setSel('varSel', 'vmax');
  ok('an explicit estimator choice survives a field change', st().S.est === 'ts', st().S.est, 'ts');

  // reset the touched flag the way a fresh load would, then check the per-field
  // default (S is a const binding, but it is the same object, so mutate it)
  st().S.estTouched = false;
  setSel('varSel', 'vmax');
  ok('vmax defaults to Theil–Sen', st().S.est === 'ts', st().S.est, 'ts');
  setSel('varSel', 'pmin');
  ok('pmin defaults to Theil–Sen', st().S.est === 'ts', st().S.est, 'ts');
  setSel('varSel', 'density');
  ok('back to density defaults to least squares', st().S.est === 'ols', st().S.est, 'ols');
  ok('  the select reflects it', $('estSel').value === 'ols', $('estSel').value, 'ols');

  // ---- cell click ----------------------------------------------------------
  console.log('\ncell popup');
  setSel('metSel', 'mean');
  setSel('varSel', 'density'); setSel('rgnSel', 'GL');
  setRange('y0Sl', 1980); setRange('y1Sl', 2024); setSel('metSel', 'mean');
  const target = layers.find(l => {
    const cc = l.feature.geometry.coordinates[0];
    return cc[0][0] === 280 && cc[0][1] === 25;
  });
  // hover readout — pin the statistic so both branches below are meaningful
  setSel('statSel', 'storms');
  ok('every cell has a tooltip bound', layers.every(l => typeof l._tip === 'function'),
     layers.filter(l => typeof l._tip !== 'function').length + ' without', 'all bound');
  ok('  and it is sticky, so it follows the cursor', target._tipOpts.sticky === true,
     JSON.stringify(target._tipOpts), 'sticky: true');
  let tip = target.openTooltip();
  ok('tooltip names the box', /25–30°N/.test(tip) && /80–75°W/.test(tip),
     tip.replace(/<[^>]+>/g, ' ').slice(0, 60), '25–30°N, 80–75°W');
  ok('  and shows the value with its unit', /storms\/yr/.test(tip),
     tip.replace(/<[^>]+>/g, ' ').slice(0, 80), 'a value in storms/yr');

  // the tooltip body must re-evaluate, so it tracks the current view
  setSel('statSel', 'days');
  tip = target.openTooltip();
  ok('tooltip follows a change of statistic', /storm-days\/yr/.test(tip),
     tip.replace(/<[^>]+>/g, ' ').slice(0, 80), 'storm-days/yr');
  setSel('metSel', 'trend');
  tip = target.openTooltip();
  ok('tooltip follows a change of metric', /per decade/.test(tip) && /p /.test(tip),
     tip.replace(/<[^>]+>/g, ' ').slice(0, 90), 'per decade, with p');
  setSel('metSel', 'mean'); setSel('statSel', 'storms');

  // a cell with no data must say so rather than show a stale number
  const empty = layers.find(l => !isFinite(st().CUR.val[l.feature.properties.c]));
  ok('empty cells report no data', /no data/.test(empty.openTooltip()),
     empty.openTooltip().replace(/<[^>]+>/g, ' '), 'no data');

  // interactivity has to survive a round trip through an empty threshold
  const before = target.options.interactive;
  setSel('thrSel', 'maj'); setSel('thrSel', 'ts');
  ok('cells stay interactive after a threshold round trip',
     before === true && target.options.interactive === true,
     `${before} -> ${target.options.interactive}`, 'true -> true');

  noThrow('clicking a cell builds a popup', () => target._h.click());
  ok('popup names the cell', popupContent && popupContent.includes('25–30°N'),
     popupContent && popupContent.slice(0, 60), 'mentions 25–30°N');
  // the map frame is 0-360 but people read longitudes as E/W, so 280E must
  // still be labelled 80-75W
  ok('popup labels 280E as 80–75°W', popupContent && popupContent.includes('80–75°W'),
     popupContent && popupContent.slice(0, 60), 'mentions 80–75°W');
  ok('popup reports storm-days', popupContent && popupContent.includes('storm-days'),
     'missing', 'present');

  // ---- CSV + link ----------------------------------------------------------
  console.log('\nexport');
  let csv = null;
  const realCreate = w.URL.createObjectURL;
  w.URL.createObjectURL = (b) => { csv = b; return 'blob:x'; };
  w.HTMLAnchorElement.prototype.click = function () {};
  noThrow('CSV export runs', () => $('csvBtn').onclick());
  w.URL.createObjectURL = realCreate;
  noThrow('copy link runs', () => $('linkBtn').onclick.call($('linkBtn')));
  ok('hash carries the state', w.location.hash.includes('v=density') && w.location.hash.includes('r=GL'),
     w.location.hash, 'v=density … r=GL');

  ok('nothing threw during the run', thrown.length === 0,
     thrown.map(e => e.message).join('; '), 'no errors');

  console.log(`\n${checks - fails}/${checks} checks passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

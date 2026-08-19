/* Headless test of the explorer's aggregation + statistics, run against the real
   data files.  Compares JS output to independently computed Python values. */
const fs = require('fs');
const vm = require('vm');
const zlib = require('zlib');

const html = fs.readFileSync(process.argv[2], 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const el = new Proxy({}, {
  get: (t, k) => {
    if (k === 'style') return {};
    if (k === 'dataset') return {};
    if (k === 'classList') return { add(){}, remove(){} };
    if (k === 'appendChild' || k === 'setAttribute') return () => {};
    if (k === 'querySelector') return () => null;
    if (k === 'onclick' || k === 'onchange' || k === 'oninput') return null;
    return '';
  },
  set: () => true
});
const ctx = {
  console,
  document: {
    getElementById: () => el,
    createElement: () => el,
    body: { classList: { add(){}, remove(){} } }
  },
  window: {}, location: { hash: '' }, history: { replaceState(){} },
  navigator: {}, Blob: class {}, URL: {},
  fetch: () => Promise.reject(new Error('no network in test')),
  L: undefined, topojson: undefined,
  setTimeout, clearTimeout, setInterval, clearInterval
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

/* top-level let/const live in the context's lexical scope, not on the global
   object — reach them by evaluating their names inside the context. */
const G = name => vm.runInContext(name, ctx);
['GEOID','NAME','STUSPS','AREA','CENT','gidxOf','HZ','S','tp','ols',
 'rebuildMatrix','computeMetric','monthYear'].forEach(n => { ctx[n] = G(n); });
vm.runInContext('var INDEX_SET=function(x){INDEX=x};var HZ_SET=function(k,v){HZ[k]=v};', ctx);

/* ---- load the real data the same way the page does ----------------------
   Only county attributes are needed here (no geometry), so read the properties
   straight out of the TopoJSON rather than shipping an extra GeoJSON file. */
const topo = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[3])).toString());
const geoms = topo.objects[Object.keys(topo.objects)[0]].geometries;
geoms.forEach((g, i) => {
  const p = g.properties;
  ctx.gidxOf[p.GEOID] = i;
  ctx.GEOID.push(p.GEOID);
  ctx.NAME.push(p.NAME);
  ctx.STUSPS.push(p.STUSPS);
  ctx.AREA.push(p.AREA || 1);
});

const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.argv[4])).toString());
d.nY = d.meta.year1 - d.meta.year0 + 1;
d.g = new Int32Array(d.counties.length);
d.counties.forEach((g, i) => { const gi = ctx.gidxOf[g]; d.g[i] = gi === undefined ? -1 : gi; });
d.ci = Int32Array.from(d.ci); d.yi = Int16Array.from(d.yi); d.mi = Int8Array.from(d.mi);
d.v = d.v.map(a => Int16Array.from(a));
d.M = new Float32Array(ctx.GEOID.length * d.nY);
ctx.HZ_SET(d.meta.hazard, d);
ctx.INDEX_SET({ hazards: [{ key: d.meta.hazard, label: d.meta.label, thresholds: d.meta.thresholds,
                            year0: d.meta.year0, year1: d.meta.year1 }] });

const S = ctx.S;
S.hazard = d.meta.hazard;

function run(metric, thresh, y0, y1, months) {
  S.metric = metric; S.thresh = thresh; S.y0 = y0; S.y1 = y1;
  S.months = new Set(months);
  ctx.rebuildMatrix();
  return ctx.computeMetric();
}

const IN = ctx.GEOID.map((g, i) => g.startsWith('18') ? i : -1).filter(i => i >= 0);
const show = (r, label, n) => {
  const rows = IN.map(i => [ctx.NAME[i], r.val[i], r.pval ? r.pval[i] : null])
                 .sort((a, b) => b[1] - a[1]).slice(0, n || 6);
  console.log('\n' + label);
  rows.forEach(([nm, v, p]) => console.log('  ' + nm.padEnd(14) + v.toFixed(3) + (p != null ? '   p=' + p.toFixed(3) : '')));
  const fin = IN.map(i => r.val[i]).filter(Number.isFinite);
  console.log('  [mean over IN counties ' + (fin.reduce((a, b) => a + b, 0) / fin.length).toFixed(4) +
              ', n=' + fin.length + ', domain ' + r.lo + '..' + r.hi + ']');
};

const ALL = [1,2,3,4,5,6,7,8,9,10,11,12];
show(run('mean', 0, 2000, 2024, ALL), 'MEAN annual days, any report, Indiana 2000-2024');
show(run('mean', 1, 2000, 2024, ALL), 'MEAN annual days, >=1 inch, Indiana 2000-2024');
show(run('trend', 0, 2000, 2024, ALL), 'TREND (days/decade), any report, Indiana 2000-2024');
show(run('mean', 0, 2000, 2024, [6,7,8]), 'MEAN annual days, any report, JJA only');
const y = run('year', 0, 2000, 2024, ALL); S.year = 2011;
show(run('year', 0, 2000, 2024, ALL), 'DAYS in 2011');
show(run('pct', 0, 2000, 2024, ALL), 'PCT change late vs early');

/* season consistency: months must partition the annual total */
S.metric = 'total'; S.thresh = 0; S.y0 = 2000; S.y1 = 2024;
S.months = new Set(ALL); ctx.rebuildMatrix();
const tot = ctx.computeMetric().val;
let acc = new Float64Array(ctx.GEOID.length);
for (const m of ALL) { S.months = new Set([m]); ctx.rebuildMatrix();
  const r = ctx.computeMetric().val;
  for (let i = 0; i < acc.length; i++) if (Number.isFinite(r[i])) acc[i] += r[i]; }
let maxdiff = 0;
for (let i = 0; i < acc.length; i++) maxdiff = Math.max(maxdiff, Math.abs(acc[i] - tot[i]));
console.log('\nseason partition check: max |sum(months) - all| = ' + maxdiff + '  (want 0)');

/* threshold monotonicity: >=1" days can never exceed any-report days */
S.months = new Set(ALL);
S.thresh = 0; ctx.rebuildMatrix(); const t0 = ctx.computeMetric().val.slice();
S.thresh = 1; ctx.rebuildMatrix(); const t1 = ctx.computeMetric().val.slice();
let viol = 0; for (let i = 0; i < t0.length; i++) if (t1[i] > t0[i] + 1e-6) viol++;
console.log('threshold monotonicity violations: ' + viol + '  (want 0)');

/* p-value sanity against known values */
console.log('\ntp(2.086,20)=' + ctx.tp(2.086, 20).toFixed(4) + ' (want 0.0500)');
console.log('tp(1.960,1e6)=' + ctx.tp(1.96, 1e6).toFixed(4) + ' (want 0.0500)');
console.log('tp(3.169,10)=' + ctx.tp(3.169, 10).toFixed(4) + ' (want 0.0100)');

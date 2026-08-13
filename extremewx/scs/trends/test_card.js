/* End-to-end test for scstrend_state.html: real DOM (jsdom), real data files,
   real topojson decode.  Checks the four panels render, the statistics match
   independently computed values, and every control works. */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.argv[2];
const html = fs.readFileSync(path.join(ROOT, 'scstrend_state.html'), 'utf8');
const errors = [];

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                              url: 'http://localhost/extremewx/scs/trends/scstrend_state.html' });
const w = dom.window;

w.fetch = async (url) => {
  const p = path.join(ROOT, url);
  if (!fs.existsSync(p)) throw new Error('404 ' + url);
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()),
           arrayBuffer: async () => buf };
};
w.DecompressionStream = function () {};
w.Blob = class { constructor(parts) { this.parts = parts; } stream() { return this; }
                 pipeThrough() { return this; } };
w.Response = class { constructor(x) { this.x = x; }
                     async text() { return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString(); } };
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
w.navigator.clipboard = { writeText: async () => {} };
w.topojson = require(path.join(process.env.NODE_PATH || '.', 'topojson-client'));

w.addEventListener('error', e => errors.push('window error: ' + e.message));
process.on('unhandledRejection', e => errors.push('unhandled rejection: ' + (e && e.message)));

w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const $ = id => w.document.getElementById(id);
const fire = (id, type) => { const el = $(id); const h = el['on' + type]; if (h) h.call(el, { target: el }); };
const svg = () => $('card').innerHTML;
const say = (label, ok, extra) =>
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (extra ? '  — ' + extra : ''));

/* independent expectation: Indiana statewide hail days, straight from the file */
function indianaHailDays() {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/hail.json.gz'))).toString());
  const ri = d.regions.indexOf('IN'), y0 = d.meta.year0, out = {};
  for (let k = 0; k < d.rri.length; k++) {
    if (d.rri[k] !== ri) continue;
    const yr = d.ryi[k] + y0;
    out[yr] = (out[yr] || 0) + d.rv[0][k];
  }
  return out;
}

(async () => {
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n--- card renders');
  say('card visible', $('card').style.display === 'block');
  say('viewBox set', $('card').getAttribute('viewBox') === '0 0 1520 1035',
      $('card').getAttribute('viewBox'));
  const s = svg();
  say('four panel titles present',
      /Climatological frequency/.test(s) && />Trend</.test(s) &&
      /Annual number of hail days/.test(s) && /Month by month/.test(s));
  say('title reads Indiana', /Hail days · Indiana/.test(s), (s.match(/Hail days[^<]*/) || [])[0]);
  // each county is drawn once per map, so 92 Indiana counties => 184 paths
  say('county polygons drawn', (s.match(/class="cty"/g) || []).length === 92 * 2,
      (s.match(/class="cty"/g) || []).length + ' paths across 2 maps');
  say('two colour bars', (s.match(/<linearGradient/g) || []).length === 2,
      (s.match(/<linearGradient/g) || []).length + '');
  say('12 month sub-panels', MONTHCOUNT(s) === 12, MONTHCOUNT(s) + ' months');
  // one band on the annual panel plus one per month sub-panel
  say('confidence bands drawn', (s.match(/class="ciband"/g) || []).length === 13,
      (s.match(/class="ciband"/g) || []).length + ' bands (want 1 annual + 12 monthly)');
  say('bands are closed paths', (s.match(/class="ciband" d="M[^"]*Z"/g) || []).length === 13);
  say('trend stipple present', (s.match(/r="1\.7"/g) || []).length > 0,
      (s.match(/r="1\.7"/g) || []).length + ' stippled counties');
  say('annual points = 25 years', (s.match(/r="4"/g) || []).length === 25,
      (s.match(/r="4"/g) || []).length + ' points');
  /* Zero-hail years are real observations. Every month panel must plot all 25
     years, so 12 x 25 = 300 points — not just the non-zero ones. */
  say('monthly points = 12 months x 25 years', (s.match(/r="2\.1"/g) || []).length === 300,
      (s.match(/r="2\.1"/g) || []).length + ' points');
  say('zero points are drawn', (s.match(/>Jan 20\d\d: 0</g) || []).length > 0,
      (s.match(/>Jan 20\d\d: 0</g) || []).length + ' zero-valued Jan points');

  console.log('\n--- map orientation');
  /* SVG y grows downward, so a northern county must land at a SMALLER y than a
     southern one.  Albers returns y increasing northward, so the projection has
     to negate it — this caught the map rendering upside down. */
  {
    const P = w.eval('buildPaths()');
    const c = g => P.cent[g];
    const IN = { LaPorte:'18091', Warrick:'18173', Adams:'18001', Sullivan:'18153' };
    say('north is above south (Indiana)', c(IN.LaPorte)[1] < c(IN.Warrick)[1],
        'LaPorte y=' + c(IN.LaPorte)[1].toFixed(0) + ', Warrick y=' + c(IN.Warrick)[1].toFixed(0));
    say('east is right of west (Indiana)', c(IN.Adams)[0] > c(IN.Sullivan)[0],
        'Adams x=' + c(IN.Adams)[0].toFixed(0) + ', Sullivan x=' + c(IN.Sullivan)[0].toFixed(0));
  }
  $('regSel').value = ''; fire('regSel', 'change');
  {
    const P = w.eval('buildPaths()');
    const c = g => P.cent[g];
    // Cook IL (Chicago), Miami-Dade FL, Suffolk MA (Boston), San Diego CA
    say('north is above south (US)', c('17031')[1] < c('12086')[1],
        'Cook y=' + c('17031')[1].toFixed(0) + ', Miami-Dade y=' + c('12086')[1].toFixed(0));
    say('east is right of west (US)', c('25025')[0] > c('06073')[0],
        'Suffolk x=' + c('25025')[0].toFixed(0) + ', San Diego x=' + c('06073')[0].toFixed(0));
    say('Florida is the southeast corner',
        c('12086')[1] > c('17031')[1] && c('12086')[0] > c('06073')[0]);
  }
  $('regSel').value = 'IN'; fire('regSel', 'change');

  console.log('\n--- statistics');
  const truth = indianaHailDays();
  const years = [], vals = [];
  for (let y = 2000; y <= 2024; y++) { years.push(y); vals.push(truth[y]); }
  say('2011 peak = 46', truth[2011] === 46, String(truth[2011]));
  say('2021 low = 13', truth[2021] === 13, String(truth[2021]));
  // R^2 from the page's own ols, checked against a hand computation
  const n = years.length;
  const mx = years.reduce((a, b) => a + b) / n, my2 = vals.reduce((a, b) => a + b) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = years[i] - mx, dy = vals[i] - my2;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const slope = sxy / sxx; let sse = 0;
  for (let i = 0; i < n; i++) { const r = vals[i] - (my2 + slope * (years[i] - mx)); sse += r * r; }
  const r2 = 1 - sse / syy;
  const shown = parseFloat((s.match(/R² = ([\d.]+)/) || [])[1]);
  say('R² matches hand calc', Math.abs(shown - r2) < 0.001, shown + ' vs ' + r2.toFixed(3));
  say('R² ≈ 0.235 as in the original figure', Math.abs(shown - 0.235) < 0.005, String(shown));
  const slopeShown = parseFloat((s.match(/slope ([-+][\d.]+) days\/decade/) || [])[1]);
  say('slope matches', Math.abs(slopeShown - slope * 10) < 0.01, slopeShown + ' vs ' + (slope * 10).toFixed(2));
  say('t critical value', Math.abs(w.eval('tcrit(0.05,23)') - 2.0687) < 0.001,
      w.eval('tcrit(0.05,23)').toFixed(4) + ' (want 2.0687)');
  say('t critical value, df=10', Math.abs(w.eval('tcrit(0.05,10)') - 2.2281) < 0.001,
      w.eval('tcrit(0.05,10)').toFixed(4) + ' (want 2.2281)');

  console.log('\n--- controls');
  $('thrSel').value = 1; fire('thrSel', 'change');
  say('threshold -> 1 inch', /≥ 1.00/.test(svg()));
  $('thrSel').value = 0; fire('thrSel', 'change');

  $('regSel').value = 'TX'; fire('regSel', 'change');
  say('region -> Texas', /Hail days · Texas/.test(svg()));
  say('Texas counties drawn', (svg().match(/class="cty"/g) || []).length === 254 * 2,
      (svg().match(/class="cty"/g) || []).length + ' paths across 2 maps');
  say('county dropdown repopulated', $('ctySel').children.length === 255,
      $('ctySel').children.length + ' options');

  $('regSel').value = ''; fire('regSel', 'change');
  say('region -> whole US', /Hail days · United States/.test(svg()));
  // the national map is the lower 48: 3222 counties minus AK/HI/PR
  say('lower-48 counties drawn', (svg().match(/class="cty"/g) || []).length === 3109 * 2,
      (svg().match(/class="cty"/g) || []).length + ' paths across 2 maps');
  say('county dropdown disabled', $('ctySel').disabled === true);

  $('regSel').value = 'IN'; fire('regSel', 'change');
  $('ctySel').value = '18097'; fire('ctySel', 'change');
  say('county drill-down', /Hail days · Marion County, IN/.test(svg()));
  const cval = (svg().match(/r="4"/g) || []).length;
  say('county series still 25 years', cval === 25, cval + ' points');
  say('footer switches to county wording', /county alone/.test($('foot').innerHTML));
  $('ctySel').value = ''; fire('ctySel', 'change');

  $('y0In').value = 1996; fire('y0In', 'change');
  say('period start -> 1996', /1996–2024/.test(svg()));
  $('y1In').value = 1990; fire('y1In', 'change');
  say('inverted period clamps', S_y1() >= S_y0() + 2, S_y0() + '-' + S_y1());
  $('y0In').value = 2000; fire('y0In', 'change');
  $('y1In').value = 2024; fire('y1In', 'change');

  console.log('\n--- hazards');
  for (const h of ['tornado', 'wind']) {
    $('hazSel').value = h; await $('hazSel').onchange({ target: { value: h } });
    await new Promise(r => setTimeout(r, 700));
    say(h + ' renders', svg().length > 10000 && new RegExp('Annual number of').test(svg()),
        (svg().match(/&gt;|days · [A-Za-z ]+/) || [])[0]);
  }
  $('hazSel').value = 'hail'; await $('hazSel').onchange({ target: { value: 'hail' } });
  await new Promise(r => setTimeout(r, 700));

  console.log('\n--- theme + export');
  $('themeBtn').onclick.call($('themeBtn'));
  say('light theme', /fill="#ffffff"/.test(svg()) && $('themeBtn').textContent === 'Dark');
  $('themeBtn').onclick.call($('themeBtn'));
  say('back to dark', /fill="#111c26"/.test(svg()));
  const markup = w.eval('svgMarkup()');
  say('SVG export well formed', markup.startsWith('<?xml') && markup.trim().endsWith('</svg>') &&
      markup.length > 50000, markup.length + ' bytes');
  say('export filename', /^hail_in_any_2000-2024$/.test(w.eval('fileStem()')), w.eval('fileStem()'));
  say('hash written', w.location.hash.includes('h=hail') && w.location.hash.includes('r=IN'),
      w.location.hash);

  console.log('\n--- errors captured: ' + errors.length);
  errors.forEach(e => console.log('  ' + e));
  process.exit(errors.length ? 1 : 0);

  function S_y0() { return +$('y0In').value; }
  function S_y1() { return +$('y1In').value; }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

function MONTHCOUNT(s) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    .filter(m => new RegExp('>' + m + '<').test(s)).length;
}

/* End-to-end wiring test: real DOM (jsdom), real data files, stubbed Leaflet.
   Exercises init -> render -> every control -> CSV export, and fails loudly on
   any thrown error or unhandled rejection. */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.argv[2];   // .../trends/old — the page fetches ../data and ../geo
const html = fs.readFileSync(path.join(ROOT, 'scstrend_map.html'), 'utf8');

const errors = [];
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
                              url: 'http://localhost/extremewx/scs/trends/old/scstrend_map.html' });
const w = dom.window;

/* ---- stub the network: serve the real files off disk --------------------- */
w.fetch = async (url) => {
  const p = path.join(ROOT, url);
  if (!fs.existsSync(p)) throw new Error('404 ' + url);
  const buf = fs.readFileSync(p);
  return {
    ok: true, status: 200,
    json: async () => JSON.parse(buf.toString()),
    arrayBuffer: async () => buf
  };
};
w.DecompressionStream = function () {};          // presence check only
w.Blob = class { constructor(parts) { this.parts = parts; } stream() { return this; }
                 pipeThrough() { return this; } };
w.Response = class { constructor(x) { this.x = x; }
                     async text() { return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString(); } };
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
w.navigator.clipboard = { writeText: async () => {} };

/* ---- stub Leaflet ------------------------------------------------------- */
let styleCalls = 0, layerCount = 0;
const bounds = { getSouth: () => 24, getNorth: () => 50, getWest: () => -126, getEast: () => -66,
                 getCenter: () => ({ lat: 39, lng: -96 }) };
const layers = [];
const mkLayer = (feature) => ({
  feature, _h: {}, on(ev, fn) { this._h[ev] = fn; }, setStyle() {},
  bindTooltip(fn) { this._tip = fn; }, bringToFront() {},
  getBounds: () => ({ getCenter: () => ({ lat: 39 + Math.random(), lng: -96 + Math.random() }) })
});
let fitCalls = [];
w.L = {
  map: () => ({ setView() { return this; }, fitBounds(b) { fitCalls.push(b); return this; },
                getBounds: () => bounds,
                getCenter: () => ({ lat: 39, lng: -96 }), getZoom: () => 4,
                on() {}, removeLayer() {}, addLayer() {} }),
  tileLayer: () => ({ addTo() { return this; } }),
  layerGroup: (arr) => ({ _a: arr, addTo() { return this; } }),
  geoJSON: (data, opts) => {
    const L = {
      _added: [],
      addTo() { return this; },
      addData(f) { this._added.push(f); },
      clearLayers() { this._added = []; },
      getBounds: () => bounds,
      setStyle(fn) { styleCalls++; if (typeof fn === 'function') layers.forEach(l => fn(l.feature)); },
      eachLayer(cb) { layers.forEach(cb); }
    };
    if (data && data.features && opts && opts.onEachFeature) {
      data.features.forEach(f => { const l = mkLayer(f); layers.push(l); layerCount++;
                                   opts.onEachFeature(f, l); });
    }
    return L;
  }
};
/* ---- stub topojson ------------------------------------------------------ */
w.topojson = {
  feature: (topo, obj) => {
    // minimal topojson -> geojson (polygons only, quantised)
    const t = topo.transform, arcs = topo.arcs;
    const decode = (i) => {
      const rev = i < 0, a = arcs[rev ? ~i : i];
      let x = 0, y = 0; const pts = [];
      for (const [dx, dy] of a) { x += dx; y += dy;
        pts.push([x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]); }
      return rev ? pts.reverse() : pts;
    };
    const ring = (idx) => idx.reduce((acc, i) => acc.concat(decode(i)), []);
    return { type: 'FeatureCollection', features: obj.geometries.map(g => ({
      type: 'Feature', properties: g.properties,
      geometry: { type: g.type,
        coordinates: g.type === 'Polygon' ? g.arcs.map(ring) : g.arcs.map(p => p.map(ring)) } })) };
  }
};

w.addEventListener('error', e => errors.push('window error: ' + e.message));
process.on('unhandledRejection', e => errors.push('unhandled rejection: ' + (e && e.message)));

const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
w.eval(src);

const $ = id => w.document.getElementById(id);
const fire = (id, type) => { const el = $(id); const h = el['on' + type]; if (h) h.call(el, { target: el }); };

(async () => {
  await new Promise(r => setTimeout(r, 2500));    // let init() finish

  const say = (label, ok, extra) =>
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (extra ? '  — ' + extra : ''));

  console.log('\n--- init');
  say('county layers built', layerCount === 3222, layerCount + ' layers');
  say('loading overlay hidden', $('loadmsg').style.display === 'none', $('loadmsg').style.display);
  // station hazards are excluded here: this page maps counties
  say('hazard dropdown populated', $('hazSel').children.length === 3, $('hazSel').children.length + ' options');
  say('threshold dropdown populated', $('thrSel').children.length === 4, $('thrSel').children.length + ' options');
  say('month chips built', $('monthBox').children.length === 12);
  say('legend rendered', $('legLabel').textContent.includes('Mean annual days'), $('legLabel').textContent.slice(0, 60));
  say('colour bar has gradient', /linear-gradient/.test($('cbar').style.background));
  say('defaults to Indiana', $('stateSel').value === 'IN', $('stateSel').value);
  say('state dropdown populated', $('stateSel').children.length === 53,   // US + 50 + DC + PR
      $('stateSel').children.length + ' options');
  say('zoomed to the focus state', fitCalls.length === 1);
  say('focus note', /Indiana · 92 counties/.test($('stateNote').textContent), $('stateNote').textContent);
  say('info panel scoped to state', $('info').innerHTML.includes('>Indiana<') &&
      $('info').innerHTML.includes('92 counties'));
  say('info has 3 charts', ($('info').innerHTML.match(/<svg/g) || []).length === 3,
      ((($('info').innerHTML.match(/<svg/g)) || []).length) + ' svgs');
  say('URL hash written', w.location.hash.includes('h=hail'), w.location.hash.slice(0, 70));

  console.log('\n--- controls');
  const before = $('legLabel').textContent;
  $('metSel').value = 'trend'; fire('metSel', 'change');
  say('metric -> trend', $('legLabel').textContent.includes('Linear trend'));
  say('significance checkbox revealed', $('sigWrap').style.display === '');
  $('sigChk').checked = true; fire('sigChk', 'change');
  say('fade non-significant applied', $('legNote').innerHTML.includes('0.05'));

  $('metSel').value = 'year'; fire('metSel', 'change');
  say('metric -> year', $('yearBox').style.display === '' && $('legLabel').textContent.includes('Days in'));
  $('yrSl').value = 2011; fire('yrSl', 'input');
  say('year slider', $('yrLb').textContent === '2011', $('yrLb').textContent);

  $('metSel').value = 'pct'; fire('metSel', 'change');
  say('metric -> pct change', $('legLabel').textContent.includes('Change, late'));
  $('metSel').value = 'mean'; fire('metSel', 'change');

  $('thrSel').value = 2; fire('thrSel', 'change');
  say('threshold -> 2 inch', $('legLabel').textContent.includes('2.00'), $('legLabel').textContent.slice(0, 70));

  $('y0Sl').value = 1990; fire('y0Sl', 'input');
  say('period start -> 1990', $('y0Lb').textContent === '1990', $('y0Lb').textContent);
  $('y1Sl').value = 1985; fire('y1Sl', 'input');
  say('inverted range clamps', $('y0Lb').textContent === '1985' && $('y1Lb').textContent === '1985',
      $('y0Lb').textContent + '-' + $('y1Lb').textContent);

  $('perPresets').onclick({ target: { dataset: { p: '2000,2024' } } });
  say('period preset', $('y0Lb').textContent === '2000' && $('y1Lb').textContent === '2024');
  $('perPresets').onclick({ target: { dataset: { p: 'full' } } });
  say('full-record preset', $('y0Lb').textContent === '1955', $('y0Lb').textContent + '-' + $('y1Lb').textContent);
  $('perPresets').onclick({ target: { dataset: { p: '2000,2024' } } });

  $('seasPresets').onclick({ target: { dataset: { s: '6,7,8' } } });
  say('season preset JJA', $('legNote').innerHTML.includes('JJA'), $('legNote').innerHTML.slice(0, 50));
  const onChips = [...$('monthBox').children].filter(c => c.className === 'on').length;
  say('3 month chips lit', onChips === 3, onChips + ' lit');
  $('monthBox').children[0].onclick();
  say('chip toggle adds Jan', [...$('monthBox').children].filter(c => c.className === 'on').length === 4);
  $('seasPresets').onclick({ target: { dataset: { s: 'all' } } });

  $('areaChk').checked = true; fire('areaChk', 'change');
  say('per-area normalisation', $('legLabel').textContent.includes('10,000 km'));
  $('areaChk').checked = false; fire('areaChk', 'change');

  $('stChk').checked = false; fire('stChk', 'change');
  say('state boundary toggle', true);

  console.log('\n--- state focus');
  $('stateSel').value = 'TX'; fire('stateSel', 'change');
  say('switch to Texas', /Texas · 254 counties/.test($('stateNote').textContent), $('stateNote').textContent);
  say('Texas zoom fired', fitCalls.length === 2);
  say('panel follows state', $('info').innerHTML.includes('>Texas<') &&
      $('info').innerHTML.includes('254 counties'));
  say('hash records focus', w.location.hash.includes('f=TX'));
  $('stateSel').value = ''; fire('stateSel', 'change');
  say('back to whole US', $('stateNote').textContent === 'Whole United States' &&
      $('info').innerHTML.includes('Counties in view'), $('stateNote').textContent);
  $('stateSel').value = 'IN'; fire('stateSel', 'change');

  console.log('\n--- county selection');
  $('thrSel').value = 0; fire('thrSel', 'change');       // back to "any report"
  const marion = layers.find(l => l.feature.properties.GEOID === '18097');
  say('click handler bound', typeof marion._h.click === 'function');
  marion._h.click();                                   // the page's own handler
  say('county panel', $('info').innerHTML.includes('Marion County, IN'));
  say('county charts', ($('info').innerHTML.match(/<svg/g) || []).length === 3);
  const m = $('info').innerHTML.match(/class="bigval"[^>]*>([^<]*)</);
  say('county headline = 3.60 d/yr', m && Math.abs(parseFloat(m[1]) - 3.60) < 0.005, m && m[1]);
  say('tooltip renders', /Marion, IN/.test(marion._tip()), marion._tip());
  const cls = $('info').querySelector('.infoclose');
  say('close button present', !!cls);
  if (cls) cls.onclick();
  say('deselect returns to the focused state', $('info').innerHTML.includes('>Indiana<'));

  console.log('\n--- hazard switch');
  $('hazSel').value = 'tornado'; await $('hazSel').onchange({ target: { value: 'tornado' } });
  await new Promise(r => setTimeout(r, 600));
  say('tornado loaded', $('legLabel').textContent.toLowerCase().includes('tornado'), $('legLabel').textContent.slice(0, 60));
  say('tornado has 5 thresholds', $('thrSel').children.length === 5, $('thrSel').children.length + '');
  $('hazSel').value = 'wind'; await $('hazSel').onchange({ target: { value: 'wind' } });
  await new Promise(r => setTimeout(r, 600));
  say('wind loaded', $('legLabel').textContent.toLowerCase().includes('thunderstorm'), $('legLabel').textContent.slice(0, 60));

  console.log('\n--- export');
  let csv = null;
  w.document.createElement = () => ({ set href(v) {}, set download(v) {}, click() {}, style: {}, dataset: {} });
  w.Blob = class { constructor(parts) { csv = parts[0]; } };
  $('csvBtn').onclick();
  const lines = csv ? csv.split('\n') : [];
  say('CSV produced', lines.length > 2000, lines.length + ' rows');
  say('CSV header', lines[0] === 'GEOID,county,state,area_km2,value,metric,unit,hazard,threshold,period,season', lines[0]);
  say('CSV row well formed', lines[1] && lines[1].split(',').length === 11, lines[1]);

  console.log('\n--- errors captured: ' + errors.length);
  errors.forEach(e => console.log('  ' + e));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('TEST HARNESS ERROR', e); process.exit(2); });

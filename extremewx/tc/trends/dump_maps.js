/* Visual check for trendmaps.html without a browser.
 *
 *   node dump_maps.js [dir] [out.svg] ['v=density&m=trend&r=WP&...']
 *
 * Runs the page under jsdom with Leaflet stubbed, then draws one composite SVG:
 * the grid cells painted with the page's own cellStyle(), the region outline
 * from its own boxRings(), and the two real panel plots beside them.  The
 * projection here is a plain plate carree rather than Leaflet's Web Mercator,
 * so this checks the colours, the values and the box geometry — not the tiles.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');

const DIR = process.argv[2] || '.';
const OUT = process.argv[3] || 'maps.svg';
const HASH = process.argv[4] || '';

const html = fs.readFileSync(path.join(DIR, 'trendmaps.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', e => console.error('jsdom:', e.message));
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'http://localhost/extremewx/tc/trends/trendmaps.html' + (HASH ? '#' + HASH : '') });
const w = dom.window;

w.fetch = async (url) => {
  const buf = fs.readFileSync(path.join(DIR, url.replace(/^\.?\//, '')));
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')),
           arrayBuffer: async () => buf };
};
w.DecompressionStream = function () {};
w.Blob = class { constructor(p) { this.parts = p; } stream() { return this; } pipeThrough() { return this; } };
w.Response = class { constructor(x) { this.x = x; }
                     async text() { return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString('utf8'); } };
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
w.navigator.clipboard = { writeText: async () => {} };

const polylines = [];
w.L = {
  map: () => ({ setView() { return this; }, fitBounds() { return this; }, on() {},
                removeLayer() {}, addLayer() {},
                getBounds: () => ({ getSouth: () => -60, getNorth: () => 60,
                                    getWest: () => -180, getEast: () => 180 }) }),
  tileLayer: () => ({ addTo() { return this; } }),
  layerGroup: () => ({ addTo() { return this; }, clearLayers() { polylines.length = 0; } }),
  polyline: (ll, o) => ({ addTo() { polylines.push(ll); return this; } }),
  popup: () => ({ setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; } }),
  geoJSON: (data, opts) => ({ addTo() { return this; }, setStyle() {} })
};

const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1]
  + '\n;window.__state=()=>({IX,S,CUR,CELLGEO,GRID,NLON});';
w.eval(script);

(async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (w.document.getElementById('loadmsg').style.display === 'none') break;
  }
  const st = w.__state();
  const { CELLGEO, GRID } = st;

  // ---- map preview: plate carree in the page's own 0..360 frame -----------
  const MW = 980, MH = MW / 3, OX = 20, OY = 66;
  const X = lon => OX + lon / 360 * MW;
  const Y = lat => OY + (60 - lat) / 120 * MH;
  let m = `<rect x="${OX}" y="${OY}" width="${MW}" height="${MH}" fill="#0b1119"/>`;
  for (const f of CELLGEO.features) {
    const s = w.cellStyle(f);
    if (!s.fill) continue;
    const c = f.geometry.coordinates[0];
    const lo = c[0][0], la = c[0][1];
    if (la + GRID < -60 || la > 60) continue;
    m += `<rect x="${X(lo).toFixed(1)}" y="${Y(la + GRID).toFixed(1)}"`
       + ` width="${(MW / 360 * GRID + 0.4).toFixed(1)}" height="${(MH / 120 * GRID + 0.4).toFixed(1)}"`
       + ` fill="${s.fillColor}" opacity="${s.fillOpacity}"/>`;
  }
  for (const g of [-60, -30, 0, 30, 60]) m += `<line x1="${OX}" y1="${Y(g)}" x2="${OX + MW}" y2="${Y(g)}" stroke="#2a3a4d" stroke-width=".6"/>`;
  for (let g = 0; g <= 360; g += 60) m += `<line x1="${X(g)}" y1="${OY}" x2="${X(g)}" y2="${OY + MH}" stroke="#2a3a4d" stroke-width=".6"/>`;
  for (const r of polylines) {
    let d = '';
    r.forEach((p, i) => { const la = Math.max(-60, Math.min(60, p[0]));
      d += (i ? 'L' : 'M') + X(p[1]).toFixed(1) + ' ' + Y(la).toFixed(1); });
    m += `<path d="${d}" fill="none" stroke="#ffb14e" stroke-width="2.4" stroke-dasharray="7 5"/>`;
  }
  m += `<rect x="${OX}" y="${OY}" width="${MW}" height="${MH}" fill="none" stroke="#6d8299"/>`;

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const T = (x, y, s, o) => `<text x="${x}" y="${y}" font-family="-apple-system,Helvetica,Arial,sans-serif"`
    + ` font-size="${(o && o.size) || 12}" fill="${(o && o.fill) || '#e6edf3'}"`
    + `${o && o.weight ? ` font-weight="${o.weight}"` : ''}>${esc(s)}</text>`;
  const strip = id => (w.document.getElementById(id).innerHTML.match(/<svg[\s\S]*<\/svg>/) || [''])[0];
  const inner = s => (s.match(/<svg[^>]*>([\s\S]*)<\/svg>/) || ['', ''])[1];
  const vbH = s => { const v = (s.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/) || [])[1]; return +v || 200; };
  const zs = strip('zonPlot'), ts = strip('tsPlot');

  const H = OY + MH + 60 + Math.max(vbH(zs), 250) + 40 + vbH(ts) + 40;
  const Wd = 1040;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}">`
    + `<rect width="${Wd}" height="${H}" fill="#0f1720"/>`
    + T(20, 30, w.document.getElementById('legLabel').textContent.replace(/\s+/g, ' ').trim(), { size: 15, weight: 650 })
    + T(20, 50, w.document.getElementById('legNote').textContent.replace(/\s+/g, ' ').trim(), { size: 10.5, fill: '#9fb0c0' })
    + m
    + T(20, OY + MH + 28, w.document.getElementById('rgnNote').textContent.replace(/\s+/g, ' ').trim(), { size: 11, fill: '#ffb14e' });

  let yc = OY + MH + 52;
  svg += T(20, yc + 12, 'Trend by latitude', { size: 13, weight: 650 });
  svg += T(20, yc + 27, w.document.getElementById('zonCap').textContent, { size: 10.5, fill: '#9fb0c0' });
  svg += `<g transform="translate(20 ${yc + 34})">${inner(zs)}</g>`;
  svg += T(20, yc + 34 + vbH(zs) + 14, w.document.getElementById('zonStat').textContent, { size: 11, fill: '#9fb0c0' });

  yc += 34 + vbH(zs) + 34;
  svg += T(20, yc + 12, 'Annual series', { size: 13, weight: 650 });
  svg += T(20, yc + 27, w.document.getElementById('tsCap').textContent, { size: 10.5, fill: '#9fb0c0' });
  svg += `<g transform="translate(20 ${yc + 34})">${inner(ts)}</g>`;
  svg += T(20, yc + 34 + vbH(ts) + 14, w.document.getElementById('tsStat').textContent, { size: 11, fill: '#9fb0c0' });
  svg += `</svg>`;

  fs.writeFileSync(OUT, svg);
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

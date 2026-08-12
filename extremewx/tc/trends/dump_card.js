/* Render tccard.html under jsdom and write its SVG to a file, for a visual check.
 *
 *   node dump_card.js [dir] [out.svg] ['v=vmax&b=NA&p=1980-2024']
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { JSDOM, VirtualConsole } = require('jsdom');
const topojson = require('topojson-client');

const DIR = process.argv[2] || '.';
const OUT = process.argv[3] || 'card.svg';
const HASH = process.argv[4] || '';

(async () => {
  const html = fs.readFileSync(path.join(DIR, 'tccard.html'), 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com\/topojson-client[^>]*><\/script>/, '');
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.error('jsdom:', e.message));
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'http://localhost/extremewx/tc/trends/tccard.html' + (HASH ? '#' + HASH : '') });
  const w = dom.window;
  w.topojson = topojson;
  w.fetch = async (url) => {
    const buf = fs.readFileSync(path.join(DIR, url.replace(/^\.?\//, '')));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  w.DecompressionStream = class {};
  w.Blob = class { constructor(p) { this.p = p; } stream() { return { pipeThrough: () => this.p[0] }; } };
  w.Response = class { constructor(a) { this.a = a; }
                       async text() { return zlib.gunzipSync(Buffer.from(this.a)).toString('utf8'); } };
  w.eval(/<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)[1]);
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 25));
    if (w.document.getElementById('card').style.display === 'block') break;
  }
  fs.writeFileSync(OUT, w.svgMarkup());
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

/* Headless checks for the SCS sounding explorer.
 * Part A: the model, against published values in Chavas & Dawson (2021).
 * Part B: the page, driven through jsdom + node-canvas.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/scstest/node_modules/jsdom');
const { createCanvas } = require('/tmp/scstest/node_modules/canvas');

const DIR = process.argv[2] || '.';
const S = require(path.join(DIR, 'scssounding.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function near(name, got, want, tol) {
  ok(name, Math.abs(got - want) <= tol,
     'got ' + (+got).toPrecision(6) + ', want ' + want + ' ±' + tol);
}
function head(s) { console.log('\n' + s); }

/* ================================================== A. MODEL ============ */
head('A1. Paper §2e Fig. 4 example — WK-equivalent parameters the paper reports');
// Psfc 1000 hPa, Tsfc 300 K, RHsfc 0.7, HBL 700 m, dD 3000 J/kg, Ttpp 220 K,
// GammaFT 7.0 K/km, RHFT0 0.7  ->  theta_sfc 300 K, theta_tpp 340.6 K,
// ztpp 11.6 km, rsfc 15.8 g/kg
{
  const s = S.buildSounding({});
  near('theta_sfc = 300 K',        s.diag.thetaSfc, 300, 0.05);
  near('rsfc = 15.8 g/kg',         s.diag.rsfc, 15.8, 0.1);
  near('ztpp = 11.6 km',           s.diag.Htpp / 1000, 11.6, 0.1);
  near('theta_tpp = 340.6 K',      S.interpAtZ(s.z, s.theta, s.diag.Htpp), 340.6, 0.8);
}

head('A2. Structural properties of the two-layer state');
{
  const P = Object.assign({}, S.DEFAULTS);
  const s = S.buildSounding(P);
  const kB = Math.round(P.HBL / P.dz);

  ok('BL is well mixed in mixing ratio',
     Math.abs(s.r[0] - s.r[kB]) < 1e-9, 'r(0)-r(HBL) = ' + (s.r[0] - s.r[kB]).toExponential(2));
  ok('BL has constant dry static energy',
     Math.abs(s.D[0] - s.D[kB]) < 1e-6, 'ΔD in BL = ' + (s.D[kB] - s.D[0]).toExponential(2));
  ok('BL has constant moist static energy',
     Math.abs(s.M[0] - s.M[kB]) < 1e-6);

  const jump = s.D[kB + 1] - s.D[kB];
  near('dD jump ≈ 3000 J/kg (+ one grid step of beta)', jump, 3000 + s.beta * P.dz, 1);
  near('temperature jump = dD/cp', s.T[kB + 1] - s.T[kB],
       P.dD / S.C.cp - (S.C.Gd - P.GammaFT / 1000) * 0 - (P.GammaFT / 1000) * P.dz, 0.02);

  // FT lapse rate
  const k1 = Math.round(2000 / P.dz), k2 = Math.round(8000 / P.dz);
  near('free-tropospheric lapse rate = Gamma_FT',
       1000 * (s.T[k1] - s.T[k2]) / (s.z[k2] - s.z[k1]), P.GammaFT, 0.002);

  // stratosphere
  const kT = Math.round(s.Htpp / P.dz);
  ok('stratosphere is isothermal at Ttpp',
     Math.abs(s.T[kT + 100] - P.Ttpp) < 1e-9 && Math.abs(s.T[s.N - 1] - P.Ttpp) < 1e-9);
  ok('stratosphere is dry', s.r[kT + 100] === 0 && s.r[s.N - 1] === 0);

  // FT relative humidity
  let maxdev = 0;
  for (let k = kB + 2; k < kT - 2; k++) maxdev = Math.max(maxdev, Math.abs(s.RH[k] - P.RHFT0));
  ok('FT relative humidity constant at RHFT0', maxdev < 1e-6, 'max dev ' + maxdev.toExponential(2));

  // hydrostatic balance
  let mx = 0;
  for (let k = 0; k < s.N - 1; k++) {
    const rho = 0.5 * (s.p[k] + s.p[k + 1]) / (S.C.Rd * 0.5 * (s.Tv[k] + s.Tv[k + 1]));
    mx = Math.max(mx, Math.abs((s.p[k + 1] - s.p[k]) / P.dz + rho * S.C.g));
  }
  ok('hydrostatic to <1e-4 Pa/m', mx < 1e-4, 'max residual ' + mx.toExponential(2));

  ok('pressure decreases monotonically',
     (() => { for (let k = 0; k < s.N - 1; k++) if (s.p[k + 1] >= s.p[k]) return false; return true; })());

  near('column saturation fraction of the FT recovers RHFT0', s.diag.CSF, P.RHFT0, 0.02);
}

head('A3. RH is capped at 99% in the BL (step 3 of the algorithm)');
{
  // very moist, very deep BL: the well-mixed r would supersaturate near the top
  const s = S.buildSounding({ RHsfc: 0.99, HBL: 2500, Tsfc: 300 });
  let maxRH = 0;
  for (let k = 0; k <= Math.round(2500 / s.params.dz); k++) maxRH = Math.max(maxRH, s.RH[k]);
  ok('BL relative humidity never exceeds 99%', maxRH <= 0.9901, 'max RH ' + maxRH.toFixed(4));
}

head('A4. Paper §3c — THEO fit to 3 May 1999');
// Published: dD = 2095 J/kg, HBL = 0.42 km, RHFT0 = 0.54, Gamma_FT = 7.34 K/km,
// Ttpp = 211.25 K, (usfc,vsfc) = (-2.64, 5.83), cBL = 0.0293, cFT1 = 0.0139,
// cFT2 = -5.367e-6, SBCAPE ~ 4490 J/kg, 0-3 km bulk shear = 21 m/s.
{
  const s = S.buildSounding(S.PRESETS['THEO — CD21 fit to 3 May 1999']);
  near('0-3 km bulk shear ≈ 21 m/s', s.diag.shear03, 21, 1.0);
  ok('SBCAPE within 10% of the published 4490 J/kg',
     Math.abs(s.diag.SBCAPE - 4490) / 4490 < 0.10,
     'got ' + s.diag.SBCAPE.toFixed(0));
  near('Ttpp respected', S.interpAtZ(s.z, s.T, s.diag.Htpp), 211.25, 0.3);
  ok('CIN is small, as a severe-storm proximity sounding should be',
     s.diag.SBCIN > -100, 'CIN = ' + s.diag.SBCIN.toFixed(0));
}

head('A5. Kinematic profile matches the closed-form algorithm');
{
  const P = Object.assign({}, S.DEFAULTS, { HBL: 700, Hstop: 3000, usfc: -3, vsfc: 6,
                                            cBL: 0.02, cFT1: 0.012, cFT2: -2e-6 });
  const s = S.buildSounding(P);
  const at = zz => ({ u: S.interpAtZ(s.z, s.u, zz), v: S.interpAtZ(s.z, s.v, zz) });
  near('u constant through the BL', at(500).u, P.usfc, 1e-9);
  near('v = vsfc + cBL·z in the BL', at(500).v, P.vsfc + P.cBL * 500, 1e-9);
  const dzz = 3000 - 700;
  near('u at Hstop matches the quadratic',
       at(3000).u, P.usfc + P.cFT1 * dzz + 0.5 * P.cFT2 * dzz * dzz, 1e-6);
  near('v constant above HBL', at(3000).v, P.vsfc + P.cBL * P.HBL, 1e-9);
  near('wind constant above Hstop (u)', at(9000).u, at(3000).u, 1e-9);
  near('wind constant above Hstop (v)', at(9000).v, at(3000).v, 1e-9);
  near('bulk BL shear = cBL·HBL',
       Math.hypot(at(700).u - P.usfc, at(700).v - P.vsfc), P.cBL * P.HBL, 1e-6);

  // Eq. 25: bulk FT shear
  const dU = P.cFT1 * dzz + 0.5 * P.cFT2 * dzz * dzz;
  near('bulk upper-layer shear = Eq. 25', at(3000).u - at(700).u, dU, 1e-6);

  // taper limit case: cFT2 = -cFT1/(Hstop-HBL) -> zero shear at layer top
  // analytic derivative at Hstop, evaluated by a one-grid-step difference
  const s2 = S.buildSounding(Object.assign({}, P, { cFT2: -P.cFT1 / dzz }));
  const du = (S.interpAtZ(s2.z, s2.u, 3000) - S.interpAtZ(s2.z, s2.u, 3000 - P.dz)) / P.dz;
  near('taper case: du/dz -> 0 at Hstop', du, 0, 1e-4);
  near('taper case: du/dz = cFT1 at HBL',
       (S.interpAtZ(s2.z, s2.u, 700 + P.dz) - S.interpAtZ(s2.z, s2.u, 700)) / P.dz, P.cFT1, 1e-4);
}

head('A6. Monotonic parameter sensitivities (the physics the page is meant to teach)');
{
  const base = S.buildSounding({});
  const d = o => S.buildSounding(o).diag;
  ok('warmer surface -> more CAPE', d({ Tsfc: 302 }).SBCAPE > base.diag.SBCAPE);
  ok('moister surface -> more CAPE', d({ RHsfc: 0.8 }).SBCAPE > base.diag.SBCAPE);
  ok('stronger cap -> more CIN (more negative)', d({ dD: 6000 }).SBCIN < base.diag.SBCIN);
  ok('stronger cap -> less CAPE', d({ dD: 6000 }).SBCAPE < base.diag.SBCAPE);
  ok('steeper FT lapse rate -> more CAPE', d({ GammaFT: 8.0 }).SBCAPE > base.diag.SBCAPE);
  ok('colder tropopause -> higher tropopause', d({ Ttpp: 205 }).Htpp > base.diag.Htpp);
  ok('colder tropopause -> more CAPE', d({ Ttpp: 205 }).SBCAPE > base.diag.SBCAPE);
  ok('deeper BL -> higher LCL is not implied, but rsfc unchanged',
     Math.abs(d({ HBL: 1500 }).rsfc - base.diag.rsfc) < 1e-6);
  ok('drier FT barely changes CAPE (paper §2e)',
     Math.abs(d({ RHFT0: 0.2 }).SBCAPE - base.diag.SBCAPE) / base.diag.SBCAPE < 0.12,
     'ΔCAPE = ' + (d({ RHFT0: 0.2 }).SBCAPE - base.diag.SBCAPE).toFixed(0));
  ok('drier FT -> less precipitable water', d({ RHFT0: 0.2 }).PW < base.diag.PW);
  ok('more BL shear -> more 0-1 km shear', d({ cBL: 0.04 }).shear01 > base.diag.shear01);
  ok('MLCAPE <= SBCAPE for this well-mixed BL', base.diag.MLCAPE <= base.diag.SBCAPE + 1);
  ok('LCL < LFC < EL', base.diag.zLCL < base.diag.zLFC && base.diag.zLFC < base.diag.zEL);
  ok('EL is near or above the tropopause',
     base.diag.zEL > base.diag.Htpp - 1500,
     'EL ' + base.diag.zEL.toFixed(0) + ' vs Htpp ' + base.diag.Htpp.toFixed(0));
}

head('A6b. Parcel ascent modes');
{
  const ps=S.buildSounding({ascent:'pseudo'}), rev=S.buildSounding({ascent:'reversible'}),
        dry=S.buildSounding({ascent:'dry'});
  ok('pseudoadiabatic CAPE exceeds reversible', ps.diag.SBCAPE>rev.diag.SBCAPE,
     ps.diag.SBCAPE.toFixed(0)+' vs '+rev.diag.SBCAPE.toFixed(0)+' J/kg');
  ok('water loading costs 10-40% of CAPE',
     (ps.diag.SBCAPE-rev.diag.SBCAPE)/ps.diag.SBCAPE>0.10 &&
     (ps.diag.SBCAPE-rev.diag.SBCAPE)/ps.diag.SBCAPE<0.40,
     (100*(ps.diag.SBCAPE-rev.diag.SBCAPE)/ps.diag.SBCAPE).toFixed(1)+'%');
  ok('dry ascent has no CAPE', dry.diag.SBCAPE===0);
  ok('pseudoadiabatic parcel carries no condensate',
     [...ps.parcel.rl].filter(isFinite).every(v=>v===0));
  ok('reversible parcel conserves total water',
     (()=>{ for(let k=0;k<rev.N;k++){
              if(!isFinite(rev.parcel.rp[k]))continue;
              if(Math.abs(rev.parcel.rp[k]+rev.parcel.rl[k]-rev.parcel.rp[0])>1e-12) return false; }
            return true; })());
  // reversible is warmer but less buoyant — the classic inversion (Emanuel 1994 §4.7)
  const k=Math.round(8000/ps.params.dz);
  ok('at 8 km the reversible parcel is warmer than the pseudoadiabatic one',
     rev.parcel.Tp[k]>ps.parcel.Tp[k],
     '+'+(rev.parcel.Tp[k]-ps.parcel.Tp[k]).toFixed(2)+' K');
  ok('...but its buoyancy is lower', rev.parcel.B[k]<ps.parcel.B[k],
     rev.parcel.B[k].toFixed(4)+' vs '+ps.parcel.B[k].toFixed(4)+' m/s²');
  ok('LCL is the same in all three modes',
     Math.abs(ps.diag.zLCL-rev.diag.zLCL)<1e-9 && Math.abs(ps.diag.zLCL-dry.diag.zLCL)<1e-9);
  ok('ice fraction ramps 0 -> 1 between 273.15 and 233.15 K',
     S.iceFrac(278,true)===0 && Math.abs(S.iceFrac(253.15,true)-0.5)<1e-12 &&
     S.iceFrac(220,true)===1 && S.iceFrac(253.15,false)===0,
     'at 253.15 K: '+S.iceFrac(253.15,true).toFixed(6));
  ['pseudo','reversible'].forEach(m=>{
    const a=S.buildSounding({ascent:m}), b=S.buildSounding({ascent:m, ice:true});
    ok('ice adds CAPE ('+m+')', b.diag.SBCAPE>a.diag.SBCAPE,
       a.diag.SBCAPE.toFixed(0)+' -> '+b.diag.SBCAPE.toFixed(0)+' J/kg');
  });
  // every mode must still produce a finite, well-formed sounding
  let bad=0;
  ['pseudo','reversible','dry'].forEach(m=>[false,true].forEach(i=>{
    const s=S.buildSounding({ascent:m, ice:i});
    if (!s.p.every(v=>isFinite(v)&&v>0) || !s.parcel.Tp.every((v,k)=>k<s.parcel.k0||isFinite(v))
        || !isFinite(s.diag.SBCAPE)) bad++;
  }));
  ok('all six mode/ice combinations produce finite soundings', bad===0, bad+' bad');
}

head('A7. Every preset builds cleanly');
Object.keys(S.PRESETS).forEach(name => {
  const s = S.buildSounding(S.PRESETS[name]);
  const finite = ['SBCAPE','SBCIN','MLCAPE','PW','shear06','srh03','Htpp']
    .every(k => isFinite(s.diag[k]));
  const good = s.p.every(v => isFinite(v) && v > 0) && s.T.every(v => isFinite(v) && v > 100);
  ok('preset "' + name + '"', finite && good,
     'CAPE ' + s.diag.SBCAPE.toFixed(0) + ', CIN ' + s.diag.SBCIN.toFixed(0) +
     ', shr06 ' + s.diag.shear06.toFixed(0) + ', SRH03 ' + s.diag.srh03.toFixed(0));
});

head('A8. Slider extremes never produce NaN or a crash');
{
  const rng = {
    Psfc:[900,1030], Tsfc:[280,315], RHsfc:[0.1,0.99], HBL:[100,3000],
    dD:[0,9000], GammaFT:[4,9.7], RHFT0:[0.02,0.99], Ttpp:[185,235],
    usfc:[-20,20], vsfc:[-20,25], cBL:[0,0.05], cFT1:[0,0.03],
    cFT2:[-2e-5,1e-5], Hstop:[1000,9000]
  };
  let bad = 0, n = 0;
  Object.keys(rng).forEach(k => {
    rng[k].forEach(v => {
      n++;
      try {
        const s = S.buildSounding({ [k]: v });
        const arraysOK = s.p.every(x => isFinite(x) && x > 0) &&
                         s.T.every(x => isFinite(x)) &&
                         s.r.every(x => isFinite(x) && x >= 0) &&
                         s.u.every(x => isFinite(x)) && s.v.every(x => isFinite(x)) &&
                         s.D.every(x => isFinite(x)) && s.M.every(x => isFinite(x));
        const diagOK = isFinite(s.diag.SBCAPE) && isFinite(s.diag.SBCIN) &&
                       isFinite(s.diag.PW) && isFinite(s.diag.shear06);
        if (!arraysOK || !diagOK) { bad++; console.log('      -> ' + k + '=' + v + ' produced non-finite output'); }
      } catch (e) { bad++; console.log('      -> ' + k + '=' + v + ' threw: ' + e.message); }
    });
  });
  ok('all ' + n + ' slider extremes produce finite profiles', bad === 0, bad + ' bad');
}

head('A9. CM1 input_sounding format');
{
  const s = S.buildSounding({});
  const txt = S.toCM1(s, { dzOut: 100 });
  const lines = txt.trim().split('\n');
  const h = lines[0].trim().split(/\s+/).map(Number);
  ok('header has 3 fields', h.length === 3, lines[0]);
  near('header psfc in mb', h[0], 1000, 0.01);
  near('header theta_sfc', h[1], s.theta[0], 0.001);
  ok('header qv in g/kg (order 10-20)', h[2] > 5 && h[2] < 30, 'qv = ' + h[2]);

  const body = lines.slice(1).map(l => l.trim().split(/\s+/).map(Number));
  ok('every body line has 5 fields', body.every(r => r.length === 5));
  ok('all values finite', body.every(r => r.every(isFinite)));
  ok('first level is 100 m', Math.abs(body[0][0] - 100) < 1e-6, 'z = ' + body[0][0]);
  ok('z increases monotonically',
     body.every((r, i) => i === 0 || r[0] > body[i - 1][0]));
  // theta is NOT exactly constant in the BL: constant D gives dT/dz = -g/cp
  // exactly, and dln(theta)/dz = (g/cp)(1/Tv - 1/T) < 0 in a moist layer. This is
  // the paper's own §2b point (Eq. 18) — static energy and potential temperature
  // are dynamically equivalent but not identical. The drift is ~0.1 K.
  const bl = body.filter(r => r[0] <= s.params.HBL);
  const drift = bl[bl.length - 1][1] - s.theta[0];
  ok('theta near-constant through the BL (|drift| < 0.15 K)', Math.abs(drift) < 0.15,
     'drift = ' + drift.toFixed(4) + ' K over ' + s.params.HBL + ' m');
  ok('theta increases monotonically above HBL',
     (() => { const ft = body.filter(r => r[0] > s.params.HBL);
              return ft.every((r, i) => i === 0 || r[1] > ft[i - 1][1]); })());
  ok('qv >= 0 everywhere', body.every(r => r[2] >= 0));
  ok('top of sounding is the model top', Math.abs(body[body.length - 1][0] - 20000) < 1e-6);
  ok('u,v constant above Hstop',
     (() => { const tail = body.filter(r => r[0] > s.params.Hstop);
              return tail.every(r => Math.abs(r[3] - tail[0][3]) < 1e-9 &&
                                     Math.abs(r[4] - tail[0][4]) < 1e-9); })());

  // round-trip: recover T and p from theta/qv, and check against the model
  const kmid = body.findIndex(r => r[0] === 5000);
  const kk = Math.round(5000 / s.params.dz);
  near('round-trip theta at 5 km', body[kmid][1], s.theta[kk], 1e-4);
  near('round-trip qv at 5 km', body[kmid][2], s.r[kk] / (1 + s.r[kk]) * 1000, 1e-4);
}

head('A10. Python snippet');
{
  const txt = S.toPython(S.DEFAULTS);
  ok('mentions the DOI', txt.indexOf('10.1175/JAS-D-20-0120.1') > -1);
  ok('contains all 14 parameters',
     ['Psfc_hPa','Tsfc_K','RHsfc','HBL_m','dD_Jkg','GammaFT_Kkm','RHFT0','Ttpp_K',
      'usfc','vsfc','cBL','cFT1','cFT2','Hstop_m'].every(k => txt.indexOf(k) > -1));
}

/* =================================================== B. PAGE =========== */
head('B. Page driven headlessly (jsdom + node-canvas)');

const rawHtml = fs.readFileSync(path.join(DIR, 'sounding_ideal.html'), 'utf8');
ok('page references scssounding.js exactly once',
   (rawHtml.match(/<script src="scssounding\.js"><\/script>/g) || []).length === 1);
ok('page references the shared skewt.js exactly once',
   (rawHtml.match(/<script src="\.\.\/skewt\.js"><\/script>/g) || []).length === 1);
ok('page loads no external resources (works offline / over file://)',
   !/(src|href)\s*=\s*["']https?:\/\//.test(
     rawHtml.replace(/<a\b[^>]*>/g, '')));

// jsdom will not fetch the sibling script, so inline it — the page then runs
// exactly as it would in a browser, at parse time, in the right order.
const html = rawHtml
  .replace('<script src="../skewt.js"></script>',
    '<script>' + fs.readFileSync(path.join(DIR, '..', 'skewt.js'), 'utf8') + '</script>')
  .replace('<script src="scssounding.js"></script>',
    '<script>' + fs.readFileSync(path.join(DIR, 'scssounding.js'), 'utf8') + '</script>');

let errs = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    // one node-canvas backing store per element. Named panels get a fixed size
    // (the page resizes the element, not this); the offscreen skew-T background
    // canvas is created with explicit dimensions, so honour those.
    w.HTMLCanvasElement.prototype.getContext = function (t) {
      if (!this.__c) this.__c = createCanvas(this.width > 1 ? this.width : 1400,
                                             this.height > 1 ? this.height : 900);
      return this.__c.getContext(t);
    };
    // let drawImage accept a jsdom canvas element by unwrapping to its backing store
    const cproto = createCanvas(1, 1).getContext('2d').constructor.prototype;
    if (!cproto.__unwrapped) {
      const orig = cproto.drawImage;
      cproto.drawImage = function (img) {
        const args = Array.prototype.slice.call(arguments);
        if (img && img.__c) args[0] = img.__c;
        return orig.apply(this, args);
      };
      cproto.__unwrapped = true;
    }
    w.HTMLElement.prototype.getBoundingClientRect = function () {
      const h = this.id === 'cSkew' ? 560 : 400;
      return { width: 640, height: h, top: 0, left: 0, right: 640, bottom: h, x: 0, y: 0 };
    };
    // synchronous, so drawing errors surface in this test rather than vanishing
    w.requestAnimationFrame = cb => { cb(Date.now()); return 1; };
    w.cancelAnimationFrame = () => {};
    w.devicePixelRatio = 1;
    w.URL.createObjectURL = () => 'blob:test';
    w.URL.revokeObjectURL = () => {};
    w.addEventListener('error', e => errs.push(String(e.error || e.message)));
  }
});
const win = dom.window;

ok('page script runs without throwing', errs.length === 0, errs.join(' | ').slice(0, 400));

const doc = win.document;
const val = id => doc.getElementById(id) ? doc.getElementById(id).textContent : null;

ok('preset dropdown populated with all presets',
   doc.getElementById('preset').options.length === Object.keys(S.PRESETS).length,
   doc.getElementById('preset').options.length + ' options');

ok('SBCAPE rendered as a number', /^-?[\d.]+$/.test(val('dSBCAPE') || ''), 'SBCAPE = ' + val('dSBCAPE'));
ok('0-6 km shear rendered', /^-?[\d.]+$/.test(val('dS06') || ''), 'shear06 = ' + val('dS06'));
ok('SRH rendered', /^-?[\d.]+$/.test(val('dH03') || ''), 'SRH03 = ' + val('dH03'));
ok('LCL rendered', /^-?[\d.]+$/.test(val('dLCL') || ''), 'LCL = ' + val('dLCL'));

// every slider exists, and its value round-trips to the readout
const KEYS = ['Psfc','Tsfc','RHsfc','HBL','dD','GammaFT','RHFT0','Ttpp',
              'usfc','vsfc','cBL','cFT1','cFT2','Hstop'];
ok('all 14 sliders present', KEYS.every(k => !!doc.getElementById(k)),
   KEYS.filter(k => !doc.getElementById(k)).join(',') || 'all found');

// drive every slider to both extremes and confirm the page stays alive
let sliderBad = 0;
KEYS.forEach(k => {
  const el = doc.getElementById(k);
  [el.min, el.max].forEach(v => {
    el.value = v;
    try {
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      const cape = val('dSBCAPE');
      if (cape === null || cape === 'NaN' || cape === 'undefined') {
        sliderBad++; console.log('      -> ' + k + '=' + v + ' gave SBCAPE "' + cape + '"');
      }
    } catch (e) { sliderBad++; console.log('      -> ' + k + '=' + v + ' threw: ' + e.message); }
  });
  el.value = S.DEFAULTS[k];
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
});
ok('all 28 slider extremes render without error', sliderBad === 0, sliderBad + ' failures');

// presets
let presetBad = 0;
const sel = doc.getElementById('preset');
Object.keys(S.PRESETS).forEach(name => {
  sel.value = name;
  try {
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    const cape = val('dSBCAPE');
    if (!/^-?[\d.]+$/.test(cape)) { presetBad++; console.log('      -> preset ' + name + ' -> "' + cape + '"'); }
  } catch (e) { presetBad++; console.log('      -> preset ' + name + ' threw: ' + e.message); }
});
ok('all presets selectable and render', presetBad === 0, presetBad + ' failures');

// THEO preset through the UI should show the published shear
sel.value = 'THEO — CD21 fit to 3 May 1999';
sel.dispatchEvent(new win.Event('change', { bubbles: true }));
near('UI shows 0-3 km shear ≈ 21 m/s for THEO', parseFloat(val('dS03')), 21, 1.0);

// taper checkbox
const tap = doc.getElementById('taper');
tap.checked = true;
tap.dispatchEvent(new win.Event('change', { bubbles: true }));
ok('taper hides the cFT2 slider', doc.getElementById('cFT2box').style.display === 'none');
ok('taper still renders CAPE', /^-?[\d.]+$/.test(val('dSBCAPE')));
tap.checked = false;
tap.dispatchEvent(new win.Event('change', { bubbles: true }));
ok('untaper shows the cFT2 slider again', doc.getElementById('cFT2box').style.display === 'block');

// ascent-mode selector and ice toggle
const capeOf = () => parseFloat(val('dSBCAPE'));
const modeBtn = v => [...doc.querySelectorAll('#ascentSeg button')].find(b => b.dataset.v === v);
doc.getElementById('resetBtn').dispatchEvent(new win.Event('click', { bubbles: true }));
const psCape = capeOf();
modeBtn('reversible').dispatchEvent(new win.Event('click', { bubbles: true }));
ok('UI: reversible lowers CAPE', capeOf() < psCape,
   psCape.toFixed(0) + ' -> ' + capeOf().toFixed(0));
ok('UI: reversible button marked active', modeBtn('reversible').classList.contains('on'));
ok('UI: ascent note updates', /condensate/i.test(val('ascentNote')), val('ascentNote').slice(0, 45));
const revCape = capeOf();
doc.getElementById('iceOn').checked = true;
doc.getElementById('iceOn').dispatchEvent(new win.Event('change', { bubbles: true }));
ok('UI: ice raises CAPE', capeOf() > revCape, revCape.toFixed(0) + ' -> ' + capeOf().toFixed(0));
doc.getElementById('iceOn').checked = false;
doc.getElementById('iceOn').dispatchEvent(new win.Event('change', { bubbles: true }));
modeBtn('dry').dispatchEvent(new win.Event('click', { bubbles: true }));
ok('UI: dry mode renders', /^-?[\d.]+$/.test(val('dSBCAPE')), 'SBCAPE = ' + val('dSBCAPE'));
// the ascent choice must survive a preset change
modeBtn('reversible').dispatchEvent(new win.Event('click', { bubbles: true }));
sel.value = 'THEO — CD21 fit to 3 May 1999';
sel.dispatchEvent(new win.Event('change', { bubbles: true }));
ok('UI: ascent mode survives a preset change', modeBtn('reversible').classList.contains('on'));
modeBtn('pseudo').dispatchEvent(new win.Event('click', { bubbles: true }));

// reset
doc.getElementById('resetBtn').dispatchEvent(new win.Event('click', { bubbles: true }));
ok('development banner is present and above the header',
   (() => { const b = doc.querySelector('.devbanner');
            if (!b) return false;
            const txt = b.textContent.replace(/\s+/g,' ').trim();
            if (!/rapid development/.test(txt) || !/email me/i.test(txt)) return false;
            const h = doc.querySelector('header');
            return !!(h && (b.compareDocumentPosition(h) & 4)); })(),
   (doc.querySelector('.devbanner')||{textContent:'(missing)'}).textContent.replace(/\s+/g,' ').trim().slice(0,80));
ok('banner links to the contact address',
   !!doc.querySelector('.devbanner a[href^="mailto:"]'));

ok('reset returns to the first preset', sel.value === Object.keys(S.PRESETS)[0]);
ok('reset restores the pseudoadiabatic CAPE', Math.abs(capeOf() - psCape) < 1e-6);

// warning path: a sounding with no CAPE should raise the warning box
['Tsfc','RHsfc'].forEach(k => {
  const el = doc.getElementById(k); el.value = el.min;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
});
ok('no-CAPE sounding raises the warning box',
   doc.getElementById('warn').style.display === 'block',
   doc.getElementById('warn').textContent.slice(0, 70));
doc.getElementById('resetBtn').dispatchEvent(new win.Event('click', { bubbles: true }));
ok('warning clears after reset', doc.getElementById('warn').style.display === 'none',
   'warn = "' + doc.getElementById('warn').textContent.slice(0, 90) + '"');

// download button
let downloaded = false;
const realCreate = doc.createElement.bind(doc);
doc.createElement = function (t) {
  const el = realCreate(t);
  if (t === 'a') el.click = () => { downloaded = true; };
  return el;
};
doc.getElementById('dlBtn').dispatchEvent(new win.Event('click', { bubbles: true }));
ok('download button triggers a file download', downloaded);

// canvases actually got drawn (non-blank)
['cSkew','cSE','cHodo','cWind','cThermo'].forEach(id => {
  const el = doc.getElementById(id);
  const c = el.__c;
  if (!c) { ok(id + ' drew pixels', false, 'no canvas backing'); return; }
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let nonzero = 0;
  for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 0) nonzero++;
  ok(id + ' drew pixels', nonzero > 20, nonzero + ' non-transparent samples');
});

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(64));
console.log((fail === 0 ? 'ALL PASS' : fail + ' FAILURES') + '   —   ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);

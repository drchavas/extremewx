/* ============================================================================
 * skewt.js — the skew-T log-p renderer from the TC potential-intensity explorer
 * on this site, factored out so every sounding page draws an identical figure.
 *
 * Ported verbatim from web/index.html of the TCPI project: same geometry
 * (MetPy SkewT rotation 47°, p 1050 -> 50 hPa, surface-temperature-dependent
 * x-bounds), same background (cornflower dry and moist adiabats, black dashed
 * saturation mixing-ratio lines, blue dashed 0 and -20 °C isotherms, grey
 * isobars, bold black tick labels), same fonts, same line widths, and the same
 * SounderPy-derived curve palette. Curves are labelled in place rather than
 * through a legend.
 *
 * The background depends only on the axes, so it is rendered once to an
 * offscreen canvas and blitted.
 *
 * No dependencies. Browser or node.
 * ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkewT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const K = { CPD:1005.7, RD:287.04, RV:461.5, ALV0:2.501e6, CPV:1870, CL:4190 };
K.EPS = K.RD / K.RV;

/* Match SounderPy: MetPy SkewT rotation=47°, p 1050->50, surface-temp-dependent bounds */
const Pbot = 1050, Ptop = 50, ROT = 47 * Math.PI / 180;

const FF = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

const COL = {
  paper    : '#ffffff',
  adiabat  : 'rgba(100,149,237,0.55)',   // dry AND moist, as on the PI page
  mixr     : 'rgba(0,0,0,0.42)',
  isotherm : 'rgba(120,134,145,0.26)',
  isoBlue  : 'rgba(0,0,255,0.30)',
  isobar   : 'rgba(150,160,170,0.55)',
  tick     : '#111',
  axisTitle: '#9aa8b3',
  km       : '#9aa8b3',
  frame    : '#000',
  ink      : '#16222e',
  T        : 'red',
  Td       : 'green',
  Tw       : '#3d8aff',
  Tv       : 'darkred',
  parcel   : '#b1239e',
  gray     : '#7e8c98',
  cape     : 'rgba(214,69,55,.34)',
  cin      : 'rgba(31,99,184,.20)',
  band     : 'rgba(126,140,152,.10)',
  bandEdge : 'rgba(126,140,152,.55)'
};

const FONT = {
  tick    : 'bold 12px ' + FF,
  axis    : '10px ' + FF,
  km      : '9.5px ' + FF,
  label   : '800 11px ' + FF,
  subBase : '800 12px ' + FF,
  subSmall: '700 9px ' + FF,
  marker  : '700 10.5px ' + FF
};

const LW = {
  adiabat:0.7, mixr:0.55, isotherm:0.8, isoBlue:1, isobar:0.8, frame:1,
  T:3.2, Td:3, Tw:1.8, Tv:2.2, parcelRho:2.6, parcelT:1.8, parcelTv:1.6
};

const DASH = {
  mixr:[4,3], isoBlue:[5,4], Tv:[1.5,2.5],
  parcelRho:[7,4], parcelT:[5,4], parcelTv:[1,2.5], marker:[3,3]
};

const ALPHA = { Tw:0.65, Tv:0.75 };

/* ------------------------------------------------------------ thermo bits */
function esat(Tc){ return 6.112 * Math.exp(17.67 * Tc / (Tc + 243.5)); }
function dewpFromR(rg, p){
  const rr = rg/1000, e = rr*p/(K.EPS+rr);
  if (!(e>0)) return NaN;
  const l = Math.log(e/6.112);
  return 243.5*l/(17.67-l);
}
/** Default pseudoadiabat for the background curves. T in K, p in hPa. */
function dTdlnpDefault(T, p){
  const es=esat(T-273.15), rs=K.EPS*es/Math.max(p-es,1e-6);
  const L=K.ALV0+(K.CPV-K.CL)*(T-273.15);
  return (K.RD*T + L*rs) / (K.CPD + L*L*rs*K.EPS/(K.RD*T*T));
}

/* --------------------------------------------------------------- geometry */
/** Surface-temperature-dependent x-bounds, exactly as on the PI page. */
function tempBounds(T0){
  if (T0 <= -10) return T0 <= -20 ? [-52,32] : [-42,42];
  if (T0 >=  20) return [-22,62];
  return [-32,52];
}

/**
 * @param w,h   canvas size in CSS px
 * @param T0    surface temperature in °C (sets the x-bounds)
 * @param mRight extra right margin (the PI page uses 14; pass more for wind barbs)
 */
function makeGeo(w, h, T0, mRight){
  const mL=46, mR=(mRight===undefined?14:mRight), mT=12, mB=30;
  const W=w-mL-mR, H=h-mT-mB;
  const [Tmn,Tmx]=tempBounds(T0);
  const lp0=Math.log(Pbot), lp1=Math.log(Ptop), TAN=Math.tan(ROT);
  const yn=p=>(Math.log(p)-lp0)/(lp1-lp0);
  const xn=T=>(T-Tmn)/(Tmx-Tmn);
  return {
    mL,mR,mT,mB,W,H,Tmn,Tmx,yn,xn,
    yP:p=>mT+(1-yn(p))*H,
    xT:(T,p)=>mL+(xn(T)+TAN*yn(p))*W,
    /** inverse of xT: screen x at pressure p -> temperature °C */
    Tx:(x,p)=>Tmn+((x-mL)/W - TAN*yn(p))*(Tmx-Tmn),
    key:()=>w+'x'+h+'_'+Tmn+'_'+mR
  };
}

/* ------------------------------------------------------------- background */
/**
 * Render the static background to an offscreen canvas.
 * @param doc      a document (for createElement); pass window.document
 * @param dTdlnp   optional pseudoadiabat dT/dlnp(T[K], p[hPa]) so the moist
 *                 adiabats match the calling page's own thermodynamics
 */
function buildBackground(doc, w, h, g, dpr, dTdlnp){
  const f = dTdlnp || dTdlnpDefault;
  const off = doc.createElement('canvas');
  off.width  = Math.round(w*dpr);
  off.height = Math.round(h*dpr);
  const ctx = off.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);

  ctx.fillStyle = COL.paper; ctx.fillRect(0,0,w,h);
  ctx.save(); ctx.beginPath(); ctx.rect(g.mL,g.mT,g.W,g.H); ctx.clip();

  // dry adiabats
  ctx.strokeStyle=COL.adiabat; ctx.lineWidth=LW.adiabat;
  for (let th=-40; th<=240; th+=10){
    ctx.beginPath(); let first=true;
    for (let p=Pbot; p>=Ptop; p-=10){
      const T=(th+273.15)*Math.pow(p/1000, K.RD/K.CPD)-273.15;
      const x=g.xT(T,p), y=g.yP(p);
      first ? (ctx.moveTo(x,y), first=false) : ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  // moist (pseudo) adiabats
  ctx.strokeStyle=COL.adiabat; ctx.lineWidth=LW.adiabat;
  for (let t0=-30; t0<=40; t0+=5){
    let Tk=t0+273.15;
    ctx.beginPath(); let first=true;
    for (let p=1000; p>=Ptop; p-=12){
      const x=g.xT(Tk-273.15,p), y=g.yP(p);
      first ? (ctx.moveTo(x,y), first=false) : ctx.lineTo(x,y);
      const dl=Math.log((p-12)/p);
      const a=f(Tk,p), b=f(Tk+a*dl, p-12);
      Tk += 0.5*(a+b)*dl;
      if (!isFinite(Tk)) break;
    }
    ctx.stroke();
  }
  // saturation mixing-ratio lines
  ctx.strokeStyle=COL.mixr; ctx.lineWidth=LW.mixr; ctx.setLineDash(DASH.mixr);
  [1,2,4,7,10,16,24,32].forEach(rg=>{
    ctx.beginPath(); let first=true;
    for (let p=1050; p>=400; p-=18){
      const T=dewpFromR(rg,p);
      if (!isFinite(T)) continue;
      const x=g.xT(T,p), y=g.yP(p);
      first ? (ctx.moveTo(x,y), first=false) : ctx.lineTo(x,y);
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);
  // isotherms
  ctx.strokeStyle=COL.isotherm; ctx.lineWidth=LW.isotherm;
  for (let T=-120; T<=80; T+=10){
    ctx.beginPath();
    ctx.moveTo(g.xT(T,Pbot), g.yP(Pbot));
    ctx.lineTo(g.xT(T,Ptop), g.yP(Ptop));
    ctx.stroke();
  }
  // 0 and -20 °C highlights
  ctx.strokeStyle=COL.isoBlue; ctx.lineWidth=LW.isoBlue; ctx.setLineDash(DASH.isoBlue);
  [0,-20].forEach(T=>{
    ctx.beginPath();
    ctx.moveTo(g.xT(T,Pbot), g.yP(Pbot));
    ctx.lineTo(g.xT(T,Ptop), g.yP(Ptop));
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.restore();

  // isobars + pressure labels
  ctx.strokeStyle=COL.isobar; ctx.lineWidth=LW.isobar;
  ctx.fillStyle=COL.tick; ctx.font=FONT.tick;
  ctx.textAlign='right'; ctx.textBaseline='middle';
  [1000,900,800,700,600,500,400,300,200,150,100].forEach(p=>{
    const y=g.yP(p);
    ctx.beginPath(); ctx.moveTo(g.mL,y); ctx.lineTo(g.mL+g.W,y); ctx.stroke();
    ctx.fillText(p, g.mL-5, y);
  });
  // bottom temperature ticks
  ctx.textAlign='center'; ctx.textBaseline='top';
  ctx.fillStyle=COL.tick; ctx.font=FONT.tick;
  for (let T=-20; T<=60; T+=10){
    const x=g.xT(T,Pbot);
    if (x>g.mL && x<g.mL+g.W) ctx.fillText(T, x, h-g.mB+7);
  }
  // axis titles
  ctx.fillStyle=COL.axisTitle; ctx.font=FONT.axis;
  ctx.fillText('Temperature (°C)', g.mL+g.W/2, h-13);
  ctx.save(); ctx.translate(12, g.mT+g.H/2); ctx.rotate(-Math.PI/2);
  ctx.textBaseline='alphabetic'; ctx.fillText('Pressure (hPa)',0,0); ctx.restore();

  ctx.strokeStyle=COL.frame; ctx.lineWidth=LW.frame;
  ctx.strokeRect(g.mL,g.mT,g.W,g.H);
  return off;
}

/* ----------------------------------------------------------------- pieces */
function clipPlot(ctx,g){ ctx.save(); ctx.beginPath(); ctx.rect(g.mL,g.mT,g.W,g.H); ctx.clip(); }

/**
 * Draw one profile. `pts` is an array of [T °C, p hPa]; non-finite T is skipped.
 */
function curve(ctx, g, pts, color, lw, dash, alpha){
  ctx.save();
  ctx.strokeStyle=color; ctx.lineWidth=lw;
  ctx.lineJoin='round'; ctx.lineCap='round';
  if (dash) ctx.setLineDash(dash);
  if (alpha!==undefined) ctx.globalAlpha=alpha;
  ctx.beginPath(); let first=true;
  for (let i=0;i<pts.length;i++){
    const T=pts[i][0], p=pts[i][1];
    if (!isFinite(T) || p>Pbot || p<Ptop){ first=true; continue; }
    const x=g.xT(T,p), y=g.yP(p);
    first ? (ctx.moveTo(x,y), first=false) : ctx.lineTo(x,y);
  }
  ctx.stroke(); ctx.restore();
}

/** Fill the area between two profiles, sampled on the same pressure list. */
function band(ctx, g, ps, aVals, bVals, color){
  ctx.save(); ctx.fillStyle=color; ctx.beginPath();
  let n=0;
  for (let i=0;i<ps.length;i++){
    if (!isFinite(aVals[i])) continue;
    const x=g.xT(aVals[i],ps[i]), y=g.yP(ps[i]);
    n++ ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  }
  for (let i=ps.length-1;i>=0;i--){
    if (!isFinite(bVals[i])) continue;
    ctx.lineTo(g.xT(bVals[i],ps[i]), g.yP(ps[i]));
  }
  ctx.closePath(); ctx.fill(); ctx.restore();
}

/** Inline curve label, PI-page style. */
function label(ctx, g, T, p, txt, color, align, dx){
  if (!isFinite(T) || p>Pbot || p<Ptop) return;
  ctx.save();
  ctx.fillStyle=color; ctx.font=FONT.label;
  ctx.textAlign=align||'left'; ctx.textBaseline='middle';
  ctx.fillText(txt, g.xT(T,p)+(dx||0), g.yP(p));
  ctx.restore();
}

/** "base" followed by a lowered subscript, anchored at x with the given alignment. */
function subLabel(ctx, x, y, base, sub, color, align){
  ctx.save();
  ctx.fillStyle=color; ctx.textBaseline='middle'; ctx.textAlign='left';
  ctx.font=FONT.subBase;  const wb=ctx.measureText(base).width;
  ctx.font=FONT.subSmall; const ws=ctx.measureText(sub).width;
  let x0=x;
  if (align==='right') x0 = x-(wb+ws);
  else if (align==='center') x0 = x-(wb+ws)/2;
  ctx.font=FONT.subBase;  ctx.fillText(base, x0, y);
  ctx.font=FONT.subSmall; ctx.fillText(sub, x0+wb+0.5, y+4);
  ctx.restore();
}

/** Inline label anchored on a curve, with a subscript. */
function subLabelAt(ctx, g, T, p, base, sub, color, align, dx){
  if (!isFinite(T) || p>Pbot || p<Ptop) return;
  subLabel(ctx, g.xT(T,p)+(dx||0), g.yP(p), base, sub, color, align);
}

/** Height labels down the left interior, PI-page style. */
function kmLabels(ctx, g, pAtKm, kms){
  ctx.save();
  ctx.fillStyle=COL.km; ctx.font=FONT.km;
  ctx.textAlign='left'; ctx.textBaseline='middle';
  (kms||[1,3,5,9,13,16]).forEach(km=>{
    const pp=pAtKm(km);
    if (pp && pp>=Ptop && pp<=Pbot) ctx.fillText(km+' km', g.mL+5, g.yP(pp));
  });
  ctx.restore();
}

/** A horizontal reference level with a right-aligned label, dodged vertically. */
function levelMarker(ctx, g, p, txt, color, used){
  if (!(p>=Ptop && p<=Pbot)) return;
  const y=g.yP(p);
  ctx.save();
  ctx.strokeStyle=color; ctx.lineWidth=1; ctx.setLineDash(DASH.marker);
  ctx.beginPath(); ctx.moveTo(g.mL,y); ctx.lineTo(g.mL+g.W,y); ctx.stroke();
  ctx.setLineDash([]);
  let ly=y-3;
  if (used){ while (used.some(v=>Math.abs(v-ly)<11)) ly-=11; used.push(ly); }
  ctx.fillStyle=color; ctx.font=FONT.marker;
  ctx.textAlign='right'; ctx.textBaseline='alphabetic';
  ctx.fillText(txt, g.mL+g.W-3, ly);
  ctx.restore();
}

/* ---------------------------------------------------------------------- */
return { K, Pbot, Ptop, ROT, COL, FONT, LW, DASH, ALPHA, FF,
         esat, dewpFromR, dTdlnpDefault, tempBounds, makeGeo,
         buildBackground, clipPlot, curve, band, label, subLabel, subLabelAt,
         kmLabels, levelMarker };
}));

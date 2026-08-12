/* ============================================================================
 * sounding.js — thermodynamics and severe-weather diagnostics for an arbitrary
 * atmospheric sounding.
 *
 * Input is a list of levels {p, T, Td, wdir, wspd} (hPa, °C, °C, deg, kt).
 * Everything else — heights, parcel ascent, CAPE/CIN/LCL/LFC/EL for surface,
 * mixed-layer and most-unstable parcels, the effective inflow layer, shear,
 * Bunkers storm motion, SRH, and the usual composite indices — is derived.
 *
 * No dependencies. Browser or node:
 *     const SK = require('./sounding.js');
 *     const a  = SK.analyze(SK.PRESETS['Weisman-Klemp supercell']);
 *     console.log(a.sb.CAPE, a.kin.shear06, a.idx.STP);
 *
 * Conventions
 *   - pressure in hPa, temperature in °C, mixing ratio in g/kg, height in m AGL
 *   - u,v in m/s; wind speed reported in kt where labelled
 *   - parcel ascent is pseudoadiabatic; buoyancy uses virtual temperature
 *
 * (c) 2026 Dan Chavas.
 * ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SoundingKit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ------------------------------------------------------------- constants */
const C = {
  g:9.80665, cp:1005.7, Rd:287.04, Rv:461.5, Lv:2501000, p00:1000
};
C.eps = C.Rd / C.Rv;
C.kappa = C.Rd / C.cp;
const KT = 0.514444;              // kt -> m/s

/* ------------------------------------------------------- thermodynamics */
/** Saturation vapour pressure over liquid, Bolton (1980) Eq. 10. T °C -> hPa */
function esat(Tc){ return 6.112 * Math.exp(17.67*Tc/(Tc+243.5)); }

/** Mixing ratio from dewpoint. Td °C, p hPa -> g/kg */
function mixr(Tdc, p){ const e=esat(Tdc); return e>=p ? NaN : C.eps*e/(p-e)*1000; }

/** Dewpoint from mixing ratio. r g/kg, p hPa -> °C */
function dewp(rg, p){
  const r=rg/1000, e=r*p/(C.eps+r);
  if (!(e>0)) return NaN;
  const l=Math.log(e/6.112);
  return 243.5*l/(17.67-l);
}

/** Relative humidity, 0-1. */
function rh(Tc, Tdc){ return Math.min(1, esat(Tdc)/esat(Tc)); }

/** Virtual temperature. Tc °C, r g/kg -> °C */
function tvirt(Tc, rg){
  const r=rg/1000;
  return (Tc+273.15)*(1+r/C.eps)/(1+r) - 273.15;
}

/** Potential temperature. Tc °C, p hPa -> K */
function theta(Tc, p){ return (Tc+273.15)*Math.pow(C.p00/p, C.kappa); }

/** Equivalent potential temperature, Bolton (1980) Eqs. 15, 38, 39. -> K */
function thetaE(Tc, Tdc, p){
  const T=Tc+273.15, Td=Tdc+273.15, rg=mixr(Tdc,p);
  if (!isFinite(rg)) return NaN;
  const TL = 1/(1/(Td-56) + Math.log(T/Td)/800) + 56;
  return T * Math.pow(C.p00/p, 0.2854*(1-0.28e-3*rg))
           * Math.exp((3.376/TL - 0.00254)*rg*(1+0.81e-3*rg));
}

/** Wet-bulb temperature, Stull (2011). Tc °C, RH 0-1 -> °C */
function wetbulb(Tc, RH){
  const R=Math.max(1e-3, Math.min(100, RH*100));
  return Tc*Math.atan(0.151977*Math.sqrt(R+8.313659)) + Math.atan(Tc+R)
       - Math.atan(R-1.676331) + 0.00391838*Math.pow(R,1.5)*Math.atan(0.023101*R)
       - 4.686035;
}

/* ------------------------------------------------------- moist ascent ----
 * One generalized saturated lapse rate covers both moist ascent modes; they
 * differ only in what happens to the condensate.
 *
 *   dT/dlnp = (1 + rv/ε)(Rd T + L rv) / (cpd + rt cl + L² rv (1 + rv/ε)/(Rv T²))
 *
 * with rt the TOTAL water mixing ratio: rt = rv for pseudoadiabatic ascent
 * (condensate is removed as fast as it forms) and rt = r0, conserved, for
 * reversible ascent (condensate is carried along, adding heat capacity and
 * weighing the parcel down). This is Emanuel (1994) Eq. 4.7.3 converted from
 * height to log-pressure; it reduces to the textbook pseudoadiabatic formula
 * when rt = rv and the rv/ε refinements are dropped.
 *
 * With ice enabled, the latent heat and the saturation vapour pressure are
 * blended between liquid and ice over 0 to -40 °C, following the mixed-phase
 * treatment of Peters et al. (2022).
 * ------------------------------------------------------------------------ */
const ICE = { Tliq:0, Tice:-40, Lf:3.337e5, cpv:1870, cl:4190 };

/** Ice fraction of the condensate, 0 below the liquid limit to 1 below -40 °C. */
function iceFrac(Tc, useIce){
  if (!useIce) return 0;
  if (Tc >= ICE.Tliq) return 0;
  if (Tc <= ICE.Tice) return 1;
  return (ICE.Tliq - Tc)/(ICE.Tliq - ICE.Tice);
}
/** Saturation vapour pressure over ice (Magnus form). Tc °C -> hPa */
function esatIce(Tc){ return 6.112*Math.exp(22.46*Tc/(272.62+Tc)); }
/** Saturation vapour pressure, blended across the mixed-phase range. */
function esatMix(Tc, useIce){
  const w=iceFrac(Tc,useIce);
  return w===0 ? esat(Tc) : (1-w)*esat(Tc) + w*esatIce(Tc);
}
/** Effective latent heat, temperature dependent, plus fusion where there is ice. */
function Lheat(Tc, useIce){
  return C.Lv + (ICE.cpv-ICE.cl)*Tc + iceFrac(Tc,useIce)*ICE.Lf;
}
/** Saturation mixing ratio using the blended vapour pressure. -> g/kg */
function mixrSat(Tc, p, useIce){
  const e=esatMix(Tc,useIce);
  return e>=p ? NaN : C.eps*e/(p-e)*1000;
}

/**
 * dT/dln(p) for a saturated parcel. T in K, p in hPa, rt total water in g/kg
 * (pass null for pseudoadiabatic, i.e. rt = rv at every level).
 */
function dTdlnp(T, p, rt, useIce){
  const Tc=T-273.15;
  const rs=mixrSat(Tc,p,useIce)/1000;
  if (!isFinite(rs)) return C.Rd*T/C.cp;
  const L=Lheat(Tc,useIce);
  const rtot=(rt===null||rt===undefined) ? rs : Math.max(rt/1000, rs);
  const f=1+rs/C.eps;
  return f*(C.Rd*T + L*rs) /
         (C.cp + rtot*ICE.cl + L*L*rs*f/(C.Rv*T*T));
}

/**
 * Density temperature of a parcel: virtual temperature reduced by condensate
 * loading. rv = vapour, rt = total water, both g/kg. Tc °C -> °C.
 * With rt = rv this is the ordinary virtual temperature.
 */
function tdens(Tc, rv, rt){
  const a=rv/1000, b=Math.max(rt,rv)/1000;
  return (Tc+273.15)*(1+a/C.eps)/(1+b) - 273.15;
}

/** LCL pressure and temperature from a parcel state. Bolton (1980) Eq. 22. */
function lcl(Tc, Tdc, p){
  const T=Tc+273.15, Td=Tdc+273.15;
  const e=Math.max(esat(Tdc),1e-9);
  const TL = 2840/(3.5*Math.log(T) - Math.log(e) - 4.805) + 55;
  return { T: TL-273.15, p: p*Math.pow(TL/T, 1/C.kappa) };
}

/* ------------------------------------------------------------ utilities */
function interp(xs, ys, x){
  const n=xs.length;
  if (n===0) return NaN;
  const asc = xs[n-1] > xs[0];
  if (( asc && x<=xs[0]) || (!asc && x>=xs[0])) return ys[0];
  if (( asc && x>=xs[n-1]) || (!asc && x<=xs[n-1])) return ys[n-1];
  for (let i=0;i<n-1;i++){
    const a=xs[i], b=xs[i+1];
    if ((x>=a&&x<=b)||(x<=a&&x>=b)){
      const t=(b===a)?0:(x-a)/(b-a);
      return ys[i]+t*(ys[i+1]-ys[i]);
    }
  }
  return ys[n-1];
}
/** Interpolate a field to a height AGL. */
function atZ(prof, f, z){ return interp(prof.z, prof[f], z); }
/** Interpolate a field to a pressure. */
function atP(prof, f, p){ return interp(prof.p, prof[f], p); }

/* ============================================================ 1. PARSING */
/**
 * Parse pasted sounding text. Understands:
 *   - University of Wyoming / RAOB tables (PRES HGHT TEMP DWPT ... DRCT SKNT)
 *   - CM1 `input_sounding` (header line, then z theta qv u v)
 *   - generic CSV/TSV/whitespace with a header row naming the columns
 *   - generic positional: p, T, Td [, wdir, wspd]
 * Returns {levels, format, warnings}.
 */
function numsOf(s){
  const parts = s.split(/[\s,;]+/).filter(t=>t.length);
  const v = parts.map(Number);
  return v.length && v.every(x=>isFinite(x)) ? v : null;
}

/**
 * CM1 `input_sounding`: a 3-field header (psfc_mb, theta_sfc, qv_sfc) followed by
 * 5-field rows (z, theta, qv, u, v) with z strictly increasing. Pressure is not
 * in the file, so it is recovered by integrating hydrostatic balance upward.
 * Returns null if the text is not this format.
 */
function parseCM1(raw){
  const h=numsOf(raw[0]);
  if (!h || h.length!==3) return null;
  const body=raw.slice(1).map(numsOf);
  if (body.length<3 || !body.every(r=>r&&r.length===5)) return null;
  if (!body.every((r,i)=>i===0||r[0]>body[i-1][0])) return null;
  if (!(h[0]>500 && h[0]<1100)) return null;

  const levels=[];
  let p=h[0], zPrev=0;
  const stateAt=(th,qv,pp)=>{
    const T=th*Math.pow(pp/C.p00,C.kappa)-273.15;
    const r=qv/(1-qv/1000);              // CM1 qv is specific humidity, g/kg
    return {T, r};
  };
  let st=stateAt(h[1],h[2],p);
  const wind0=[body[0][3], body[0][4]];
  levels.push({p, T:st.T, Td:dewp(st.r,p), u:wind0[0], v:wind0[1]});

  body.forEach(r=>{
    const dz=r[0]-zPrev;
    const Tv0=tvirt(st.T,st.r)+273.15;
    let pn=p*Math.exp(-C.g*dz/(C.Rd*Tv0));
    for (let it=0;it<3;it++){
      const s1=stateAt(r[1],r[2],pn);
      const Tvm=0.5*(Tv0 + tvirt(s1.T,s1.r)+273.15);
      pn=p*Math.exp(-C.g*dz/(C.Rd*Tvm));
    }
    p=pn; zPrev=r[0];
    st=stateAt(r[1],r[2],p);
    levels.push({p, T:st.T, Td:dewp(st.r,p), u:r[3], v:r[4]});
  });
  return levels;
}

function parseText(txt){
  const warnings=[];
  const raw=(txt||'').replace(/\r/g,'').split('\n').map(s=>s.trim()).filter(s=>s.length);
  if (!raw.length) return {levels:[], format:'empty', warnings:['nothing to parse']};

  const cm1=parseCM1(raw);
  if (cm1) return {levels:cm1, format:'cm1', warnings:[
    'read as a CM1 input_sounding (z, θ, qv, u, v); pressure recovered hydrostatically',
    'the CM1 header line carries no wind, so the surface level inherits the wind of the first level above it'
  ]};

  return parseTabular(raw, warnings);
}

function parseTabular(raw, warnings){
  // ---- find a header row and map column names
  const KEYS = {
    p:   /^(pres|press|pressure|p|hpa|mb|plev)$/i,
    z:   /^(hght|height|hgt|z|alt|altitude|geop|gph)$/i,
    T:   /^(temp|tmpc|t|tempc|temperature|tc)$/i,
    Td:  /^(dwpt|dewp|dewpt|td|tdc|dewpoint|dpt)$/i,
    r:   /^(mixr|mixing|qv|w|mixratio)$/i,
    rh:  /^(relh|rh|humidity)$/i,
    wdir:/^(drct|dir|wdir|direction|wd)$/i,
    wspd:/^(sknt|spd|wspd|speed|ws|kt|knots|sped)$/i,
    u:   /^(u|uwnd|ucomp)$/i,
    v:   /^(v|vwnd|vcomp)$/i
  };
  let map=null, start=0;
  for (let i=0;i<Math.min(6,raw.length);i++){
    const toks=raw[i].split(/[\s,;]+/).filter(t=>t.length);
    if (toks.length<3 || toks.every(t=>isFinite(Number(t)))) continue;
    const m={};
    toks.forEach((t,j)=>{ const k=t.replace(/[^\w]/g,'');
      for (const key in KEYS) if (KEYS[key].test(k) && m[key]===undefined) m[key]=j; });
    if (m.p!==undefined && (m.T!==undefined)){ map=m; start=i+1; break; }
  }

  const rowsRaw = raw.slice(start)
    .map(s=>s.split(/[\s,;]+/).filter(t=>t.length))
    .filter(a=>a.length>=2 && isFinite(Number(a[0])));
  if (!rowsRaw.length) return {levels:[], format:'unknown', warnings:['no numeric rows found']};

  if (!map){
    // positional: p T Td [wdir wspd]
    map={p:0,T:1,Td:2}; if (rowsRaw[0].length>=5){ map.wdir=3; map.wspd=4; }
    warnings.push('no header recognised — read columns positionally as p, T, Td'+
                  (map.wdir!==undefined?', wind direction, wind speed':''));
  }

  const num=(a,j)=> j===undefined ? NaN : Number(a[j]);
  const levels=[];
  rowsRaw.forEach(a=>{
    const p=num(a,map.p);
    if (!isFinite(p) || p<=0 || p>1100) return;
    let T=num(a,map.T);
    if (!isFinite(T)) return;
    let Td=num(a,map.Td);
    if (!isFinite(Td)){
      if (map.r!==undefined && isFinite(num(a,map.r))) Td=dewp(num(a,map.r),p);
      else if (map.rh!==undefined && isFinite(num(a,map.rh))){
        const RH=Math.max(1,Math.min(100,num(a,map.rh)))/100;
        Td=dewp(mixr(T,p)*RH, p);                 // approximate; refined below
        Td=dewp(C.eps*RH*esat(T)/(p-RH*esat(T))*1000, p);
      }
    }
    if (!isFinite(Td)) Td=T-30;
    let u=NaN,v=NaN;
    if (map.u!==undefined && map.v!==undefined){ u=num(a,map.u); v=num(a,map.v); }
    else if (map.wdir!==undefined && map.wspd!==undefined){
      const d=num(a,map.wdir), s=num(a,map.wspd)*KT;
      if (isFinite(d)&&isFinite(s)){ u=-s*Math.sin(d*Math.PI/180); v=-s*Math.cos(d*Math.PI/180); }
    }
    levels.push({p, T, Td:Math.min(Td,T), u, v});
  });

  if (!levels.length) return {levels:[], format:'unknown', warnings:['no usable levels']};
  levels.sort((a,b)=>b.p-a.p);
  return {levels, format: map?'table':'positional', warnings};
}

/* ==================================================== 2. PROFILE BUILDING */
/**
 * Turn a list of levels into a dense, gap-free profile on a log-p grid, with
 * hydrostatic heights AGL. `n` sets the grid resolution.
 */
function buildProfile(levels, n){
  n = n || 500;
  const L = levels.filter(l=>isFinite(l.p)&&isFinite(l.T)).slice().sort((a,b)=>b.p-a.p);
  if (L.length<2) return null;

  const pIn=L.map(l=>l.p), lnp=pIn.map(Math.log);
  const TIn=L.map(l=>l.T), TdIn=L.map(l=>Math.min(l.Td,l.T));
  const haveW = L.some(l=>isFinite(l.u)&&isFinite(l.v));
  const uIn=L.map(l=>isFinite(l.u)?l.u:0), vIn=L.map(l=>isFinite(l.v)?l.v:0);

  const p0=pIn[0], pT=pIn[pIn.length-1];
  const p=new Float64Array(n), T=new Float64Array(n), Td=new Float64Array(n),
        u=new Float64Array(n), v=new Float64Array(n);
  for (let i=0;i<n;i++){
    const lp = Math.log(p0) + (Math.log(pT)-Math.log(p0))*i/(n-1);
    p[i]=Math.exp(lp);
    T[i]=interp(lnp,TIn,lp);
    Td[i]=Math.min(interp(lnp,TdIn,lp), T[i]);
    u[i]=interp(lnp,uIn,lp); v[i]=interp(lnp,vIn,lp);
  }

  const r=new Float64Array(n), Tv=new Float64Array(n), z=new Float64Array(n),
        th=new Float64Array(n), the=new Float64Array(n), RHa=new Float64Array(n),
        Tw=new Float64Array(n), spd=new Float64Array(n), q=new Float64Array(n),
        qs=new Float64Array(n), thes=new Float64Array(n);
  for (let i=0;i<n;i++){
    r[i]=mixr(Td[i],p[i]); if(!isFinite(r[i])) r[i]=0;
    const rs=mixr(T[i],p[i]);
    q[i]=r[i]/(1+r[i]/1000);                 // specific humidity, g/kg
    qs[i]=isFinite(rs)?rs/(1+rs/1000):0;     // saturation specific humidity
    Tv[i]=tvirt(T[i],r[i]);
    th[i]=theta(T[i],p[i]);
    the[i]=thetaE(T[i],Td[i],p[i]);
    thes[i]=thetaE(T[i],T[i],p[i]);          // saturation equivalent potential temperature
    RHa[i]=rh(T[i],Td[i]);
    Tw[i]=wetbulb(T[i],RHa[i]);
    spd[i]=Math.hypot(u[i],v[i]);
  }
  z[0]=0;
  for (let i=1;i<n;i++){
    const Tvm=0.5*(Tv[i]+Tv[i-1])+273.15;
    z[i]=z[i-1] + C.Rd*Tvm/C.g*Math.log(p[i-1]/p[i]);
  }
  return {n,p,T,Td,r,q,qs,Tv,z,theta:th,thetaE:the,thetaEs:thes,RH:RHa,Tw,u,v,spd,
          haveW,levels:L};
}

/* ------------------------------------------------------- static energy ---
 * Chavas and Peters (2023, BAMS), Eqs. 1-2:
 *     D = g·z + cp·T                    dry static energy
 *     M = g·z + cp·T + Lv·qv            moist static energy
 * Energies are per unit mass, in J/kg. Note that z here is geopotential height
 * above MEAN SEA LEVEL, not above ground: the potential-energy term is what it
 * is because of where the column sits, so a surface elevation must be supplied
 * for the absolute values to mean anything. (CP23's Fig. 2 sounding sits at
 * 277.4 m.) Lapse rates and vertical *differences* are unaffected by it.
 *
 * CP23 uses specific humidity qv; Chavas and Dawson (2021) Eq. 1 uses mixing
 * ratio r instead. The two differ by ~2% of the latent term. Both are returned.
 * ------------------------------------------------------------------------ */
function staticEnergy(prof, elevation){
  const zs = elevation||0, n=prof.n;
  const out={ zMSL:new Float64Array(n), PE:new Float64Array(n), SE:new Float64Array(n),
              LE:new Float64Array(n), D:new Float64Array(n), M:new Float64Array(n),
              Mstar:new Float64Array(n), Mr:new Float64Array(n), elevation:zs };
  for (let i=0;i<n;i++){
    const zm=prof.z[i]+zs;
    out.zMSL[i]=zm;
    out.PE[i]=C.g*zm;
    out.SE[i]=C.cp*(prof.T[i]+273.15);
    out.LE[i]=C.Lv*prof.q[i]/1000;
    out.D[i]=out.PE[i]+out.SE[i];
    out.M[i]=out.D[i]+out.LE[i];
    out.Mstar[i]=out.D[i]+C.Lv*prof.qs[i]/1000;      // saturation MSE
    out.Mr[i]=out.D[i]+C.Lv*prof.r[i]/1000;          // CD21 mixing-ratio form
  }
  return out;
}

/* ====================================================== 3. PARCEL THEORY */
/**
 * Lift a parcel from (p0, T0, Td0) through the profile.
 * Returns the parcel temperature at every level plus CAPE/CIN/LCL/LFC/EL.
 */
function liftParcel(prof, p0, T0, Td0, opt){
  opt=opt||{};
  const mode = opt.mode || 'pseudo';           // 'pseudo' | 'reversible' | 'dry'
  const ice  = !!opt.ice;
  const {n,p,z,Tv}=prof;
  const Tp=new Float64Array(n).fill(NaN), Tvp=new Float64Array(n).fill(NaN),
        rvp=new Float64Array(n).fill(NaN), rlp=new Float64Array(n).fill(NaN),
        B=new Float64Array(n).fill(NaN);
  const r0=mixr(Td0,p0);
  const L=lcl(T0,Td0,p0);
  // total water: conserved for reversible ascent, tracked down to rv for pseudo
  const rtArg = mode==='reversible' ? r0 : null;

  // index of the parcel's own level
  let k0=0; while (k0<n-1 && p[k0]>p0) k0++;

  let Tk=T0+273.15, sat=false;
  for (let k=k0;k<n;k++){
    const pk=p[k];
    if (k===k0){ Tk=T0+273.15; }
    else if (mode==='dry' || (!sat && pk>=L.p)){
      // dry adiabat: theta conserved, no condensation
      Tk=(T0+273.15)*Math.pow(pk/p0, C.kappa);
    } else {
      if (!sat){
        // cross the LCL in sub-steps, then continue level by level
        Tk=(T0+273.15)*Math.pow(L.p/p0, C.kappa);
        const ns=10, dl=(Math.log(pk)-Math.log(L.p))/ns;
        for (let i=0;i<ns;i++){
          const pa=Math.exp(Math.log(L.p)+i*dl), pb=Math.exp(Math.log(L.p)+(i+1)*dl);
          const a=dTdlnp(Tk,pa,rtArg,ice), b=dTdlnp(Tk+a*dl,pb,rtArg,ice);
          Tk += 0.5*(a+b)*dl;
        }
        sat=true;
      } else {
        const dl=Math.log(pk)-Math.log(p[k-1]);
        const a=dTdlnp(Tk,p[k-1],rtArg,ice), b=dTdlnp(Tk+a*dl,pk,rtArg,ice);
        Tk += 0.5*(a+b)*dl;
      }
    }
    Tp[k]=Tk-273.15;

    // partition the parcel's water
    let rv, rt;
    if (mode==='dry' || !sat){ rv=r0; rt=r0; }
    else {
      rv=mixrSat(Tp[k],pk,ice);
      if (!isFinite(rv)) rv=0;
      if (mode==='reversible'){ rt=r0; rv=Math.min(rv,r0); }
      else                    { rt=rv; }          // pseudo: condensate removed
    }
    rvp[k]=rv; rlp[k]=Math.max(0,rt-rv);
    Tvp[k]=tdens(Tp[k], rv, rt);
    B[k]=C.g*((Tvp[k]+273.15)-(Tv[k]+273.15))/(Tv[k]+273.15);
  }

  const zLCL=interp(p,z,L.p);
  // LFC: lowest level at/above the LCL with positive buoyancy
  let kL=-1;
  for (let k=k0;k<n;k++) if (z[k]>=zLCL-1 && B[k]>0){ kL=k; break; }

  let CAPE=0, CIN=0, zLFC=NaN, zEL=NaN, kE=-1, pLFC=NaN, pEL=NaN;
  if (kL>k0){
    const a=kL-1;
    zLFC = (isFinite(B[a])&&B[a]<0) ? z[a]+(z[kL]-z[a])*(-B[a])/(B[kL]-B[a]) : z[kL];
    for (let k=kL;k<n-1;k++) if (B[k]>0 && B[k+1]<=0){
      zEL=z[k]+(z[k+1]-z[k])*B[k]/(B[k]-B[k+1]); kE=k;
    }
    if (kE<0){ kE=n-1; zEL=z[n-1]; }
    for (let k=kL;k<kE;k++){
      const b0=Math.max(B[k],0), b1=Math.max(B[k+1],0);
      CAPE += 0.5*(b0+b1)*(z[k+1]-z[k]);
    }
    for (let k=k0;k<kL;k++){
      const b0=Math.min(B[k],0), b1=Math.min(B[k+1],0);
      CIN += 0.5*(b0+b1)*(z[k+1]-z[k]);
    }
    pLFC=interp(z,p,zLFC); pEL=interp(z,p,zEL);
  } else if (kL===k0){ // buoyant right off the deck
    zLFC=z[k0]; pLFC=p[k0];
    for (let k=k0;k<n-1;k++) if (B[k]>0 && B[k+1]<=0){
      zEL=z[k]+(z[k+1]-z[k])*B[k]/(B[k]-B[k+1]); kE=k;
    }
    if (kE<0){ kE=n-1; zEL=z[n-1]; }
    for (let k=k0;k<kE;k++){
      const b0=Math.max(B[k],0), b1=Math.max(B[k+1],0);
      CAPE += 0.5*(b0+b1)*(z[k+1]-z[k]);
    }
    pEL=interp(z,p,zEL);
  }
  return {Tp,Tvp,rvp,rlp,B,k0,kLFC:kL,kEL:kE,CAPE,CIN,
          zLCL,pLCL:L.p,TLCL:L.T, zLFC,pLFC, zEL,pEL,
          p0,T0,Td0,r0, mode, ice, thetaE:thetaE(T0,Td0,p0)};
}

/** Surface-based parcel. */
function sbParcel(prof, opt){ return liftParcel(prof, prof.p[0], prof.T[0], prof.Td[0], opt); }

/** Mixed-layer parcel: mass-weighted mean θ and r over the lowest `depth` hPa. */
function mlParcel(prof, depth, opt){
  depth=depth||100;
  const pTop=prof.p[0]-depth;
  let sTh=0,sR=0,sW=0;
  for (let k=0;k<prof.n-1;k++){
    if (prof.p[k]<pTop) break;
    const w=prof.p[k]-prof.p[k+1];
    sTh+=prof.theta[k]*w; sR+=prof.r[k]*w; sW+=w;
  }
  if (sW<=0) return sbParcel(prof, opt);
  const T0=sTh/sW*Math.pow(prof.p[0]/C.p00,C.kappa)-273.15;
  return liftParcel(prof, prof.p[0], T0, dewp(sR/sW, prof.p[0]), opt);
}

/** Most-unstable parcel: highest θe in the lowest `depth` hPa. */
function muParcel(prof, depth, opt){
  depth=depth||300;
  const pTop=prof.p[0]-depth;
  let best=0, bv=-Infinity;
  for (let k=0;k<prof.n;k++){
    if (prof.p[k]<pTop) break;
    if (prof.thetaE[k]>bv){ bv=prof.thetaE[k]; best=k; }
  }
  return liftParcel(prof, prof.p[best], prof.T[best], prof.Td[best], opt);
}

/** Downdraft CAPE: min-θe parcel in the lowest 400 hPa, descended saturated. */
function dcape(prof, opt){
  const ice=!!(opt&&opt.ice);
  // search 50-400 hPa above the surface: allowing the surface itself would give a
  // zero-depth descent whenever the boundary layer is the min-theta-e layer
  const pBot=prof.p[0]-50, pTop=prof.p[0]-400;
  let src=-1, bv=Infinity;
  for (let k=0;k<prof.n;k++){
    if (prof.p[k]>pBot) continue;
    if (prof.p[k]<pTop) break;
    if (prof.thetaE[k]<bv){ bv=prof.thetaE[k]; src=k; }
  }
  if (src<1) return {DCAPE:NaN, pSrc:NaN, zSrc:NaN};
  let Tk=prof.Tw[src]+273.15, D=0;
  for (let k=src;k>0;k--){
    const dl=Math.log(prof.p[k-1])-Math.log(prof.p[k]);
    const a=dTdlnp(Tk,prof.p[k],null,ice), b=dTdlnp(Tk+a*dl,prof.p[k-1],null,ice);
    const Tn=Tk+0.5*(a+b)*dl;
    const Tvp0=tvirt(Tk-273.15, mixrSat(Tk-273.15,prof.p[k],ice));
    const Tvp1=tvirt(Tn-273.15, mixrSat(Tn-273.15,prof.p[k-1],ice));
    const b0=C.g*((prof.Tv[k]+273.15)-(Tvp0+273.15))/(Tvp0+273.15);
    const b1=C.g*((prof.Tv[k-1]+273.15)-(Tvp1+273.15))/(Tvp1+273.15);
    D += 0.5*(Math.max(b0,0)+Math.max(b1,0))*(prof.z[k]-prof.z[k-1]);
    Tk=Tn;
  }
  return {DCAPE:D, pSrc:prof.p[src], zSrc:prof.z[src]};
}

/**
 * Effective inflow layer (Thompson et al. 2007): the contiguous set of levels
 * whose parcels have CAPE >= 100 J/kg and CIN >= -250 J/kg.
 */
function effectiveInflow(prof, opt){
  let base=NaN, top=NaN, inLayer=false;
  const step=Math.max(1, Math.round(prof.n/120));
  for (let k=0;k<prof.n;k+=step){
    if (prof.p[k] < prof.p[0]-450) break;
    const q=liftParcel(prof, prof.p[k], prof.T[k], prof.Td[k], opt);
    const good = q.CAPE>=100 && q.CIN>=-250;
    if (good && !inLayer){ base=prof.z[k]; inLayer=true; }
    if (!good && inLayer){ top=prof.z[k]; break; }
    if (good) top=prof.z[k];
  }
  if (!isFinite(base)) return {base:NaN, top:NaN, depth:NaN};
  return {base, top, depth: top-base};
}

/* ======================================================= 4. KINEMATICS */
function meanWind(prof, z0, z1){
  let su=0,sv=0,n=0;
  for (let k=0;k<prof.n;k++) if (prof.z[k]>=z0 && prof.z[k]<=z1){ su+=prof.u[k]; sv+=prof.v[k]; n++; }
  return n?{u:su/n,v:sv/n}:{u:prof.u[0],v:prof.v[0]};
}
function shearVec(prof, z0, z1){
  return {u: atZ(prof,'u',z1)-atZ(prof,'u',z0), v: atZ(prof,'v',z1)-atZ(prof,'v',z0)};
}
function bulkShear(prof, z0, z1){ const s=shearVec(prof,z0,z1); return Math.hypot(s.u,s.v); }

/** Bunkers et al. (2000) internal-dynamics storm motion. */
function bunkers(prof){
  const D=7.5, mw=meanWind(prof,0,6000), lo=meanWind(prof,0,500), hi=meanWind(prof,5500,6000);
  const su=hi.u-lo.u, sv=hi.v-lo.v, m=Math.hypot(su,sv)||1e-9;
  return { right:{u:mw.u+D*sv/m, v:mw.v-D*su/m},
           left :{u:mw.u-D*sv/m, v:mw.v+D*su/m}, mean:mw };
}

/** Storm-relative helicity over [z0,z1] about (cu,cv). m²/s² */
function srh(prof, z0, z1, cu, cv){
  let s=0;
  for (let k=0;k<prof.n-1;k++){
    if (prof.z[k]<z0 || prof.z[k+1]>z1) continue;
    s += (prof.u[k+1]-cu)*(prof.v[k]-cv) - (prof.u[k]-cu)*(prof.v[k+1]-cv);
  }
  return s;
}

function kinematics(prof, eil, muEL){
  const bk=bunkers(prof);
  const k={ bunkers:bk,
    shear01:bulkShear(prof,0,1000), shear03:bulkShear(prof,0,3000),
    shear06:bulkShear(prof,0,6000), shear08:bulkShear(prof,0,8000),
    srh01:srh(prof,0,1000,bk.right.u,bk.right.v),
    srh03:srh(prof,0,3000,bk.right.u,bk.right.v),
    srh01L:srh(prof,0,1000,bk.left.u,bk.left.v),
    meanWind06:meanWind(prof,0,6000) };
  // effective-layer quantities
  if (eil && isFinite(eil.base)){
    k.esrh = srh(prof, eil.base, eil.top, bk.right.u, bk.right.v);
    const half = isFinite(muEL) ? eil.base + 0.5*(muEL-eil.base) : 6000;
    k.ebwd = bulkShear(prof, eil.base, half);
  } else { k.esrh=NaN; k.ebwd=NaN; }
  return k;
}

/* ================================================== 5. COMPOSITE INDICES */
function indices(prof, P, kin, eil){
  const T850=atP(prof,'T',850), T700=atP(prof,'T',700), T500=atP(prof,'T',500);
  const D850=atP(prof,'Td',850), D700=atP(prof,'Td',700);
  const out={
    K:  (T850-T500) + D850 - (T700-D700),
    TT: (T850+D850) - 2*T500,
    lapse03: 1000*(prof.T[0]-atZ(prof,'T',3000))/3000,
    lapse75: (T700-T500)/((atP(prof,'z',500)-atP(prof,'z',700))/1000),
    PWAT: pwat(prof),
    zFreeze: crossing(prof,'T',0),
    zWBZ: crossing(prof,'Tw',0)
  };
  // SCP (Thompson et al.): MUCAPE/1000 × ESRH/50 × EBWD-term
  const eb = isFinite(kin.ebwd) ? (kin.ebwd>20?20:(kin.ebwd<10?0:kin.ebwd)) : NaN;
  out.SCP = (isFinite(eb)&&isFinite(kin.esrh))
    ? (P.mu.CAPE/1000)*(kin.esrh/50)*(eb/20) : NaN;
  // STP fixed-layer (Thompson et al. 2003)
  const lclT = P.sb.zLCL<1000 ? 1 : (P.sb.zLCL>2000 ? 0 : (2000-P.sb.zLCL)/1000);
  const shT  = kin.shear06>30 ? 1.5 : (kin.shear06<12.5 ? 0 : kin.shear06/20);
  out.STP = (P.sb.CAPE/1500)*lclT*(kin.srh01/150)*shT;
  return out;
}
function pwat(prof){
  let W=0;
  for (let k=0;k<prof.n-1;k++){
    const q0=prof.r[k]/1000/(1+prof.r[k]/1000), q1=prof.r[k+1]/1000/(1+prof.r[k+1]/1000);
    W += 0.5*(q0+q1)*(prof.p[k]-prof.p[k+1])*100/C.g;
  }
  return W;   // mm
}
/** Height of the lowest crossing of `field` through `val`. */
function crossing(prof, field, val){
  const f=prof[field];
  for (let k=0;k<prof.n-1;k++){
    if ((f[k]-val)*(f[k+1]-val)<=0 && f[k]!==f[k+1]){
      const t=(val-f[k])/(f[k+1]-f[k]);
      return prof.z[k]+t*(prof.z[k+1]-prof.z[k]);
    }
  }
  return NaN;
}

/* ============================================================ 6. DRIVER */
function analyze(levels, opts){
  opts=opts||{};
  const prof=buildProfile(levels, opts.n);
  if (!prof) return null;
  const asc={mode:opts.mode||'pseudo', ice:!!opts.ice};
  const sb=sbParcel(prof,asc), ml=mlParcel(prof,100,asc), mu=muParcel(prof,300,asc);
  const eil=effectiveInflow(prof,asc);
  const kin=kinematics(prof, eil, mu.zEL);
  const dc=dcape(prof, asc);
  const idx=indices(prof, {sb,ml,mu}, kin, eil);
  idx.DCAPE=dc.DCAPE;
  const energy=staticEnergy(prof, opts.elevation||0);
  return {prof, sb, ml, mu, eil, kin, idx, dcape:dc, energy, ascent:asc};
}

/* ============================================================ 7. EXPORT */
/** Levels back out as a plain table. */
function toText(levels){
  const L=['   PRES   TEMP   DWPT   DRCT   SKNT'];
  levels.forEach(l=>{
    let d='', s='';
    if (isFinite(l.u)&&isFinite(l.v)){
      const sp=Math.hypot(l.u,l.v);
      s=(sp/KT).toFixed(1);
      d=((270-Math.atan2(l.v,l.u)*180/Math.PI)%360+360)%360;
      d=d.toFixed(0);
    }
    L.push([l.p.toFixed(1).padStart(7), l.T.toFixed(1).padStart(7),
            l.Td.toFixed(1).padStart(7), d.padStart(7), s.padStart(7)].join(''));
  });
  return L.join('\n')+'\n';
}

/* =========================================================== 8. PRESETS */
const JORDAN=[[1015,26.3,23.8,120,8],[1000,25.3,22.8,125,10],[950,22.6,19.8,130,12],[900,19.8,16.6,135,13],
  [850,17,13.1,140,14],[800,14.5,9.6,145,14],[750,12,6.1,150,13],[700,9.4,2.6,155,12],[650,6.5,-1.5,165,11],
  [600,3.4,-5.6,175,10],[550,0,-9.8,185,9],[500,-3.9,-14.5,200,9],[450,-8.4,-20.3,215,9],[400,-13.2,-25.5,230,10],
  [350,-18.8,-32.1,245,11],[300,-25.6,-39.6,255,13],[250,-33.9,-47.5,265,15],[200,-43.9,-57.6,270,17],
  [150,-56.9,-70.1,275,16],[100,-73.5,-81.8,280,12],[70,-68,-85.2,285,9],[50,-60,-87.2,290,7]];

const WK=[[1000,26.9,19,180,8],[950,23.2,18.2,190,11],[900,19.6,17.4,200,14],[850,16.1,15.2,210,17],
  [800,12.4,11.2,220,20],[750,8.6,7.1,230,23],[700,4.7,2.7,240,26],[650,0.6,-1.9,245,29],[600,-3.7,-6.7,250,32],
  [550,-8.3,-11.9,255,35],[500,-13.2,-17.4,258,38],[450,-18.5,-23.4,260,41],[400,-24.4,-30,262,44],
  [350,-30.8,-37.4,264,47],[300,-38.1,-45.7,265,50],[250,-46.5,-55.4,266,52],[200,-56.1,-66.7,267,50],
  [150,-55.7,-66.4,268,44],[100,-55.1,-65.9,270,36],[70,-54.6,-65.4,270,28],[50,-54,-64.9,270,22]];

// Strongly sheared, high-CAPE plains environment with an elevated mixed layer cap.
const SUPERCELL=[[970,31,22,160,15],[950,29.4,21.6,170,20],[925,27.4,21,175,24],[900,25.6,20.4,180,27],
  [850,24.5,14,190,31],[800,20.6,9,200,35],[750,16.6,5,210,39],[700,12.6,1,220,43],[650,8,-3.5,230,47],
  [600,3.2,-8.5,240,50],[550,-1.8,-14,245,53],[500,-7.2,-20,250,56],[450,-13.2,-26.5,253,58],
  [400,-19.8,-33.5,255,60],[350,-27.2,-41,257,61],[300,-35.6,-49,259,60],[250,-45,-58,260,56],
  [200,-55.6,-68,261,48],[150,-58,-71,262,38],[100,-57,-70,263,28],[70,-56,-69,264,20],[50,-55,-68,265,15]];

// Weak shear, deep moisture, small CIN — a pulse/multicell "popcorn" day.
const PULSE=[[1008,30,24,200,6],[1000,29.4,23.8,200,7],[950,26,22,205,8],[900,22.6,20.2,210,9],
  [850,19.4,18,215,9],[800,16,14.6,220,9],[750,12.6,11,225,9],[700,9.2,7.4,230,9],[650,5.4,3,235,9],
  [600,1.4,-1.6,240,9],[550,-2.8,-6.6,245,9],[500,-7.4,-12,250,9],[450,-12.6,-18,252,9],[400,-18.6,-25,254,10],
  [350,-25.4,-33,256,10],[300,-33.4,-42,258,11],[250,-42.8,-52,260,12],[200,-53.6,-63,262,12],
  [150,-59,-69,264,11],[100,-60,-70,266,9],[70,-58,-69,268,7],[50,-56,-68,270,6]];

// Deep, dry, well-mixed boundary layer over the high plains — an inverted-V.
const INVERTEDV=[[845,35.0,3.0,200,10],[800,30.1,-2.4,208,13],[750,24.7,-3.3,216,16],[700,18.8,-4.2,222,19],[650,12.8,-5.2,228,21],[600,6.3,-6.3,234,24],[550,-0.5,-19.7,238,26],[500,-5.9,-24.2,242,28],[450,-11.8,-29.2,246,30],[400,-18.2,-34.8,250,32],[350,-25.3,-40.9,253,33],[300,-33.2,-47.7,256,35],[250,-42.3,-55.6,259,35],[200,-52.8,-64.8,261,33],[150,-55.1,-72.3,263,30],[100,-51.2,-69.1,265,22],[70,-47.7,-66.3,266,20],[50,-44.3,-63.5,266,20]];

// Cold-season, strongly sheared, low-CAPE/high-shear ("high shear low CAPE").
const HSLC=[[1006,15.5,14.2,150,22],[1000,15.1,14.0,152,23],[950,12.5,11.4,162,29],[900,9.7,8.6,174,35],[850,6.8,0.9,183,39],[800,3.6,-2.1,193,43],[750,0.3,-5.3,203,47],[700,-3.2,-8.7,215,52],[650,-6.9,-12.2,219,55],[600,-10.8,-16.0,224,58],[550,-15.0,-20.0,229,62],[500,-19.6,-24.3,235,66],[450,-24.6,-29.1,239,69],[400,-29.9,-34.2,243,72],[350,-35.9,-39.9,246,76],[300,-42.4,-48.7,250,79],[250,-49.0,-55.0,253,77],[200,-54.8,-69.3,256,74],[150,-52.6,-67.4,259,60],[100,-49.4,-64.7,262,40],[70,-46.6,-62.3,262,40],[50,-43.9,-60.1,262,40]];

function mk(rows){
  return rows.map(a=>{
    const [p,T,Td,d,s]=a, sp=s*KT;
    return {p, T, Td, u:-sp*Math.sin(d*Math.PI/180), v:-sp*Math.cos(d*Math.PI/180)};
  });
}
const PRESETS={
  'Classic supercell (plains, EML cap)': mk(SUPERCELL),
  'Weisman–Klemp (1982) analytic':       mk(WK),
  'Pulse / weak-shear summer day':       mk(PULSE),
  'High shear, low CAPE (cold season)':  mk(HSLC),
  'Inverted-V (high plains, dry)':       mk(INVERTEDV),
  'Jordan (1958) mean tropical':         mk(JORDAN)
};

/* ---------------------------------------------------------------------- */
return {
  C, KT, PRESETS,
  esat, esatIce, esatMix, iceFrac, Lheat, mixrSat, mixr, dewp, rh, tvirt, tdens,
  theta, thetaE, wetbulb, lcl, dTdlnp, ICE,
  interp, atZ, atP, crossing, pwat,
  parseText, parseTabular, parseCM1, buildProfile,
  staticEnergy,
  liftParcel, sbParcel, mlParcel, muParcel, dcape, effectiveInflow,
  meanWind, shearVec, bulkShear, bunkers, srh, kinematics, indices,
  analyze, toText
};
}));

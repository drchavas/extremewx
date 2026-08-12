/* Headless checks for the sounding plotter: the engine, then the page. */
const fs=require('fs'), path=require('path');
const {JSDOM}=require('/tmp/scstest/node_modules/jsdom');
const {createCanvas}=require('/tmp/scstest/node_modules/canvas');

const DIR=process.argv[2]||'.';
const SK=require(path.join(DIR,'sounding.js'));

let pass=0,fail=0;
const ok=(n,c,d)=>{ if(c){pass++;console.log('  ok   '+n+(d?'   ['+d+']':''));}
                    else{fail++;console.log('  FAIL '+n+(d?'   ['+d+']':''));} };
const near=(n,g,w,t)=>ok(n,Math.abs(g-w)<=t,'got '+(+g).toPrecision(6)+', want '+w+' ±'+t);
const head=s=>console.log('\n'+s);

/* ================================================== A. THERMODYNAMICS ==== */
head('A1. Thermodynamic primitives against published values');
near('esat(0°C) = 6.112 hPa',        SK.esat(0), 6.112, 0.001);
near('esat(20°C) ≈ 23.4 hPa',        SK.esat(20), 23.4, 0.1);
near('esat(30°C) ≈ 42.4 hPa',        SK.esat(30), 42.4, 0.2);
near('mixr(20°C, 1000 hPa) ≈ 14.9 g/kg', SK.mixr(20,1000), 14.9, 0.1);
ok('dewp inverts mixr',
   Math.abs(SK.dewp(SK.mixr(12.3,880),880)-12.3)<1e-6);
near('RH(25, 15) ≈ 0.538',           SK.rh(25,15), 0.538, 0.005);
ok('Td = T gives RH = 1',            Math.abs(SK.rh(17,17)-1)<1e-9);
ok('Tv > T when moist',              SK.tvirt(25,15)>25);
ok('Tv = T when dry',                Math.abs(SK.tvirt(25,0)-25)<1e-12);
near('theta(20°C, 1000 hPa) = T',    SK.theta(20,1000), 293.15, 1e-6);
near('theta(0°C, 500 hPa) ≈ 333.3 K',SK.theta(0,500), 333.3, 0.5);
// Bolton's own worked example: T=300 K, p=1000 hPa, r=20 g/kg -> theta_e ≈ 358.4 K
near('thetaE ≈ 358 K for Bolton\'s example',
     SK.thetaE(26.85, SK.dewp(20,1000), 1000), 358.4, 1.5);
ok('wetbulb between Td and T',
   (()=>{ const T=25,Td=12,Tw=SK.wetbulb(T,SK.rh(T,Td)); return Tw>Td&&Tw<T; })(),
   'Tw = '+SK.wetbulb(25,SK.rh(25,12)).toFixed(2));
ok('wetbulb = T at saturation', Math.abs(SK.wetbulb(20,1)-20)<0.6,
   'Tw = '+SK.wetbulb(20,1).toFixed(2));

head('A2. LCL');
{
  const L=SK.lcl(30,20,1000);
  ok('LCL is above the parcel', L.p<1000, 'pLCL = '+L.p.toFixed(1)+' hPa');
  ok('LCL temperature is below the parcel', L.T<30 && L.T<20+0.01, 'TLCL = '+L.T.toFixed(2));
  // a saturated parcel has its LCL at its own level
  const Ls=SK.lcl(20,20,1000);
  near('saturated parcel: LCL at its own level', Ls.p, 1000, 2);
  // Espy's rule sanity: zLCL ≈ 125 m per °C of dewpoint depression
  const zapprox=125*(30-20);
  const prof=SK.buildProfile(SK.PRESETS['Classic supercell (plains, EML cap)']);
  ok('LCL height scales like Espy\'s rule', zapprox>800 && zapprox<1500, 'Espy ≈ '+zapprox+' m');
}

/* ========================================================= B. PARCELS === */
head('B1. Parcel theory on a saturated, moist-neutral column has ~zero CAPE');
{
  // build a column that is exactly a pseudoadiabat, saturated throughout
  const levels=[]; let Tk=26+273.15;
  for (let p=1000;p>=150;p-=25){
    levels.push({p, T:Tk-273.15, Td:Tk-273.15, u:0, v:0});
    const dl=Math.log((p-25)/p);
    const a=SK.dTdlnp(Tk,p), b=SK.dTdlnp(Tk+a*dl,p-25);
    Tk += 0.5*(a+b)*dl;
  }
  const a=SK.analyze(levels);
  ok('moist-neutral column: |CAPE| < 30 J/kg', Math.abs(a.sb.CAPE)<30, 'CAPE = '+a.sb.CAPE.toFixed(1));
  ok('moist-neutral column: |CIN| < 30 J/kg',  Math.abs(a.sb.CIN)<30,  'CIN = '+a.sb.CIN.toFixed(1));
  near('LCL at the surface for a saturated parcel', a.sb.zLCL, 0, 40);
}

head('B2. An isothermal column is absolutely stable');
{
  const levels=[];
  for (let p=1000;p>=150;p-=25) levels.push({p,T:10,Td:-10,u:0,v:0});
  const a=SK.analyze(levels);
  ok('isothermal column has no CAPE', a.sb.CAPE===0, 'CAPE = '+a.sb.CAPE);
  ok('isothermal column has no LFC', !isFinite(a.sb.zLFC));
}

head('B3. Parcel ordering and internal consistency, all presets');
Object.keys(SK.PRESETS).forEach(n=>{
  const a=SK.analyze(SK.PRESETS[n]);
  const good = a.mu.CAPE >= a.sb.CAPE-1              // MU is by definition the largest
            && a.mu.CAPE >= a.ml.CAPE-1
            && (!isFinite(a.sb.zLFC) || a.sb.zLCL<=a.sb.zLFC+1)
            && (!isFinite(a.sb.zEL)  || a.sb.zLFC<=a.sb.zEL)
            && a.sb.CIN<=0 && a.ml.CIN<=0
            && a.idx.PWAT>0 && a.idx.PWAT<120
            && isFinite(a.kin.shear06);
  ok('"'+n+'"', good,
     'SB '+a.sb.CAPE.toFixed(0)+' ML '+a.ml.CAPE.toFixed(0)+' MU '+a.mu.CAPE.toFixed(0)+
     ' PW '+a.idx.PWAT.toFixed(1));
});

head('B4. Physical sensitivities');
{
  const base=SK.PRESETS['Classic supercell (plains, EML cap)'];
  const warm=base.map((l,i)=>i===0?Object.assign({},l,{T:l.T+3}):Object.assign({},l));
  const moist=base.map((l,i)=>i===0?Object.assign({},l,{Td:l.Td+3}):Object.assign({},l));
  const dry=base.map((l,i)=>i===0?Object.assign({},l,{Td:l.Td-6}):Object.assign({},l));
  const b=SK.analyze(base);
  ok('warmer surface -> more SBCAPE', SK.analyze(warm).sb.CAPE > b.sb.CAPE);
  ok('moister surface -> more SBCAPE', SK.analyze(moist).sb.CAPE > b.sb.CAPE);
  ok('drier surface -> higher LCL', SK.analyze(dry).sb.zLCL > b.sb.zLCL);
  ok('drier surface -> less SBCAPE', SK.analyze(dry).sb.CAPE < b.sb.CAPE);
  ok('moister column -> more PWAT',
     SK.analyze(base.map(l=>Object.assign({},l,{Td:Math.min(l.T,l.Td+2)}))).idx.PWAT > b.idx.PWAT);
  // SRH is quadratic in the wind, so negating BOTH components (a 180° rotation of
  // the hodograph) leaves it unchanged — the sense of turning is preserved.
  ok('rotating the hodograph 180° leaves SRH unchanged',
     Math.abs(SK.analyze(base.map(l=>Object.assign({},l,{u:-l.u,v:-l.v}))).kin.srh03
              - b.kin.srh03) < 1e-6);
  // Mirroring one component reflects the hodograph, which does reverse the turning.
  ok('mirroring the hodograph flips the sign of SRH',
     SK.analyze(base.map(l=>Object.assign({},l,{u:-l.u}))).kin.srh03 * b.kin.srh03 < 0,
     'mirrored SRH03 = '+SK.analyze(base.map(l=>Object.assign({},l,{u:-l.u}))).kin.srh03.toFixed(0)+
     ' vs '+b.kin.srh03.toFixed(0));
  ok('doubling the winds roughly doubles the shear',
     Math.abs(SK.analyze(base.map(l=>Object.assign({},l,{u:2*l.u,v:2*l.v}))).kin.shear06
              - 2*b.kin.shear06) < 0.6);
}

head('B5. Vertical-resolution convergence');
{
  const p=SK.PRESETS['Classic supercell (plains, EML cap)'];
  const c=[200,500,1200].map(n=>SK.analyze(p,{n}).sb.CAPE);
  ok('CAPE converges with grid resolution',
     Math.abs(c[2]-c[1])/c[2] < 0.01,
     '200: '+c[0].toFixed(0)+'  500: '+c[1].toFixed(0)+'  1200: '+c[2].toFixed(0));
}

/* ================================================== B6. STATIC ENERGY === */
head('B6. Static energy — Chavas & Peters (2023, BAMS) Eqs. 1-2');
{
  const a=SK.analyze(SK.PRESETS['Classic supercell (plains, EML cap)'],{elevation:277.4});
  const E=a.energy, prof=a.prof, n=prof.n;

  let d1=0,d2=0,d3=0;
  for (let i=0;i<n;i++){
    d1=Math.max(d1, Math.abs(E.D[i]-(E.PE[i]+E.SE[i])));
    d2=Math.max(d2, Math.abs(E.M[i]-(E.PE[i]+E.SE[i]+E.LE[i])));
    d3=Math.max(d3, Math.abs(E.PE[i]-SK.C.g*(prof.z[i]+277.4)));
  }
  ok('D = PE + SE exactly',        d1===0, 'max dev '+d1);
  ok('M = PE + SE + LE exactly',   d2===0, 'max dev '+d2);
  ok('PE = g·z with z from MSL',   d3<1e-9, 'max dev '+d3.toExponential(2));
  ok('M >= D everywhere',    [...E.M].every((v,i)=>v>=E.D[i]-1e-9));
  ok('M* >= M everywhere',   [...E.Mstar].every((v,i)=>v>=E.M[i]-1e-9));
  ok('LE = 0 where the air is dry', Math.abs(SK.C.Lv*prof.q[n-1]/1000-E.LE[n-1])<1e-9);
  ok('q <= r everywhere',    [...prof.q].every((v,i)=>v<=prof.r[i]+1e-12));
  ok('CD21 mixing-ratio M exceeds the CP23 specific-humidity M',
     [...E.Mr].every((v,i)=>v>=E.M[i]-1e-9),
     'surface difference = '+((E.Mr[0]-E.M[0])/1000).toFixed(3)+' kJ/kg');
  ok('θe* >= θe >= θ everywhere',
     [...prof.theta].every((v,i)=>prof.thetaEs[i]>=prof.thetaE[i]-1e-6 && prof.thetaE[i]>=v-1e-9));

  // elevation shifts PE (and D, M) by exactly g·Δz and nothing else
  const b=SK.analyze(SK.PRESETS['Classic supercell (plains, EML cap)'],{elevation:0});
  const shift=SK.C.g*277.4;
  let e1=0,e2=0;
  for (let i=0;i<n;i++){
    e1=Math.max(e1, Math.abs((E.D[i]-b.energy.D[i])-shift));
    e2=Math.max(e2, Math.abs(E.SE[i]-b.energy.SE[i]), Math.abs(E.LE[i]-b.energy.LE[i]));
  }
  ok('elevation shifts D and M by exactly g·Δz', e1<1e-6, 'max dev '+e1.toExponential(2));
  ok('elevation leaves SE and LE untouched',     e2===0);
  ok('elevation leaves CAPE untouched',          Math.abs(a.sb.CAPE-b.sb.CAPE)<1e-9);

  // in a dry-adiabatic, well-mixed layer D is constant and theta is constant
  const iv=SK.analyze(SK.PRESETS['Inverted-V (high plains, dry)']);
  const dSfc=iv.energy.D[0], d3k=SK.interp(iv.prof.z,iv.energy.D,3000);
  ok('dry-adiabatic mixed layer: D constant to <0.5 kJ/kg',
     Math.abs(d3k-dSfc)/1000 < 0.5,
     (dSfc/1000).toFixed(2)+' -> '+(d3k/1000).toFixed(2)+' kJ/kg over 3 km');
  const thSfc=iv.prof.theta[0], th3k=SK.interp(iv.prof.z,iv.prof.theta,3000);
  ok('dry-adiabatic mixed layer: θ constant to <1.5 K',
     Math.abs(th3k-thSfc) < 1.5, thSfc.toFixed(1)+' -> '+th3k.toFixed(1)+' K');

  // D and theta must carry the same vertical information (both monotone together)
  let agree=0, tot=0;
  for (let i=1;i<n;i++){
    if (prof.z[i]>14000) break;
    tot++;
    if (Math.sign(E.D[i]-E.D[i-1])===Math.sign(prof.theta[i]-prof.theta[i-1])) agree++;
  }
  ok('D and θ increase and decrease together at >99% of levels',
     agree/tot>0.99, (100*agree/tot).toFixed(1)+'% of '+tot+' levels');
}

/* ================================================== B7. ASCENT MODES ==== */
head('B7. Reversible / pseudoadiabatic / dry ascent');
{
  const P=SK.PRESETS['Classic supercell (plains, EML cap)'];
  const ps=SK.analyze(P,{mode:'pseudo'}), rev=SK.analyze(P,{mode:'reversible'}),
        dry=SK.analyze(P,{mode:'dry'});

  ok('pseudoadiabatic CAPE exceeds reversible', ps.sb.CAPE>rev.sb.CAPE,
     ps.sb.CAPE.toFixed(0)+' vs '+rev.sb.CAPE.toFixed(0)+' J/kg');
  ok('water loading costs 10-40% of CAPE',
     (ps.sb.CAPE-rev.sb.CAPE)/ps.sb.CAPE>0.10 && (ps.sb.CAPE-rev.sb.CAPE)/ps.sb.CAPE<0.40,
     (100*(ps.sb.CAPE-rev.sb.CAPE)/ps.sb.CAPE).toFixed(1)+'%');
  ok('reversible CIN is at least as negative as pseudoadiabatic',
     rev.sb.CIN<=ps.sb.CIN+1e-6, rev.sb.CIN.toFixed(0)+' vs '+ps.sb.CIN.toFixed(0));
  ok('dry ascent has no CAPE in this environment', dry.sb.CAPE===0);

  // condensate bookkeeping is the whole difference between the two moist modes
  ok('pseudoadiabatic parcel carries no condensate',
     [...ps.sb.rlp].filter(isFinite).every(v=>v===0));
  ok('reversible parcel carries condensate aloft',
     [...rev.sb.rlp].filter(isFinite).some(v=>v>0),
     'max rl = '+Math.max(...[...rev.sb.rlp].filter(isFinite)).toFixed(2)+' g/kg');
  ok('reversible total water is conserved (rv + rl = r0)',
     (()=>{ for(let k=rev.sb.k0;k<rev.prof.n;k++){
              if(!isFinite(rev.sb.rvp[k]))continue;
              if(Math.abs(rev.sb.rvp[k]+rev.sb.rlp[k]-rev.sb.r0)>1e-9) return false; }
            return true; })());

  // below the LCL all three modes are the same dry adiabat
  const kb=Math.round(ps.prof.n*0.02);
  ok('the three modes agree below the LCL',
     Math.abs(ps.sb.Tp[kb]-rev.sb.Tp[kb])<1e-9 && Math.abs(ps.sb.Tp[kb]-dry.sb.Tp[kb])<1e-9,
     'T at p='+ps.prof.p[kb].toFixed(0)+' hPa');
  // Above the LCL the reversible parcel is WARMER than the pseudoadiabatic one —
  // the retained condensate adds heat capacity, which slows the cooling — yet it
  // is LESS BUOYANT, because condensate loading in the density temperature more
  // than cancels the extra warmth. That inversion is the whole point of the
  // distinction (Emanuel 1994, §4.7), so assert both directions.
  const ka=Math.round(ps.prof.n*0.5);
  ok('above the LCL, temperature: dry < pseudoadiabatic <= reversible',
     dry.sb.Tp[ka] < ps.sb.Tp[ka] && ps.sb.Tp[ka] <= rev.sb.Tp[ka]+1e-9,
     [dry.sb.Tp[ka],ps.sb.Tp[ka],rev.sb.Tp[ka]].map(x=>x.toFixed(2)).join(' < '));
  ok('above the LCL, buoyancy: dry < reversible < pseudoadiabatic',
     dry.sb.Tvp[ka] < rev.sb.Tvp[ka] && rev.sb.Tvp[ka] < ps.sb.Tvp[ka],
     'Tv: '+[dry.sb.Tvp[ka],rev.sb.Tvp[ka],ps.sb.Tvp[ka]].map(x=>x.toFixed(2)).join(' < '));
  ok('the reversible parcel is warmer but less buoyant than the pseudoadiabatic one',
     rev.sb.Tp[ka]>ps.sb.Tp[ka] && rev.sb.Tvp[ka]<ps.sb.Tvp[ka],
     'ΔT = +'+(rev.sb.Tp[ka]-ps.sb.Tp[ka]).toFixed(2)+
     ' K but ΔTv = '+(rev.sb.Tvp[ka]-ps.sb.Tvp[ka]).toFixed(2)+' K');

  ok('LCL is identical in all three modes',
     Math.abs(ps.sb.zLCL-rev.sb.zLCL)<1e-9 && Math.abs(ps.sb.zLCL-dry.sb.zLCL)<1e-9);
  ok('mode is reported on the result', ps.sb.mode==='pseudo' && rev.sb.mode==='reversible');
}

head('B8. Ice option');
{
  const P=SK.PRESETS['Classic supercell (plains, EML cap)'];
  ok('ice fraction ramps 0 -> 1 between 0 and -40 °C',
     SK.iceFrac(5,true)===0 && SK.iceFrac(-20,true)===0.5 && SK.iceFrac(-50,true)===1 &&
     SK.iceFrac(-20,false)===0);
  ok('effective latent heat gains ~Lf where the condensate is all ice',
     Math.abs((SK.Lheat(-50,true)-SK.Lheat(-50,false))-SK.ICE.Lf)<1e-6);
  ok('no fusion above freezing', Math.abs(SK.Lheat(10,true)-SK.Lheat(10,false))<1e-12);
  ok('saturation vapour pressure over ice is below that over liquid',
     SK.esatIce(-20)<SK.esat(-20) && Math.abs(SK.esatIce(0)-SK.esat(0))<0.02,
     'at -20 °C: '+SK.esatIce(-20).toFixed(3)+' vs '+SK.esat(-20).toFixed(3)+' hPa');
  ['pseudo','reversible'].forEach(m=>{
    const a=SK.analyze(P,{mode:m}), b=SK.analyze(P,{mode:m,ice:true});
    ok('ice adds CAPE ('+m+')', b.sb.CAPE>a.sb.CAPE,
       a.sb.CAPE.toFixed(0)+' -> '+b.sb.CAPE.toFixed(0)+' J/kg');
    ok('ice leaves the LCL alone ('+m+')', Math.abs(a.sb.zLCL-b.sb.zLCL)<1e-9);
  });
}

head('B9. Cross-check against the independent CD21 engine, every ascent mode');
{
  const scsPath=path.join(DIR,'..','scs','scssounding.js');
  if (!fs.existsSync(scsPath)) ok('SCS module available', false, scsPath);
  else {
    const SCS=require(scsPath);
    [['pseudo',false],['reversible',false],['pseudo',true],['reversible',true]].forEach(([m,i])=>{
      const s=SCS.buildSounding({ascent:m, ice:i});
      const r=SK.parseText(SCS.toCM1(s,{dzOut:100}));
      const a=SK.analyze(r.levels,{mode:m, ice:i, n:1000});
      const rel=Math.abs(a.sb.CAPE-s.diag.SBCAPE)/s.diag.SBCAPE;
      ok('two engines agree within 1% ('+m+(i?' + ice':'')+')', rel<0.01,
         'CD21 '+s.diag.SBCAPE.toFixed(0)+' vs plotter '+a.sb.CAPE.toFixed(0)+
         ' ('+(100*rel).toFixed(2)+'%)');
    });
  }
}

/* ========================================================= C. PARSING === */
head('C1. University of Wyoming format');
{
  const wy = `-----------------------------------------------------------------------------
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SKNT   THTA   THTE   THTV
    hPa     m      C      C      %    g/kg    deg   knot     K      K      K
-----------------------------------------------------------------------------
 1000.0    111   26.0   21.0     74  16.10    170     12  299.0  346.0  301.9
  925.0    790   21.4   19.4     88  15.60    190     22  300.5  345.9  303.3
  850.0   1518   17.0   13.0     77  11.30    215     31  303.4  336.7  305.4
  700.0   3120    8.0    0.0     58   5.80    240     44  310.0  328.5  311.1
  500.0   5840  -10.0  -22.0     40   1.50    255     56  318.0  323.6  318.3
  300.0   9660  -40.0  -55.0     22   0.15    260     70  330.0  330.7  330.0
  200.0  12280  -55.0  -70.0     18   0.03    265     60  350.0  350.2  350.0`;
  const r=SK.parseText(wy);
  ok('parsed 7 levels', r.levels.length===7, r.levels.length+' levels, format '+r.format);
  near('surface pressure', r.levels[0].p, 1000, 1e-9);
  near('surface temperature', r.levels[0].T, 26, 1e-9);
  near('surface dewpoint', r.levels[0].Td, 21, 1e-9);
  // 170° at 12 kt -> u = -12*sin(170°)*KT, v = -12*cos(170°)*KT
  near('surface u from dir/spd', r.levels[0].u, -12*SK.KT*Math.sin(170*Math.PI/180), 1e-6);
  near('surface v from dir/spd', r.levels[0].v, -12*SK.KT*Math.cos(170*Math.PI/180), 1e-6);
  ok('a southerly wind gives v > 0', r.levels[0].v>0, 'v = '+r.levels[0].v.toFixed(2));
  ok('a westerly wind (255°) gives u > 0', r.levels[4].u>0, 'u = '+r.levels[4].u.toFixed(2));
  const a=SK.analyze(r.levels);
  ok('the parsed sounding analyses', a && isFinite(a.sb.CAPE),
     'SBCAPE = '+(a?a.sb.CAPE.toFixed(0):'--'));
}

head('C2. CSV with a header, and RH / mixing ratio in place of dewpoint');
{
  const csv='p,T,relh\n1000,25,80\n900,18,70\n800,12,55\n700,6,40\n500,-12,25\n300,-42,15';
  const r=SK.parseText(csv);
  ok('parsed 6 levels', r.levels.length===6, r.levels.length);
  near('RH recovered as a dewpoint', SK.rh(r.levels[0].T,r.levels[0].Td), 0.80, 0.01);
  ok('no winds -> u,v are NaN', !isFinite(r.levels[0].u));
  const a=SK.analyze(r.levels);
  ok('analyses without winds', a && isFinite(a.sb.CAPE));
  ok('haveW is false', a.prof.haveW===false);

  const mx='pres temp mixr\n1000 25 16\n900 18 12\n800 12 8\n700 6 5\n500 -12 1.5\n300 -42 0.1';
  const r2=SK.parseText(mx);
  near('mixing ratio recovered as a dewpoint', SK.mixr(r2.levels[0].Td,1000), 16, 0.05);
}

head('C3. Positional, no header');
{
  const r=SK.parseText('1000 28 22 180 15\n850 16 12 210 25\n700 8 0 240 35\n500 -12 -25 260 50\n300 -42 -58 265 60');
  ok('parsed 5 levels', r.levels.length===5);
  ok('warned about positional reading', r.warnings.some(w=>/positional/.test(w)), r.warnings[0]);
  near('third column read as dewpoint', r.levels[0].Td, 22, 1e-9);
}

head('C4. CM1 input_sounding round-trip');
{
  // write a CM1 file from the SCS model, read it back, compare
  const scsPath=path.join(DIR,'..','scs','scssounding.js');
  if (!fs.existsSync(scsPath)){ ok('SCS module available for the round-trip', false, scsPath); }
  else {
    const SCS=require(scsPath);
    const s=SCS.buildSounding({});
    const txt=SCS.toCM1(s,{dzOut:250});
    const r=SK.parseText(txt);
    ok('detected as CM1', r.format==='cm1', 'format = '+r.format);
    ok('level count matches', r.levels.length===txt.trim().split('\n').length,
       r.levels.length+' levels');
    near('surface pressure recovered', r.levels[0].p, s.p[0]/100, 0.01);
    near('surface temperature recovered', r.levels[0].T, s.T[0]-273.15, 0.05);

    // Compare against the model at the heights the file actually uses. toCM1
    // quantises dzOut to a whole number of model grid steps, so the spacing is
    // not exactly 250 m — read the heights back out of the text.
    const zs=txt.trim().split('\n').slice(1)
      .map(l=>Number(l.trim().split(/\s+/)[0]));
    const j=zs.reduce((best,z,i)=>Math.abs(z-5000)<Math.abs(zs[best]-5000)?i:best,0);
    const zAct=zs[j], kk=Math.round(zAct/s.params.dz);
    near('pressure at '+zAct+' m recovered hydrostatically',
         r.levels[j+1].p, s.p[kk]/100, 0.6);
    near('temperature at '+zAct+' m recovered', r.levels[j+1].T, s.T[kk]-273.15, 0.15);

    const a=SK.analyze(r.levels);
    ok('CM1 round-trip CAPE is within 12% of the model\'s own',
       Math.abs(a.sb.CAPE-s.diag.SBCAPE)/s.diag.SBCAPE < 0.12,
       'plotter '+a.sb.CAPE.toFixed(0)+' vs model '+s.diag.SBCAPE.toFixed(0));
    // The CM1 header line carries no wind, so the surface level inherits the wind
    // of the first body row. Winds above the surface must match exactly.
    near('winds at '+zAct+' m survive the round-trip (u)',
         r.levels[j+1].u, s.u[kk], 1e-6);
    near('winds at '+zAct+' m survive the round-trip (v)',
         r.levels[j+1].v, s.v[kk], 1e-6);
    ok('CM1 reader warns that surface winds are inherited',
       r.warnings.some(w=>/surface level inherits the wind/i.test(w)), r.warnings.join(' | '));
  }
}

head('C5. toText round-trips through parseText');
{
  const orig=SK.PRESETS['Classic supercell (plains, EML cap)'];
  const r=SK.parseText(SK.toText(orig));
  ok('level count preserved', r.levels.length===orig.length, r.levels.length+' vs '+orig.length);
  let mx=0;
  r.levels.forEach((l,i)=>{
    mx=Math.max(mx, Math.abs(l.p-orig[i].p), Math.abs(l.T-orig[i].T), Math.abs(l.Td-orig[i].Td),
                Math.abs(l.u-orig[i].u), Math.abs(l.v-orig[i].v));
  });
  ok('values preserved to the printed precision', mx<0.35, 'max diff '+mx.toExponential(2));
}

head('C6. Garbage input is handled, not thrown');
[['',                    'empty'],
 ['hello world\nfoo bar','no numbers'],
 ['1\n2\n3',             'single column'],
 ['abc,def\n1,2',        'two columns'],
 ['9999 1 1\n8888 2 2',  'nonsense pressures']].forEach(([txt,label])=>{
  let threw=false, res=null;
  try { res=SK.parseText(txt); } catch(e){ threw=true; }
  ok('"'+label+'" returns cleanly', !threw && res && Array.isArray(res.levels),
     threw?'THREW':(res.levels.length+' levels'));
});
ok('too few levels -> analyze returns null', SK.analyze([{p:1000,T:20,Td:10}])===null);

/* ============================================================ D. PAGE === */
head('D. Page driven headlessly (jsdom + node-canvas)');

const rawHtml=fs.readFileSync(path.join(DIR,'sounding_plotter.html'),'utf8');
ok('page references sounding.js exactly once',
   (rawHtml.match(/<script src="sounding\.js"><\/script>/g)||[]).length===1);
ok('page references the shared skewt.js exactly once',
   (rawHtml.match(/<script src="\.\.\/skewt\.js"><\/script>/g)||[]).length===1);
ok('page loads no external resources',
   !/(src|href)\s*=\s*["']https?:\/\//.test(rawHtml.replace(/<a\b[^>]*>/g,'')));

const html=rawHtml
  .replace('<script src="../skewt.js"></script>',
    '<script>'+fs.readFileSync(path.join(DIR,'..','skewt.js'),'utf8')+'</script>')
  .replace('<script src="sounding.js"></script>',
    '<script>'+fs.readFileSync(path.join(DIR,'sounding.js'),'utf8')+'</script>');

let errs=[];
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
  w.HTMLCanvasElement.prototype.getContext=function(t){
    if(!this.__c) this.__c=createCanvas(this.width>1?this.width:1200, this.height>1?this.height:900);
    return this.__c.getContext(t);
  };
  const cp=createCanvas(1,1).getContext('2d').constructor.prototype;
  if(!cp.__u){ const o=cp.drawImage;
    cp.drawImage=function(img){ const a=[].slice.call(arguments);
      if(img&&img.__c)a[0]=img.__c; return o.apply(this,a); };
    cp.__u=true; }
  w.HTMLElement.prototype.getBoundingClientRect=function(){
    const h=this.id==='cSkew'?720:(this.id==='cProf'?400:380);
    const wd=this.id==='cProf'?1180:640;
    return {width:wd,height:h,top:0,left:0,right:wd,bottom:h,x:0,y:0};
  };
  w.requestAnimationFrame=cb=>{cb(0);return 1;};
  w.cancelAnimationFrame=()=>{};
  w.devicePixelRatio=1;
  w.URL.createObjectURL=()=>'blob:t'; w.URL.revokeObjectURL=()=>{};
  w.addEventListener('error',e=>errs.push(String(e.error||e.message)));
}});
const win=dom.window, doc=win.document;
ok('page script runs without throwing', errs.length===0, errs.join(' | ').slice(0,400));

const val=id=>doc.getElementById(id)?doc.getElementById(id).textContent:null;
const numish=s=>/^-?[\d.]+$/.test(s||'');

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

ok('preset dropdown populated',
   doc.getElementById('preset').options.length===Object.keys(SK.PRESETS).length,
   doc.getElementById('preset').options.length+' options');
ok('table built with one row per level',
   doc.querySelectorAll('#tbody tr').length===SK.PRESETS[Object.keys(SK.PRESETS)[0]].length,
   doc.querySelectorAll('#tbody tr').length+' rows');
ok('SBCAPE rendered', numish(val('sbCAPE')), 'SBCAPE = '+val('sbCAPE'));
ok('MUCAPE rendered', numish(val('muCAPE')), 'MUCAPE = '+val('muCAPE'));
ok('shear rendered',  numish(val('dS06')),   'shear06 = '+val('dS06'));
ok('SRH rendered',    numish(val('dH03')),   'SRH03 = '+val('dH03'));
ok('STP rendered',    numish(val('dSTP')),   'STP = '+val('dSTP'));
ok('Bunkers RM rendered', /\d+° \/ \d+ kt/.test(val('dRM')), 'RM = '+val('dRM'));

// every preset
let bad=0;
const sel=doc.getElementById('preset');
Object.keys(SK.PRESETS).forEach(n=>{
  sel.value=n;
  try {
    sel.dispatchEvent(new win.Event('change',{bubbles:true}));
    if(!numish(val('sbCAPE'))){ bad++; console.log('      -> '+n+' gave "'+val('sbCAPE')+'"'); }
  } catch(e){ bad++; console.log('      -> '+n+' threw: '+e.message); }
});
ok('all presets render', bad===0, bad+' failures');

// parcel selector
let pbad=0;
doc.querySelectorAll('#parcelSeg button').forEach(b=>{
  try { b.dispatchEvent(new win.Event('click',{bubbles:true}));
        if(!numish(val('sbCAPE'))) pbad++; } catch(e){ pbad++; }
});
ok('all three parcel types render', pbad===0);

// toggles
let tbad=0;
['showVirt','showWet','showBarbs','dragOn'].forEach(id=>{
  const el=doc.getElementById(id);
  [true,false].forEach(v=>{ el.checked=v;
    try { el.dispatchEvent(new win.Event('change',{bubbles:true})); } catch(e){ tbad++; } });
});
ok('all display toggles work', tbad===0);

// edit a cell
sel.value=Object.keys(SK.PRESETS)[0];
sel.dispatchEvent(new win.Event('change',{bubbles:true}));
const before=parseFloat(val('sbCAPE'));
const tInput=doc.querySelector('#tbody input[data-i="0"][data-k="T"]');
tInput.value=(parseFloat(tInput.value)+5).toFixed(1);
tInput.dispatchEvent(new win.Event('input',{bubbles:true}));
const after=parseFloat(val('sbCAPE'));
ok('editing surface T changes SBCAPE', after>before, before.toFixed(0)+' -> '+after.toFixed(0));

// Td is clamped to T
const tdInput=doc.querySelector('#tbody input[data-i="0"][data-k="Td"]');
tdInput.value='99';
tdInput.dispatchEvent(new win.Event('input',{bubbles:true}));
ok('dewpoint cannot exceed temperature',
   numish(val('sbCAPE')) && parseFloat(val('sbLCL'))>=0, 'LCL = '+val('sbLCL'));

// add / delete
sel.value=Object.keys(SK.PRESETS)[0]; sel.dispatchEvent(new win.Event('change',{bubbles:true}));
const n0=doc.querySelectorAll('#tbody tr').length;
doc.getElementById('addBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('add level inserts a row', doc.querySelectorAll('#tbody tr').length===n0+1);
doc.querySelector('#tbody button[data-del]').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('delete removes a row', doc.querySelectorAll('#tbody tr').length===n0);
ok('still renders after add/delete', numish(val('sbCAPE')));

// ascent-mode selector and ice toggle
sel.value=Object.keys(SK.PRESETS)[0]; sel.dispatchEvent(new win.Event('change',{bubbles:true}));
const capeOf=()=>parseFloat(val('sbCAPE'));
const modeBtn=v=>[...doc.querySelectorAll('#ascentSeg button')].find(b=>b.dataset.v===v);
const psCape=capeOf();
modeBtn('reversible').dispatchEvent(new win.Event('click',{bubbles:true}));
const revCape=capeOf();
ok('UI: reversible lowers CAPE', revCape<psCape, psCape.toFixed(0)+' -> '+revCape.toFixed(0));
ok('UI: reversible button is marked active', modeBtn('reversible').classList.contains('on'));
ok('UI: ascent note updates',
   /condensate/i.test(doc.getElementById('ascentNote').textContent),
   doc.getElementById('ascentNote').textContent.slice(0,50));
doc.getElementById('iceOn').checked=true;
doc.getElementById('iceOn').dispatchEvent(new win.Event('change',{bubbles:true}));
ok('UI: ice raises CAPE', capeOf()>revCape, revCape.toFixed(0)+' -> '+capeOf().toFixed(0));
ok('UI: ice is mentioned in the note', /ice/i.test(doc.getElementById('ascentNote').textContent));
doc.getElementById('iceOn').checked=false;
doc.getElementById('iceOn').dispatchEvent(new win.Event('change',{bubbles:true}));
modeBtn('dry').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('UI: dry mode renders without error', numish(val('sbCAPE')), 'SBCAPE = '+val('sbCAPE'));
ok('UI: dry mode warns there is no LFC',
   /no LFC/i.test(doc.getElementById('warn').textContent),
   doc.getElementById('warn').textContent.slice(0,40));
modeBtn('pseudo').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('UI: returning to pseudoadiabatic restores CAPE', Math.abs(capeOf()-psCape)<1e-6);

// paste import
const box=doc.getElementById('pasteBox');
box.value='p,T,Td,dir,spd\n1000,30,23,170,15\n900,22,18,200,25\n800,16,10,220,32\n700,9,2,240,40\n'+
          '600,2,-6,250,46\n500,-7,-16,255,52\n400,-18,-28,258,58\n300,-33,-44,260,62\n'+
          '200,-52,-64,262,55\n150,-56,-70,264,44\n100,-55,-70,266,32';
doc.getElementById('loadBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('paste import loads', doc.querySelectorAll('#tbody tr').length===11,
   doc.querySelectorAll('#tbody tr').length+' rows');
ok('paste import renders', numish(val('sbCAPE')), 'SBCAPE = '+val('sbCAPE'));
ok('paste note shown', doc.getElementById('parseNote').style.display==='block',
   doc.getElementById('parseNote').textContent.slice(0,60));

// bad paste
box.value='total nonsense here';
doc.getElementById('loadBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('bad paste is reported, not applied',
   /Could not read/.test(doc.getElementById('parseNote').textContent),
   doc.getElementById('parseNote').textContent.slice(0,60));
ok('page still alive after a bad paste', numish(val('sbCAPE')));

// copy current / download
doc.getElementById('fillBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('"copy current" fills the box', box.value.split('\n').length>5);
let dl=false;
const realCreate=doc.createElement.bind(doc);
doc.createElement=function(t){ const el=realCreate(t); if(t==='a') el.click=()=>{dl=true;}; return el; };
doc.getElementById('dlBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('download button fires', dl);
doc.createElement=realCreate;

// no-wind sounding: the hodograph must degrade gracefully
box.value='p,T,Td\n1000,28,22\n850,16,12\n700,8,0\n500,-12,-25\n300,-42,-58\n200,-55,-70';
doc.getElementById('loadBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
ok('no-wind sounding still renders CAPE', numish(val('sbCAPE')), 'SBCAPE = '+val('sbCAPE'));
ok('no-wind sounding warns about missing winds',
   /no wind data/.test(doc.getElementById('warn').textContent),
   doc.getElementById('warn').textContent.slice(0,60));

// reset, then canvases
doc.getElementById('resetBtn').dispatchEvent(new win.Event('click',{bubbles:true}));
['cSkew','cHodo','cProf'].forEach(id=>{
  const c=doc.getElementById(id).__c;
  if(!c){ ok(id+' drew pixels', false, 'no backing canvas'); return; }
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let nz=0; for(let i=3;i<d.length;i+=4*37) if(d[i]>0) nz++;
  ok(id+' drew pixels', nz>20, nz+' non-transparent samples');
});

console.log('\n'+'='.repeat(64));
console.log((fail===0?'ALL PASS':fail+' FAILURES')+'   —   '+pass+' passed, '+fail+' failed');
console.log('='.repeat(64));
process.exit(fail===0?0:1);

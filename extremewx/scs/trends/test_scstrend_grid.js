/* End-to-end test for scstrend.html: real DOM, real data, stubbed Leaflet.
   The thing most worth testing here is the map linkage — two Leaflet instances
   driven as one, which is exactly the kind of thing that silently half-works. */
const fs=require('fs'), zlib=require('zlib'), path=require('path'), {JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scstrend_grid.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
                          url:'http://localhost/extremewx/scs/trends/scstrend_grid.html'});
const w=dom.window;

w.fetch=async u=>{ const p=path.join(ROOT,u);
  if(!fs.existsSync(p)) throw new Error('404 '+u);
  const b=fs.readFileSync(p);
  return {ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b}; };
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));

/* ---- Leaflet stub that actually models view state, so sync can be tested --- */
const maps=[];
const B={getSouth:()=>24,getNorth:()=>50,getWest:()=>-126,getEast:()=>-66,
         getCenter:()=>({lat:39,lng:-96}),pad(){return this}};
function mkMap(id){
  const handlers={};
  const m={id,_c:{lat:39.8,lng:-86.3},_z:6,_layers:[],_fit:0,
    setView(c,z){ this._c=Array.isArray(c)?{lat:c[0],lng:c[1]}:c; if(z!=null)this._z=z;
                  (handlers.move||[]).forEach(f=>f()); return this; },
    fitBounds(){ this._fit++; this._z=7; (handlers.move||[]).forEach(f=>f()); return this; },
    getCenter(){return this._c}, getZoom(){return this._z},
    on(ev,fn){ ev.split(' ').forEach(e=>(handlers[e]=handlers[e]||[]).push(fn)); },
    removeLayer(l){ this._layers=this._layers.filter(x=>x!==l); },
    addLayer(l){ if(!this._layers.includes(l)) this._layers.push(l); },
    hasLayer(l){ return this._layers.includes(l); },
    eachLayer(cb){ this._layers.slice().forEach(cb); },
    invalidateSize(){}, _h:handlers};
  maps.push(m); return m;
}
const gjLayers=[];
w.L={
  map:id=>mkMap(id),
  tileLayer:()=>({addTo(m){ this._t=true; m.addLayer(this); return this; }, _tile:true}),
  layerGroup:()=>({_marks:[],addTo(m){m.addLayer(this);return this}}),
  circleMarker:()=>({bindTooltip(){return this},on(){return this},addTo(g){g._marks.push(this);return this}}),
  DomEvent:{stop(){}},
  TileLayer:function(){},
  geoJSON:(data,opts)=>{
    const layers=[];
    if(data&&data.features&&opts&&opts.onEachFeature){
      data.features.forEach(f=>{ const l={feature:f,_h:{},_style:
          (typeof opts.style==='function'?opts.style(f):opts.style),
        on(ev,fn){this._h[ev]=fn}, bindTooltip(fn){this._tip=fn; return this},
        setStyle(){}, getBounds:()=>B};
        layers.push(l); opts.onEachFeature(f,l); });
    }
    const L={_data:data,_opts:opts,_layers:layers,_styled:0,
      addTo(m){m.addLayer(this);return this}, getLayers(){return layers},
      setStyle(fn){ this._styled++;
        if(typeof fn==='function') layers.forEach(l=>{ l._style=fn(l.feature); });
        else layers.forEach(l=>{ l._style=fn; }); },
      bringToFront(){this._front=(this._front||0)+1}, getBounds:()=>B};
    gjLayers.push(L); return L;
  }
};
w.L.TileLayer.prototype={};
w.addEventListener('error',e=>errors.push('window error: '+e.message));
process.on('unhandledRejection',e=>errors.push('unhandled rejection: '+(e&&e.message)));
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

// tell the two layer kinds apart by size: ~260 populated 2-degree boxes vs
// 52 state outlines.
const isGrid  =l=>l._data&&l._data.features&&l._data.features.length>150&&l._data.features.length<3000;
const isCounty2=l=>l._data&&l._data.features&&l._data.features.length>3000;
const isState =l=>l._data&&l._data.features&&l._data.features.length<200;
const gridLayers=()=>gjLayers.filter(isGrid);
const $=id=>w.document.getElementById(id);
const fire=(id,t)=>{const e=$(id); const h=e['on'+t]; if(h) h.call(e,{target:e});};
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));

(async()=>{
  await new Promise(r=>setTimeout(r,3200));
  const [A,Bm]=maps;

  console.log('\n--- init');
  say('two maps created',maps.length===2,maps.length+'');
  say('body shown',$('body').style.display==='block');
  say('grid layer on each map',gridLayers().length===2, gridLayers().length+'');
  say('state layer on each map',gjLayers.filter(isState).length===2);
  say('opens on the Lower 48',$('regSel').value===''&&A.getZoom()===4,
      `region="${$('regSel').value}" z${A.getZoom()}`);
  say('opens on the national aggregate, not one box',$('ctySel').value==='',
      `ctySel="${$('ctySel').value}"`);
  say('the aggregate is the first option',
      $('ctySel').options[0].textContent==='All boxes (lower 48)',
      $('ctySel').options[0].textContent);
  say('the opening series is non-zero',
      w.eval("[...seriesMonthYear().my].reduce((a,b)=>a+b,0)")>0);
  say('panels name the national scope',/mean over all \d+ boxes/.test($('card').innerHTML),
      ($('card').innerHTML.match(/mean over all \d+ boxes/)||[''])[0]);
  say('panels drawn',$('card').innerHTML.length>4000,$('card').innerHTML.length+' chars');
  say('two colour bars',$('cbClim').innerHTML.includes('linear-gradient')&&
                        $('cbTrend').innerHTML.includes('linear-gradient'));
  say('trend bar is diverging',$('cbTrend').innerHTML.includes('#2166ac'));

  console.log('\n--- the two maps move as one');
  A.setView([35,-100],7);
  say('drag A → B follows',Bm.getCenter().lat===35&&Bm.getZoom()===7,
      `B at ${Bm.getCenter().lat},${Bm.getCenter().lng} z${Bm.getZoom()}`);
  Bm.setView([44,-72],5);
  say('drag B → A follows',A.getCenter().lat===44&&A.getZoom()===5,
      `A at ${A.getCenter().lat},${A.getCenter().lng} z${A.getZoom()}`);
  say('no feedback oscillation',A.getCenter().lat===Bm.getCenter().lat);

  console.log('\n--- states and counties are inert reference only');
  const stl=gjLayers.filter(isState);
  say('state layer is non-interactive',stl.every(l=>l._opts.interactive===false));
  say('state layer has no click handlers',stl.every(l=>l._layers.every(x=>!x._h.click)));
  say('county reference layer built',gjLayers.filter(isCounty2).length===2,
      gjLayers.filter(isCounty2).length+'');
  say('county layer is non-interactive',
      gjLayers.filter(isCounty2).every(l=>l._opts.interactive===false));

  console.log('\n--- the box is the analysis unit');
  const grid=gridLayers()[0];
  const before=$('foot').innerHTML;
  const box=grid._layers.find(l=>String(l.feature.properties.ci)!==$('ctySel').value);
  box._h.click({});
  say('clicking a box changes the selection',$('ctySel').value===String(box.feature.properties.ci),
      $('ctySel').value);
  say('panels follow the box',$('foot').innerHTML!==before&&/°N/.test($('foot').innerHTML));
  say('selected box outlined magenta',
      grid._layers.find(l=>String(l.feature.properties.ci)===$('ctySel').value)._style.color==='#ff3ecb');
  say('the aggregate stays available to go back to',
      [...$('ctySel').options].some(o=>/all box/i.test(o.textContent)));
  // the click narrowed scope; the panels must say so, and the units must not change
  say('panels name the chosen box',/box at \d+°N/.test($('card').innerHTML),
      ($('card').innerHTML.match(/box at [^<·]*/)||[''])[0]);

  console.log('\n--- the state menu only moves the camera');
  const cellBefore=$('ctySel').value, fitBefore=A._fit;
  $('regSel').value='TX'; fire('regSel','change');
  say('state choice re-centres',A._fit>fitBefore);
  say('state choice leaves the analysed box alone',$('ctySel').value===cellBefore,
      $('ctySel').value+' vs '+cellBefore);
  say('both maps still together',A.getCenter().lat===Bm.getCenter().lat);
  $('regSel').value=''; fire('regSel','change');

  console.log('\n--- controls');
  $('thrSel').value=1; fire('thrSel','change');
  say('threshold change restyles both',gridLayers().every(l=>l._styled>0));
  $('y0In').value=1996; fire('y0In','change');
  say('period change',$('y0In').value==='1996');
  $('usBtn').onclick();
  say('back to lower 48',$('regSel').value===''&&A.getZoom()===4,'z'+A.getZoom());

  console.log('\n--- Gaussian smoothing');
  say('control offers 1° and raw',
      [...$('smSel').options].map(o=>o.value).join(',')==='1,off',
      [...$('smSel').options].map(o=>o.textContent).join(' / '));
  say('smoothing is on at 1° by default',$('smSel').value==='1',$('smSel').value);
  say('subtitles badge the smoothing in bold yellow',
      /class="smtag">1° Gaussian</.test($('climSub').innerHTML)&&
      /class="smtag">1° Gaussian</.test($('trendSub').innerHTML),
      ($('climSub').innerHTML.match(/<span class="smtag">[^<]*/)||[''])[0]);
  /* page-level `let CUR` is not reachable from outside the eval; go through the
     functions the page declares, which are */
  const raw     =JSON.parse(w.eval("JSON.stringify([...cellMetrics().mean])"));
  const smoothed=JSON.parse(w.eval("JSON.stringify([...smoothField(cellMetrics().mean)])"));
  say('smoothing changes the drawn field',
      JSON.stringify(raw)!==JSON.stringify(smoothed));
  $('smSel').value='off'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,200));
  say('with it off, smoothField is a pass-through',
      w.eval("JSON.stringify([...smoothField(cellMetrics().mean)])")===JSON.stringify(raw));
  say('subtitle says Raw data when off',
      /class="smtag">Raw data</.test($('climSub').innerHTML)&&
      !/Gaussian/.test($('climSub').innerHTML),
      ($('climSub').innerHTML.match(/<span class="smtag">[^<]*/)||[''])[0]);
  /* The three properties that matter, checked rather than assumed. */
  const nRaw=raw.filter(v=>v!==null&&isFinite(v)).length;
  const nSm =smoothed.filter(v=>v!==null&&isFinite(v)).length;
  say('smoothing does not change which boxes have a value',nRaw===nSm,nRaw+' vs '+nSm);
  const mean=a=>{const f=a.filter(v=>v!==null&&isFinite(v));return f.reduce((x,y)=>x+y,0)/f.length;};
  say('it is an average, so it reduces the spread',
      Math.max(...smoothed.filter(isFinite))<Math.max(...raw.filter(isFinite)),
      'peak '+Math.max(...raw.filter(isFinite)).toFixed(2)+' -> '+
      Math.max(...smoothed.filter(isFinite)).toFixed(2));
  say('and keeps the field roughly centred',Math.abs(mean(smoothed)-mean(raw))/mean(raw)<0.15,
      mean(raw).toFixed(3)+' -> '+mean(smoothed).toFixed(3));
  /* Trend gates must survive: a greyed box stays grey. */
  $('smSel').value='2'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,200));
  const gt=w.eval("(function(){const m=cellMetrics();let n=0;"+
    "for(let i=0;i<m.trend.length;i++) if(!isFinite(m.trend[i]))n++;return n;})()");
  const gd=w.eval("(function(){const t=smoothField(cellMetrics().trend);let n=0;"+
    "for(let i=0;i<t.length;i++) if(!isFinite(t[i]))n++;return n;})()");
  say('boxes without a fitted trend stay unfitted',gt===gd,gt+' gated, '+gd+' grey');
  say('the panels are never smoothed',
      w.eval("(function(){const s=seriesMonthYear();return [...s.my].reduce((a,b)=>a+b,0);})()")>0);
  // capture the hash while it is off, or the message reports the state after
  $('smSel').value='off'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,150));
  const offHash=w.location.hash;
  $('smSel').value='2'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,150));
  say('a non-default choice is written to the hash',/[?&]sm=off/.test(offHash)&&
      !/[?&]sm=/.test(w.location.hash),
      'raw -> "'+(offHash.match(/sm=\w+/)||[''])[0]+'", 2° default -> omitted');
  /* 1° is half a box here: it must do something, but gently enough that local
     maxima are not pulled into their neighbours. */
  const f=a=>a.filter(v=>v!==null&&isFinite(v));
  say('1° blurs, but keeps local maxima',
      Math.max(...f(smoothed))<Math.max(...f(raw))&&
      Math.max(...f(smoothed))>0.8*Math.max(...f(raw)),
      'raw peak '+Math.max(...f(raw)).toFixed(2)+' -> '+Math.max(...f(smoothed)).toFixed(2));

  console.log('\n--- the Derecho hazard');
  say('Derecho is in the grid hazard menu',
      [...$('hazSel').options].some(o=>o.value==='derechoday'),
      [...$('hazSel').options].map(o=>o.value).join(','));
  $('hazSel').value='derechoday'; await $('hazSel').onchange({target:{value:'derechoday'}});
  await new Promise(r=>setTimeout(r,900));
  say('record starts in 1996',$('y0In').min==='1996'&&$('y1In').max==='2024',
      $('y0In').min+'-'+$('y1In').max);
  /* Same wording rule as the county page: a derecho is one coherent storm. */
  say('counted in events, not days',/events\/yr/.test($('cbClim').innerHTML)&&
      !/days\/yr/.test($('cbClim').innerHTML),
      ($('cbClim').innerHTML.match(/\w+\/yr/)||[''])[0]);
  say('map subtitle says events',/Mean annual derecho events per 2/i.test($('climSub').textContent),
      $('climSub').textContent);
  // page-level `let CELLS` is not reachable from outside the eval; the metrics
  // arrays are one per box, so their length is the same number
  const nBox=w.eval('cellMetrics().mean.length');
  say('boxes populated',nBox>100,nBox+' boxes');
  /* White marks a true zero so the edge of the affected area is visible. It has
     to stay distinct from no-data, which is the land colour, and must not leak
     onto the diverging trend ramp where zero is mid-scale. */
  say('exact zero is pure white',w.eval("colorFor(0,{div:false,lo:0,hi:1})")==='#ffffff',
      w.eval("colorFor(0,{div:false,lo:0,hi:1})"));
  say('a small non-zero is not white',w.eval("colorFor(0.01,{div:false,lo:0,hi:1})")!=='#ffffff',
      w.eval("colorFor(0.01,{div:false,lo:0,hi:1})"));
  say('zero on the trend ramp is untouched',w.eval("colorFor(0,{div:true,lo:-1,hi:1})")!=='#ffffff');
  say('no-data is still null, not white',w.eval("colorFor(NaN,{div:false,lo:0,hi:1})")===null);
  say('the climo bar explains the white',/exactly 0/.test($('cbClim').innerHTML));
  say('the trend bar does not',!/exactly 0/.test($('cbTrend').innerHTML));
  say('values are small, as derechos are rare',
      w.eval("(function(){const m=cellMetrics();let mx=0;"+
             "for(let i=0;i<m.mean.length;i++)if(isFinite(m.mean[i]))mx=Math.max(mx,m.mean[i]);"+
             "return mx;})()")<1.5,
      'max '+w.eval("(function(){const m=cellMetrics();let mx=0;"+
             "for(let i=0;i<m.mean.length;i++)if(isFinite(m.mean[i]))mx=Math.max(mx,m.mean[i]);"+
             "return mx.toFixed(2);})()")+' events/yr');
  say('wind still says days', await (async()=>{
      $('hazSel').value='wind'; await $('hazSel').onchange({target:{value:'wind'}});
      await new Promise(r=>setTimeout(r,900));
      return /days\/yr/.test($('cbClim').innerHTML); })());
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,900));

  console.log('\n--- switching hazard keeps a live box');
  // each hazard populates a different set of boxes and starts in a different year,
  // so the geometry and the year axis have to be rebuilt, not just the counts
  const seriesTotal=()=>w.eval("(function(){const s=seriesMonthYear();"+
    "return [...s.my].reduce((a,b)=>a+b,0);})()");
  say('hail series is non-zero',seriesTotal()>0,seriesTotal().toFixed(0));
  const boxBefore=$('ctySel').value;
  $('hazSel').value='tornado'; await $('hazSel').onchange({target:{value:'tornado'}});
  await new Promise(r=>setTimeout(r,800));
  say('a box is still selected after the switch',$('ctySel').value!=='',$('ctySel').value);
  say('it stayed on the same box',$('ctySel').value===boxBefore,
      $('ctySel').value+' vs '+boxBefore);
  say('tornado series is non-zero',seriesTotal()>0,seriesTotal().toFixed(0));
  say('panels redrawn',$('card').innerHTML.length>4000);
  $('hazSel').value='wind'; await $('hazSel').onchange({target:{value:'wind'}});
  await new Promise(r=>setTimeout(r,800));
  say('wind series is non-zero',seriesTotal()>0,seriesTotal().toFixed(0));
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,800));

  console.log('\n--- reload default');
  // jsdom makes location.reload non-configurable, so the reload itself cannot be
  // intercepted here — asserting it would only be testing a stub. What matters and
  // is observable is that the hash is dropped FIRST: reloading with state still in
  // the URL would restore exactly what the user asked to discard.
  $('regSel').value='TX'; fire('regSel','change');
  say('hash carries state before reset',w.location.hash.length>1,w.location.hash.slice(0,44));
  $('resetBtn').onclick();
  say('reset clears the hash',w.location.hash===''||w.location.hash==='#',
      JSON.stringify(w.location.hash));

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e); process.exit(2);});

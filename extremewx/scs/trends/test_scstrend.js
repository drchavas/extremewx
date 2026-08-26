/* End-to-end test for scstrend.html: real DOM, real data, stubbed Leaflet.
   The thing most worth testing here is the map linkage — two Leaflet instances
   driven as one, which is exactly the kind of thing that silently half-works. */
const fs=require('fs'), zlib=require('zlib'), path=require('path'), {JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scstrend.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
                          url:'http://localhost/extremewx/scs/trends/scstrend.html'});
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
    /* real maps expose their view bounds; the vector export projects into them */
    getBounds(){ const c=this._c, s=20/Math.pow(2,this._z-3);
      return {getWest:()=>c.lng-30*s,getEast:()=>c.lng+30*s,
              getSouth:()=>c.lat-13*s,getNorth:()=>c.lat+13*s}; },
    on(ev,fn){ ev.split(' ').forEach(e=>(handlers[e]=handlers[e]||[]).push(fn)); },
    removeLayer(l){ this._layers=this._layers.filter(x=>x!==l); },
    addLayer(l){ this._layers.push(l); },
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
/* PNG export needs a canvas and an Image; jsdom has neither in usable form.
   These stubs are enough to prove the code path runs to a download — which is
   what broke: a ReferenceError inside img.onload, where nothing surfaces it, so
   the button silently did nothing. */
let lastCanvas=null, downloads=[];
w.HTMLCanvasElement.prototype.getContext=function(){
  return {fillStyle:'',fillRect(){},drawImage(){}}; };
w.HTMLCanvasElement.prototype.toBlob=function(cb){ lastCanvas=this; cb(new w.Blob(['png'])); };
w.HTMLAnchorElement.prototype.click=function(){ if(this.download) downloads.push(this.download); };
w.Image=class{ constructor(){ this.onload=null; this.onerror=null; }
  set src(v){ this._src=v; setTimeout(()=>{ if(this.onload) this.onload(); },0); }
  get src(){ return this._src; } };
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

// GEO/STGEO are scope-local to the page's eval; tell the two layer kinds apart
// by size instead (3222 counties vs 52 state outlines).
const isCounty=l=>l._data&&l._data.features&&l._data.features.length>3000;
const isState =l=>l._data&&l._data.features&&l._data.features.length<200;
const countyLayers=()=>gjLayers.filter(isCounty);
const $=id=>w.document.getElementById(id);
const fire=(id,t)=>{const e=$(id); const h=e['on'+t]; if(h) h.call(e,{target:e});};
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));

(async()=>{
  await new Promise(r=>setTimeout(r,3200));
  const [A,Bm]=maps;

  console.log('\n--- init');
  say('two maps created',maps.length===2,maps.length+'');
  say('body shown',$('body').style.display==='block');
  say('county layer on each map',countyLayers().length===2, countyLayers().length+'');
  say('state layer on each map',gjLayers.filter(isState).length===2);
  say('opens on Indiana',$('regSel').value==='IN',$('regSel').value);
  say('fitBounds fired for the default state',A._fit>0,'fits='+A._fit);
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

  console.log('\n--- a state click re-centres only when the state changes');
  const stLayer=gjLayers.filter(isState)[0];
  const tx=stLayer._layers.find(l=>l.feature.properties.STUSPS==='TX');
  const ok=stLayer._layers.find(l=>l.feature.properties.STUSPS==='OK');
  const nBefore=countyLayers()[0].getLayers().length;

  // clicking a NEW state is a "take me there" gesture and should frame it
  let fitBefore=A._fit;
  tx._h.click({});
  say('state click sets the region',$('regSel').value==='TX',$('regSel').value);
  say('a NEW state re-centres',A._fit>fitBefore,(A._fit-fitBefore)+' refit');
  say('both maps still centred together',A.getCenter().lat===Bm.getCenter().lat);

  /* The regression: zoom in, then click inside the state you are already on. It
     used to re-fit anyway, throwing away the reader's own zoom. */
  A.setView([31.5,-99],9);
  fitBefore=A._fit;
  const zBefore=A.getZoom(), cBefore=JSON.stringify(A.getCenter());
  tx._h.click({});
  say('clicking the SAME state leaves a zoomed view alone',
      A.getZoom()===zBefore&&JSON.stringify(A.getCenter())===cBefore&&A._fit===fitBefore,
      'z'+zBefore+' -> z'+A.getZoom()+', '+(A._fit-fitBefore)+' refits');
  say('and it is still the selected state',$('regSel').value==='TX');

  // but moving to another state from that zoom does frame the new one
  fitBefore=A._fit;
  ok._h.click({});
  say('moving to another state re-centres again',
      $('regSel').value==='OK'&&A._fit>fitBefore,
      $('regSel').value+', '+(A._fit-fitBefore)+' refit');
  tx._h.click({});
  const fitBeforeSel=A._fit;
  $('regSel').value='TX'; fire('regSel','change');
  say('the Place menu re-centres too',A._fit>fitBeforeSel,(A._fit-fitBeforeSel)+' refit');
  const nAfter=countyLayers()[0].getLayers().length;
  say('all 3222 counties still drawn',nAfter===3222&&nAfter===nBefore,nAfter+' counties');
  say('panels rescoped to Texas',$('foot').innerHTML.includes('Texas'));
  const stl=gjLayers.filter(isState);
  const styleOfState=(layer,ab)=>layer._layers.find(l=>l.feature.properties.STUSPS===ab)._style;
  say('selected state outlined magenta',styleOfState(stl[0],'TX').color==='#ff3ecb',
      styleOfState(stl[0],'TX').color);
  say('magenta on the trend map too',styleOfState(stl[1],'TX').color==='#ff3ecb',
      styleOfState(stl[1],'TX').color);
  say('unselected states are thin black',styleOfState(stl[0],'OK').color==='#000'&&
      styleOfState(stl[0],'OK').weight<1,
      styleOfState(stl[0],'OK').color+' w'+styleOfState(stl[0],'OK').weight);
  say('selected outline is heavier',styleOfState(stl[0],'TX').weight >
      styleOfState(stl[0],'OK').weight);
  say('selected outline is 3.9 (30% up from 3)',styleOfState(stl[0],'TX').weight===3.9,
      String(styleOfState(stl[0],'TX').weight));

  console.log('\n--- Gaussian smoothing');
  say('control offers 2° and raw',
      [...$('smSel').options].map(o=>o.value).join(',')==='2,off',
      [...$('smSel').options].map(o=>o.textContent).join(' / '));
  say('smoothing is on at 2° by default',$('smSel').value==='2'&&
      $('smWrap').style.display!=='none',$('smSel').value);
  say('subtitles badge the smoothing in bold yellow',
      /class="smtag">2° Gaussian smoothed</.test($('climSub').innerHTML)&&
      /class="smtag">2° Gaussian smoothed</.test($('trendSub').innerHTML),
      ($('climSub').innerHTML.match(/<span class="smtag">[^<]*/)||[''])[0]);
  const raw=JSON.parse(w.eval("JSON.stringify([...countyMetrics().mean])"));
  const sm =JSON.parse(w.eval("JSON.stringify([...smoothField(countyMetrics().mean)])"));
  say('smoothing changes the drawn field',JSON.stringify(raw)!==JSON.stringify(sm));
  const fin=a=>a.filter(v=>v!==null&&isFinite(v));
  say('it does not change which counties have a value',fin(raw).length===fin(sm).length,
      fin(raw).length+' vs '+fin(sm).length);
  say('it reduces the peak, being an average',
      Math.max(...fin(sm))<Math.max(...fin(raw)),
      'peak '+Math.max(...fin(raw)).toFixed(2)+' -> '+Math.max(...fin(sm)).toFixed(2));
  const mean=a=>{const f=fin(a);return f.reduce((x,y)=>x+y,0)/f.length;};
  say('and keeps the field roughly centred',Math.abs(mean(sm)-mean(raw))/mean(raw)<0.2,
      mean(raw).toFixed(3)+' -> '+mean(sm).toFixed(3));
  /* Area weighting is the difference between a spatial mean and a per-county
     vote; without it a cluster of small counties dominates its neighbourhood. */
  say('neighbour weights are area-weighted',
      w.eval("(function(){const nb=smoothNeighbours();"+
             "for(let k=0;k<nb.idx[0].length;k++) if(nb.idx[0][k]!==0)"+
             "  return Math.abs(nb.wt[0][k]-Math.exp(0))>1e-9; return false;})()"));
  /* A 2° blur is firm, so pin structure rather than a fraction of the raw peak:
     the maximum must still stand well clear of the field mean. */
  const pk=Math.max(...fin(sm)), mn=fin(sm).reduce((x,y)=>x+y,0)/fin(sm).length;
  say('the smoothed field keeps a distinct maximum',pk>2*mn,
      'peak '+pk.toFixed(2)+' vs field mean '+mn.toFixed(2)+
      '  (raw peak '+Math.max(...fin(raw)).toFixed(2)+')');
  $('smSel').value='off'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,200));
  say('raw is a pass-through',
      w.eval("JSON.stringify([...smoothField(countyMetrics().mean)])")===JSON.stringify(raw));
  say('subtitle says Raw data when off',
      /class="smtag">Raw data</.test($('climSub').innerHTML)&&
      !/Gaussian/.test($('climSub').innerHTML),
      ($('climSub').innerHTML.match(/<span class="smtag">[^<]*/)||[''])[0]);
  say('the choice is written to the hash',/[?&]sm=off/.test(w.location.hash),
      (w.location.hash.match(/sm=\w+/)||[''])[0]);
  $('smSel').value='2'; fire('smSel','change');
  await new Promise(r=>setTimeout(r,200));


  console.log('\n--- the guidance box follows the data type');
  /* Storm Events and ASOS fail in completely different ways; showing both
     caveats together left the reader to work out which one applied. */
  const guide=()=>$('guide').innerHTML;
  say('a county hazard gets the Storm Events caveat',
      /Storm Events records/.test(guide())&&/thirtyfold/.test(guide()));
  say('and the 1993 gap, which is a Storm Events problem',
      /June and July 1993 are missing/.test(guide()));
  say('with no ASOS text',!/ASOS/.test(guide()));
  $('hazSel').value='fzra'; await $('hazSel').onchange({target:{value:'fzra'}});
  await new Promise(r=>setTimeout(r,900));
  say('a station hazard gets the instrument caveat instead',
      /fixed instrument network/.test(guide())&&/ASOS replaced human observers/.test(guide()));
  say('and the 90% completeness rule',/no observation and dropped/.test(guide()));
  say('with no Storm Events text',!/Storm Events records/.test(guide()));
  say('and no 1993 gap, which does not apply to 2000-2024 station data',
      !/June and July 1993/.test(guide()));
  say('freezing rain points at the QC source',/DelPizzo/.test(guide()));
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,900));
  say('switching back restores the Storm Events caveat',
      /Storm Events records/.test(guide())&&!/ASOS/.test(guide()));


  console.log('\n--- the light theme repaints the whole page, not just the maps');
  const H=w.document.documentElement;
  say('the theme is on the root element, where the CSS can see it',
      H.dataset.theme==='dark',H.dataset.theme);
  $('themeBtn').onclick.call($('themeBtn'));
  await new Promise(r=>setTimeout(r,200));
  /* Without this attribute the CSS variables stayed dark and light mode gave
     white gutters around dark navy cards, with links close to illegible. */
  say('switching flips it, so --panel, --text and --line all switch',
      H.dataset.theme==='light',H.dataset.theme);
  say('the button offers the way back',$('themeBtn').textContent==='Dark');
  say('and the basemap follows',/World_Light_Gray_Base/.test(w.eval('tileUrl()')),
      w.eval('tileUrl()').split('/Canvas/')[1].split('/')[0]);
  $('themeBtn').onclick.call($('themeBtn'));
  await new Promise(r=>setTimeout(r,200));
  say('back to dark, page and basemap together',
      H.dataset.theme==='dark'&&/World_Dark_Gray_Base/.test(w.eval('tileUrl()')));


  console.log('\n--- the PNG button actually exports');
  downloads.length=0; lastCanvas=null;
  $('pngBtn').onclick();
  await new Promise(r=>setTimeout(r,200));
  say('a file is produced',downloads.length===1,downloads.join(' ')||'nothing downloaded');
  say('named .png',/\.png$/.test(downloads[0]||''),downloads[0]||'');
  /* The bug this replaced: the canvas was sized from globals that no longer
     existed, so it came out NaN and the handler threw before reaching toBlob. */
  const F=JSON.parse(w.eval('(function(){const f=figureSVG();return JSON.stringify({W:f.W,H:f.H});})()'));
  say('canvas sized from the figure, at 2x',
      lastCanvas&&lastCanvas.width===F.W*2&&lastCanvas.height===F.H*2,
      lastCanvas?`${lastCanvas.width}x${lastCanvas.height} for ${F.W}x${F.H} @2x`:'no canvas');
  /* The export is now the whole figure, not just the series panels. */
  const LO=JSON.parse(w.eval('JSON.stringify(panelLayout())'));
  say('the figure is taller than the panels alone',F.H>LO.H,
      `${F.H} vs ${LO.H} for the panels`);
  const fig=w.eval('figureSVG().svg');
  say('it carries both maps',(fig.match(/Climatology/g)||[]).length===1&&
      (fig.match(/>Trend</g)||[]).length===1);
  say('the maps are real county paths, not a screenshot',
      (fig.match(/<path /g)||[]).length>3000,
      (fig.match(/<path /g)||[]).length+' paths');
  say('both map colour bars are redrawn as SVG',
      (fig.match(/linearGradient/g)||[]).length>=2,
      (fig.match(/linearGradient/g)||[]).length+' gradients');
  /* SVG in the page is parsed as HTML, which forgives a raw "<"; a standalone
     exported file is parsed as XML, which does not — and the subtitles say
     "p < 0.05". That one character silently broke every export. */
  say('the exported SVG is well-formed XML — no raw < in text',
      !/>[^<]*[<][^\/!a-zA-Z][^<]*<\/text>/.test(fig)&&/p &lt; 0\.05/.test(fig),
      (fig.match(/p [^<]{0,6}0\.05/)||[''])[0]);
  /* A choropleth, not a flat backdrop: many distinct fills across the ramp.
     (Page-level CUR and gidxOf are not reachable from out here, so count what
     the output actually contains rather than reaching into page state.) */
  const fills=new Set((fig.match(/fill="rgb\([^)]*\)"/g)||[]));
  say('the maps are painted across the colour ramp',fills.size>40,
      fills.size+' distinct fills');
  say('the filename carries the hazard',/hail|tornado|wind|derecho|fzra|pkwnd/.test(downloads[0]||''),
      downloads[0]||'');

  console.log('\n--- panels stack on a phone');
  const layoutAt=px=>{ const o=Object.getOwnPropertyDescriptor(w,'innerWidth');
    Object.defineProperty(w,'innerWidth',{value:px,configurable:true});
    const L=JSON.parse(w.eval('JSON.stringify(panelLayout())'));
    if(o) Object.defineProperty(w,'innerWidth',o);
    return L; };
  const wide=layoutAt(1400), narrow=layoutAt(400);
  say('wide screens keep the side-by-side layout',
      wide.W===1520&&wide.H===470&&wide.monthly[0]>0,
      `${wide.W}x${wide.H}, monthly at x=${wide.monthly[0]}`);
  /* A 1520-wide viewBox on a phone rendered both panels at about a third of
     legible size; stacking gives each the full width. */
  say('narrow screens stack them',
      narrow.W===760&&narrow.monthly[0]===0&&narrow.monthly[1]>narrow.annual[1],
      `${narrow.W}x${narrow.H}, monthly at y=${narrow.monthly[1]}`);
  say('each panel gets the full width when stacked',
      narrow.annual[2]===narrow.W&&narrow.monthly[2]===narrow.W,
      narrow.annual[2]+' and '+narrow.monthly[2]+' of '+narrow.W);
  say('stacked panels do not overlap',
      narrow.annual[1]+narrow.annual[3]<=narrow.monthly[1],
      `annual ends ${narrow.annual[1]+narrow.annual[3]}, monthly starts ${narrow.monthly[1]}`);
  say('and fit inside the viewBox',
      narrow.monthly[1]+narrow.monthly[3]<=narrow.H,
      `${narrow.monthly[1]+narrow.monthly[3]} <= ${narrow.H}`);

  console.log('\n--- controls');
  $('thrSel').value=1; fire('thrSel','change');
  /* gjLayers accumulates every layer ever created, including backdrops that
     have since been removed; only the ones currently on a map are restyled. */
  const liveCounty=m=>m._layers.filter(isCounty);
  say('threshold change restyles both',
      liveCounty(A).length>0&&liveCounty(A).every(l=>l._styled>0)&&
      liveCounty(Bm).every(l=>l._styled>0));
  $('y0In').value=1996; fire('y0In','change');
  say('period change',$('y0In').value==='1996');
  $('usBtn').onclick();
  say('back to lower 48',$('regSel').value===''&&A.getZoom()===4,'z'+A.getZoom());
  $('regSel').value='IN'; fire('regSel','change');

  console.log('\n--- county readout on hover');
  // the state layer is on top and hit-tests first, so the check that matters is
  // that hovering it still reports the county, not the state
  const stLay=gjLayers.filter(isState)[0];
  const inLay=stLay._layers.find(l=>l.feature.properties.STUSPS==='IN');
  inLay._h.mousemove({latlng:{lat:39.78,lng:-86.15}});      // Indianapolis
  const tip=inLay._tip();
  say('state hover reports the county under the cursor',/^<b>Marion, IN<\/b>/.test(tip),
      tip.split('<br>')[0]);
  say('readout has name and state abbrev',/<b>[A-Za-z. ]+, [A-Z]{2}<\/b>/.test(tip));
  say('readout carries both values',/days\/yr/.test(tip)&&/per decade/.test(tip));
  inLay._h.mousemove({latlng:{lat:44.0,lng:-70.0}});         // off in Maine
  say('falls back to the state name when outside it',
      inLay._tip()==='Indiana',inLay._tip());
  const cty=countyLayers()[0]._layers.find(l=>l.feature.properties.GEOID==='18097');
  say('county layer says the same thing',cty._tip()===tip.replace(/[\d.+-]+ days/,m=>m));

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
  // jsdom cannot actually reload, so put the region back by hand before the next
  // section: every station in the data is in Indiana, and leaving it on Texas
  // would empty the marker layer for reasons that have nothing to do with the page
  $('regSel').value='IN'; fire('regSel','change');

  console.log('\n--- station hazard');
  $('hazSel').value='fzra'; await $('hazSel').onchange({target:{value:'fzra'}});
  await new Promise(r=>setTimeout(r,700));
  say('QC toggle appears',$('dpWrap').style.display==='');
  /* DelPizzo's screen is the whole reason freezing rain is trendable, so the
     default matters more than the toggle: landing on the unscreened pool would
     show noise and look like signal. */
  say('freezing rain opens on the QC subset',/^QC only/.test($('dpBtn').textContent),
      $('dpBtn').textContent);
  say('the QC button reads as engaged',$('dpBtn').classList.contains('on'));
  say('footer credits the QC source',/DelPizzo/.test($('foot').innerHTML));
  const nStn=()=>{const g=A._layers.find(l=>l._marks);return g?g._marks.length:0;};
  say('five QC stations plotted',nStn()===5,nStn()+' markers');
  $('dpBtn').onclick.call($('dpBtn'));
  await new Promise(r=>setTimeout(r,300));
  say('the toggle still reaches the full pool',nStn()===12&&/^All/.test($('dpBtn').textContent),
      nStn()+' markers, "'+$('dpBtn').textContent+'"');
  say('opting out survives in the hash',/[?&]q=0/.test(w.location.hash),
      w.location.hash.slice(-16));
  $('dpBtn').onclick.call($('dpBtn'));
  await new Promise(r=>setTimeout(r,300));
  /* Stations have no county values, so the choropleth goes — but the counties
     are still drawn unshaded, so every map on the site reads the same way and
     the opaque land covers CARTO's "API key required" basemap watermark. */
  const back=A._layers.filter(isCounty);
  say('a plain county backdrop is drawn for a station hazard',back.length===1,
      back.length+' county layer(s) on the map');
  say('it is unshaded, not a choropleth',
      back.length===1&&back[0]._opts&&typeof back[0]._opts.style==='function'&&
      back[0]._opts.style({properties:{GEOID:'18097'}}).fillColor===
      back[0]._opts.style({properties:{GEOID:'48201'}}).fillColor,
      'every county the same colour');
  say('and non-interactive, so it cannot be clicked as data',
      back.length===1&&back[0]._opts.interactive===false);
  say('station markers drawn',A._layers.some(l=>l._marks&&l._marks.length>0),
      (A._layers.find(l=>l._marks)||{_marks:[]})._marks.length+' markers');
  // peak wind is a different measurement; DelPizzo's FZRA screen does not apply
  $('hazSel').value='pkwnd'; await $('hazSel').onchange({target:{value:'pkwnd'}});
  await new Promise(r=>setTimeout(r,700));
  say('peak wind opens on all stations',/^All/.test($('dpBtn').textContent),
      $('dpBtn').textContent);

  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,700));
  say('back to a county hazard',A._layers.some(isCounty));
  say('the choropleth is back, not just the backdrop',
      A._layers.filter(isCounty).some(l=>l._opts&&l._opts.onEachFeature));
  say('QC toggle hidden for county hazards',$('dpWrap').style.display==='none');

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e); process.exit(2);});

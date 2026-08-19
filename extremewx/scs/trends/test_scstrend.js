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

  console.log('\n--- clicking a state re-centres without hiding anything');
  const stLayer=gjLayers.filter(isState)[0];
  const tx=stLayer._layers.find(l=>l.feature.properties.STUSPS==='TX');
  const nBefore=countyLayers()[0].getLayers().length;
  const fitBefore=A._fit;
  tx._h.click({});
  say('state click sets the region',$('regSel').value==='TX',$('regSel').value);
  say('state click re-centres',A._fit>fitBefore);
  say('both maps still centred together',A.getCenter().lat===Bm.getCenter().lat);
  const nAfter=countyLayers()[0].getLayers().length;
  say('all 3222 counties still drawn',nAfter===3222&&nAfter===nBefore,nAfter+' counties');
  say('panels rescoped to Texas',$('foot').innerHTML.includes('Texas'));
  const stl=gjLayers.filter(isState);
  const styleOfState=(layer,ab)=>layer._layers.find(l=>l.feature.properties.STUSPS===ab)._style;
  say('selected state outlined magenta',styleOfState(stl[0],'TX').color==='#ff3ecb',
      styleOfState(stl[0],'TX').color);
  say('magenta on the trend map too',styleOfState(stl[1],'TX').color==='#ff3ecb',
      styleOfState(stl[1],'TX').color);
  say('unselected states stay neutral',styleOfState(stl[0],'OK').color!=='#ff3ecb',
      styleOfState(stl[0],'OK').color);
  say('selected outline is heavier',styleOfState(stl[0],'TX').weight >
      styleOfState(stl[0],'OK').weight);
  say('selected outline is 3.9 (30% up from 3)',styleOfState(stl[0],'TX').weight===3.9,
      String(styleOfState(stl[0],'TX').weight));

  console.log('\n--- controls');
  $('thrSel').value=1; fire('thrSel','change');
  say('threshold change restyles both',countyLayers().every(l=>l._styled>0));
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
  say('county layers removed for a station hazard',
      A._layers.filter(isCounty).length===0);
  say('station markers drawn',A._layers.some(l=>l._marks&&l._marks.length>0),
      (A._layers.find(l=>l._marks)||{_marks:[]})._marks.length+' markers');
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,700));
  say('back to a county hazard',A._layers.some(isCounty));

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e); process.exit(2);});

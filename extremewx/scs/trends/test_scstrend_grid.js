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
  say('a box is pre-selected so panels are not blank',$('ctySel').value!=='',
      $('ctySel').value);
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
  say('box menu has no aggregate option',
      ![...$('ctySel').options].some(o=>/all box/i.test(o.textContent)));

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

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e); process.exit(2);});

/* scsevents.html: the derecho archive plus the biggest-days lists. The things
   worth testing are the ones a screenshot would not catch — that the rankings
   the page shows are the ones the builder computed, that switching threshold or
   state cannot strand the reader on a day that is no longer in the list, and
   that the heavy per-report file is only fetched when actually asked for. */
const fs=require('fs'), zlib=require('zlib'), path=require('path'), {JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scsevents.html'),'utf8');
const errors=[], fetched=[];
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
                          url:'http://localhost/extremewx/scs/trends/scsevents.html'});
const w=dom.window;
w.fetch=async u=>{ const p=path.join(ROOT,u);
  if(!fs.existsSync(p)) throw new Error('404 '+u);
  fetched.push(u);
  const b=fs.readFileSync(p);
  return {ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b}; };
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));

const maps=[];
const B={getSouth:()=>24,getNorth:()=>50,getWest:()=>-126,getEast:()=>-66,
         getCenter:()=>({lat:39,lng:-96}),pad(){return this}};
w.L={
  map:id=>{const h={};const m={id,_c:{lat:39,lng:-96},_z:4,_layers:[],_fit:0,
    setView(c,z){this._c=Array.isArray(c)?{lat:c[0],lng:c[1]}:c;if(z!=null)this._z=z;return this},
    fitBounds(b){this._fit++;this._b=b;this._z=6;return this},
    getCenter(){return this._c},getZoom(){return this._z},
    on(e,f){e.split(' ').forEach(x=>(h[x]=h[x]||[]).push(f))},
    removeLayer(l){this._layers=this._layers.filter(x=>x!==l)},
    addLayer(l){this._layers.push(l)},hasLayer(l){return this._layers.includes(l)},
    eachLayer(cb){this._layers.slice().forEach(cb)},invalidateSize(){},_h:h};
   maps.push(m);return m;},
  tileLayer:()=>({_tile:true,addTo(m){m.addLayer(this);return this}}),
  layerGroup:()=>({_marks:[],_polys:[],_lines:[],addTo(m){m.addLayer(this);return this}}),
  circleMarker:(ll,o)=>({_ll:ll,_o:o,bindTooltip(f){this._tip=f;return this},
    on(){return this},addTo(g){g._marks.push(this);return this}}),
  polygon:(ll,o)=>({_ll:ll,_o:o,addTo(g){g._polys.push(this);return this}}),
  polyline:(ll,o)=>({_ll:ll,_o:o,addTo(g){g._lines.push(this);return this}}),
  DomEvent:{stop(){}}, TileLayer:function(){},
  geoJSON:(d,o)=>{const ls=[];
    if(d&&d.features&&o&&o.onEachFeature) d.features.forEach(f=>{const l={feature:f,_h:{},
      _style:(typeof o.style==='function'?o.style(f):o.style),
      on(e,fn){this._h[e]=fn},bindTooltip(fn){this._tip=fn;return this},
      setStyle(){},getBounds:()=>B};
      ls.push(l);o.onEachFeature(f,l);});
    const L={_data:d,_opts:o,_layers:ls,_styled:0,
      addTo(m){m.addLayer(this);return this},getLayers(){return ls},
      setStyle(fn){this._styled++;if(typeof fn==='function')ls.forEach(l=>{l._style=fn(l.feature);});},
      bringToFront(){},getBounds:()=>B};
    return L;}};
w.L.TileLayer.prototype={};
w.addEventListener('error',e=>errors.push('window error: '+e.message));
process.on('unhandledRejection',e=>errors.push('unhandled rejection: '+(e&&e.message)));
w.eval(html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g,''));

const $=id=>w.document.getElementById(id);
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));
const rows=()=>[...$('rankBody').querySelectorAll('tr')];
const gz=f=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,'data',f))).toString());

(async()=>{
  await new Promise(r=>setTimeout(r,3500));
  const M=maps[0];

  console.log('\n--- opens on the derecho archive');
  say('hazard menu carries all four',
      [...$('hazSel').options].map(o=>o.value).join(',')==='derecho,hail,tornado,wind',
      [...$('hazSel').options].map(o=>o.value).join(','));
  say('opens on derecho events',$('hazSel').value==='derecho');
  say('ranked list hidden for derechos',$('ranks').style.display==='none');
  say('confidence + derecho menus shown',$('tierWrap').style.display===''&&
      $('evWrap').style.display==='');
  say('view toggle hidden',$('viewWrap').style.display==='none');
  say('swath track drawn',(M._layers.find(l=>l._lines&&l._lines.length)||{})._lines?.length===1);
  say('footer credits the archive',/Squitieri, Wade and Jirak \(2026\)/.test($('foot').innerHTML));
  say('the report file was NOT fetched',!fetched.some(u=>/_pts\./.test(u)),
      fetched.filter(u=>/data\//.test(u)).join(' '));

  console.log('\n--- the biggest tornado days');
  $('hazSel').value='tornado'; await $('hazSel').onchange({target:{value:'tornado'}});
  await new Promise(r=>setTimeout(r,900));
  say('ranked list shown',$('ranks').style.display==='');
  say('derecho-only controls hidden',$('tierWrap').style.display==='none'&&
      $('evWrap').style.display==='none');
  say('view toggle shown, on counties',$('viewWrap').style.display===''&&
      $('viewSel').value==='cty');
  const raw=gz('events_tornado.json.gz');
  say('national list is the builder\'s top 100',rows().length===100,rows().length+' rows');
  say('#1 nationally is the 1974 Super Outbreak',
      rows()[0].dataset.d==='1974-04-03',rows()[0].dataset.d);
  say('#2 is 27 April 2011',rows()[1].dataset.d==='2011-04-27',rows()[1].dataset.d);
  say('the page order matches the data file',
      rows().map(r=>r.dataset.d).join()===raw.rank[0].US.map(([i])=>raw.days[i]).join());
  say('it opens on the top day, not a blank map',
      $('mapTitle').textContent==='3 Apr 1974',$('mapTitle').textContent);
  say('counties are shaded',(M._layers.filter(l=>l._data&&l._data.features&&
      l._data.features.length>3000).length)>0);
  /* The choropleth layer is built without onEachFeature (nothing is clickable),
     so there are no per-feature stubs to inspect. Ask the page's own style
     function instead — that is what Leaflet would call. */
  const shaded=()=>{
    const on=M._layers.some(x=>x._data&&x._data.features&&x._data.features.length>3000);
    if(!on) return 0;
    return w.eval("shadedCount()");
  };
  say('only the involved counties are shaded',shaded()===176,shaded()+' of 3222');
  say('footer states counties and reports',/<b>176<\/b> counties/.test($('foot').innerHTML),
      ($('foot').innerHTML.match(/<b>\d+<\/b> counties and <b>\d+<\/b> reports[^.]*/)||[''])[0]);

  console.log('\n--- threshold changes the list');
  $('thrSel').value=3; $('thrSel').onchange({target:{value:'3'}});
  await new Promise(r=>setTimeout(r,300));
  say('EF3+ list is a different ranking',rows()[0].dataset.d==='1974-04-03'&&
      rows().map(r=>r.dataset.d).join()!==raw.rank[0].US.map(([i])=>raw.days[i]).join());
  say('EF3+ matches the file',
      rows().map(r=>r.dataset.d).join()===raw.rank[3].US.map(([i])=>raw.days[i]).join());
  say('the county count falls with the threshold',
      +rows()[0].querySelectorAll('td')[2].textContent===119,
      rows()[0].querySelectorAll('td')[2].textContent+' counties at EF3+ vs 176 at EF0+');
  $('thrSel').value=0; $('thrSel').onchange({target:{value:'0'}});
  await new Promise(r=>setTimeout(r,300));

  console.log('\n--- by state');
  $('regSel').value='IN'; $('regSel').onchange({target:{value:'IN'}});
  await new Promise(r=>setTimeout(r,300));
  say('Indiana list capped at 50',rows().length===50,rows().length+' rows');
  say('matches the file for Indiana',
      rows().map(r=>r.dataset.d).join()===raw.rank[0].IN.map(([i])=>raw.days[i]).join());
  say('header names the state and the cap',/Indiana/.test($('rankHead').innerHTML)&&
      /Top 50/.test($('rankHead').innerHTML));
  /* A state with fewer than 50 qualifying days must show what it has and say so. */
  $('regSel').value='RI'; $('regSel').onchange({target:{value:'RI'}});
  await new Promise(r=>setTimeout(r,300));
  say('Rhode Island shows all it has',rows().length===raw.rank[0].RI.length&&rows().length<50,
      rows().length+' days');
  say('and says the list is short',/Only \d+ qualifying day/.test($('rankHead').innerHTML),
      ($('rankHead').innerHTML.match(/Only [^<]*/)||[''])[0]);
  $('regSel').value=''; $('regSel').onchange({target:{value:''}});
  await new Promise(r=>setTimeout(r,300));

  console.log('\n--- switching cannot strand the reader');
  const rowsAt=()=>rows().map(r=>r.dataset.d);
  $('regSel').value='FL'; $('regSel').onchange({target:{value:'FL'}});
  await new Promise(r=>setTimeout(r,300));
  say('a state switch lands on a day that is in the list',rowsAt().includes(w.eval('curDay()')),
      w.eval('curDay()'));
  $('thrSel').value=3; $('thrSel').onchange({target:{value:'3'}});
  await new Promise(r=>setTimeout(r,300));
  say('a threshold switch does too',rows().length===0||rowsAt().includes(w.eval('curDay()')),
      w.eval('curDay()')+' among '+rows().length);
  $('thrSel').value=0; $('thrSel').onchange({target:{value:'0'}});
  $('regSel').value=''; $('regSel').onchange({target:{value:''}});
  await new Promise(r=>setTimeout(r,300));

  console.log('\n--- points are fetched only on demand');
  say('still not fetched',!fetched.some(u=>/_pts\./.test(u)));
  $('viewSel').value='pts'; await $('viewSel').onchange({target:{value:'pts'}});
  await new Promise(r=>setTimeout(r,600));
  say('now fetched, once',fetched.filter(u=>/_pts\./.test(u)).length===1,
      fetched.filter(u=>/_pts\./.test(u)).join(' '));
  const marks=()=>{const g=M._layers.find(l=>l._marks&&l._marks.length);return g?g._marks.length:0;};
  say('reports drawn as points',marks()>100,marks()+' points');
  say('county shading removed',shaded()===0);
  $('viewSel').value='cty'; await $('viewSel').onchange({target:{value:'cty'}});
  await new Promise(r=>setTimeout(r,300));
  say('back to counties',shaded()>0&&marks()===0);

  console.log('\n--- a shared link reopens the same day');
  const d2=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
    url:'http://localhost/scsevents.html#h=hail&t=2&r=&d=2012-03-02&v=cty'});
  const w2=d2.window;
  Object.assign(w2,{fetch:w.fetch,DecompressionStream:w.DecompressionStream,Blob:w.Blob,
    Response:w.Response,topojson:w.topojson,L:w.L});
  w2.URL.createObjectURL=()=>'blob:x'; w2.URL.revokeObjectURL=()=>{};
  w2.navigator.clipboard={writeText:async()=>{}};
  w2.eval(html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g,''));
  await new Promise(r=>setTimeout(r,3500));
  say('link restores hazard, threshold and day',
      w2.document.getElementById('hazSel').value==='hail'&&
      w2.document.getElementById('thrSel').value==='2'&&
      w2.document.getElementById('mapTitle').textContent==='2 Mar 2012',
      w2.document.getElementById('mapTitle').textContent);
  say('and it is the #1 ≥2″ hail day',
      w2.document.getElementById('rankBody').querySelector('tr').dataset.d==='2012-03-02');

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e); process.exit(2);});

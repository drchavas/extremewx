/* Derecho event mode in scstrend.html. The things worth testing are the ones a
   screenshot would not catch: that the envelope encloses what it claims to, that
   the clock survives events running past UTC midnight, and that switching in and
   out of event mode leaves the time-series machinery intact. */
const fs=require('fs'), zlib=require('zlib'), path=require('path'), {JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scstrend.html'),'utf8');
const errors=[];
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
                          url:'http://localhost/extremewx/scs/trends/scstrend.html'});
const w=dom.window;
w.fetch=async u=>{const p=path.join(ROOT,u);
  if(!fs.existsSync(p)) throw new Error('404 '+u);
  const b=fs.readFileSync(p);
  return{ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b};};
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));

const maps=[];
const B={getSouth:()=>24,getNorth:()=>50,getWest:()=>-126,getEast:()=>-66,
         getCenter:()=>({lat:39,lng:-96}),pad(){return this}};
function mkMap(id){
  const h={};
  const m={id,_c:{lat:39.8,lng:-86.3},_z:6,_layers:[],_fit:0,_bounds:null,
    setView(c,z){this._c=Array.isArray(c)?{lat:c[0],lng:c[1]}:c;if(z!=null)this._z=z;
                 (h.move||[]).forEach(f=>f());return this},
    fitBounds(b){this._fit++;this._bounds=b;this._z=7;(h.move||[]).forEach(f=>f());return this},
    getCenter(){return this._c},getZoom(){return this._z},
    on(e,f){e.split(' ').forEach(x=>(h[x]=h[x]||[]).push(f))},
    removeLayer(l){this._layers=this._layers.filter(x=>x!==l)},
    addLayer(l){this._layers.push(l)},eachLayer(cb){this._layers.slice().forEach(cb)},
    invalidateSize(){},_h:h};
  maps.push(m);return m;
}
w.L={map:mkMap,
  tileLayer:()=>({addTo(m){m.addLayer(this);return this}}),
  layerGroup:()=>({_marks:[],_polys:[],addTo(m){m.addLayer(this);return this}}),
  circleMarker:(ll,o)=>({_ll:ll,_o:o,bindTooltip(f){this._tip=f;return this},
    on(){return this},addTo(g){g._marks.push(this);return this}}),
  polygon:(ll,o)=>({_ll:ll,_o:o,addTo(g){g._polys.push(this);return this}}),
  DomEvent:{stop(){}},TileLayer:function(){},
  geoJSON:(d,o)=>{const ls=[];
    if(d&&d.features&&o&&o.onEachFeature)d.features.forEach(f=>{const l={feature:f,_h:{},
      _style:(typeof o.style==='function'?o.style(f):o.style),
      on(e,fn){this._h[e]=fn},bindTooltip(fn){this._tip=fn;return this},
      setStyle(){},getBounds:()=>B};
      ls.push(l);o.onEachFeature(f,l);});
    return{_data:d,_layers:ls,addTo(m){m.addLayer(this);return this},getLayers(){return ls},
           setStyle(){},bringToFront(){},getBounds:()=>B};}};
w.L.TileLayer.prototype={};
w.addEventListener('error',e=>errors.push('window error: '+e.message));
process.on('unhandledRejection',e=>errors.push('unhandled rejection: '+(e&&e.message)));
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);

const $=id=>w.document.getElementById(id);
const fire=(id,t)=>{const e=$(id);const h=e['on'+t];if(h)return h.call(e,{target:e});};
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));
const isCounty=l=>l._data&&l._data.features&&l._data.features.length>3000;
const grp=()=>maps[0]._layers.filter(l=>l._polys).pop();
const ptInRing=(x,y,ring)=>{let c=false;
  for(let i=0,n=ring.length;i<n;i++){const [x1,y1]=ring[i],[x2,y2]=ring[(i+1)%n];
    if(((y1>y)!==(y2>y))&&x<(x2-x1)*(y-y1)/(y2-y1)+x1)c=!c;}
  return c;};

(async()=>{
  await new Promise(r=>setTimeout(r,3200));
  const [A,Bm]=maps;

  console.log('\n--- entering event mode');
  say('Derecho is in the hazard menu',
      [...$('hazSel').options].some(o=>o.value==='derecho'),
      [...$('hazSel').options].map(o=>o.value).join(','));
  $('hazSel').value='derecho'; await $('hazSel').onchange({target:{value:'derecho'}});
  await new Promise(r=>setTimeout(r,900));
  say('trend column hidden',$('trendCol').style.display==='none');
  say('timeseries panels hidden',$('panels').style.display==='none');
  say('county fills removed',!A._layers.some(isCounty));
  say('menu relabelled Derecho',
      w.document.querySelector('label[for="ctySel"]').textContent==='Derecho',
      w.document.querySelector('label[for="ctySel"]').textContent);
  const opts=[...$('ctySel').options].slice(1);
  say('54 dates listed',opts.length===54,opts.length+' dates');
  say('newest first',/2024/.test(opts[0].textContent),opts[0].textContent);
  say('footer explains the 54-of-147 gap',/<b>54 of the 147<\/b>/.test($('foot').innerHTML),
      ($('foot').innerHTML.match(/<b>\d+ of the 147<\/b>/)||[''])[0]);
  say('the window opens wide enough to show the 1990s',
      $('y0In').value==='1995'&&$('y1In').value==='2024',
      $('y0In').value+'-'+$('y1In').value);

  console.log('\n--- the 10 Aug 2020 Corn Belt derecho');
  $('ctySel').value='2020-08-10'; fire('ctySel','change');
  await new Promise(r=>setTimeout(r,200));
  const g=grp();
  say('envelope drawn',g._polys.length===1,g._polys.length+' polygons');
  say('envelope is dashed and closed',!!g._polys[0]._o.dashArray&&g._polys[0]._ll.length>=3,
      g._polys[0]._ll.length+' vertices');
  say('reports plotted',g._marks.length>400,g._marks.length+' markers');
  say('map framed on the swath',A._fit>0&&Bm.getZoom()===A.getZoom(),'z'+A.getZoom());

  // the claim the envelope makes is that it encloses the qualifying reports
  const ev=w.eval("JSON.parse(JSON.stringify(curEvent()))");
  const min=w.eval("thrSpec().min"), tk=w.eval("thrSpec().key");
  const ring=ev.hull[tk];
  const out=ev.reports.filter(r=>r.d&&r.kt>=min)
    .filter(r=>!ring.some(p=>p[0]===r.lo&&p[1]===r.la)&&!ptInRing(r.lo,r.la,ring));
  say('every qualifying swath report is inside the envelope',out.length===0,
      out.length+' outside of '+ev.reports.filter(r=>r.d&&r.kt>=min).length);
  say('off-swath reports kept but greyed',
      ev.reports.some(r=>!r.d)&&g._marks.length<ev.reports.length+1);

  console.log('\n--- the readout');
  const foot=$('foot').innerHTML;
  say('start and stop times shown',/\d\d:\d\dZ.*→.*\d\d:\d\dZ/.test(foot),
      (foot.match(/\d\d:\d\dZ[^<]*→[^<]*/)||[''])[0].trim());
  say('crossing UTC midnight names the next day',/→ <\/b>?\s*\d\d:\d\dZ 11 Aug|→ 0\d:\d\dZ 11 Aug/.test(foot)
      ||/11 Aug/.test(foot), (foot.match(/→ [^<]*/)||[''])[0]);
  say('duration given',/\(\d+\.\d h\)/.test(foot),(foot.match(/\(\d+\.\d h\)/)||[''])[0]);
  say('extent and states given',/km across \d+ states/.test(foot),
      (foot.match(/[\d,]+ km across \d+ states/)||[''])[0]);
  say('peak gust given',/peak <b>126 kt<\/b>/.test(foot));
  say('paper is credited',/Shourd and Kaplan \(2025\)/.test(foot));
  say('gust colour bar shown',/gust, kt/.test($('cbClim').innerHTML));
  say('trend colour bar cleared',$('cbTrend').innerHTML==='');

  console.log('\n--- threshold changes the envelope');
  const v0=grp()._polys[0]._ll.length;
  $('thrSel').value=2; fire('thrSel','change');
  await new Promise(r=>setTimeout(r,200));
  say('envelope redrawn for >=74 kt',grp()._polys.length===1);
  say('a stricter threshold does not enlarge it',grp()._polys[0]._ll.length<=v0+2,
      v0+' -> '+grp()._polys[0]._ll.length+' vertices');
  $('thrSel').value=0; fire('thrSel','change');

  console.log('\n--- the year window filters the list');
  $('y0In').value=2020; fire('y0In','change');
  await new Promise(r=>setTimeout(r,200));
  const yrs=[...$('ctySel').options].slice(1).map(o=>o.value.slice(0,4));
  say('only 2020+ dates listed',yrs.length>0&&yrs.every(y=>+y>=2020),
      yrs.length+' dates, earliest '+Math.min(...yrs.map(Number)));
  $('y0In').value=1995; fire('y0In','change');

  console.log('\n--- leaving event mode restores the time series');
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,900));
  say('the analysis period comes back, not 1995',
      $('y0In').value==='2000'&&$('y1In').value==='2024',
      $('y0In').value+'-'+$('y1In').value);
  say('trend column back',$('trendCol').style.display==='');
  say('panels back',$('panels').style.display===''&&$('card').innerHTML.length>4000);
  say('county fills back',A._layers.some(isCounty));
  say('both colour bars back',/linear-gradient/.test($('cbClim').innerHTML)&&
                              /linear-gradient/.test($('cbTrend').innerHTML));

  console.log('\n--- a shared link reopens the same event');
  const d2=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,
    url:'http://localhost/scstrend.html#h=derecho&t=0&r=&c=2022-05-12&p=1995-2024'});
  const w2=d2.window;
  Object.assign(w2,{fetch:w.fetch,DecompressionStream:w.DecompressionStream,Blob:w.Blob,
    Response:w.Response,topojson:w.topojson,L:w.L});
  w2.URL.createObjectURL=()=>'blob:x'; w2.URL.revokeObjectURL=()=>{};
  w2.navigator.clipboard={writeText:async()=>{}};
  w2.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await new Promise(r=>setTimeout(r,3200));
  say('link restores hazard and date',
      w2.document.getElementById('hazSel').value==='derecho'&&
      w2.document.getElementById('ctySel').value==='2022-05-12',
      w2.document.getElementById('hazSel').value+' / '+w2.document.getElementById('ctySel').value);
  say('and its readout',/12 May 2022/.test(w2.document.getElementById('foot').innerHTML));

  console.log('\n--- errors captured: '+errors.length);
  errors.forEach(e=>console.log('  '+e));
  process.exit(errors.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR',e);process.exit(2);});

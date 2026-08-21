const fs=require('fs'),zlib=require('zlib'),path=require('path'),{JSDOM}=require('jsdom');
const ROOT=process.argv[2];
const html=fs.readFileSync(path.join(ROOT,'scstrend_grid.html'),'utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/x.html'});
const w=dom.window;
w.fetch=async u=>{const b=fs.readFileSync(path.join(ROOT,u));
  return{ok:true,status:200,json:async()=>JSON.parse(b.toString()),arrayBuffer:async()=>b};};
w.DecompressionStream=function(){};
w.Blob=class{constructor(p){this.parts=p} stream(){return this} pipeThrough(){return this}};
w.Response=class{constructor(x){this.x=x} async text(){return zlib.gunzipSync(Buffer.from(this.x.parts[0])).toString()}};
w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{};
w.navigator.clipboard={writeText:async()=>{}};
w.topojson=require(path.join(process.env.NODE_PATH,'topojson-client'));
const maps=[];const B={getSouth:()=>24,getNorth:()=>50,getWest:()=>-126,getEast:()=>-66,getCenter:()=>({lat:39,lng:-96})};
function mk(id){const h={};const m={id,_c:{lat:39.8,lng:-86.3},_z:4,_layers:[],_fit:0,
  setView(c,z){this._c=Array.isArray(c)?{lat:c[0],lng:c[1]}:c;if(z!=null)this._z=z;(h.move||[]).forEach(f=>f());return this},
  fitBounds(){this._fit++;this._z=7;return this},getCenter(){return this._c},getZoom(){return this._z},
  on(e,f){e.split(' ').forEach(x=>(h[x]=h[x]||[]).push(f))},removeLayer(l){this._layers=this._layers.filter(x=>x!==l)},
  addLayer(l){if(!this._layers.includes(l))this._layers.push(l)},hasLayer(l){return this._layers.includes(l)},
  eachLayer(cb){this._layers.slice().forEach(cb)},invalidateSize(){},_h:h};maps.push(m);return m;}
const gj=[];
w.L={map:mk,tileLayer:()=>({addTo(m){m.addLayer(this);return this}}),
  layerGroup:()=>({_marks:[],addTo(m){m.addLayer(this);return this}}),
  circleMarker:()=>({bindTooltip(){return this},on(){return this},addTo(g){g._marks.push(this);return this}}),
  DomEvent:{stop(){}},TileLayer:function(){},
  geoJSON:(d,o)=>{const ls=[];
    if(d&&d.features&&o&&o.onEachFeature) d.features.forEach(f=>{const l={feature:f,_h:{},
      on(e,fn){this._h[e]=fn},bindTooltip(fn){this._tip=fn;return this},setStyle(){},getBounds:()=>B};
      ls.push(l);o.onEachFeature(f,l);});
    const L={_data:d,_layers:ls,addTo(m){m.addLayer(this);return this},getLayers(){return ls},
      setStyle(){},bringToFront(){},getBounds:()=>B};gj.push(L);return L;}};
w.L.TileLayer.prototype={};
w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const $=id=>w.document.getElementById(id);
const say=(l,ok,x)=>console.log((ok?'  ok   ':'  FAIL ')+l+(x?'  — '+x:''));
const svg=()=>$('card').innerHTML;
(async()=>{
  await new Promise(r=>setTimeout(r,3000));

  console.log('\n--- B2: a quiet box is 0.00, not missing');
  const stats=t=>w.eval(`(function(){const cm=cellMetrics();let nan=0,zero=0,fin=0;
    for(let i=0;i<cm.mean.length;i++){ if(!isFinite(cm.mean[i])) nan++;
      else { fin++; if(cm.mean[i]===0) zero++; } } return {nan,zero,fin};})()`);
  $('hazSel').value='tornado'; await $('hazSel').onchange({target:{value:'tornado'}});
  await new Promise(r=>setTimeout(r,800));
  $('thrSel').value=3; $('thrSel').onchange({target:{value:3}});   // EF3+
  const s1=stats();
  say('tornado EF3+: no box left as no-data',s1.nan===0,`NaN=${s1.nan} finite=${s1.fin} of which zero=${s1.zero}`);
  say('and the true zeros are present',s1.zero>100,`${s1.zero} boxes at exactly 0.00`);

  console.log('\n--- B3: panels obey the same gate as the map');
  // wind >=65kt at 37N 117W was the audit's example: map grey, panel "p < 0.001"
  $('hazSel').value='wind'; await $('hazSel').onchange({target:{value:'wind'}});
  await new Promise(r=>setTimeout(r,800));
  $('thrSel').value=2; $('thrSel').onchange({target:{value:2}});
  const pick=ci=>{ $('ctySel').value=String(ci); $('ctySel').onchange({target:$('ctySel')});
    return w.eval(`(function(){const cm=cellMetrics();const i=selCell();
      return {trend:cm.trend[i], place:placeLabel()};})()`); };
  const probe=pick(184);          // 37N 117W, the audit's example
  say('map still refuses that box (trend NaN)',!isFinite(probe.trend),probe.place);
  say('panel no longer prints a slope',!/slope [-+]/.test(svg()));
  say('panel explains why instead',/No trend fitted/.test(svg()),
      (svg().match(/No trend fitted[^<]*/)||[''])[0].slice(0,74));

  console.log('\n--- B3b: a dense box still gets its fit');
  const dense=pick(222);          // 39N 101W, dense Plains box
  say('dense Plains box is fitted on the map',isFinite(dense.trend),
      dense.place+' trend='+dense.trend.toFixed(2));
  say('and the panel shows a slope',/slope [-+]/.test(svg()),
      (svg().match(/slope [^<·]*/)||[''])[0]);

  console.log('\n--- B1: To never displays past the record');
  $('hazSel').value='hail'; await $('hazSel').onchange({target:{value:'hail'}});
  await new Promise(r=>setTimeout(r,800));
  for(const y of [2023,2024]){
    $('y0In').value=y; $('y0In').onchange({target:$('y0In')});
    say(`From ${y} -> To stays within the record`,+$('y1In').value<=2024,
        `From ${$('y0In').value} To ${$('y1In').value}`);
  }

  console.log('\n--- B4: a too-short window says so');
  $('y0In').value=2015; $('y0In').onchange({target:$('y0In')});
  $('y1In').value=2020; $('y1In').onchange({target:$('y1In')});
  say('trend subtitle explains the empty map',/No trends shown/.test($('trendSub').textContent),
      $('trendSub').textContent.slice(0,86));
  process.exit(0);
})();

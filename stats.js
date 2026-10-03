(function(){
const RAPE_DAY=31516/365, HAR_DAY=85300/365, MS=86400000, IST=19800000;
const SINCE_2023=Date.UTC(2023,0,1)-IST, RAPE_2014_22=299520;
const $=id=>document.getElementById(id);
const fmt=(n,d=0)=>n.toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});
function tick(){
  const now=Date.now(), dayStart=Math.floor((now+IST)/MS)*MS-IST;
  const sd=now-dayStart, sy=now-SINCE_2023;
  const rd=sd/MS*RAPE_DAY, hd=sd/MS*HAR_DAY;
  $('st-rape-all').textContent=fmt(RAPE_2014_22+sy/MS*RAPE_DAY,2);
  $('st-rape-day').textContent=fmt(rd,2);
  $('st-har-day').textContent=fmt(hd,2);
  $('st-har-all').textContent=fmt(sy/MS*HAR_DAY,0);
  const left=(Math.ceil(rd)-rd)/RAPE_DAY*MS/1000, m=Math.floor(left/60), s=Math.floor(left%60);
  $('st-next').textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  const hl=$('hot-list');
  if(hl && !hl.children.length && window.state && state.zones){
    hl.innerHTML=state.zones.filter(z=>z.level!=='green').sort((a,b)=>(a.level==='red'?0:1)-(b.level==='red'?0:1)).slice(0,8)
      .map(z=>`<button type="button" class="hot-item" data-id="${z.id}"><i style="background:${LEVEL_COLOR[z.level]}"></i>${z.name}<span>${LEVEL_LABEL[z.level]}</span></button>`).join('');
    hl.querySelectorAll('.hot-item').forEach(b=>b.addEventListener('click',()=>{
      const z=state.zones.find(x=>x.id===b.dataset.id); if(map&&z){map.flyTo([z.lat,z.lng],9,{duration:1.2}); openZoneSheet(z.id);}
    }));
  }
}
const card=$('stats-card');
$('stats-toggle').addEventListener('click',()=>card.classList.toggle('open'));
tick(); setInterval(tick,1000);
})();

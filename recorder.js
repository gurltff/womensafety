'use strict';
/* =====================================================================
   SafeCircle India: evidence recorder.
   Records audio with the microphone, draws a live waveform, and keeps the
   recordings in this browser (IndexedDB) until you download or delete them.
   ===================================================================== */
const Recorder = (() => {
  const DB_NAME = 'safecircle', STORE = 'recordings', MAX_MS = 30*60*1000;
  let stream = null, rec = null, chunks = [], startedAt = 0, tick = null, raf = null, analyser = null, source = null, startPos = null;
  const listeners = new Set();

  /* ---------- storage ---------- */
  function openDB(){
    return new Promise((resolve, reject) => {
      if(!('indexedDB' in window)) return reject(new Error('no indexedDB'));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, {keyPath:'id'}); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function tx(mode, fn){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
      const req = fn(st);
      t.oncomplete = () => { db.close(); resolve(req && req.result); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  }
  const putItem = item => tx('readwrite', st => st.put(item));
  const allItems = () => tx('readonly', st => st.getAll()).then(list => (list || []).sort((a, b) => b.ts - a.ts));
  const delItem = id => tx('readwrite', st => st.delete(id));
  async function clearAll(){ try{ await tx('readwrite', st => st.clear()); }catch(e){} }

  /* ---------- recording ---------- */
  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const isRecording = () => !!rec && rec.state === 'recording';
  function pickType(){
    return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  }
  async function start(){
    if(isRecording()) return true;
    if(!supported()){ toast("Recording isn't supported in this browser"); return false; }
    if(!isSecureCtx()){ toast('Recording needs the https:// version of the app'); return false; }
    try{ stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false}}); }
    catch(e){ toast(e.name === 'NotAllowedError' ? 'Microphone access was denied' : "Couldn't start the microphone"); return false; }
    const type = pickType();
    rec = new MediaRecorder(stream, type ? {mimeType:type} : undefined);
    chunks = [];
    rec.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.start(1000); // 1 s slices: if the tab dies we still have most of it in memory
    startedAt = Date.now();
    startPos = currentKnownPosition();
    requestWakeLock('recorder');
    vibrate(60);
    const ctx = getAudio();
    if(ctx){
      try{
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        const mute = ctx.createGain(); mute.gain.value = 0; // keeps the graph pulling data without playing it back
        source.connect(analyser); analyser.connect(mute); mute.connect(ctx.destination);
      }catch(e){ analyser = null; }
    }
    clearInterval(tick);
    tick = setInterval(() => { emit(); if(Date.now() - startedAt > MAX_MS) stop(); }, 500);
    drawWave();
    emit();
    return true;
  }
  function stop(){
    if(!isRecording()) return;
    rec.stop();
  }
  async function finish(){
    const dur = Date.now() - startedAt;
    const type = (rec && rec.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, {type});
    if(stream) stream.getTracks().forEach(t => t.stop());
    if(source) try{ source.disconnect(); }catch(e){}
    stream = null; source = null; analyser = null; rec = null; chunks = [];
    clearInterval(tick); cancelAnimationFrame(raf);
    releaseWakeLock('recorder');
    const item = {id:'rec' + startedAt.toString(36), ts:startedAt, dur, type, size:blob.size, blob, pos:startPos ? {lat:startPos.lat, lng:startPos.lng} : null};
    try{ await putItem(item); toast(`Recording saved (${fmtClockDur(dur)})`); }
    catch(e){ toast("Couldn't save the recording. Download it from the list next time"); }
    emit();
    renderList();
  }

  /* ---------- UI ---------- */
  function fmtClockDur(ms){ const s = Math.round(ms/1000); return Math.floor(s/60) + ':' + String(s%60).padStart(2, '0'); }
  function elapsed(){ return isRecording() ? Date.now() - startedAt : 0; }
  function emit(){ listeners.forEach(fn => fn(isRecording(), elapsed())); }
  function onChange(fn){ listeners.add(fn); }
  function drawWave(){
    const canvas = $('rec-wave');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const buf = new Uint8Array(1024);
    const loop = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if(canvas.width !== w*dpr){ canvas.width = w*dpr; canvas.height = h*dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
      if(analyser){
        analyser.getByteTimeDomainData(buf);
        ctx.strokeStyle = '#FF3B4E'; ctx.lineWidth = 1.6; ctx.beginPath();
        for(let i = 0; i < buf.length; i++){
          const x = i/(buf.length - 1)*w, y = h/2 + (buf[i] - 128)/128*h*.45;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      if(isRecording()) raf = requestAnimationFrame(loop);
      else ctx.clearRect(0, 0, w, h);
    };
    loop();
  }
  async function renderList(){
    const el = $('rec-list');
    if(!el) return;
    let items = [];
    try{ items = await allItems(); }catch(e){}
    el.querySelectorAll('audio').forEach(a => { if(a.src) URL.revokeObjectURL(a.src); });
    if(!items.length){ el.innerHTML = '<p class="hint">No recordings yet. They stay on this device until you download or delete them.</p>'; return; }
    el.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'rec-item';
      const d = new Date(it.ts);
      const ext = /mp4/.test(it.type) ? 'm4a' : /ogg/.test(it.type) ? 'ogg' : 'webm';
      const name = `safecircle-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
      const url = URL.createObjectURL(it.blob);
      row.innerHTML = `
        <div class="rec-meta"><b></b><small></small></div>
        <audio controls preload="none"></audio>
        <div class="rec-actions"><a class="pill-btn" download>Download</a><button type="button" class="pill-btn danger">Delete</button></div>`;
      row.querySelector('b').textContent = d.toLocaleString('en-IN', {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
      row.querySelector('small').textContent = `${fmtClockDur(it.dur)} · ${Math.max(1, Math.round(it.size/1024))} KB${it.pos ? ` · ${it.pos.lat.toFixed(4)}, ${it.pos.lng.toFixed(4)}` : ''}`;
      row.querySelector('audio').src = url;
      const a = row.querySelector('a'); a.href = url; a.download = name;
      row.querySelector('button').addEventListener('click', async () => {
        if(!(await confirmDialog({title:'Delete this recording?', body:"It's only stored on this device, so it can't be recovered.", ok:'Delete', danger:true}))) return;
        await delItem(it.id);
        renderList();
      });
      el.appendChild(row);
    });
  }

  return {start, stop, isRecording, elapsed, onChange, renderList, clearAll, supported, fmtClockDur};
})();

/* Toolkit card + SOS button wiring */
(function(){
  const btn = $('rec-toggle'), sosBtn = $('btn-sos-record');
  const paint = (on, ms) => {
    btn.classList.toggle('recording', on);
    btn.setAttribute('aria-pressed', String(on));
    $('rec-label').textContent = on ? 'Stop & save' : 'Start recording';
    $('rec-time').textContent = Recorder.fmtClockDur(ms);
    $('rec-card').classList.toggle('is-recording', on);
    sosBtn.classList.toggle('recording', on);
    sosBtn.textContent = on ? `■ Stop recording · ${Recorder.fmtClockDur(ms)}` : '● Record audio evidence';
  };
  Recorder.onChange(paint);
  const toggle = () => { Recorder.isRecording() ? Recorder.stop() : Recorder.start(); };
  btn.addEventListener('click', toggle);
  sosBtn.addEventListener('click', toggle);
  paint(false, 0);
})();

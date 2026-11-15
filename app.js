(() => {
"use strict";
const CFG = window.RD_CONFIG;
const ACCOUNTS = [["dockcharged","DockCharged"],["momentum","Momentum"]];
const REASONS = [["switcheroo","Switcheroo"],["empty_box","Empty box"],["wrong_item","Wrong item"],["damaged_used","Damaged / used"]];
// All new photos go in one pile ("photos"); Claude sorts them. Older rows used the per-type columns.
const SLOT_KEYS = ["photos","slip","lpn","item","packaging"];
const STATUS = {
  draft:["Draft","draft"], ready:["Sent to Claude",""], filing:["Claude is filing",""],
  filed:["Filed, waiting on Amazon",""], needs_you:["Needs you","needs_you"],
  won:["Reimbursed","won"], lost:["Denied","lost"]
};
const TABS = [["open","Open"],["needs_you","Needs you"],["filed","Filed"],["closed","Closed"],["all","All"]];
// Sheet columns. Claude's skill reads/writes the same names. Append new columns at the end only.
const COLS = ["id","created_at","updated_at","status","account","reason","order_id","lpn","notes",
  "slip_photos","lpn_photos","item_photos","packaging_photos","drive_folder",
  "shipment_id","asin","sku","product_name","amount","claim_type","case_id","filed_at",
  "claude_note","question","reply","recovered_amount","closed_at","sent_at","replied_at","photos"];
const TAB = "Returns";
const LASTCOL = colLetter(COLS.length);

const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nowIso = () => new Date().toISOString();
const fmtDate = iso => { try { return iso ? new Date(iso).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : ""; } catch { return ""; } };
const label = (list, k) => (list.find(x => x[0] === k) || [k, k || "—"])[1];
const ls = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function colLetter(n){ let s=""; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); } return s; }
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,2800); }

// ---------------- auth (OAuth implicit redirect; works inside a home-screen app) ----------------
let token = null;
function redirectUri(){ return location.origin + location.pathname; }
function readHashToken(){
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get("access_token") && !p.get("error")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  if (p.get("state") !== ls.get("rd-state")) return {error:"state_mismatch"};
  if (p.get("error")) return {error: p.get("error")};
  return {token: p.get("access_token"), exp: Date.now() + (Number(p.get("expires_in")||3600) - 120) * 1000};
}
function signIn(prompt){
  if (!CFG.clientId || CFG.clientId.includes("REPLACE")) { alert("Returns Desk is almost ready: its Google sign-in key isn't set up yet. Ask Claude to finish setup."); return; }
  const state = Math.random().toString(36).slice(2);
  ls.set("rd-state", state);
  const q = new URLSearchParams({client_id: CFG.clientId, redirect_uri: redirectUri(), response_type: "token",
    scope: CFG.scopes, include_granted_scopes: "true", state, hd: CFG.hostedDomain});
  if (prompt) q.set("prompt", prompt);
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
}
function signOut(){ ls.set("rd-token", null); ls.set("rd-signed", null); token = null; render(); }
function loadToken(){
  const h = readHashToken();
  if (h && h.token) { ls.set("rd-token", JSON.stringify(h)); ls.set("rd-signed","1"); return {ok:true}; }
  if (h && h.error) return {error:h.error};
  try { const t = JSON.parse(ls.get("rd-token") || "null"); if (t && t.exp > Date.now()) return {ok:true, t}; } catch {}
  return {expired: !!ls.get("rd-signed")};
}
function currentToken(){ try { const t = JSON.parse(ls.get("rd-token")||"null"); return t && t.exp > Date.now() ? t.token : null; } catch { return null; } }

async function api(url, opts={}){
  const t = currentToken();
  if (!t) { signIn(); throw new Error("reauth"); }
  const r = await fetch(url, {...opts, headers: {...(opts.headers||{}), Authorization: "Bearer " + t}});
  if (r.status === 401) { ls.set("rd-token", null); signIn(); throw new Error("reauth"); }
  if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch {} const e = new Error(m || ("HTTP " + r.status)); e.status = r.status; throw e; }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r;
}
const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const jpost = (url, body, method="POST") => api(url, {method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});

// ---------------- storage: Drive folder + Google Sheet ----------------
let folderId = ls.get("rd-folder"), sheetId = ls.get("rd-sheet");
async function findOne(q){ const r = await api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&pageSize=5`); return r.files && r.files[0] ? r.files[0].id : null; }
async function ensureStore(){
  if (folderId && sheetId) return;
  folderId = await findOne(`name='${CFG.folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  if (!folderId) folderId = (await jpost(`${DRIVE}/files?fields=id`, {name: CFG.folderName, mimeType:"application/vnd.google-apps.folder"})).id;
  sheetId = await findOne(`name='${CFG.sheetName}' and mimeType='application/vnd.google-apps.spreadsheet' and '${folderId}' in parents and trashed=false`);
  if (!sheetId) {
    const s = await jpost(SHEETS, {properties:{title: CFG.sheetName}, sheets:[{properties:{title: TAB, sheetId: 0, gridProperties:{frozenRowCount:1}}}]});
    sheetId = s.spreadsheetId;
    const meta = await api(`${DRIVE}/files/${sheetId}?fields=parents`);
    await api(`${DRIVE}/files/${sheetId}?addParents=${folderId}&removeParents=${(meta.parents||[]).join(",")}&fields=id`, {method:"PATCH"});
    await jpost(`${SHEETS}/${sheetId}/values/${TAB}!A1:${LASTCOL}1?valueInputOption=RAW`, {values:[COLS]}, "PUT");
  }
  ls.set("rd-folder", folderId); ls.set("rd-sheet", sheetId);
}

let header = COLS.slice();
async function fetchRows(){
  const r = await api(`${SHEETS}/${sheetId}/values/${TAB}!A1:${colLetter(Math.max(COLS.length, 40))}`);
  const vals = r.values || [];
  header = (vals[0] && vals[0].length) ? vals[0] : COLS.slice();
  // Add any column the sheet is missing (app updated after the sheet was made).
  const missing = COLS.filter(c => !header.includes(c));
  if (missing.length) {
    header = header.concat(missing);
    await jpost(`${SHEETS}/${sheetId}/values/${TAB}!A1:${colLetter(header.length)}1?valueInputOption=RAW`, {values:[header]}, "PUT");
  }
  return vals.slice(1).map((row, i) => {
    const o = {_row: i + 2};
    header.forEach((h, j) => o[h] = row[j] == null ? "" : String(row[j]));
    return o;
  }).filter(o => o.id);
}
function toRow(o){ return header.map(h => o[h] == null ? "" : String(o[h])); }
const colOf = slot => slot === "photos" ? "photos" : slot + "_photos";
function photoIds(c, slot){ return String(c[colOf(slot)] || "").split(",").map(s => s.trim()).filter(Boolean); }
function allPhotos(c){ return SLOT_KEYS.flatMap(k => photoIds(c, k).map(fid => ({slot:k, fid}))); }
const EDITABLE = ["draft","ready","needs_you"];

let chain = Promise.resolve();
function serial(fn){ const p = chain.catch(()=>{}).then(fn); chain = p; return p; }

async function patchClaim(id, data){
  return serial(async () => {
    const rows = await fetchRows();
    const c = rows.find(r => r.id === id);
    if (!c) throw new Error("This return no longer exists in the sheet.");
    const next = {...c, ...data, updated_at: nowIso()};
    await jpost(`${SHEETS}/${sheetId}/values/${TAB}!A${c._row}:${colLetter(header.length)}${c._row}?valueInputOption=RAW`, {values:[toRow(next)]}, "PUT");
    claims = rows.map(r => r.id === id ? next : r);
    return next;
  });
}
async function appendClaim(o){
  return serial(async () => {
    await fetchRows();
    await jpost(`${SHEETS}/${sheetId}/values/${TAB}!A1:${colLetter(header.length)}1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {values:[toRow(o)]});
    claims = await fetchRows();
  });
}
async function deleteClaimRow(id){
  return serial(async () => {
    const rows = await fetchRows();
    const c = rows.find(r => r.id === id); if (!c) return;
    await jpost(`${SHEETS}/${sheetId}:batchUpdate`, {requests:[{deleteDimension:{range:{sheetId:0, dimension:"ROWS", startIndex:c._row-1, endIndex:c._row}}}]});
    if (c.drive_folder) { try { await jpost(`${DRIVE}/files/${c.drive_folder}`, {trashed:true}, "PATCH"); } catch {} }
    claims = await fetchRows();
  });
}

// ---------------- photos ----------------
const thumbCache = new Map();
async function photoUrl(fid){
  if (thumbCache.has(fid)) return thumbCache.get(fid);
  const p = (async () => { const r = await api(`${DRIVE}/files/${fid}?alt=media`); return URL.createObjectURL(await r.blob()); })();
  thumbCache.set(fid, p);
  p.catch(() => thumbCache.delete(fid));
  return p;
}
function hydrateImages(){
  document.querySelectorAll("img[data-fid]:not([src])").forEach(img => {
    photoUrl(img.dataset.fid).then(u => { img.src = u; }).catch(() => { img.alt = "Photo unavailable"; });
  });
}
async function toJpeg(file){
  const MAX = 2000;
  let src;
  try { src = await createImageBitmap(file, {imageOrientation:"from-image"}); }
  catch { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("decode")); im.src = URL.createObjectURL(file); }); }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const k = Math.min(1, MAX / Math.max(w, h));
  const cv = document.createElement("canvas"); cv.width = Math.round(w*k); cv.height = Math.round(h*k);
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error("encode")), "image/jpeg", 0.86));
}
const folderJobs = new Map();
function claimFolder(c){
  if (c.drive_folder) return Promise.resolve(c.drive_folder);
  if (!folderJobs.has(c.id)) {
    const job = (async () => {
      const f = await jpost(`${DRIVE}/files?fields=id`, {name: c.id, mimeType:"application/vnd.google-apps.folder", parents:[folderId]});
      await patchClaim(c.id, {drive_folder: f.id});
      return f.id;
    })();
    job.catch(() => folderJobs.delete(c.id));
    folderJobs.set(c.id, job);
  }
  return folderJobs.get(c.id);
}
async function uploadPhoto(c, slot, blob){
  const folder = await claimFolder(c);
  const name = `${slot}-${new Date().toISOString().replace(/[:.]/g,"").slice(0,15)}-${Math.random().toString(36).slice(2,5)}.jpg`;
  const boundary = "rd" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({name, parents:[folder], mimeType:"image/jpeg"});
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${boundary}--`]);
  const r = await api(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`, {method:"POST", headers:{"Content-Type":`multipart/related; boundary=${boundary}`}, body});
  return r.id;
}

// ---------------- state + rendering ----------------
let claims = [];
let loaded = false, loadError = null;
let tab = "open";
let openId = null;
let pending = {};          // claimId -> slot -> [{url,state,err}]
let confirmDelete = false;
const localDraft = {};

function claimById(id){ return claims.find(c => c.id === id); }
function inTab(c){
  const s = c.status || "draft";
  if (tab === "all") return true;
  if (tab === "open") return ["draft","ready","filing","needs_you"].includes(s);
  if (tab === "needs_you") return s === "needs_you";
  if (tab === "filed") return s === "filed";
  if (tab === "closed") return s === "won" || s === "lost";
  return true;
}
function setFab(html){ const f=$("#fab"); if(!html){f.hidden=true;return;} $("#fabInner").innerHTML=html; f.hidden=false; }

function render(){
  const v = $("#view");
  const acct = $("#acctBtn");
  if (!currentToken()) {
    acct.hidden = true; setFab("");
    v.innerHTML = `<div class="card signin"><h2>Sign in</h2>
      <p class="muted">Use your dockcharged.com Google account. Photos are saved to a <b>Returns Desk</b> folder in your Google Drive and each return becomes a row in the <b>Returns Desk</b> sheet, where Claude picks it up.</p>
      ${render.authError ? `<div class="notice bad small">Sign-in didn't finish (${esc(render.authError)}). Try again.</div>` : ""}
      <button type="button" class="primary" id="signInBtn">Sign in with Google</button></div>`;
    return;
  }
  acct.hidden = false; acct.textContent = "Sign out"; acct.id = "acctBtn";
  if (openId) return renderEditor();
  confirmDelete = false;
  const rows = claims.filter(inTab).sort((a,b) => (b.updated_at||"").localeCompare(a.updated_at||""));
  const nNeed = claims.filter(c => c.status === "needs_you").length;
  let h = `<nav class="tabs" aria-label="Filter returns">` + TABS.map(([k,l]) =>
    `<button type="button" data-tab="${k}" aria-pressed="${tab===k}">${l}${k==="needs_you"&&nNeed?` · ${nNeed}`:""}</button>`).join("") + `</nav>`;
  if (loadError) h += `<div class="notice bad"><strong>Couldn't load your returns.</strong><span class="small">${esc(loadError)}</span><button type="button" id="retryBtn">Try again</button></div>`;
  else if (!loaded) h += `<div class="empty"><strong>Loading your returns…</strong><span class="muted small">First time, this also creates the Returns Desk folder and sheet in your Drive.</span></div>`;
  else if (!claims.length) h += `<div class="empty"><strong>No returns logged yet.</strong><span class="muted small">Tap <b>New return</b> and shoot the slip, the LPN sticker and the item. Then tap <b>Send to Claude</b>. Claude works out the account, order, LPN and reason from the photos and files the claim.</span></div>`;
  else if (!rows.length) h += `<div class="empty"><span class="muted">Nothing here.</span></div>`;
  else h += `<div class="list">` + rows.map(rowHtml).join("") + `</div>`;
  if (loaded && sheetId) h += `<p class="small muted">Records: <a href="https://docs.google.com/spreadsheets/d/${esc(sheetId)}" target="_blank" rel="noopener">Returns Desk sheet</a></p>`;
  v.innerHTML = h;
  setFab(loaded ? `<label class="primary bigbtn" for="newCam">📷 New return<input type="file" id="newCam" accept="image/*" capture="environment" data-new="1"></label><label class="bigbtn lib" for="newLib">Library<input type="file" id="newLib" accept="image/*" multiple data-new="1"></label>` : "");
  hydrateImages();
}

function rowHtml(c){
  const st = STATUS[c.status||"draft"] || STATUS.draft;
  const ph = allPhotos(c);
  const first = (ph.find(p => p.slot === "item") || ph[0] || {}).fid;
  const n = ph.length;
  const title = c.product_name || c.order_id || c.lpn || `Return · ${fmtDate(c.created_at)}`;
  const amt = c.status === "won" && c.recovered_amount ? ` · $${esc(c.recovered_amount)}` : (c.amount ? ` · $${esc(c.amount)}` : "");
  return `<button type="button" class="row" data-open="${esc(c.id)}">
    ${first ? `<img class="thumb" data-fid="${esc(first)}" alt="">` : `<span class="thumb" aria-hidden="true"></span>`}
    <span class="meta"><span class="t mono">${esc(title)}</span>
      <span class="small muted">${[c.account?label(ACCOUNTS,c.account):"", c.reason?label(REASONS,c.reason):"", `${n} photo${n===1?"":"s"}`].filter(Boolean).map(esc).join(" · ")}${amt}</span>
      <span class="small muted">${fmtDate(c.created_at)}${c.case_id?` · case <span class="mono">${esc(c.case_id)}</span>`:""}</span></span>
    <span class="pill ${st[1]}">${st[0]}</span></button>`;
}

function readiness(c){
  const pend = Object.values(pending[c.id]||{}).flat().some(x => x.state === "up");
  return {n: allPhotos(c).length, pend};
}

function renderEditor(){
  const c = claimById(openId);
  const v = $("#view");
  if (!c) { v.innerHTML = `<div class="empty"><strong>That return was deleted.</strong></div>`; setFab(`<button type="button" id="backBtn">← All returns</button>`); return; }
  const st = c.status || "draft";
  const editable = EDITABLE.includes(st);
  const ld = localDraft[c.id] || {};
  let h = `<div class="bar"><button type="button" class="ghost" id="backBtn">← All returns</button><span class="grow"></span><span class="pill ${STATUS[st][1]}">${STATUS[st][0]}</span></div>`;
  h += statusNotice(c);
  h += `<section class="card" aria-label="Photos">${photosHtml(c, editable)}</section>`;
  if (editable) h += `<section class="card"><label class="f" for="f-notes">Note for Claude (optional)<textarea id="f-notes" data-field="notes" placeholder="Anything the photos don't show.">${esc(ld.notes ?? c.notes ?? "")}</textarea></label>
      ${st === "draft" ? `<div class="confirm">${confirmDelete
        ? `<span class="small">Delete this return and its photos?</span><button type="button" class="danger" id="delYes">Delete</button><button type="button" id="delNo">Keep</button>`
        : `<button type="button" class="ghost danger" id="delBtn">Delete</button>`}</div>` : ""}</section>`;
  else if (c.notes) h += `<section class="card"><span class="eyebrow">Your note</span><span>${esc(c.notes)}</span></section>`;
  v.innerHTML = h;
  const r = readiness(c);
  if (st === "draft") setFab(`<button type="button" class="primary" id="sendBtn" ${r.n && !r.pend ? "" : "disabled"}>${r.pend ? "Uploading…" : r.n ? "Send to Claude" : "Add photos first"}</button>`);
  else if (st === "needs_you") setFab(`<button type="button" class="primary" id="replyBtn">Send answer to Claude</button>`);
  else setFab("");
  hydrateImages();
}

function photosHtml(c, editable){
  const ph = allPhotos(c);
  const pend = Object.values(pending[c.id]||{}).flat();
  const thumbs = ph.map((p, i) => `<div class="ph"><img data-fid="${esc(p.fid)}" alt="Photo ${i+1}">${editable?`<button type="button" class="x" aria-label="Remove photo" data-rm="${p.slot}:${esc(p.fid)}">×</button>`:""}</div>`).join("")
    + pend.map(x => `<div class="ph"><img src="${x.url}" alt="">${x.state==="up"?`<span class="busy">Uploading</span>`:x.state==="err"?`<span class="err">${esc(x.err)}</span>`:""}</div>`).join("");
  const add = editable ? `<div class="add">
      <label for="cam">📷 Take photo<input type="file" id="cam" accept="image/*" capture="environment" data-slot="photos"></label>
      <label class="lib" for="lib">Library<input type="file" id="lib" accept="image/*" multiple data-slot="photos"></label></div>` : "";
  return `<div class="slot-head"><span class="name">Photos</span><span class="count">${ph.length}</span></div>
    ${editable ? `<span class="hint">Return slip, LPN sticker, the item from a few sides, and anything wrong with it. Any order.</span>` : ""}
    ${(ph.length||pend.length)?`<div class="grid">${thumbs}</div>`:""}${add}`;
}

function statusNotice(c){
  const st = c.status || "draft";
  const kv = [];
  if (c.case_id) kv.push(["Case ID", `<span class="mono">${esc(c.case_id)}</span>`]);
  if (c.amount) kv.push(["Claimed", `$${esc(c.amount)}`]);
  if (c.recovered_amount) kv.push(["Reimbursed", `$${esc(c.recovered_amount)}`]);
  if (c.filed_at) kv.push(["Filed", fmtDate(c.filed_at)]);
  if (c.account) kv.push(["Account", esc(label(ACCOUNTS, c.account))]);
  if (c.reason) kv.push(["Reason", esc(label(REASONS, c.reason))]);
  if (c.product_name) kv.push(["Item", esc(c.product_name)]);
  if (c.order_id) kv.push(["Order", `<span class="mono">${esc(c.order_id)}</span>`]);
  if (c.lpn) kv.push(["LPN", `<span class="mono">${esc(c.lpn)}</span>`]);
  if (c.shipment_id) kv.push(["Shipment", `<span class="mono">${esc(c.shipment_id)}</span>`]);
  if (c.claude_note && st === "ready") kv.push(["Claude", esc(c.claude_note)]);
  const kvHtml = kv.length ? `<dl class="kv">${kv.map(([a,b])=>`<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>` : "";
  const note = c.claude_note ? `<span>${esc(c.claude_note)}</span>` : "";
  if (st === "ready") return `<div class="notice info"><strong>Sent to Claude.</strong><span>Claude picks this up on its next check (9 am and 3 pm), files the claim with Amazon and shows the case ID here. You can still add photos or a note until then.</span>${kvHtml}</div>`;
  if (st === "filing") return `<div class="notice info"><strong>Claude is filing this claim.</strong>${note}</div>`;
  if (st === "filed") return `<div class="notice info"><strong>Filed. Waiting on Amazon.</strong>${note}${kvHtml}</div>`;
  if (st === "won") return `<div class="notice good"><strong>Reimbursed.</strong>${note}${kvHtml}</div>`;
  if (st === "lost") return `<div class="notice bad"><strong>Denied.</strong>${note}${kvHtml}</div>`;
  if (st === "needs_you") return `<div class="notice warn"><strong>Claude needs something from you.</strong><span style="white-space:pre-wrap">${esc(c.question || "See the note and add photos or details.")}</span>${kvHtml}
    <label class="f" for="f-reply">Your answer<textarea id="f-reply" data-field="reply" placeholder="Type your answer, or add the photos it asked for below.">${esc((localDraft[c.id]||{}).reply ?? c.reply ?? "")}</textarea></label></div>`;
  return "";
}

function slotHtml(c, s, editable){
  const ids = photoIds(c, s.key);
  const pend = ((pending[c.id]||{})[s.key]) || [];
  const n = ids.length;
  const countTxt = s.need ? `${n} / ${s.need}${s.key==="item"?"+":""}` : `${n}`;
  const thumbs = ids.map((fid, i) => `<div class="ph"><img data-fid="${esc(fid)}" alt="${esc(s.name)} photo ${i+1}">${editable?`<button type="button" class="x" aria-label="Remove photo" data-rm="${s.key}:${esc(fid)}">×</button>`:""}</div>`).join("")
    + pend.map(x => `<div class="ph"><img src="${x.url}" alt="">${x.state==="up"?`<span class="busy">Uploading</span>`:x.state==="err"?`<span class="err">${esc(x.err)}</span>`:""}</div>`).join("");
  const add = editable ? `<div class="add">
      <label for="cam-${s.key}">📷 Take photo<input type="file" id="cam-${s.key}" accept="image/*" capture="environment" data-slot="${s.key}"></label>
      <label class="lib" for="lib-${s.key}">From library<input type="file" id="lib-${s.key}" accept="image/*" multiple data-slot="${s.key}"></label></div>` : "";
  return `<div class="slot"><div class="slot-head"><span class="name">${esc(s.name)}</span><span class="count ${s.need && n>=s.need?"ok":""}">${countTxt}</span></div>
    <span class="hint">${esc(s.hint)}</span>${(n||pend.length)?`<div class="grid">${thumbs}</div>`:""}${add}</div>`;
}

// ---------------- actions ----------------
function newId(){ const d=new Date(), p=n=>String(n).padStart(2,"0"); return `r-${String(d.getFullYear()).slice(2)}${p(d.getMonth()+1)}${p(d.getDate())}-${Math.random().toString(36).slice(2,6)}`; }
function fail(e, what){ if (e && e.message === "reauth") return; console.error(e); toast(`${what}: ${e && e.message ? e.message : "check your connection"}`); }

async function createClaim(files){
  const t = nowIso();
  const o = {id:newId(), created_at:t, updated_at:t, status:"draft"};
  try { setFab(`<button type="button" class="primary" disabled>Starting…</button>`); await appendClaim(o); openId = o.id; render(); scrollTo(0,0); }
  catch(e){ fail(e, "Couldn't create the return"); render(); return; }
  if (files && files.length) addPhotos("photos", files);
}

async function addPhotos(slot, files){
  const id = openId; if (!id || !files.length) return;
  pending[id] = pending[id] || {}; pending[id][slot] = pending[id][slot] || [];
  const items = files.map(f => ({f, url: URL.createObjectURL(f), state:"up"}));
  pending[id][slot].push(...items); render();
  for (const it of items) {
    try {
      let blob;
      try { blob = await toJpeg(it.f); } catch { if (/^image\/(jpeg|png|webp)$/.test(it.f.type)) blob = it.f; else throw new Error("format"); }
      const fid = await uploadPhoto(claimById(id), slot, blob);
      thumbCache.set(fid, Promise.resolve(it.url));
      const fresh = claimById(id);
      await patchClaim(id, {[colOf(slot)]: photoIds(fresh, slot).concat(fid).join(",")});
      pending[id][slot] = pending[id][slot].filter(x => x !== it);
    } catch (e) {
      if (e && e.message === "reauth") return;
      it.state = "err"; it.err = e && e.message === "format" ? "Format not supported" : "Upload failed";
      setTimeout(() => { const arr = (pending[id]||{})[slot]; if (arr) { pending[id][slot] = arr.filter(x => x !== it); render(); } }, 6000);
    }
    render();
  }
}

async function removePhoto(slot, fid){
  const c = claimById(openId); if (!c) return;
  try {
    await patchClaim(c.id, {[colOf(slot)]: photoIds(c, slot).filter(x => x !== fid).join(",")});
    render();
    try { await jpost(`${DRIVE}/files/${fid}`, {trashed:true}, "PATCH"); } catch {}
  } catch(e){ fail(e, "Couldn't remove the photo"); }
}

function takeDraft(id){
  const ld = localDraft[id] || {}; const out = {};
  ["notes"].forEach(k => { if (ld[k] !== undefined) out[k] = ld[k].trim(); });
  return out;
}
async function flushField(el){
  const id = openId; const k = el.dataset.field; if (!id || k === "reply") return;
  const c = claimById(id); const v = el.value.trim();
  if (!c || (c[k] ?? "") === v) return;
  try { await patchClaim(id, {[k]: v}); if (localDraft[id]) delete localDraft[id][k]; } catch(e){ fail(e, "Couldn't save"); }
}
async function send(){
  const c = claimById(openId); if (!c) return;
  try { await patchClaim(c.id, {...takeDraft(c.id), status:"ready", sent_at: nowIso()}); delete localDraft[c.id]; toast("Sent to Claude"); openId = null; render(); }
  catch(e){ fail(e, "Couldn't send"); }
}
async function sendReply(){
  const c = claimById(openId); if (!c) return;
  const reply = ((localDraft[c.id]||{}).reply ?? c.reply ?? "").trim();
  try { await patchClaim(c.id, {...takeDraft(c.id), reply, status:"ready", replied_at: nowIso()}); delete localDraft[c.id]; toast("Answer sent to Claude"); openId = null; render(); }
  catch(e){ fail(e, "Couldn't send"); }
}
async function deleteDraft(){
  const c = claimById(openId); if (!c || (c.status||"draft") !== "draft") return;
  try { await deleteClaimRow(c.id); openId = null; toast("Draft deleted"); render(); } catch(e){ fail(e, "Couldn't delete"); }
}

async function refresh(){
  if (!currentToken()) return;
  try { await ensureStore(); claims = await serial(fetchRows); loaded = true; loadError = null; }
  catch(e){
    if (e && e.message === "reauth") return;
    if (e && e.status === 404) { ls.set("rd-folder", null); ls.set("rd-sheet", null); folderId = sheetId = null; }
    loadError = e && e.message || "Unknown error";
  }
  safeRender();
}
function safeRender(){
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && a.type !== "file") return;
  render();
}

// ---------------- events ----------------
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "signInBtn") { signIn("select_account"); return; }
  if (t.id === "acctBtn") { signOut(); return; }
  if (t.id === "retryBtn") { loadError = null; render(); refresh(); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
  if (t.dataset.open) { openId = t.dataset.open; confirmDelete = false; render(); scrollTo(0,0); return; }
  if (t.id === "backBtn") { const a = document.activeElement; if (a && a.dataset && a.dataset.field) flushField(a); openId = null; render(); return; }
  if (t.dataset.rm) { const i = t.dataset.rm.indexOf(":"); removePhoto(t.dataset.rm.slice(0,i), t.dataset.rm.slice(i+1)); return; }
  if (t.id === "sendBtn") { send(); return; }
  if (t.id === "replyBtn") { sendReply(); return; }
  if (t.id === "delBtn") { confirmDelete = true; render(); return; }
  if (t.id === "delNo") { confirmDelete = false; render(); return; }
  if (t.id === "delYes") { deleteDraft(); return; }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.type === "file" && el.dataset.new) { const files = [...el.files]; el.value = ""; if (files.length) createClaim(files); return; }
  if (el.type === "file" && el.dataset.slot) { const files = [...el.files]; el.value = ""; addPhotos(el.dataset.slot, files); }
});
document.addEventListener("input", e => {
  const el = e.target; if (!el.dataset || !el.dataset.field || !openId) return;
  (localDraft[openId] = localDraft[openId] || {})[el.dataset.field] = el.value;
});
document.addEventListener("focusout", e => { const el = e.target; if (el.dataset && el.dataset.field) flushField(el); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !openId) refresh(); });
setInterval(() => { if (document.visibilityState === "visible" && !openId) refresh(); }, 60000);

// ---------------- boot ----------------
// Updates: check for a new version whenever the app comes to the front, and reload into it
// as soon as it's installed (unless photos are still uploading).
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const busy = () => Object.values(pending).some(m => Object.values(m).flat().some(x => x.state === "up"));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    const go = () => { if (busy()) return setTimeout(go, 2000); reloading = true; location.reload(); };
    go();
  });
  navigator.serviceWorker.register("sw.js", {updateViaCache: "none"}).then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    reg.update().catch(() => {});
  }).catch(() => {});
}
const auth = loadToken();
if (auth.error) render.authError = auth.error;
if (!auth.ok && auth.expired && !auth.error) { signIn(); }
else { render(); refresh(); }
})();

#!/usr/bin/env node
/*
 * Genera automaticamente le pagine statiche articolo/<id>.html a partire
 * da MEDIA_ITEMS e EVENTI_FUTURI dentro index.html.
 *
 * Perche' esistono queste pagine: il sito e' una SPA, quindi i tag Open
 * Graph vengono aggiornati via JS quando si naviga — ma i crawler di
 * Facebook/WhatsApp/Twitter non eseguono JS e vedono sempre e solo i meta
 * tag della home. Ogni contenuto ha quindi bisogno di una paginetta HTML
 * statica con i meta corretti, che poi reindirizza alla SPA vera.
 *
 * Questo script si occupa di generarle/aggiornarle da solo: va lanciato
 * (vedi .github/workflows/generate-articolo-pages.yml) ogni volta che
 * index.html cambia, cosi' non serve piu' crearle a mano.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, 'articolo');
const BASE_URL = 'https://scaro.it';
const DEFAULT_IMAGE = BASE_URL + '/pomodoro_originale_trasparente.png';
const DEFAULT_DESC = 'Market, Community, Cafe: cultura, incontro e monitoraggio civico ad Agrigento.';

function extractArray(src, varName) {
  const startMarker = 'const ' + varName + ' = [';
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('Non trovo "' + varName + '" in index.html');
  const arrStart = start + startMarker.length - 1; // indice della '['
  let depth = 0, i = arrStart, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const literal = src.slice(arrStart, i);
  const sandbox = {};
  vm.createContext(sandbox);
  return vm.runInContext('(' + literal + ')', sandbox);
}

function plainText(s, max) {
  max = max || 300;
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
}

function absUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return BASE_URL + '/' + String(p).replace(/^\/+/, '');
}

// Se il video e' stato caricato da poco, YouTube potrebbe non aver ancora
// generato la miniatura ad alta risoluzione (maxresdefault): in quel caso
// restituisce un placeholder grigio minuscolo, che Facebook scarta come
// "immagine troppo piccola" e la condivisione resta senza anteprima.
// hqdefault.jpg (480x360) invece esiste sempre, subito: e' la scelta sicura
// di default; usiamo maxresdefault solo se verifichiamo che sia quella vera.
async function youtubeImage(id) {
  const hq = 'https://img.youtube.com/vi/' + id + '/hqdefault.jpg';
  const maxres = 'https://img.youtube.com/vi/' + id + '/maxresdefault.jpg';
  try {
    const res = await fetch(maxres, { method: 'GET' });
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (res.ok && len > 10000) return maxres;
  } catch (e) { /* rete non disponibile: usa il fallback sicuro */ }
  return hq;
}

async function itemImage(it) {
  if (it.img) return absUrl(it.img);
  if (it.flyer) return absUrl(it.flyer);
  if (it.youtube) return youtubeImage(it.youtube);
  return DEFAULT_IMAGE;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPage(opts) {
  const url = BASE_URL + '/articolo/' + opts.urlId + '.html';
  const target = '/?a=' + opts.urlId;
  const t = escHtml(opts.title);
  const d = escHtml(opts.description);
  const img = escHtml(opts.image);
  const noun = /^evento-/.test(opts.urlId) ? 'evento' : 'articolo';
  return '<!doctype html>\n' +
'<html lang="it">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>' + t + ' — Scaro</title>\n' +
'<meta name="description" content="' + d + '">\n' +
'<link rel="canonical" href="' + url + '">\n' +
'<meta property="og:type" content="article">\n' +
'<meta property="og:site_name" content="Scaro">\n' +
'<meta property="og:title" content="' + t + '">\n' +
'<meta property="og:description" content="' + d + '">\n' +
'<meta property="og:image" content="' + img + '">\n' +
'<meta property="og:url" content="' + url + '">\n' +
'<meta name="twitter:card" content="summary_large_image">\n' +
'<meta name="twitter:title" content="' + t + '">\n' +
'<meta name="twitter:description" content="' + d + '">\n' +
'<meta name="twitter:image" content="' + img + '">\n' +
'<meta http-equiv="refresh" content="0; url=' + target + '">\n' +
'<script>location.replace(\'' + target + '\');</script>\n' +
'</head>\n' +
'<body>\n' +
'<p>Se non vieni reindirizzato automaticamente, <a href="' + target + '">clicca qui per leggere l\'' + noun + ' su Scaro</a>.</p>\n' +
'</body>\n' +
'</html>\n';
}

// Contenuti pubblicati dal pannello (/admin) via content/talks e content/eventi:
// scripts/build-content.js li raccoglie in content/scaro-content.js, che
// index.html carica e fonde con MEDIA_ITEMS/EVENTI_FUTURI a runtime (funzione
// scaroApplyContent). Qui rifacciamo la stessa normalizzazione dei campi,
// cosi' anche questi contenuti ottengono la loro pagina di anteprima.
function loadCmsContent() {
  const file = path.join(ROOT, 'content', 'scaro-content.js');
  if (!fs.existsSync(file)) return { news: [], events: [] };
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/window\.SCARO_CONTENT\s*=\s*([\s\S]*?);\s*$/);
  if (!m) return { news: [], events: [] };
  const data = JSON.parse(m[1]);
  return { news: data.news || [], events: data.events || [] };
}

function normalizeCmsNews(n) {
  return {
    id: n.id,
    testo: n.testo || n.title,
    desc: n.desc || n.description || '',
    body: n.body || n.text || '',
    youtube: n.youtube || '',
    img: n.img || n.image || '',
    flyer: n.flyer || ''
  };
}

function normalizeCmsEvent(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description || '',
    body: e.body || e.text || '',
    flyer: e.flyer || '',
    img: e.img || e.image || '',
    info: e.info || [e.time ? 'Ore ' + e.time : '', e.place || '', e.description || ''].filter(Boolean),
    ics: e.ics || null
  };
}

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

async function main() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const cms = loadCmsContent();
  const mediaItems = extractArray(src, 'MEDIA_ITEMS').concat(cms.news.map(normalizeCmsNews));
  const eventiFuturi = extractArray(src, 'EVENTI_FUTURI').concat(cms.events.map(normalizeCmsEvent));

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let written = 0, upToDate = 0;

  for (const it of mediaItems) {
    if (!it.id) continue;
    const content = renderPage({
      urlId: it.id,
      title: it.testo,
      description: plainText(it.desc || it.body) || DEFAULT_DESC,
      image: await itemImage(it)
    });
    const changed = writeIfChanged(path.join(OUT_DIR, it.id + '.html'), content);
    if (changed) { written++; console.log('scritto:', 'articolo/' + it.id + '.html'); }
    else upToDate++;
  }

  for (const ev of eventiFuturi) {
    if (!ev.id) continue;
    const urlId = 'evento-' + ev.id;
    const content = renderPage({
      urlId: urlId,
      title: ev.title,
      description: plainText(ev.description || (ev.ics && ev.ics.description) || (ev.info || []).join(' · ')) || DEFAULT_DESC,
      image: await itemImage(ev)
    });
    const changed = writeIfChanged(path.join(OUT_DIR, urlId + '.html'), content);
    if (changed) { written++; console.log('scritto:', 'articolo/' + urlId + '.html'); }
    else upToDate++;
  }

  console.log((written + upToDate) + ' contenuti controllati — ' + written + ' scritti/aggiornati, ' + upToDate + ' gia\' ok.');
}

main().catch(function (e) { console.error(e); process.exit(1); });

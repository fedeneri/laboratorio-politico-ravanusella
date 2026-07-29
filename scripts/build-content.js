#!/usr/bin/env node
/*
 * Ricostruisce content/scaro-content.js a partire dai file editabili dal
 * pannello (Decap CMS, /admin): content/talks/*.json e content/eventi/*.json.
 *
 * Il pannello scrive un file per ogni talk/podcast/articolo/evento (piu'
 * comodo per un editor umano); il sito invece si aspetta un unico oggetto
 * window.SCARO_CONTENT = { news:[...], events:[...] } caricato da index.html.
 * Questo script fa da ponte tra le due cose, e va rilanciato a ogni push
 * (vedi .github/workflows/generate-articolo-pages.yml).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TALKS_DIR = path.join(ROOT, 'content', 'talks');
const EVENTI_DIR = path.join(ROOT, 'content', 'eventi');
const OUT_FILE = path.join(ROOT, 'content', 'scaro-content.js');

function readJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith('.json'); })
    .map(function (f) {
      const slug = f.replace(/\.json$/, '');
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!data.id) data.id = slug;
      return data;
    })
    // Piu' recenti prima, cosi' l'ordine e' stabile anche prima del sort
    // per data che fa gia' index.html.
    .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
}

function main() {
  const news = readJsonFiles(TALKS_DIR);
  const events = readJsonFiles(EVENTI_DIR);
  const content = 'window.SCARO_CONTENT = ' + JSON.stringify({ news: news, events: events }, null, 2) + ';\n';
  const prev = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (prev === content) {
    console.log('content/scaro-content.js gia\' aggiornato (' + news.length + ' talk/articoli, ' + events.length + ' eventi).');
    return;
  }
  fs.writeFileSync(OUT_FILE, content);
  console.log('content/scaro-content.js rigenerato: ' + news.length + ' talk/articoli, ' + events.length + ' eventi.');
}

main();

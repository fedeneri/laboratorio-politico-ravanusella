/*
 * Scaro — backend biglietti (Cloudflare Worker)
 *
 * Cosa fa:
 *   1. Crea l'ordine PayPal lato server (non nel browser: PayPal segnala la
 *      creazione lato client come deprecata e, per alcuni account, causa
 *      comportamenti instabili nel checkout).
 *   2. Quando il cliente approva il pagamento, conferma (capture) l'ordine
 *      DIRETTAMENTE con PayPal, server-to-server.
 *   3. Se il pagamento è davvero completato, genera un codice biglietto
 *      univoco, lo salva in Cloudflare KV e manda un'email con QR al cliente
 *      (tramite Resend).
 *   4. Espone due endpoint per il check-in all'ingresso: uno per leggere lo
 *      stato di un biglietto (senza consumarlo) e uno per marcarlo come usato.
 *
 * Variabili d'ambiente richieste (impostale con `wrangler secret put NOME`,
 * MAI scritte in questo file o nel repository):
 *   PAYPAL_CLIENT_ID, PAYPAL_SECRET   -> app REST su developer.paypal.com
 *   RESEND_API_KEY                    -> resend.com
 *   RESEND_FROM   (facoltativa)       -> es. "Scaro <biglietti@scaro.it>"
 *   PAYPAL_API_BASE (facoltativa)     -> default produzione; per test usa
 *                                        https://api-m.sandbox.paypal.com
 *   TEST_KEY                          -> valore a piacere, inventato da te;
 *                                        serve solo per proteggere l'endpoint
 *                                        di test /api/test-ticket (non è
 *                                        collegato a nessun account esterno)
 *   ADMIN_KEY                         -> valore a piacere, inventato da te;
 *                                        protegge la lista degli acquirenti
 *                                        (contiene email e nomi: non deve
 *                                        essere pubblica)
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET -> app OAuth GitHub, per il login
 *                                        al pannello editoriale su /admin
 *   GITHUB_PAT                        -> Personal Access Token GitHub (solo
 *                                        permesso "Contents" in scrittura sul
 *                                        repo), usato dal pannello semplificato
 *                                        pannello.html per pubblicare a nome
 *                                        del sistema (i soci non hanno un
 *                                        account GitHub proprio)
 *   SOCI_CREDENTIALS                  -> JSON tipo {"Mario":"1234","Anna":"5678"}
 *                                        con nome e PIN di chi puo' pubblicare
 *                                        da pannello.html
 *
 * Richiede inoltre un KV namespace collegato con binding "TICKETS"
 * (vedi wrangler.toml).
 */

const ALLOWED_ORIGINS = [
  'https://scaro.it',
  'https://www.scaro.it',
  'https://fedeneri.github.io'
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Test-Key, X-Admin-Key',
    'Vary': 'Origin'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // esclusi 0/O, 1/I/L per evitare ambiguità a mano
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 10);
}

async function paypalToken(env) {
  const base = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const auth = btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_SECRET);
  const res = await fetch(base + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('paypal-auth-failed');
  const data = await res.json();
  return data.access_token;
}

async function paypalCreateOrder(env, { eventId, tierId, amount }) {
  const base = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await paypalToken(env);
  const res = await fetch(base + '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: eventId + (tierId ? ':' + tierId : ''),
        amount: { currency_code: 'EUR', value: amount }
      }]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error('paypal-create-order-failed');
    err.detail = detail;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paypalCaptureOrder(env, orderId) {
  const base = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await paypalToken(env);
  const res = await fetch(base + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error('paypal-capture-failed');
    err.detail = detail;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function sendTicketEmail(env, { to, codes, eventTitle, tierLabel, verifyUrlBase, resend }) {
  const ticketBlocks = codes.map(function(code){
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(verifyUrlBase + code);
    return '<div style="border-top:1px solid #ddd;padding:20px 0;">' +
      '<p style="font-size:22px;font-weight:bold;letter-spacing:2px;margin:0 0 12px;">' + code + '</p>' +
      '<img src="' + qrUrl + '" alt="QR biglietto" style="width:100%;max-width:280px;display:block;margin:0 0 8px;">' +
      '</div>';
  }).join('');
  const html =
    '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;border:2px solid #164194;padding:24px;">' +
    '<h1 style="color:#164194;font-size:20px;margin:0 0 12px;">' + (codes.length > 1 ? 'I tuoi ' + codes.length + ' biglietti Scaro' : 'Il tuo biglietto Scaro') + '</h1>' +
    (resend ? '<p style="margin:0 0 12px;color:#555;">Ti rimandiamo il tuo biglietto per sicurezza, nel caso non l\'avessi ricevuto o scaricato la prima volta.</p>' : '') +
    '<p style="margin:0 0 4px;"><b>' + eventTitle + '</b></p>' +
    '<p style="margin:0 0 8px;color:#555;">' + tierLabel + '</p>' +
    ticketBlocks +
    '<p style="font-size:13px;color:#555;margin:16px 0 0;">Mostra questa email (o i QR) all\'ingresso. Ogni biglietto è valido per un solo ingresso.</p>' +
    '</div>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Scaro <onboarding@resend.dev>',
      to: [to],
      subject: (resend ? '[Reinvio] ' : '') + (codes.length > 1 ? 'I tuoi biglietti' : 'Il tuo biglietto') + ' — ' + eventTitle,
      html: html
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, detail: detail };
  }
  return { ok: true };
}

async function handleCreateOrder(request, env, origin) {
  // L'ordine PayPal viene creato QUI, lato server, come raccomandato da
  // PayPal stessa (la creazione lato browser e' deprecata e, per alcuni
  // account, causa comportamenti instabili nel checkout).
  const body = await request.json().catch(() => null);
  if (!body || !body.eventId || !body.amount) return json({ ok: false, error: 'bad-request' }, 400, origin);

  let order;
  try { order = await paypalCreateOrder(env, body); }
  catch (e) { return json({ ok: false, error: 'paypal-create-failed', detail: e.detail || String(e) }, 502, origin); }

  return json({ id: order.id }, 200, origin);
}

async function handleCaptureOrder(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || !body.orderID) return json({ ok: false, error: 'bad-request' }, 400, origin);

  // Idempotenza: se questo ordine ha già generato dei biglietti, restituisci quelli.
  const existing = await env.TICKETS.get('order:' + body.orderID);
  if (existing) {
    const codes = JSON.parse(existing);
    return json({ ok: true, code: codes[0], codes: codes, alreadyIssued: true }, 200, origin);
  }

  let capture;
  try { capture = await paypalCaptureOrder(env, body.orderID); }
  catch (e) { return json({ ok: false, error: 'paypal-capture-failed', detail: e.detail || String(e) }, 502, origin); }

  if (capture.status !== 'COMPLETED') return json({ ok: false, error: 'not-completed' }, 402, origin);

  const unit = (capture.purchase_units && capture.purchase_units[0]) || {};
  const paidCustomId = unit.custom_id || '';
  const eventId = paidCustomId.split(':')[0];
  const qty = Math.max(1, Math.min(20, parseInt(body.qty, 10) || 1));

  const payer = capture.payer || {};
  const buyerEmail = payer.email_address || body.buyerEmail || '';
  const buyerName = (payer.name && payer.name.given_name) || body.buyerName || '';
  const codes = [];
  for (let i = 0; i < qty; i++) {
    const code = randomCode();
    const record = {
      orderId: body.orderID,
      eventId: eventId,
      tierId: body.tierId || '',
      tierLabel: body.tierLabel || '',
      eventTitle: body.eventTitle || '',
      buyerEmail: buyerEmail,
      buyerName: buyerName,
      used: false,
      createdAt: new Date().toISOString(),
      usedAt: null
    };
    await env.TICKETS.put('ticket:' + code, JSON.stringify(record));
    codes.push(code);
  }
  await env.TICKETS.put('order:' + body.orderID, JSON.stringify(codes));

  let emailSent = false;
  let emailError = '';
  if (buyerEmail) {
    try {
      const emailResult = await sendTicketEmail(env, {
        to: buyerEmail,
        codes: codes,
        eventTitle: body.eventTitle || '',
        tierLabel: body.tierLabel || '',
        verifyUrlBase: 'https://scaro.it/verifica.html?c='
      });
      emailSent = emailResult.ok;
      if (!emailResult.ok) emailError = emailResult.detail || '';
    } catch (e) { emailError = String(e); /* i biglietti restano validi anche se l'invio email fallisce */ }
  }

  return json({ ok: true, code: codes[0], codes: codes, emailSent: emailSent, emailError: emailError }, 200, origin);
}

async function handleTestTicket(request, env, origin) {
  // Genera un biglietto vero SALTANDO PayPal, per verificare che il resto
  // della catena (KV, email, QR, check-in) funzioni. Protetto da una chiave
  // condivisa (TEST_KEY) che non deve mai finire nel codice del sito.
  const key = request.headers.get('X-Test-Key') || '';
  if (!env.TEST_KEY || key !== env.TEST_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body || !body.eventId) return json({ ok: false, error: 'bad-request' }, 400, origin);

  const code = randomCode();
  const record = {
    orderId: 'TEST-' + code,
    eventId: body.eventId,
    tierId: body.tierId || 'test',
    tierLabel: (body.tierLabel || 'Biglietto di prova') + ' (FINTO — nessun pagamento reale)',
    eventTitle: body.eventTitle || '',
    buyerEmail: body.buyerEmail || '',
    buyerName: body.buyerName || '',
    used: false,
    createdAt: new Date().toISOString(),
    usedAt: null
  };
  await env.TICKETS.put('ticket:' + code, JSON.stringify(record));

  let emailSent = false;
  let emailError = '';
  if (record.buyerEmail) {
    try {
      const emailResult = await sendTicketEmail(env, {
        to: record.buyerEmail,
        codes: [code],
        eventTitle: record.eventTitle,
        tierLabel: record.tierLabel,
        verifyUrlBase: 'https://scaro.it/verifica.html?c='
      });
      emailSent = emailResult.ok;
      if (!emailResult.ok) emailError = emailResult.detail || '';
    } catch (e) { emailError = String(e); /* il biglietto resta valido anche se l'invio email fallisce */ }
  }

  return json({ ok: true, code: code, emailSent: emailSent, emailError: emailError }, 200, origin);
}

async function handleBoxOfficeReserve(request, env, origin) {
  // Prenotazione senza pagamento immediato: il codice viene dato alla persona
  // subito, il pagamento si conferma dopo (vedi handleConfirmPayment) quando
  // arriva davvero al botteghino.
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body || !body.eventId || !body.tierLabel || !body.buyerName) return json({ ok: false, error: 'bad-request' }, 400, origin);

  const qty = Math.max(1, Math.min(20, parseInt(body.qty, 10) || 1));
  const codes = [];
  for (let i = 0; i < qty; i++) {
    const code = randomCode();
    const record = {
      orderId: 'PRENOTAZIONE-' + code,
      eventId: body.eventId,
      tierId: body.tierId || '',
      tierLabel: body.tierLabel,
      eventTitle: body.eventTitle || '',
      buyerEmail: '',
      buyerName: body.buyerName,
      paymentMethod: '',
      price: body.price || '',
      paid: false,
      used: false,
      createdAt: new Date().toISOString(),
      usedAt: null
    };
    await env.TICKETS.put('ticket:' + code, JSON.stringify(record));
    codes.push(code);
  }

  return json({ ok: true, code: codes[0], codes: codes }, 200, origin);
}

async function handleConfirmPayment(request, env, origin, code) {
  // Conferma il pagamento di una prenotazione esistente, inserendo il codice
  // che il cliente ha ricevuto al momento della prenotazione.
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body || !body.paymentMethod) return json({ ok: false, error: 'bad-request' }, 400, origin);
  if (body.paymentMethod !== 'cash' && body.paymentMethod !== 'bancomat') return json({ ok: false, error: 'bad-payment-method' }, 400, origin);

  const raw = await env.TICKETS.get('ticket:' + code);
  if (!raw) return json({ ok: false, error: 'not-found' }, 404, origin);
  const t = JSON.parse(raw);
  if (t.paid !== false) return json({ ok: false, error: 'already-paid' }, 409, origin);

  t.paid = true;
  t.paymentMethod = body.paymentMethod;
  t.paidAt = new Date().toISOString();
  await env.TICKETS.put('ticket:' + code, JSON.stringify(t));

  return json({ ok: true, buyerName: t.buyerName, eventTitle: t.eventTitle, tierLabel: t.tierLabel }, 200, origin);
}

async function handleBoxOfficeTicket(request, env, origin) {
  // Biglietto venduto di persona al botteghino (contanti o bancomat), senza
  // passare da PayPal. Protetto dalla stessa ADMIN_KEY usata per la lista
  // acquirenti, cosi' solo chi e' fisicamente alla cassa puo' generarli.
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body || !body.eventId || !body.tierLabel || !body.paymentMethod) return json({ ok: false, error: 'bad-request' }, 400, origin);
  if (body.paymentMethod !== 'cash' && body.paymentMethod !== 'bancomat') return json({ ok: false, error: 'bad-payment-method' }, 400, origin);

  const qty = Math.max(1, Math.min(20, parseInt(body.qty, 10) || 1));
  const codes = [];
  for (let i = 0; i < qty; i++) {
    const code = randomCode();
    const record = {
      orderId: 'BOTTEGHINO-' + code,
      eventId: body.eventId,
      tierId: body.tierId || '',
      tierLabel: body.tierLabel,
      eventTitle: body.eventTitle || '',
      buyerEmail: '',
      buyerName: body.buyerName || '',
      paymentMethod: body.paymentMethod,
      price: body.price || '',
      used: false,
      createdAt: new Date().toISOString(),
      usedAt: null
    };
    await env.TICKETS.put('ticket:' + code, JSON.stringify(record));
    codes.push(code);
  }

  return json({ ok: true, code: codes[0], codes: codes }, 200, origin);
}

async function handleCheckinByEmail(request, env, origin) {
  // Fa il check-in di tutti i biglietti pagati e non ancora usati di una
  // email, in un colpo solo (utile per chi ha comprato piu' biglietti).
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  const email = (body && body.email || '').trim().toLowerCase();
  if (!email) return json({ ok: false, error: 'bad-request' }, 400, origin);

  const list = await env.TICKETS.list({ prefix: 'ticket:' });
  const results = [];
  for (const k of list.keys) {
    const raw = await env.TICKETS.get(k.name);
    if (!raw) continue;
    const t = JSON.parse(raw);
    if ((t.buyerEmail || '').toLowerCase() !== email) continue;
    const code = k.name.replace(/^ticket:/, '');
    if (t.paid === false) { results.push({ code, status: 'not-paid', tierLabel: t.tierLabel, buyerName: t.buyerName }); continue; }
    if (t.used) { results.push({ code, status: 'already-used', tierLabel: t.tierLabel, buyerName: t.buyerName }); continue; }
    t.used = true;
    t.usedAt = new Date().toISOString();
    await env.TICKETS.put(k.name, JSON.stringify(t));
    results.push({ code, status: 'checked-in', tierLabel: t.tierLabel, buyerName: t.buyerName });
  }

  return json({ ok: true, results: results }, 200, origin);
}

async function handleDeleteTicket(request, env, origin, code) {
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);
  const raw = await env.TICKETS.get('ticket:' + code);
  if (!raw) return json({ ok: false, error: 'not-found' }, 404, origin);
  await env.TICKETS.delete('ticket:' + code);
  return json({ ok: true }, 200, origin);
}

async function handleReconcileCreateTicket(request, env, origin) {
  // Genera il biglietto mancante per un pagamento PayPal gia' avvenuto
  // (trovato con /api/reconcile), senza richiamare PayPal di nuovo.
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const body = await request.json().catch(() => null);
  if (!body || !body.orderId || !body.eventId) return json({ ok: false, error: 'bad-request' }, 400, origin);

  const existing = await env.TICKETS.get('order:' + body.orderId);
  if (existing) {
    const codes = JSON.parse(existing);
    return json({ ok: true, code: codes[0], codes: codes, alreadyIssued: true }, 200, origin);
  }

  const qty = Math.max(1, Math.min(20, parseInt(body.qty, 10) || 1));
  const codes = [];
  for (let i = 0; i < qty; i++) {
    const code = randomCode();
    const record = {
      orderId: body.orderId,
      eventId: body.eventId,
      tierId: body.tierId || '',
      tierLabel: body.tierLabel || '',
      eventTitle: body.eventTitle || '',
      buyerEmail: body.buyerEmail || '',
      buyerName: body.buyerName || '',
      used: false,
      createdAt: new Date().toISOString(),
      usedAt: null
    };
    await env.TICKETS.put('ticket:' + code, JSON.stringify(record));
    codes.push(code);
  }
  await env.TICKETS.put('order:' + body.orderId, JSON.stringify(codes));

  let emailSent = false;
  let emailError = '';
  if (body.buyerEmail) {
    try {
      const r = await sendTicketEmail(env, {
        to: body.buyerEmail,
        codes: codes,
        eventTitle: body.eventTitle || '',
        tierLabel: body.tierLabel || '',
        verifyUrlBase: 'https://scaro.it/verifica.html?c='
      });
      emailSent = r.ok;
      if (!r.ok) emailError = r.detail || '';
    } catch (e) { emailError = String(e); }
  }

  return json({ ok: true, code: codes[0], codes: codes, emailSent: emailSent, emailError: emailError }, 200, origin);
}

async function handleListTickets(request, env, origin) {
  // Elenco di chi ha comprato un biglietto. Contiene email e nomi, quindi
  // e' protetto da una chiave (ADMIN_KEY) che non deve mai finire nel
  // codice del sito, solo su Cloudflare.
  const key = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const list = await env.TICKETS.list({ prefix: 'ticket:' });
  const tickets = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.TICKETS.get(k.name);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return {
      code: k.name.replace(/^ticket:/, ''),
      eventId: t.eventId,
      eventTitle: t.eventTitle,
      tierLabel: t.tierLabel,
      buyerName: t.buyerName,
      buyerEmail: t.buyerEmail,
      paymentMethod: t.paymentMethod || '',
      paid: t.paid !== false,
      orderId: t.orderId || '',
      used: t.used,
      usedAt: t.usedAt,
      createdAt: t.createdAt
    };
  }));
  const cleaned = tickets.filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return json({ ok: true, tickets: cleaned }, 200, origin);
}

async function handleTicketStatus(env, origin, code) {
  const raw = await env.TICKETS.get('ticket:' + code);
  if (!raw) return json({ ok: false, error: 'not-found' }, 404, origin);
  const t = JSON.parse(raw);
  return json({ ok: true, used: t.used, usedAt: t.usedAt, eventTitle: t.eventTitle, tierLabel: t.tierLabel, buyerName: t.buyerName, paid: t.paid !== false }, 200, origin);
}

async function handleCheckin(env, origin, code) {
  const raw = await env.TICKETS.get('ticket:' + code);
  if (!raw) return json({ ok: false, error: 'not-found' }, 404, origin);
  const t = JSON.parse(raw);
  if (t.paid === false) return json({ ok: false, error: 'not-paid', buyerName: t.buyerName, eventTitle: t.eventTitle, tierLabel: t.tierLabel }, 402, origin);
  if (t.used) return json({ ok: false, error: 'already-used', usedAt: t.usedAt, buyerName: t.buyerName }, 409, origin);
  t.used = true;
  t.usedAt = new Date().toISOString();
  await env.TICKETS.put('ticket:' + code, JSON.stringify(t));
  return json({ ok: true, buyerName: t.buyerName, eventTitle: t.eventTitle, tierLabel: t.tierLabel }, 200, origin);
}

// --- Riconciliazione PayPal <-> biglietti generati ---
// Trova pagamenti realmente arrivati su PayPal per cui il nostro sistema
// NON ha generato nessun biglietto (capture riuscita lato PayPal ma la
// risposta non e' mai arrivata al browser dell'acquirente, o la chiamata
// finale non e' mai partita). Protetto da RECONCILE_KEY.
async function paypalListTransactions(env, startDate, endDate) {
  const base = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await paypalToken(env);
  const results = [];
  let page = 1;
  for (;;) {
    const url = base + '/v1/reporting/transactions'
      + '?start_date=' + encodeURIComponent(startDate)
      + '&end_date=' + encodeURIComponent(endDate)
      + '&fields=all&page_size=100&page=' + page;
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error('paypal-reporting-failed');
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    const data = await res.json();
    (data.transaction_details || []).forEach(function (t) {
      const info = t.transaction_info || {};
      results.push({
        orderId: info.paypal_reference_id || info.transaction_id || '',
        transactionId: info.transaction_id || '',
        status: info.transaction_status || '',
        amount: info.transaction_amount ? info.transaction_amount.value : '',
        currency: info.transaction_amount ? info.transaction_amount.currency_code : '',
        date: info.transaction_initiation_date || '',
        customId: info.custom_field || '',
        payerName: t.payer_info && t.payer_info.payer_name
          ? [t.payer_info.payer_name.given_name, t.payer_info.payer_name.surname].filter(Boolean).join(' ')
          : '',
        payerEmail: t.payer_info ? t.payer_info.email_address || '' : ''
      });
    });
    const totalPages = data.total_pages || 1;
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

async function handleReconcile(request, env, origin) {
  if (!env.RECONCILE_KEY) return json({ ok: false, error: 'RECONCILE_KEY non configurato' }, 500, origin);
  const key = request.headers.get('X-Reconcile-Key') || '';
  if (key !== env.RECONCILE_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const url = new URL(request.url);
  const days = Math.min(31, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 30));
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = function (d) { return d.toISOString().slice(0, 19) + '-0000'; };

  let transactions;
  try {
    transactions = await paypalListTransactions(env, fmt(start), fmt(end));
  } catch (e) {
    return json({ ok: false, error: 'paypal-reporting-failed', detail: e.detail || String(e), status: e.status }, e.status || 502, origin);
  }

  const completed = transactions.filter(function (t) {
    return t.status === 'S' || t.status === 'COMPLETED';
  });

  const missing = [];
  for (const t of completed) {
    const existing = t.orderId ? await env.TICKETS.get('order:' + t.orderId) : null;
    if (!existing) missing.push(t);
  }

  return json({
    ok: true,
    periodo: { da: start.toISOString(), a: end.toISOString() },
    transazioniCompletate: completed.length,
    ordiniSenzaBiglietto: missing.length,
    dettaglio: missing
  }, 200, origin);
}

async function handleResendTickets(request, env, origin) {
  if (!env.RECONCILE_KEY) return json({ ok: false, error: 'RECONCILE_KEY non configurato' }, 500, origin);
  const key = request.headers.get('X-Reconcile-Key') || '';
  if (key !== env.RECONCILE_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';

  const list = await env.TICKETS.list({ prefix: 'ticket:' });
  const all = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.TICKETS.get(k.name);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return Object.assign({ code: k.name.replace(/^ticket:/, '') }, t);
  }));

  const groups = {};
  all.filter(Boolean).forEach(function (t) {
    if (!t.buyerEmail) return;
    if (t.tierId === 'test' || (t.tierLabel || '').toUpperCase().indexOf('TEST') !== -1) return;
    const gKey = t.orderId + '|' + t.buyerEmail;
    if (!groups[gKey]) groups[gKey] = { buyerEmail: t.buyerEmail, buyerName: t.buyerName, eventTitle: t.eventTitle, tierLabel: t.tierLabel, codes: [] };
    groups[gKey].codes.push(t.code);
  });

  const groupList = Object.values(groups);
  if (dryRun) {
    return json({ ok: true, dryRun: true, gruppiDaInviare: groupList.length, destinatari: groupList.map(function (g) { return { email: g.buyerEmail, nome: g.buyerName, biglietti: g.codes.length, evento: g.eventTitle }; }) }, 200, origin);
  }

  const risultati = [];
  for (const g of groupList) {
    try {
      const r = await sendTicketEmail(env, {
        to: g.buyerEmail,
        codes: g.codes,
        eventTitle: g.eventTitle || 'Evento Scaro',
        tierLabel: g.tierLabel || '',
        verifyUrlBase: 'https://scaro.it/verifica.html?c=',
        resend: true
      });
      risultati.push({ email: g.buyerEmail, ok: r.ok, detail: r.detail || '' });
    } catch (e) {
      risultati.push({ email: g.buyerEmail, ok: false, detail: String(e) });
    }
  }
  const inviate = risultati.filter(function (r) { return r.ok; }).length;
  return json({ ok: true, inviate: inviate, fallite: risultati.length - inviate, risultati: risultati }, 200, origin);
}

async function handleReconcileTickets(request, env, origin) {
  if (!env.RECONCILE_KEY) return json({ ok: false, error: 'RECONCILE_KEY non configurato' }, 500, origin);
  const key = request.headers.get('X-Reconcile-Key') || '';
  if (key !== env.RECONCILE_KEY) return json({ ok: false, error: 'unauthorized' }, 401, origin);

  const list = await env.TICKETS.list({ prefix: 'ticket:' });
  const tickets = await Promise.all(list.keys.map(async (k) => {
    const raw = await env.TICKETS.get(k.name);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return {
      code: k.name.replace(/^ticket:/, ''),
      eventId: t.eventId,
      eventTitle: t.eventTitle,
      tierId: t.tierId,
      tierLabel: t.tierLabel,
      buyerName: t.buyerName,
      orderId: t.orderId,
      createdAt: t.createdAt
    };
  }));
  return json({ ok: true, tickets: tickets.filter(Boolean) }, 200, origin);
}

// --- Login GitHub per il pannello editoriale (Decap CMS su /admin) ---
// Serve perche' GitHub richiede uno scambio server-to-server (client_secret)
// per completare il login OAuth: non si puo' fare solo dal browser.
// Variabili richieste (mai nel codice/repo): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
// (impostale con `wrangler secret put NOME`).
function handleCmsAuth(request, env) {
  if (!env.GITHUB_CLIENT_ID) return new Response('GITHUB_CLIENT_ID non configurato', { status: 500 });
  const url = new URL(request.url);
  const redirectUri = url.origin + '/callback';
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'repo,user');
  return Response.redirect(authUrl.toString(), 302);
}

function cmsAuthPage(status, payload) {
  const payloadJson = JSON.stringify(payload);
  const messageLiteral = JSON.stringify('authorization:github:' + status + ':' + payloadJson);
  const html = '<!doctype html><html><body><script>' +
    '(function(){' +
    'function receiveMessage(e){' +
    'window.opener.postMessage(' + messageLiteral + ', e.origin);' +
    'window.removeEventListener("message", receiveMessage, false);' +
    '}' +
    'window.addEventListener("message", receiveMessage, false);' +
    'window.opener.postMessage("authorizing:github", "*");' +
    '})();' +
    '</script></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleCmsCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return cmsAuthPage('error', { message: 'Codice mancante nella risposta di GitHub.' });

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: code
    })
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
    return cmsAuthPage('error', { message: tokenData.error_description || 'Login GitHub fallito.' });
  }
  return cmsAuthPage('success', { token: tokenData.access_token, provider: 'github' });
}

// --- Pannello semplificato (pannello.html) per i soci senza account GitHub ---
// Loro fanno login con nome + PIN (SOCI_CREDENTIALS); il Worker pubblica per
// loro sul repo usando un token proprio (GITHUB_PAT), quindi lato GitHub
// risulta tutto pubblicato "dal sistema", non da un utente vero.
const REPO = 'fedeneri/laboratorio-politico-ravanusella';

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').split('').filter(function(ch){ return ch.charCodeAt(0) < 128; }).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || ('contenuto-' + Date.now());
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function checkSocio(env, name, pin) {
  let creds = {};
  try { creds = JSON.parse(env.SOCI_CREDENTIALS || '{}'); } catch (e) { /* config mancante o malformata */ }
  return !!name && !!pin && creds[name] && creds[name] === pin;
}

async function ghPutFile(env, path, base64Content, message) {
  const res = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + path, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + env.GITHUB_PAT,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'scaro-pannello',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: message, content: base64Content, branch: 'main' })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error('github-put-failed');
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

const TALK_FIELDS = ['mcat', 'tipo', 'date', 'data', 'dur', 'youtube', 'spotify', 'desc', 'body', 'autore'];
const EVENTO_FIELDS = ['kind', 'date', 'time', 'place', 'description', 'price'];

async function handleCmsPublish(request, env, origin) {
  if (!env.GITHUB_PAT) return json({ ok: false, error: 'GITHUB_PAT non configurato' }, 500, origin);
  const body = await request.json().catch(() => null);
  if (!body || !body.kind || !body.fields) return json({ ok: false, error: 'bad-request' }, 400, origin);
  if (!checkSocio(env, body.name, body.pin)) return json({ ok: false, error: 'unauthorized' }, 401, origin);
  if (body.kind !== 'talk' && body.kind !== 'evento') return json({ ok: false, error: 'bad-kind' }, 400, origin);

  const isTalk = body.kind === 'talk';
  const titleSrc = isTalk ? body.fields.testo : body.fields.title;
  if (!titleSrc || !String(titleSrc).trim()) return json({ ok: false, error: 'titolo mancante' }, 400, origin);

  const slug = slugify(titleSrc) + '-' + Math.random().toString(36).slice(2, 6);
  const allowedFields = isTalk ? TALK_FIELDS : EVENTO_FIELDS;
  const data = { id: slug };
  if (isTalk) data.testo = String(titleSrc).trim(); else data.title = String(titleSrc).trim();
  allowedFields.forEach(function (f) {
    const v = body.fields[f];
    if (v === undefined || v === null || v === '') return;
    data[f] = f === 'price' ? (Number(v) || 0) : v;
  });

  if (body.imageBase64) {
    const ext = (body.imageExt || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
    const imgPath = 'content/assets/' + slug + '.' + ext;
    try {
      await ghPutFile(env, imgPath, body.imageBase64, 'Immagine per ' + slug + ' (da ' + body.name + ')');
    } catch (e) {
      return json({ ok: false, error: 'upload-immagine-fallito', detail: e.detail || String(e) }, e.status || 502, origin);
    }
    if (isTalk) data.img = imgPath; else data.flyer = imgPath;
  }

  const folder = isTalk ? 'content/talks' : 'content/eventi';
  const jsonPath = folder + '/' + slug + '.json';
  const contentB64 = utf8ToBase64(JSON.stringify(data, null, 2) + '\n');
  try {
    await ghPutFile(env, jsonPath, contentB64, (isTalk ? 'Nuovo contenuto' : 'Nuovo evento') + ': ' + titleSrc + ' (da ' + body.name + ')');
  } catch (e) {
    return json({ ok: false, error: 'pubblicazione-fallita', detail: e.detail || String(e) }, e.status || 502, origin);
  }

  return json({ ok: true, id: slug }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    if (url.pathname === '/api/cms/publish' && request.method === 'POST') {
      return handleCmsPublish(request, env, origin);
    }

    if (url.pathname === '/api/reconcile' && request.method === 'GET') {
      return handleReconcile(request, env, origin);
    }
    if (url.pathname === '/api/reconcile-create-ticket' && request.method === 'POST') {
      return handleReconcileCreateTicket(request, env, origin);
    }
    if (url.pathname === '/api/reconcile-tickets' && request.method === 'GET') {
      return handleReconcileTickets(request, env, origin);
    }
    if (url.pathname === '/api/resend-tickets' && request.method === 'POST') {
      return handleResendTickets(request, env, origin);
    }

    if (url.pathname === '/auth' && request.method === 'GET') {
      return handleCmsAuth(request, env);
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      return handleCmsCallback(request, env);
    }

    if (url.pathname === '/api/create-order' && request.method === 'POST') {
      return handleCreateOrder(request, env, origin);
    }
    if (url.pathname === '/api/capture-order' && request.method === 'POST') {
      return handleCaptureOrder(request, env, origin);
    }
    if (url.pathname === '/api/test-ticket' && request.method === 'POST') {
      return handleTestTicket(request, env, origin);
    }
    if (url.pathname === '/api/tickets' && request.method === 'GET') {
      return handleListTickets(request, env, origin);
    }
    if (url.pathname === '/api/tickets/checkin-by-email' && request.method === 'POST') {
      return handleCheckinByEmail(request, env, origin);
    }
    if (url.pathname === '/api/box-office-ticket' && request.method === 'POST') {
      return handleBoxOfficeTicket(request, env, origin);
    }
    if (url.pathname === '/api/box-office-reserve' && request.method === 'POST') {
      return handleBoxOfficeReserve(request, env, origin);
    }
    const confirmMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)\/confirm-payment$/i);
    if (confirmMatch && request.method === 'POST') {
      return handleConfirmPayment(request, env, origin, confirmMatch[1].toUpperCase());
    }
    const statusMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)$/i);
    if (statusMatch && request.method === 'GET') {
      return handleTicketStatus(env, origin, statusMatch[1].toUpperCase());
    }
    const checkinMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)\/checkin$/i);
    if (checkinMatch && request.method === 'POST') {
      return handleCheckin(env, origin, checkinMatch[1].toUpperCase());
    }
    const deleteMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)$/i);
    if (deleteMatch && request.method === 'DELETE') {
      return handleDeleteTicket(request, env, origin, deleteMatch[1].toUpperCase());
    }

    return json({ ok: false, error: 'not-found' }, 404, origin);
  }
};

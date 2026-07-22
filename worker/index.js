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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

async function sendTicketEmail(env, { to, code, eventTitle, tierLabel, verifyUrl }) {
  const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=' + encodeURIComponent(verifyUrl);
  const html =
    '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;border:2px solid #164194;padding:24px;">' +
    '<h1 style="color:#164194;font-size:20px;margin:0 0 12px;">Il tuo biglietto Scaro</h1>' +
    '<p style="margin:0 0 4px;"><b>' + eventTitle + '</b></p>' +
    '<p style="margin:0 0 16px;color:#555;">' + tierLabel + '</p>' +
    '<p style="font-size:24px;font-weight:bold;letter-spacing:2px;margin:0 0 16px;">' + code + '</p>' +
    '<img src="' + qrUrl + '" alt="QR biglietto" style="width:100%;max-width:320px;display:block;margin:0 0 16px;">' +
    '<p style="font-size:13px;color:#555;margin:0;">Mostra questa email (o il QR) all\'ingresso. Il biglietto è valido per un solo ingresso.</p>' +
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
      subject: 'Il tuo biglietto — ' + eventTitle,
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

  // Idempotenza: se questo ordine ha già generato un biglietto, restituisci quello.
  const existing = await env.TICKETS.get('order:' + body.orderID);
  if (existing) return json({ ok: true, code: existing, alreadyIssued: true }, 200, origin);

  let capture;
  try { capture = await paypalCaptureOrder(env, body.orderID); }
  catch (e) { return json({ ok: false, error: 'paypal-capture-failed', detail: e.detail || String(e) }, 502, origin); }

  if (capture.status !== 'COMPLETED') return json({ ok: false, error: 'not-completed' }, 402, origin);

  const unit = (capture.purchase_units && capture.purchase_units[0]) || {};
  const paidCustomId = unit.custom_id || '';
  const eventId = paidCustomId.split(':')[0];

  const code = randomCode();
  const payer = capture.payer || {};
  const record = {
    orderId: body.orderID,
    eventId: eventId,
    tierId: body.tierId || '',
    tierLabel: body.tierLabel || '',
    eventTitle: body.eventTitle || '',
    buyerEmail: payer.email_address || body.buyerEmail || '',
    buyerName: (payer.name && payer.name.given_name) || body.buyerName || '',
    used: false,
    createdAt: new Date().toISOString(),
    usedAt: null
  };
  await env.TICKETS.put('ticket:' + code, JSON.stringify(record));
  await env.TICKETS.put('order:' + body.orderID, code);

  let emailSent = false;
  let emailError = '';
  if (record.buyerEmail) {
    try {
      const emailResult = await sendTicketEmail(env, {
        to: record.buyerEmail,
        code: code,
        eventTitle: record.eventTitle,
        tierLabel: record.tierLabel,
        verifyUrl: 'https://scaro.it/verifica.html?c=' + code
      });
      emailSent = emailResult.ok;
      if (!emailResult.ok) emailError = emailResult.detail || '';
    } catch (e) { emailError = String(e); /* il biglietto resta valido anche se l'invio email fallisce */ }
  }

  return json({ ok: true, code: code, emailSent: emailSent, emailError: emailError }, 200, origin);
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
        code: code,
        eventTitle: record.eventTitle,
        tierLabel: record.tierLabel,
        verifyUrl: 'https://scaro.it/verifica.html?c=' + code
      });
      emailSent = emailResult.ok;
      if (!emailResult.ok) emailError = emailResult.detail || '';
    } catch (e) { emailError = String(e); /* il biglietto resta valido anche se l'invio email fallisce */ }
  }

  return json({ ok: true, code: code, emailSent: emailSent, emailError: emailError }, 200, origin);
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
  return json({ ok: true, used: t.used, usedAt: t.usedAt, eventTitle: t.eventTitle, tierLabel: t.tierLabel, buyerName: t.buyerName }, 200, origin);
}

async function handleCheckin(env, origin, code) {
  const raw = await env.TICKETS.get('ticket:' + code);
  if (!raw) return json({ ok: false, error: 'not-found' }, 404, origin);
  const t = JSON.parse(raw);
  if (t.used) return json({ ok: false, error: 'already-used', usedAt: t.usedAt, buyerName: t.buyerName }, 409, origin);
  t.used = true;
  t.usedAt = new Date().toISOString();
  await env.TICKETS.put('ticket:' + code, JSON.stringify(t));
  return json({ ok: true, buyerName: t.buyerName, eventTitle: t.eventTitle, tierLabel: t.tierLabel }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

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
    const statusMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)$/i);
    if (statusMatch && request.method === 'GET') {
      return handleTicketStatus(env, origin, statusMatch[1].toUpperCase());
    }
    const checkinMatch = url.pathname.match(/^\/api\/ticket\/([A-Z0-9-]+)\/checkin$/i);
    if (checkinMatch && request.method === 'POST') {
      return handleCheckin(env, origin, checkinMatch[1].toUpperCase());
    }

    return json({ ok: false, error: 'not-found' }, 404, origin);
  }
};

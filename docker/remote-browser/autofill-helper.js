#!/usr/bin/env node
/*
 * Cerebro Remote Browser — in-container web-credential autofill helper.
 *
 * Runs INSIDE the ephemeral Chromium container (not on the host). It:
 *   1. redeems the web credential ONCE from the broker over the internal Docker
 *      network (AUTOFILL_REDEEM_URL — a single-use, IP-scoped token endpoint);
 *   2. drives Chromium over CDP (127.0.0.1:9222, never exposed) to fill the login
 *      form.
 *
 * The credential therefore never reaches the operator's client, never lands in an
 * env var / file / URL, and lives only in this process's memory. CDP is reachable
 * only on loopback inside this container.
 *
 * Dependency-free on purpose (the image is debian-slim + chromium + node): a tiny
 * RFC6455 client is implemented below rather than pulling an npm WebSocket lib.
 *
 * See docs/fabric-remote-browser-credential-injection.md.
 */
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const REDEEM_URL = process.env.AUTOFILL_REDEEM_URL;
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_HOST = '127.0.0.1';
const POLL_MS = 1500;
const POLL_CAP_MS = 60 * 60 * 1000; // stop polling after an hour (manual may arm late)
const FILL_ATTEMPTS = 20; // ~20 * 750ms = 15s for the login form to appear
const FILL_GAP_MS = 750;

const log = (...a) => console.log('[autofill]', ...a);

if (!REDEEM_URL) {
  // No credential armed for this session — nothing to do.
  process.exit(0);
}

main().catch((e) => {
  log('fatal:', e && e.message ? e.message : e);
  process.exit(0); // never take the container down on autofill failure
});

async function main() {
  await waitForCdp();
  const creds = await pollForCreds();
  if (!creds) {
    log('no credential delivered — exiting.');
    return;
  }
  if (creds.recipe) {
    // Recipes are P2; P1 falls back to the generic heuristic.
    log('a login recipe was provided but recipe execution is not enabled yet (P2); using heuristic.');
  }
  const ok = await fillWithRetries(creds.username || '', creds.password || '');
  log(ok ? 'login form filled.' : 'could not find a login form to fill.');
}

// --- Credential redemption -------------------------------------------------

function pollForCreds() {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      redeemOnce()
        .then((r) => {
          if (r.status === 200 && r.body) return resolve(r.body);
          if (r.status === 404 || r.status === 410) return resolve(null); // session gone
          if (Date.now() - started > POLL_CAP_MS) return resolve(null);
          setTimeout(tick, POLL_MS); // 204 = not armed yet (manual) — keep polling
        })
        .catch(() => {
          if (Date.now() - started > POLL_CAP_MS) return resolve(null);
          setTimeout(tick, POLL_MS);
        });
    };
    tick();
  });
}

function redeemOnce() {
  return new Promise((resolve, reject) => {
    const req = http.request(REDEEM_URL, { method: 'POST', timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body = null;
        if (res.statusCode === 200 && data) {
          try { body = JSON.parse(data); } catch { /* ignore */ }
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('redeem timeout')));
    req.on('error', reject);
    req.end();
  });
}

// --- CDP (minimal) ---------------------------------------------------------

function waitForCdp() {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      cdpGetJson('/json/version')
        .then(() => resolve())
        .catch(() => {
          if (++tries > 60) return resolve(); // ~30s; proceed and let fill retries handle it
          setTimeout(tick, 500);
        });
    };
    tick();
  });
}

function cdpGetJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: CDP_HOST, port: CDP_PORT, path, timeout: 4000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(new Error('cdp timeout')); });
  });
}

/** Find the page target's WebSocket debugger URL. */
async function pageWsUrl() {
  const targets = await cdpGetJson('/json');
  const page = (Array.isArray(targets) ? targets : []).find(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl,
  );
  return page ? page.webSocketDebuggerUrl : null;
}

/** Evaluate an expression in the page via a one-shot CDP WebSocket connection. */
function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port) || CDP_PORT, u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${u.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    sock.setTimeout(15000, () => sock.destroy(new Error('cdp ws timeout')));

    let upgraded = false;
    let buf = Buffer.alloc(0);
    const done = (err, val) => {
      try { sock.destroy(); } catch { /* noop */ }
      if (err) reject(err);
      else resolve(val);
    };

    sock.on('error', (e) => done(e));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        const head = buf.slice(0, i).toString();
        if (!/HTTP\/1\.1 101/.test(head)) return done(new Error('cdp ws upgrade failed'));
        upgraded = true;
        buf = buf.slice(i + 4);
        sock.write(
          encodeFrame(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
            }),
          ),
        );
      }
      // Parse any complete server frames.
      let frame;
      while ((frame = decodeFrame(buf))) {
        buf = frame.rest;
        if (frame.opcode === 0x8) return done(null, null); // close
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          try {
            const msg = JSON.parse(frame.payload.toString('utf8'));
            if (msg.id === 1) {
              const result = msg.result && msg.result.result ? msg.result.result.value : null;
              return done(null, result);
            }
          } catch { /* ignore non-JSON */ }
        }
      }
    });
  });
}

/** Encode a masked client text frame (RFC6455). */
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** Decode one server frame (server→client is unmasked). Returns null if incomplete. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.slice(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const m = buf.slice(offset, offset + 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
    payload = out;
  }
  return { opcode, payload, rest: buf.slice(offset + maskLen + len) };
}

// --- The fill itself -------------------------------------------------------

async function fillWithRetries(username, password) {
  for (let i = 0; i < FILL_ATTEMPTS; i++) {
    const wsUrl = await pageWsUrl().catch(() => null);
    if (wsUrl) {
      const res = await cdpEvaluate(wsUrl, fillExpression(username, password)).catch(() => null);
      if (res && res.filled) return true;
    }
    await sleep(FILL_GAP_MS);
  }
  return false;
}

/**
 * Build the page-side heuristic fill expression. Finds the first visible password
 * field, the text-like input before it in the same form as the username, sets both
 * via the native value setter (so React/Vue controlled inputs register the change),
 * and dispatches input/change. Does NOT submit — the operator reviews and submits.
 */
function fillExpression(username, password) {
  const u = JSON.stringify(username);
  const p = JSON.stringify(password);
  return `(function(U,P){
    function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    function setVal(el,val){
      var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
      setter.call(el,val);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    var pws=[].slice.call(document.querySelectorAll('input[type=password]')).filter(vis);
    var pw=pws[0];
    if(!pw) return {filled:false,reason:'no-password-field'};
    var scope=pw.form||document;
    var inputs=[].slice.call(scope.querySelectorAll('input'));
    var isUser=function(i){var t=(i.type||'text').toLowerCase();return t!=='password'&&t!=='hidden'&&t!=='checkbox'&&t!=='radio'&&t!=='submit'&&t!=='button'&&vis(i);};
    var user=null;
    var pwIdx=inputs.indexOf(pw);
    for(var k=pwIdx-1;k>=0;k--){if(isUser(inputs[k])){user=inputs[k];break;}}
    if(!user){user=inputs.filter(isUser)[0]||null;}
    if(user&&U) setVal(user,U);
    setVal(pw,P);
    return {filled:true,submitted:false,user:!!user};
  })(${u},${p})`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

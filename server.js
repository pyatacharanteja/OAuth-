'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const dns = require('dns').promises, net = require('net');

// ---- config (.env loader, no dependencies) ----
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const PORT = +process.env.PORT || 3000;
const LLM = { key: process.env.LLM_API_KEY, base: (process.env.LLM_BASE_URL || '').replace(/\/$/, ''), model: process.env.LLM_MODEL };
const llmReady = () => !!(LLM.key && LLM.base && LLM.model);
const MAX_CHARS = Math.max(4000, +process.env.LLM_MAX_CHARS || 12000);   // documentation text sent to the model
const RETRY = process.env.LLM_RETRY === '1';                              // enable only on tiers with higher rate limits
const GEN_DIR = path.join(__dirname, 'data', 'generated');
const TTL = 7 * 864e5;

// ---- safe fetching (SSRF guard, size/time limits) ----
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivate(s.slice(7));
  return s === '::1' || s === '::' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Unsupported port');
  if (net.isIP(u.hostname)) { if (isPrivate(u.hostname)) throw new Error('Blocked address'); return; }
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('Blocked address');
}
async function safeFetch(url, hops = 3) {
  let u = new URL(url);
  for (let i = 0; i <= hops; i++) {
    await assertPublic(u);
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'OAuthPathBot/1.0 (documentation research)', accept: 'text/html,text/plain' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    if (!/text\/(html|plain)|xhtml/.test(ct)) throw new Error('Not a text page');
    const chunks = []; let n = 0;
    for await (const c of r.body) { n += c.length; if (n > 1.5e6) break; chunks.push(c); }
    return { url: u.toString(), html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}
const toText = h => h.replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();
function links(html, base) {
  const out = [], re = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) && out.length < 600) {
    try { const u = new URL(m[1], base); if (/^https?:$/.test(u.protocol)) out.push({ url: u.toString().split('#')[0], text: toText(m[2]).slice(0, 80) }); } catch {}
  }
  return out;
}
const SCORE = /oauth|authoriz|authenticat|app[-_ ]?review|verification|marketplace|submit|publish|client[-_ ]?(id|secret)|redirect|scopes?|developer|api[-_ ]?(access|keys?)|partner/i;
const score = l => (SCORE.test(l.url) ? 2 : 0) + (SCORE.test(l.text) ? 1 : 0) + (/oauth/i.test(l.url + l.text) ? 3 : 0);

// ---- helpers ----
const slugify = s => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const norm = s => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s ?? '').slice(0, n);
const EV = ['documented', 'reviewed', 'unverified', 'unknown'];
const claim = (x) => {
  if (Array.isArray(x)) x = { text: x[0], evidence: x[1] };
  if (typeof x === 'string') x = { text: x };
  const o = { text: clip(x.text, 400), evidence: EV.includes(x.evidence) ? x.evidence : 'unverified' };
  if (x.source != null) o.source = x.source;
  if (x.quote) o.quote = clip(x.quote, 300);
  return o;
};
const list = (a, f, n = 12) => (Array.isArray(a) ? a : []).slice(0, n).map(f).filter(v => v && (v.text ?? v));
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function normGuide(g, origin) {
  return {
    id: slugify(g.id || g.name), name: clip(g.name, 80), site: clip(g.site, 120), origin: g.origin || origin,
    difficulty: ['Easy', 'Moderate', 'Hard', 'Unknown'].includes(g.difficulty) ? g.difficulty : 'Unknown',
    effort: clip(g.effort, 300), approval: clip(g.approval, 400), summary: clip(g.summary, 600),
    steps: list(g.steps, claim), blockers: list(g.blockers, claim),
    agentCan: list(g.agentCan, s => clip(s, 300)), humanMust: list(g.humanMust, s => clip(s, 300)), gaps: list(g.gaps, s => clip(s, 300)),
    sources: list(g.sources, s => (s && /^https?:\/\//.test(s.url) ? { title: clip(s.title || s.url, 120), url: s.url } : null)),
    generatedAt: g.generatedAt || null,
  };
}
function listGuides() {
  const seeds = (readJSON(path.join(__dirname, 'data', 'seeds.json')) || []).map(g => normGuide(g, 'curated'));
  let gen = [];
  try { gen = fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(GEN_DIR, f))).filter(Boolean); } catch {}
  return [...seeds, ...gen.filter(g => !seeds.some(s => s.id === g.id))];
}
function appName(q) {
  q = q.trim();
  if (/^https?:\/\//i.test(q) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(q)) {
    let h; try { h = new URL(/^https?:/i.test(q) ? q : 'https://' + q).hostname; } catch { return q.slice(0, 60); }
    const l = h.replace(/^www\./, '').split('.'), w = l.length > 1 ? l[l.length - 2] : l[0];
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  const n = q.slice(0, 60); return n.charAt(0).toUpperCase() + n.slice(1);
}

// ---- LLM ----
// ---- LLM ----
async function chat(messages, maxTokens = 600) {
  const url = LLM.base + '/chat/completions';
  const cap = maxTokens <= 1000 ? 800 : 3200; // headroom for models that reason before answering
  const call = async (extra) => {
    try {
      return await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + LLM.key },
        body: JSON.stringify({ model: LLM.model, temperature: 0.1, max_tokens: cap, messages, ...extra }),
      });
    } catch (e) {
      const why = (e && e.cause && (e.cause.code || e.cause.message)) || e.message;
      throw new Error('Could not reach ' + url + ' (' + why + '). Check LLM_BASE_URL and your internet connection.');
    }
  };
  let r = await call({ response_format: { type: 'json_object' }, reasoning_effort: 'low' });
  if (r.status === 400) r = await call({}); // provider does not accept the extra options
  if (!r.ok) {
    const d = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    if (r.status === 413 || r.status === 429) throw new Error('The model provider\'s rate limit was hit. Wait one minute and try again. If it keeps happening, set a smaller LLM_MAX_CHARS (for example 8000) in .env. Details: ' + d);
    throw new Error('Language model request failed (HTTP ' + r.status + ') for model "' + LLM.model + '": ' + d);
  }
  let data;
  try { data = await r.json(); } catch { throw new Error('The language model returned an unreadable response'); }
  const choice = data && data.choices && data.choices[0];
  const t = choice && choice.message && choice.message.content;
  const cut = choice && choice.finish_reason === 'length';
  if (!t) throw new Error(cut ? 'The model ran out of room before answering. Please try again.' : 'Empty model response');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error((cut ? 'The model\'s reply was cut off. ' : 'Model did not return JSON. ') + 'It said: ' + t.replace(/\s+/g, ' ').slice(0, 120));
  try { return JSON.parse(m[0]); } catch { throw new Error('Model returned malformed or cut-off JSON. Please try again.'); }
}

// ---- generation pipeline ----
async function resolveSite(q, emit) {
  q = q.trim();
  if (/^https?:\/\//i.test(q) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(q)) return new URL(/^https?:/i.test(q) ? q : 'https://' + q);
  emit('Finding the official website for "' + q + '"');
  const r = await chat([{ role: 'user', content: 'What is the primary official website domain of the software product or company "' + q.replace(/["\n]/g, ' ') + '"? Reply only with JSON: {"domain":"example.com"} or {"domain":null} if you do not recognize it.' }], 100);
  if (!r.domain) throw new Error('Could not identify that app. Try its website address instead.');
  try { return new URL('https://' + String(r.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')); }
  catch { throw new Error('Could not identify that app. Try its website address instead.'); }
}
const DOC_PATHS = ['/docs/authorization', '/docs/authentication', '/docs/oauth', '/docs/oauth2', '/docs/getting-started', '/authentication', '/oauth', '/docs/apps', '/docs/app-review'];
const KEY = /oauth|authoriz|client[ _-]?(id|secret)|redirect[ _-]?uri|app review|verification/gi;
const relevance = p => (p.text.match(KEY) || []).length;
function excerpt(text, n) { // the most OAuth-dense window of the page, not just its first lines
  if (text.length <= n) return text;
  const hits = []; let m; const re = new RegExp(KEY.source, 'gi');
  while ((m = re.exec(text)) && hits.length < 400) hits.push(m.index);
  if (!hits.length) return text.slice(0, n);
  let best = hits[0], bestN = 0;
  for (const h of hits) { const c = hits.filter(x => x >= h && x < h + n).length; if (c > bestN) { bestN = c; best = h; } }
  const start = Math.max(0, best - 200);
  return text.slice(start, start + n);
}
async function gather(site, emit) {
  const host = site.hostname.replace(/^www\./, ''), parts = host.split('.'), root = parts.slice(-2).join('.');
  const seen = new Map(); // final url -> {url,text,html}
  const add = async (u) => {
    if (seen.has(u) || seen.size >= 30) return;
    try {
      const p = await safeFetch(u); const text = toText(p.html);
      if (text.length > 300 && !seen.has(p.url)) { seen.set(p.url, { url: p.url, text, html: p.html }); emit('Read ' + p.url); }
    } catch {}
  };
  await add(site.toString());
  emit('Looking for developer documentation');
  const roots = [...new Set([`https://developers.${root}`, `https://developer.${root}`, `https://docs.${root}`, `https://${host}/docs`, `https://${host}/developers`, `https://api.${root}`])];
  await Promise.all(roots.map(add));
  const origins = [...new Set([site.origin, ...[...seen.keys()].map(u => new URL(u).origin)])].slice(0, 3);
  emit('Checking common OAuth and authentication pages');
  await Promise.all(origins.flatMap(o => DOC_PATHS.map(p => add(o + p))));
  const pool = () => [...seen.values()].flatMap(p => links(p.html, p.url));
  const sameFamily = h => h === root || h.endsWith('.' + root);
  const pick = () => [...new Map(pool().filter(l => !seen.has(l.url) && sameFamily(new URL(l.url).hostname)).map(l => [l.url, l])).values()].sort((a, b) => score(b) - score(a)).filter(l => score(l) >= 3);
  emit('Following OAuth and review links');
  for (let round = 0; round < 2; round++) await Promise.all(pick().slice(0, 4).map(l => add(l.url)));
  const ranked = [...seen.values()].sort((a, b) => relevance(b) - relevance(a));
  const out = []; let total = 0;
  const per = Math.max(2500, Math.floor(MAX_CHARS / 3));
  for (const p of ranked) {
    if (out.length >= 4 || total >= MAX_CHARS) break;
    const t = excerpt(p.text, Math.min(per, MAX_CHARS - total));
    if (!t) break;
    out.push({ url: p.url, text: t }); total += t.length;
  }
  if (!out.length) throw new Error('Could not find readable documentation for ' + host + '. Its docs may require JavaScript or a login.');
  return out;
}
const SYSTEM = `You are a careful integrations analyst. A developer building an agent product must create THEIR OWN OAuth app with a provider so their users can connect that provider's app. Write a guide using ONLY the numbered sources provided. Never use outside knowledge for facts.
Rules:
- For every step and blocker, include "source" (the source number) and "quote": an EXACT contiguous excerpt (under 200 characters) copied from that source that supports it. If you cannot quote support, set evidence to "unverified" (reasonable but unsupported) or "unknown" (not found), and omit source and quote.
- Do not invent time estimates. Give effort and approval timing only if sources state it; otherwise say it is not published and put that in "gaps".
- "difficulty": Easy (self-serve, no review), Moderate (review or verification required), Hard (gated partner access, paid or multi-week assessment), or Unknown. Always choose Easy, Moderate or Hard when the sources describe how apps are created or approved; use Unknown only if they say nothing about it.
- "agentCan": tasks software can do (drafting scope lists, generating authorize URLs, writing token exchange code, testing against a developer's own test account). "humanMust": tasks needing a person (signing in, identity or business verification, payments, consent clicks, replying to reviewers).
- "gaps": important things the sources did not answer.
- "name" is the product's own name (for example "Notion"), never a sentence.
Keep every field short. Return only JSON: {"name":str,"difficulty":str,"effort":str,"approval":str,"summary":str,"steps":[{"text":str,"evidence":"documented|unverified|unknown","source":int,"quote":str}],"blockers":[same],"agentCan":[str],"humanMust":[str],"gaps":[str]}. Use 5-7 steps and 3-5 blockers.`;
async function generate(query, emit) {
  const site = await resolveSite(query, emit);
  const pages = await gather(site, emit);
  emit('Analyzing ' + pages.length + ' pages');
  const body = pages.map((p, i) => `[Source ${i + 1}] ${p.url}\n${p.text}`).join('\n\n');
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'App or site: ' + query.slice(0, 200) + '\n\n' + body }];
  let raw = await chat(msgs, 2500);
  const quoted = r => [...(r.steps || []), ...(r.blockers || [])].filter(c => c && c.quote).length;
  if (RETRY && !quoted(raw)) { emit('Retrying analysis'); raw = await chat(msgs, 2500); }
  emit('Checking quotes against the sources');
  const normPages = pages.map(p => norm(p.text));
  const check = c => {
    const x = claim(c);
    let idx = -1;
    if (x.evidence === 'documented' && c.quote) {
      const q = norm(c.quote), want = (+c.source || 0) - 1;
      if (want >= 0 && normPages[want] && normPages[want].includes(q)) idx = want;
      else idx = normPages.findIndex(t => t.includes(q));
    }
    if (idx >= 0) { x.source = idx; x.quote = clip(c.quote, 300); }
    else { if (x.evidence === 'documented') x.evidence = 'unverified'; delete x.source; delete x.quote; }
    return x;
  };
  const name = appName(query);
  const g = normGuide({
    ...raw, name, id: name, site: site.hostname, origin: 'generated', generatedAt: new Date().toISOString(),
    steps: list(raw.steps, check), blockers: list(raw.blockers, check),
    sources: pages.map(p => ({ title: p.url.replace(/^https?:\/\//, '').slice(0, 100), url: p.url })),
  }, 'generated');
  g.steps.forEach(s => { if (s.source !== undefined && !g.sources[s.source]) delete s.source; });
  if (g.steps.length < 2) throw new Error('The analysis did not produce a usable guide. Please try again.');
  fs.mkdirSync(GEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(GEN_DIR, g.id + '.json'), JSON.stringify(g, null, 1));
  return g;
}

// ---- server ----
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 6e4); a.push(n); hits.set(ip, a); return a.length > 5; };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p === '/api/status') return send(res, 200, { generation: llmReady() });
    if (p === '/api/guides' && req.method === 'GET') return send(res, 200, listGuides().map(g => ({ id: g.id, name: g.name, site: g.site, difficulty: g.difficulty, origin: g.origin })));
    const gm = p.match(/^\/api\/guides\/([a-z0-9-]+)$/);
    if (gm) { const g = listGuides().find(x => x.id === gm[1]); return g ? send(res, 200, g) : send(res, 404, { error: 'Guide not found' }); }
    if (p === '/api/generate' && req.method === 'POST') {
      let b = ''; for await (const c of req) { b += c; if (b.length > 5000) break; }
      let q; try { q = String(JSON.parse(b).query || '').trim(); } catch { return send(res, 400, { error: 'Invalid request' }); }
      if (!q || q.length > 200) return send(res, 400, { error: 'Enter an app name or website (up to 200 characters).' });
      if (!llmReady()) return send(res, 503, { error: 'Live generation is not configured on this server. Set LLM_API_KEY, LLM_BASE_URL and LLM_MODEL.' });
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
      const cached = listGuides().find(g => g.origin === 'generated' && g.id === slugify(appName(q)) && Date.now() - Date.parse(g.generatedAt) < TTL);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const emit = m => res.write(JSON.stringify({ type: 'progress', message: m }) + '\n');
      try {
        if (cached) { emit('Using a recent guide'); res.write(JSON.stringify({ type: 'guide', guide: cached }) + '\n'); }
        else res.write(JSON.stringify({ type: 'guide', guide: await generate(q, emit) }) + '\n');
      } catch (e) { res.write(JSON.stringify({ type: 'error', message: e.message || 'Generation failed' }) + '\n'); }
      return res.end();
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    const f = p === '/' || p.startsWith('/g/') ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const fp = path.join(__dirname, 'public', f);
    if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(d); });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: 'Server error' }); else res.end(); }
});
if (require.main === module) server.listen(PORT, () => {
  console.log('OAuth Path running at http://localhost:' + PORT);
  console.log(llmReady() ? 'Live generation: ON  (' + LLM.base + ', model ' + LLM.model + ', ' + MAX_CHARS + ' chars of docs per guide)' : 'Live generation: OFF (set LLM_API_KEY, LLM_BASE_URL and LLM_MODEL in .env)');
});
module.exports = { isPrivate, norm, claim, normGuide, toText, server };
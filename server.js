const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '200kb' }));

// Render-safe paths: support both a public/index.html layout and a root index.html layout.
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const STATIC_DIR = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_DIR : __dirname;
app.use(express.static(STATIC_DIR));
app.get('/', (_req, res) => {
  const indexPath = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_INDEX : ROOT_INDEX;
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(500).type('text').send('FRS Dork URL Hunter: index.html not found. Upload index.html to the project root or public/index.html.');
});
const jobs = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cleanDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
  if (!s || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return s;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function inAllowedHost(url, domains) {
  try { const h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); return domains.some(d => h === d || h.endsWith('.' + d)); }
  catch { return false; }
}
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function extractLinks(html, engine) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi; let m;
  while ((m = re.exec(html)) !== null) {
    let raw = decodeHtml(m[1]);
    try {
      if (engine === 'bing' && raw.startsWith('/ck/a?')) continue;
      if (engine.startsWith('yahoo') && raw.startsWith('/')) continue;
      if (engine.startsWith('yahoo') && /(?:^|\?)RU=([^&]+)/i.test(raw)) {
        const rm = raw.match(/(?:^|\?)RU=([^&]+)/i); try { raw = decodeURIComponent(rm[1]); } catch {}
      }
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|exe|mp4|mp3)(?:$|\?)/i.test(u.href)) continue;
      { u.hash = ''; if (!u.hostname.match(/(?:bing|yahoo|microsoft)\.com$/i) && !u.hostname.match(/yahoo\.co\.jp$/i)) out.add(u.href); }
    } catch {}
  }
  return [...out];
}
function searchUrl(engine, query) {
  const q = encodeURIComponent(query);
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}&count=50`;
  if (engine === 'yahoo-jp') return `https://search.yahoo.co.jp/search?p=${q}`;
  return `https://search.yahoo.com/search?p=${q}&n=50`;
}
async function fetchSearch(engine, query, proxy, proxyType) {
  const url = searchUrl(engine, query);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; FRS-Dork-URL-Hunter/1.0; authorized research)', 'Accept-Language': 'en-US,en;q=0.8' };
  let agent;
  if (proxy) {
    if (proxyType === 'socks4') agent = new SocksProxyAgent('socks4://' + proxy);
    else if (proxyType === 'socks5') agent = new SocksProxyAgent('socks5h://' + proxy);
    else agent = new HttpsProxyAgent('http://' + proxy);
  }
  return await new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent, timeout: 18000 }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return reject(new Error(`${engine}: redirected; try again later`));
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`${engine}: HTTP ${response.statusCode}`));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${engine}: request timed out`)));
    req.on('error', reject);
  });
}
app.post('/api/start', (req, res) => {
  const dorks = [...new Set(String(req.body.dorks || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))].slice(0, 50);
  const engines = [...new Set((Array.isArray(req.body.engines) ? req.body.engines : []).filter(e => ['bing','yahoo','yahoo-jp'].includes(e)))];
  const proxyLines = String(req.body.proxyList || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  let proxy = '', proxyType = 'http', proxyName = 'Direct connection';
  if (proxyLines.length) {
    const first = proxyLines[0].split('|').map(x => x.trim());
    if (first.length >= 2 && ['http','socks4','socks5'].includes(first[0].toLowerCase())) { proxyType = first[0].toLowerCase(); proxy = first[1]; proxyName = `${proxyType.toUpperCase()} proxy`; }
    else { proxy = first[0]; proxyName = 'Proxy list · first entry'; }
    if (!/^[a-zA-Z0-9.:[\]-]+:\d{1,5}$/.test(proxy) || Number(proxy.split(':').pop()) > 65535) return res.status(400).json({error:'Proxy list format: IP:PORT, or TYPE | IP:PORT (HTTP/SOCKS4/SOCKS5).'});
  }
  if (!dorks.length) return res.status(400).json({ error: 'Add at least one search dork.' });
  if (!engines.length) return res.status(400).json({ error: 'Select at least one search engine.' });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const job = { id, dorks, engines, proxy, proxyType, proxyName, running: true, done: false, totalTasks: dorks.length * engines.length, completed: 0, urls: [], errors: [], startedAt: Date.now() };
  jobs.set(id, job);
  res.json({ id, totalTasks: job.totalTasks, proxyName: proxy ? `${proxyName} · ${proxyType.toUpperCase()}` : 'Direct connection' });
  (async () => {
    const seen = new Set();
    for (const dork of dorks) for (const engine of engines) {
      if (!job.running) break;
      try {
        const html = await fetchSearch(engine, dork, proxy, proxyType);
        const links = extractLinks(html, engine);
        for (const url of links) if (!seen.has(url)) { seen.add(url); job.urls.push({ url, domain: new URL(url).hostname, dork, engine, time: new Date().toISOString() }); }
      } catch (e) { job.errors.push({ engine, dork, message: String(e.message || e).slice(0, 180) }); }
      job.completed++;
      await sleep(2500);
    }
    job.running = false; job.done = true; job.finishedAt = Date.now();
  })();
});
app.get('/api/status/:id', (req, res) => {
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: j.id, running: j.running, done: j.done, completed: j.completed, totalTasks: j.totalTasks, urls: j.urls, errors: j.errors.slice(-30), proxyName: j.proxy ? (j.proxyName + ' · ' + j.proxyType.toUpperCase()) : 'Direct connection' });
});
app.post('/api/stop/:id', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'Job not found' }); j.running = false; res.json({ ok: true }); });
app.use('/api', (req, res) => res.status(404).json({ error: `API route not found: ${req.method} ${req.path}`, hint: 'The server code may be outdated. Redeploy the complete project including server.js and package.json.' }));
app.get('/health', (_req,res) => res.json({ ok: true, app: 'FRS Dork URL Hunter', version: '1.4.3' }));
app.listen(PORT, () => console.log(`FRS Dork URL Hunter listening on ${PORT}`));

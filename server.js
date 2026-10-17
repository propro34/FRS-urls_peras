const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter SPEED', version: '3.0.0' })
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter SPEED', version: '3.0.0' })
);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const STATIC_DIR = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_DIR : __dirname;
app.use(express.static(STATIC_DIR));
app.get('/', (_req, res) => {
  const p = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_INDEX : ROOT_INDEX;
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(500).type('text').send('index.html not found');
});

const jobs = new Map();

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function unwrapRedirect(raw) {
  let url = decodeHtml(raw).trim();
  if (!url) return null;
  if (/(?:^|[?&])RU=/i.test(url)) {
    const m = url.match(/(?:^|[?&])RU=([^&]+)/i);
    if (m) { try { url = decodeURIComponent(m[1]); } catch {} }
  }
  if (url.startsWith('/ck/a')) url = 'https://www.bing.com' + url;
  else if (url.startsWith('/') && !url.startsWith('//')) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('bing.com') && (u.pathname.includes('/ck/a') || u.searchParams.has('u'))) {
      const rawU = u.searchParams.get('u');
      if (rawU) {
        const payloads = [rawU];
        if (rawU.startsWith('a1')) payloads.push(rawU.slice(2));
        for (const p of payloads) {
          try {
            const decoded = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            if (/^https?:\/\//i.test(decoded)) return decoded.split(/[\s"'<>]/)[0];
          } catch {}
        }
      }
      return null;
    }
  } catch {}
  return url;
}

function isEngineHost(host) {
  const h = (host || '').toLowerCase().replace(/^www\./, '');
  return /bing\.|microsoft\.|yahoo\.|yimg\.|google\.|duckduckgo\.|live\.com|msn\.com/i.test(h);
}

function extractLinks(html, engine) {
  const out = new Set();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const unwrapped = unwrapRedirect(m[1]);
    if (!unwrapped) continue;
    try {
      const u = new URL(unwrapped);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|zip|rar|exe|mp[34]|mkv|avi)(?:$|\?)/i.test(u.pathname)) continue;
      if (isEngineHost(u.hostname)) continue;
      u.hash = '';
      // normalize: strip trailing slash noise for dedup friendliness
      let href = u.href;
      if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
      out.add(href);
    } catch {}
  }
  if (engine === 'bing') {
    const citeRe = /<cite[^>]*>([\s\S]*?)<\/cite>/gi;
    while ((m = citeRe.exec(html)) !== null) {
      let cite = decodeHtml(m[1]).replace(/<[^>]+>/g, '').replace(/\s*[›»→]\s*/g, '/').replace(/\s+/g, '').trim();
      if (!cite) continue;
      if (!/^https?:\/\//i.test(cite)) cite = 'https://' + cite.replace(/^\/+/, '');
      try {
        const u = new URL(cite);
        if (['http:', 'https:'].includes(u.protocol) && !isEngineHost(u.hostname)) {
          u.hash = '';
          let href = u.href;
          if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
          out.add(href);
        }
      } catch {}
    }
  }
  return [...out];
}

function expandDork(seed) {
  const s = seed.trim();
  if (!s) return [];
  const variants = new Set([s]);
  const quotes = [...s.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const mainQuote = quotes[0] || null;
  const inurlM = s.match(/inurl\s*:\s*([^\s]+)/i);
  const inurlVal = inurlM ? inurlM[1] : null;
  const siteM = s.match(/site\s*:\s*([^\s]+)/i);
  const siteVal = siteM ? siteM[1] : null;

  if (mainQuote && inurlVal) {
    variants.add(`intext:"${mainQuote}" inurl:${inurlVal}`);
    variants.add(`inurl:${inurlVal} intext:"${mainQuote}"`);
    variants.add(`intitle:"${mainQuote}" inurl:${inurlVal}`);
    variants.add(`"${mainQuote}" inurl:${inurlVal}`);
    if (siteVal) {
      variants.add(`site:${siteVal} intext:"${mainQuote}" inurl:${inurlVal}`);
      variants.add(`intext:"${mainQuote}" inurl:${inurlVal} site:${siteVal}`);
    }
  } else if (mainQuote) {
    variants.add(`intext:"${mainQuote}"`);
    variants.add(`intitle:"${mainQuote}"`);
    if (siteVal) variants.add(`site:${siteVal} "${mainQuote}"`);
  } else if (inurlVal) {
    variants.add(`inurl:${inurlVal}`);
    if (siteVal) variants.add(`site:${siteVal} inurl:${inurlVal}`);
  }
  return [...variants].slice(0, 8);
}

function searchUrl(engine, query, page = 0) {
  const q = encodeURIComponent(query);
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}&count=50&first=${page * 10 + 1}`;
  if (engine === 'yahoo-jp') return `https://search.yahoo.co.jp/search?p=${q}&ei=UTF-8&b=${page * 10 + 1}`;
  return `https://search.yahoo.com/search?p=${q}&n=40&b=${page * 10 + 1}`;
}

function parseProxyLine(line) {
  const parts = line.split('|').map(x => x.trim());
  let type = 'http', addr = parts[0];
  if (parts.length >= 2 && ['http', 'socks4', 'socks5'].includes(parts[0].toLowerCase())) {
    type = parts[0].toLowerCase();
    addr = parts[1];
  }
  if (!/^[a-zA-Z0-9.:[\]-]+:\d{1,5}$/.test(addr) || Number(addr.split(':').pop()) > 65535) return null;
  return { type, addr };
}

function fetchSearch(engine, query, proxyInfo, page = 0) {
  const startUrl = searchUrl(engine, query, page);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': engine === 'yahoo-jp' ? 'ja,en;q=0.8' : 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'max-age=0',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  };
  let agent;
  if (proxyInfo) {
    if (proxyInfo.type === 'socks4') agent = new SocksProxyAgent('socks4://' + proxyInfo.addr);
    else if (proxyInfo.type === 'socks5') agent = new SocksProxyAgent('socks5h://' + proxyInfo.addr);
    else agent = new HttpsProxyAgent('http://' + proxyInfo.addr);
  }
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function go(currentUrl) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch { return reject(new Error(`${engine}: bad url`)); }
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.get(currentUrl, { headers, agent, timeout: 16000 }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
          redirects++;
          let next = response.headers.location;
          if (next.startsWith('/')) next = parsed.protocol + '//' + parsed.host + next;
          response.resume();
          return go(next);
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', c => { body += c; if (body.length > 2.5e6) req.destroy(new Error('too large')); });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new Error(`${engine}: HTTP ${response.statusCode}`));
          if (body.length < 500 && /captcha|unusual traffic|robot|blocked/i.test(body))
            return reject(new Error(`${engine}: blocked`));
          resolve(body);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${engine}: timeout`)));
      req.on('error', reject);
    }
    go(startUrl);
  });
}

async function runPool(tasks, concurrency, onTask, shouldContinue) {
  let index = 0;
  const workers = [];
  async function worker() {
    while (shouldContinue()) {
      const i = index++;
      if (i >= tasks.length) break;
      await onTask(tasks[i]);
    }
  }
  const n = Math.min(concurrency, Math.max(1, tasks.length));
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
}

app.post('/api/start', (req, res) => {
  const seedDorks = [
    ...new Set(String(req.body.dorks || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))
  ];
  if (seedDorks.length > 30000) {
    return res.status(400).json({ error: 'حد الطلب الواحد 30000 دورك. قسّم على دفعات إن لزم.' });
  }

  const engines = [
    ...new Set((Array.isArray(req.body.engines) ? req.body.engines : []).filter(e =>
      ['bing', 'yahoo', 'yahoo-jp'].includes(e)
    ))
  ];

  let threads = parseInt(req.body.threads, 10);
  if (!Number.isFinite(threads) || threads < 50) threads = 50;
  if (threads > 200) threads = 200;

  const deep = req.body.deep !== false;
  const deepPages = Math.min(Math.max(parseInt(req.body.deepPages, 10) || 3, 1), 5);

  const proxies = [];
  for (const line of String(req.body.proxyList || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const p = parseProxyLine(line);
    if (p) proxies.push(p);
  }

  if (!seedDorks.length) return res.status(400).json({ error: 'أضف دورك واحد على الأقل.' });
  if (!engines.length) return res.status(400).json({ error: 'اختار محرك واحد على الأقل.' });

  let allDorks = seedDorks;
  if (deep) {
    const expanded = new Set();
    for (const d of seedDorks) for (const v of expandDork(d)) expanded.add(v);
    allDorks = [...expanded];
  }

  const tasks = [];
  for (const dork of allDorks) {
    for (const engine of engines) {
      for (let page = 0; page < deepPages; page++) {
        tasks.push({ dork, engine, page });
      }
    }
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id, threads, deep, deepPages, proxies,
    running: true, done: false,
    totalTasks: tasks.length,
    completed: 0,
    urls: [],
    errors: [],
    expandedDorks: allDorks.length,
    startedAt: Date.now()
  };
  jobs.set(id, job);

  if (jobs.size > 20) {
    const keys = [...jobs.keys()];
    for (let i = 0; i < keys.length - 15; i++) jobs.delete(keys[i]);
  }

  res.json({
    id,
    totalTasks: job.totalTasks,
    threads,
    deep,
    expandedDorks: allDorks.length,
    proxyName: proxies.length ? `Rotating ${proxies.length}` : 'Direct'
  });

  (async () => {
    const seen = new Set(); // global URL dedup
    let proxyCounter = 0;

    await runPool(
      tasks,
      threads,
      async (task) => {
        if (!job.running) return;
        let proxyInfo = null;
        if (proxies.length) proxyInfo = proxies[proxyCounter++ % proxies.length];
        try {
          const html = await fetchSearch(task.engine, task.dork, proxyInfo, task.page);
          const links = extractLinks(html, task.engine);
          for (const url of links) {
            // normalize for dedup
            const key = url.toLowerCase().replace(/\/$/, '');
            if (seen.has(key)) continue;
            seen.add(key);
            let domain = '';
            try { domain = new URL(url).hostname; } catch {}
            job.urls.push({
              url,
              domain,
              dork: task.dork,
              engine: task.engine,
              page: task.page + 1,
              time: new Date().toISOString()
            });
          }
        } catch (e) {
          job.errors.push({
            engine: task.engine,
            dork: String(task.dork).slice(0, 80),
            page: task.page + 1,
            message: String(e.message || e).slice(0, 140),
            proxy: proxyInfo ? proxyInfo.addr : 'direct'
          });
        }
        job.completed++;
      },
      () => job.running
    );

    // hard cap memory on stored list (client can download progressively)
    if (job.urls.length > 50000) job.urls = job.urls.slice(0, 50000);
    job.running = false;
    job.done = true;
    job.finishedAt = Date.now();
  })();
});

app.get('/api/status/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const urls = j.urls.length > 5000 ? j.urls.slice(-5000) : j.urls;
  res.json({
    id: j.id,
    running: j.running,
    done: j.done,
    completed: j.completed,
    totalTasks: j.totalTasks,
    threads: j.threads,
    deep: j.deep,
    expandedDorks: j.expandedDorks,
    totalUrls: j.urls.length,
    urls,
    errors: j.errors.slice(-40),
    proxyName: j.proxies.length ? `Rotating ${j.proxies.length}` : 'Direct'
  });
});

app.post('/api/stop/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  j.running = false;
  res.json({ ok: true });
});

app.use('/api', (req, res) =>
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` })
);

app.listen(PORT, () => console.log(`FRS Dork URL Hunter SPEED v3.0.0 on ${PORT}`));

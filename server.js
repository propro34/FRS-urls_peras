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

app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter PRIME', version: '1.7.0' })
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter PRIME', version: '1.7.0' })
);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const STATIC_DIR = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_DIR : __dirname;

app.use(express.static(STATIC_DIR));
app.get('/', (_req, res) => {
  const indexPath = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_INDEX : ROOT_INDEX;
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(500).type('text').send('index.html not found');
});

const jobs = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function unwrapRedirect(raw) {
  let url = decodeHtml(raw).trim();
  if (!url) return null;

  // Yahoo RU=
  if (/(?:^|[?&])RU=/i.test(url)) {
    const m = url.match(/(?:^|[?&])RU=([^&]+)/i);
    if (m) {
      try { url = decodeURIComponent(m[1]); } catch {}
    }
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

function isSearchEngineHost(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return (
    h.includes('bing.com') ||
    h.includes('microsoft.com') ||
    h.includes('yahoo.com') ||
    h.includes('yahoo.co.jp') ||
    h.includes('yimg.') ||
    h.includes('google.') ||
    h.includes('duckduckgo.') ||
    h.endsWith('.live.com') ||
    h.endsWith('.msn.com')
  );
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
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|zip|rar|exe|mp[34]|mkv|avi)(?:$|\?)/i.test(u.pathname)) continue;
      if (isSearchEngineHost(u.hostname)) continue;
      u.hash = '';
      out.add(u.href);
    } catch {}
  }

  // Bing cite
  if (engine === 'bing') {
    const citeRe = /<cite[^>]*>([\s\S]*?)<\/cite>/gi;
    while ((m = citeRe.exec(html)) !== null) {
      let cite = decodeHtml(m[1]).replace(/<[^>]+>/g, '').replace(/\s*[›»→]\s*/g, '/').replace(/\s+/g, '').trim();
      if (!cite) continue;
      if (!/^https?:\/\//i.test(cite)) cite = 'https://' + cite.replace(/^\/+/, '');
      try {
        const u = new URL(cite);
        if (['http:', 'https:'].includes(u.protocol) && !isSearchEngineHost(u.hostname)) {
          u.hash = '';
          out.add(u.href);
        }
      } catch {}
    }
  }

  return [...out];
}

function searchUrl(engine, query) {
  const q = encodeURIComponent(query);
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}&count=50`;
  if (engine === 'yahoo-jp') return `https://search.yahoo.co.jp/search?p=${q}&ei=UTF-8`;
  // Yahoo US – often blocked, but keep trying
  return `https://search.yahoo.com/search?p=${q}&n=40`;
}

function parseProxyLine(line) {
  const parts = line.split('|').map(x => x.trim());
  let type = 'http';
  let addr = parts[0];
  if (parts.length >= 2 && ['http', 'socks4', 'socks5'].includes(parts[0].toLowerCase())) {
    type = parts[0].toLowerCase();
    addr = parts[1];
  }
  if (!/^[a-zA-Z0-9.:[\]-]+:\d{1,5}$/.test(addr) || Number(addr.split(':').pop()) > 65535) return null;
  return { type, addr };
}

/**
 * Fetch with redirect following (needed for Yahoo and others)
 */
function fetchSearch(engine, query, proxyInfo) {
  const startUrl = searchUrl(engine, query);

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': engine === 'yahoo-jp' ? 'ja,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9',
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
    const maxRedirects = 5;

    function go(currentUrl) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        return reject(new Error(`${engine}: invalid url`));
      }

      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.get(
        currentUrl,
        { headers, agent, timeout: 22000 },
        response => {
          // Follow redirects
          if (
            [301, 302, 303, 307, 308].includes(response.statusCode) &&
            response.headers.location &&
            redirects < maxRedirects
          ) {
            redirects++;
            let next = response.headers.location;
            if (next.startsWith('/')) next = parsed.protocol + '//' + parsed.host + next;
            response.resume();
            return go(next);
          }

          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => {
            body += chunk;
            if (body.length > 3_000_000) req.destroy(new Error(`${engine}: response too large`));
          });
          response.on('end', () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              return reject(
                new Error(`${engine}: HTTP ${response.statusCode}${redirects ? ' after redirects' : ''}`)
              );
            }
            // Detect hard bot block pages
            if (
              body.length < 800 &&
              /captcha|unusual traffic|robot|blocked|access denied/i.test(body)
            ) {
              return reject(new Error(`${engine}: blocked / captcha`));
            }
            resolve(body);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`${engine}: timeout`)));
      req.on('error', reject);
    }

    go(startUrl);
  });
}

app.post('/api/start', (req, res) => {
  // NO limit on number of dorks – accept the full file as-is
  const dorks = [
    ...new Set(
      String(req.body.dorks || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
    )
  ];

  const engines = [
    ...new Set(
      (Array.isArray(req.body.engines) ? req.body.engines : []).filter(e =>
        ['bing', 'yahoo', 'yahoo-jp'].includes(e)
      )
    )
  ];

  const proxyLines = String(req.body.proxyList || '')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  const proxies = [];
  for (const line of proxyLines) {
    const p = parseProxyLine(line);
    if (p) proxies.push(p);
  }

  if (!dorks.length) return res.status(400).json({ error: 'أضف دورك واحد على الأقل.' });
  if (!engines.length) return res.status(400).json({ error: 'اختار محرك واحد على الأقل.' });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    dorks,
    engines,
    proxies,
    running: true,
    done: false,
    totalTasks: dorks.length * engines.length,
    completed: 0,
    urls: [],
    errors: [],
    startedAt: Date.now()
  };
  jobs.set(id, job);

  const proxyLabel = proxies.length
    ? `Rotating ${proxies.length} proxy(ies)`
    : 'Direct';

  res.json({ id, totalTasks: job.totalTasks, proxyName: proxyLabel });

  (async () => {
    const seen = new Set();
    let proxyIdx = 0;

    for (const dork of dorks) {
      for (const engine of engines) {
        if (!job.running) break;

        let proxyInfo = null;
        if (proxies.length) {
          proxyInfo = proxies[proxyIdx % proxies.length];
          proxyIdx++;
        }

        try {
          const html = await fetchSearch(engine, dork, proxyInfo);
          const links = extractLinks(html, engine);
          for (const url of links) {
            if (seen.has(url)) continue;
            seen.add(url);
            let domain = '';
            try { domain = new URL(url).hostname; } catch {}
            job.urls.push({
              url,
              domain,
              dork,
              engine,
              time: new Date().toISOString()
            });
          }
        } catch (e) {
          job.errors.push({
            engine,
            dork: dork.slice(0, 100),
            message: String(e.message || e).slice(0, 180),
            proxy: proxyInfo ? proxyInfo.addr : 'direct'
          });
        }

        job.completed++;
        await sleep(1500);
      }
      if (!job.running) break;
    }

    job.running = false;
    job.done = true;
    job.finishedAt = Date.now();
  })();
});

app.get('/api/status/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json({
    id: j.id,
    running: j.running,
    done: j.done,
    completed: j.completed,
    totalTasks: j.totalTasks,
    urls: j.urls,
    errors: j.errors.slice(-60),
    proxyName: j.proxies.length
      ? `Rotating ${j.proxies.length} proxy(ies)`
      : 'Direct'
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

app.listen(PORT, () => console.log(`FRS Dork URL Hunter PRIME v1.7.0 on ${PORT}`));

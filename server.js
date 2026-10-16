const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Health checks first so they always return JSON
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter PRIME', version: '1.5.0' })
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter PRIME', version: '1.5.0' })
);

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const STATIC_DIR = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_DIR : __dirname;

app.use(express.static(STATIC_DIR));

app.get('/', (_req, res) => {
  const indexPath = fs.existsSync(PUBLIC_INDEX) ? PUBLIC_INDEX : ROOT_INDEX;
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res
    .status(500)
    .type('text')
    .send('FRS Dork URL Hunter: index.html not found. Upload public/index.html or index.html.');
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

/**
 * Try to unwrap Bing /ck/a redirect and Yahoo RU= redirect.
 * Returns the best absolute URL we can recover, or null.
 */
function unwrapRedirect(raw) {
  let url = decodeHtml(raw).trim();
  if (!url) return null;

  // Yahoo RU= parameter
  if (/(?:^|[?&])RU=/i.test(url)) {
    const m = url.match(/(?:^|[?&])RU=([^&]+)/i);
    if (m) {
      try {
        url = decodeURIComponent(m[1]);
      } catch {}
    }
  }

  // Make absolute if relative
  if (url.startsWith('/')) {
    if (url.startsWith('/ck/a')) url = 'https://www.bing.com' + url;
    else if (url.startsWith('/')) return null; // other relative links usually not useful
  }

  // Bing ck/a – try common encodings of the real target
  try {
    const u = new URL(url);
    if (u.hostname.includes('bing.com') && (u.pathname.includes('/ck/a') || u.searchParams.has('u'))) {
      const rawU = u.searchParams.get('u');
      if (rawU) {
        // Common pattern: a1 + base64
        let payloads = [rawU];
        if (rawU.startsWith('a1')) payloads.push(rawU.slice(2));
        for (const p of payloads) {
          try {
            const decoded = Buffer.from(
              p.replace(/-/g, '+').replace(/_/g, '/'),
              'base64'
            ).toString('utf8');
            if (/^https?:\/\//i.test(decoded)) return decoded.split(/[\s"'<>]/)[0];
          } catch {}
        }
      }
      // If we cannot decode, skip pure tracking links
      return null;
    }
  } catch {}

  return url;
}

/**
 * Extract candidate links from a search-engine HTML page.
 * More permissive than before – no artificial low caps on results.
 */
function extractLinks(html, engine) {
  const out = new Set();

  // 1) Classic href extraction + unwrap
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const unwrapped = unwrapRedirect(m[1]);
    if (!unwrapped) continue;
    try {
      const u = new URL(unwrapped);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      // skip media / binaries
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|zip|rar|exe|mp[34]|mkv|avi)(?:$|\?)/i.test(u.pathname)) continue;
      // skip search-engine own domains
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (
        /(?:^|\.)(bing|microsoft|live|msn|yahoo|google|duckduckgo|yandex|baidu)\./i.test(host) ||
        host === 'bing.com' ||
        host.endsWith('.bing.com') ||
        host.endsWith('.yahoo.com') ||
        host.endsWith('.yahoo.co.jp')
      ) continue;

      u.hash = '';
      out.add(u.href);
    } catch {}
  }

  // 2) Bing <cite> tags often contain the real displayed URL
  if (engine === 'bing') {
    const citeRe = /<cite[^>]*>([\s\S]*?)<\/cite>/gi;
    while ((m = citeRe.exec(html)) !== null) {
      let cite = decodeHtml(m[1])
        .replace(/<[^>]+>/g, '')
        .replace(/\s*[›»→]\s*/g, '/')
        .replace(/\s+/g, '')
        .trim();
      if (!cite) continue;
      if (!/^https?:\/\//i.test(cite)) cite = 'https://' + cite.replace(/^\/+/, '');
      try {
        const u = new URL(cite);
        if (['http:', 'https:'].includes(u.protocol)) {
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
  if (engine === 'yahoo-jp') return `https://search.yahoo.co.jp/search?p=${q}`;
  return `https://search.yahoo.com/search?p=${q}&n=50`;
}

async function fetchSearch(engine, query, proxy, proxyType) {
  const url = searchUrl(engine, query);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.5',
    'Cache-Control': 'no-cache'
  };

  let agent;
  if (proxy) {
    if (proxyType === 'socks4') agent = new SocksProxyAgent('socks4://' + proxy);
    else if (proxyType === 'socks5') agent = new SocksProxyAgent('socks5h://' + proxy);
    else agent = new HttpsProxyAgent('http://' + proxy);
  }

  return await new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent, timeout: 20000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2_500_000) req.destroy(new Error(`${engine}: response too large`));
      });
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return reject(new Error(`${engine}: redirected; try again later`));
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`${engine}: HTTP ${response.statusCode}`));
        }
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${engine}: request timed out`)));
    req.on('error', reject);
  });
}

app.post('/api/start', (req, res) => {
  // No hard 50-dork limit – soft safety ceiling only
  const dorks = [
    ...new Set(
      String(req.body.dorks || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
    )
  ].slice(0, 300); // soft safety limit (was 50)

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

  let proxy = '';
  let proxyType = 'http';
  let proxyName = 'Direct connection';

  if (proxyLines.length) {
    const first = proxyLines[0].split('|').map(x => x.trim());
    if (first.length >= 2 && ['http', 'socks4', 'socks5'].includes(first[0].toLowerCase())) {
      proxyType = first[0].toLowerCase();
      proxy = first[1];
      proxyName = `${proxyType.toUpperCase()} proxy`;
    } else {
      proxy = first[0];
      proxyName = 'Proxy list · first entry';
    }
    if (!/^[a-zA-Z0-9.:[\]-]+:\d{1,5}$/.test(proxy) || Number(proxy.split(':').pop()) > 65535) {
      return res.status(400).json({
        error:
          'Proxy list format: IP:PORT, or TYPE | IP:PORT (HTTP/SOCKS4/SOCKS5).'
      });
    }
  }

  if (!dorks.length) return res.status(400).json({ error: 'Add at least one search dork.' });
  if (!engines.length) return res.status(400).json({ error: 'Select at least one search engine.' });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    dorks,
    engines,
    proxy,
    proxyType,
    proxyName,
    running: true,
    done: false,
    totalTasks: dorks.length * engines.length,
    completed: 0,
    urls: [],
    errors: [],
    startedAt: Date.now()
  };
  jobs.set(id, job);

  res.json({
    id,
    totalTasks: job.totalTasks,
    proxyName: proxy ? `${proxyName} · ${proxyType.toUpperCase()}` : 'Direct connection'
  });

  // Run job in background
  (async () => {
    const seen = new Set();
    for (const dork of dorks) {
      for (const engine of engines) {
        if (!job.running) break;
        try {
          const html = await fetchSearch(engine, dork, proxy, proxyType);
          const links = extractLinks(html, engine);
          for (const url of links) {
            if (seen.has(url)) continue;
            seen.add(url);
            let domain = '';
            try {
              domain = new URL(url).hostname;
            } catch {}
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
            dork,
            message: String(e.message || e).slice(0, 180)
          });
        }
        job.completed++;
        // modest delay to reduce blocking
        await sleep(1800);
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
    errors: j.errors.slice(-40),
    proxyName: j.proxy ? j.proxyName + ' · ' + j.proxyType.toUpperCase() : 'Direct connection'
  });
});

app.post('/api/stop/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  j.running = false;
  res.json({ ok: true });
});

// Catch unknown API routes
app.use('/api', (req, res) =>
  res.status(404).json({
    error: `API route not found: ${req.method} ${req.path}`,
    hint:
      'If this is HTML, Render is serving an old/different server. Replace server.js and package.json at the project root and redeploy.'
  })
);

app.listen(PORT, () => console.log(`FRS Dork URL Hunter PRIME v1.5.0 listening on ${PORT}`));

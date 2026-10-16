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

// 5MB+ files support
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter DEEP PRIVATE', version: '2.1.0' })
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, app: 'FRS Dork URL Hunter DEEP PRIVATE', version: '2.1.0' })
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

/* ── Famous / well-known domains to EXCLUDE (private mode) ── */
const FAMOUS = new Set([
  'google.com','google.co.uk','google.fr','google.de','google.es','google.it','google.ru',
  'youtube.com','youtu.be','facebook.com','fb.com','instagram.com','twitter.com','x.com',
  'linkedin.com','tiktok.com','reddit.com','pinterest.com','tumblr.com','snapchat.com',
  'wikipedia.org','wikimedia.org','amazon.com','amazon.co.uk','amazon.de','amazon.fr',
  'ebay.com','ebay.co.uk','alibaba.com','aliexpress.com','walmart.com','etsy.com',
  'microsoft.com','office.com','live.com','outlook.com','msn.com','bing.com',
  'apple.com','icloud.com','github.com','gitlab.com','bitbucket.org','stackoverflow.com',
  'stackexchange.com','medium.com','quora.com','wordpress.com','blogspot.com','blogger.com',
  'nytimes.com','cnn.com','bbc.com','bbc.co.uk','theguardian.com','forbes.com','reuters.com',
  'yahoo.com','yahoo.co.jp','yandex.ru','baidu.com','duckduckgo.com',
  'netflix.com','spotify.com','twitch.tv','discord.com','telegram.org','whatsapp.com',
  'paypal.com','stripe.com','shopify.com','wix.com','squarespace.com','godaddy.com',
  'cloudflare.com','aws.amazon.com','azure.com','digitalocean.com','heroku.com',
  'adobe.com','dropbox.com','box.com','salesforce.com','zoom.us','slack.com',
  'imdb.com','tripadvisor.com','booking.com','airbnb.com','uber.com',
  'nih.gov','who.int','cdc.gov','edu','gov', // partial handled below
  'mozilla.org','w3.org','apache.org','nginx.org','php.net','python.org','nodejs.org',
  'oracle.com','ibm.com','intel.com','nvidia.com','samsung.com','huawei.com',
  'vk.com','ok.ru','mail.ru','weibo.com','qq.com','taobao.com','jd.com'
]);

const FAMOUS_SUFFIXES = [
  '.google.', '.facebook.', '.amazon.', '.microsoft.', '.apple.',
  '.wikipedia.', '.youtube.', '.yahoo.', '.bing.', '.github.',
  '.gov', '.edu', '.mil'
];

function isFamousDomain(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^www\./, '');
  if (FAMOUS.has(h)) return true;
  // check parent domains (e.g. maps.google.com)
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (FAMOUS.has(parent)) return true;
  }
  for (const s of FAMOUS_SUFFIXES) {
    if (h.includes(s) || h.endsWith(s.replace(/^\./, ''))) return true;
  }
  // very short brand-like 2-part popular TLDs already in set
  return false;
}

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
      if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|pdf|zip|rar|exe|mp[34]|mkv|avi)(?:$|\?)/i.test(u.pathname)) continue;
      if (isEngineHost(u.hostname)) continue;
      if (isFamousDomain(u.hostname)) continue; // PRIVATE: skip famous
      u.hash = '';
      out.add(u.href);
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
        if (['http:', 'https:'].includes(u.protocol) && !isEngineHost(u.hostname) && !isFamousDomain(u.hostname)) {
          u.hash = '';
          out.add(u.href);
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
  return [...variants].slice(0, 6);
}

/** Higher = more private / interesting unknown target */
function privateScore(url) {
  let score = 0;
  const u = url.toLowerCase();
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return -100; }

  if (isFamousDomain(host)) return -100;

  // obscure TLD / long host slightly preferred
  if (/\.(tk|ml|ga|cf|gq|xyz|top|club|online|site|website|info|biz|cc|ws)$/i.test(host)) score += 4;
  if (host.split('.').length >= 3) score += 2; // subdomain

  if (/\/(admin|login|dashboard|panel|cp|manage|backend|console|wp-admin|phpmyadmin|cpanel)/i.test(u)) score += 14;
  if (/\.php(\?|$)/i.test(u)) score += 9;
  if (/\.(asp|aspx|jsp|cgi)(\?|$)/i.test(u)) score += 7;
  if (/\?(id|file|page|dir|path|doc|cat|user|uid|pid|item)=/i.test(u)) score += 11;
  if (/(\?|&)(redirect|url|next|return|continue|dest)=/i.test(u)) score += 8;
  if (/config|setup|install|backup|dump|sql|database|\.env|secret|token|api[_-]?key/i.test(u)) score += 10;
  if (/error|exception|warning|stack|trace|debug|pdoexception/i.test(u)) score += 9;
  if (/index\s+of|parent\s+directory/i.test(u)) score += 12;

  try {
    const { pathname, search } = new URL(url);
    const depth = pathname.split('/').filter(Boolean).length;
    score += Math.min(depth, 6);
    if ((pathname === '/' || pathname === '') && !search) score -= 8;
  } catch {}

  return score;
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
      const req = lib.get(currentUrl, { headers, agent, timeout: 18000 }, response => {
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
          if (body.length < 600 && /captcha|unusual traffic|robot|blocked/i.test(body))
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
  // Accept large batches (client splits 1M into chunks)
  const seedDorks = [
    ...new Set(String(req.body.dorks || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))
  ];
  // Soft per-request cap to protect RAM (client batches the rest)
  if (seedDorks.length > 25000) {
    return res.status(400).json({
      error: 'هذا الطلب فيه أكثر من 25000 دورك. التطبيق يقرأ الملف على دفعات تلقائياً — قلّل حجم الدفعة أو استعمل الاستيراد.'
    });
  }

  const engines = [
    ...new Set((Array.isArray(req.body.engines) ? req.body.engines : []).filter(e =>
      ['bing', 'yahoo', 'yahoo-jp'].includes(e)
    ))
  ];

  let threads = parseInt(req.body.threads, 10);
  if (!Number.isFinite(threads) || threads < 50) threads = 50;
  if (threads > 200) threads = 200;

  const deep = !!req.body.deep;
  const deepPages = deep ? Math.min(Math.max(parseInt(req.body.deepPages, 10) || 2, 1), 4) : 1;
  const privateOnly = req.body.privateOnly !== false; // default ON

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
    id, threads, deep, deepPages, privateOnly, proxies,
    running: true, done: false,
    totalTasks: tasks.length,
    completed: 0,
    urls: [],
    errors: [],
    expandedDorks: allDorks.length,
    startedAt: Date.now()
  };
  jobs.set(id, job);

  // Cleanup old jobs (keep last 20)
  if (jobs.size > 25) {
    const keys = [...jobs.keys()];
    for (let i = 0; i < keys.length - 20; i++) jobs.delete(keys[i]);
  }

  res.json({
    id,
    totalTasks: job.totalTasks,
    threads,
    deep,
    expandedDorks: allDorks.length,
    privateOnly,
    proxyName: proxies.length ? `Rotating ${proxies.length}` : 'Direct'
  });

  (async () => {
    const seen = new Set();
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
            if (seen.has(url)) continue;
            seen.add(url);
            let domain = '';
            try { domain = new URL(url).hostname; } catch {}
            if (privateOnly && isFamousDomain(domain)) continue;
            const score = privateScore(url);
            if (privateOnly && score < 0) continue;
            job.urls.push({
              url, domain, dork: task.dork, engine: task.engine,
              page: task.page + 1, score,
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

    job.urls.sort((a, b) => (b.score || 0) - (a.score || 0));
    // Cap stored results per job to protect memory (client can download)
    if (job.urls.length > 15000) job.urls = job.urls.slice(0, 15000);
    job.running = false;
    job.done = true;
    job.finishedAt = Date.now();
  })();
});

app.get('/api/status/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  // Light payload: only send urls if not huge, or top scored
  const urls = j.urls.length > 3000 ? j.urls.slice(0, 3000) : j.urls;
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

app.listen(PORT, () => console.log(`FRS Dork Hunter DEEP PRIVATE v2.1.0 on ${PORT}`));

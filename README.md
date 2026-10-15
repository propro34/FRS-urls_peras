# FRS Dork URL Hunter PRIME v1.5.1

Node.js/Express app with two separate modes:
- **Offline URL extraction:** paste text or HTML and extract/deduplicate HTTP(S) URLs. No network requests are made in this mode. An optional base URL resolves relative links.
- **Live search:** Bing/Yahoo search constrained to explicitly entered authorized domains, with request diagnostics. Availability depends on search-engine behavior and network access.

## Run locally
1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

Health check: `/api/health`. Offline extractor API: `POST /api/extract` with JSON `{ "text": "...", "baseUrl": "https://example.org/" }`.

Live search accepts up to 50 queries and 20 authorized domains per job. Only test domains for which you have permission.

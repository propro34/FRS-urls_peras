# FRS Dork URL Hunter PRIME

Mobile-first web app for collecting public URLs from selected search-engine result pages.

## Run
- Build command: `npm install`
- Start command: `npm start`

The app serves `public/index.html` and also includes a root `index.html` copy for easy inspection.

## Inputs
- Add one search query/dork per line.
- Choose Bing, Yahoo, and/or Yahoo Japan manually.
- Proxy list: one entry per line. `IP:PORT` defaults to HTTP; use `SOCKS4 | IP:PORT` or `SOCKS5 | IP:PORT` to specify SOCKS. The server uses the first valid line for a run.

Search engines may change markup or limit automated requests; errors are shown in the UI. The app runs requests sequentially with a delay and does not rotate proxies.

## Render route fix (v1.4.1)
The server uses an absolute path for `public/` and explicitly serves `public/index.html` at `/`, fixing `Cannot GET /` when the files are deployed in the expected project root. Ensure `server.js`, `package.json`, `index.html`, and `public/index.html` are uploaded from this folder to the repository root (do not upload only the ZIP itself).

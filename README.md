# FRS Dork URL Hunter PRIME v1.4.3

## Render deployment
- Root Directory: leave blank when these files are in repository root.
- Build Command: `npm install`
- Start Command: `npm start`

Upload the **contents** of this folder to the repository root, replacing `server.js`, `package.json`, `index.html`, and the `public/` folder. Do not upload only the HTML file.

Health check: `/health` should return JSON with `ok: true` and version `1.4.3`. If the browser says the API returned HTML instead of JSON, the live service is running old or mismatched server code; redeploy all project files.


## PRIME v1.4.4 API troubleshooting
After deployment, open `/health` and `/api/health`; both should return JSON with version `1.4.4`. If either returns HTML, Render is not running this project's `server.js`. Replace `server.js`, `package.json`, `index.html`, and the `public` folder in the repository root (do not upload only the ZIP or only the HTML file), then redeploy.

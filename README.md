FRS Dork URL Hunter PRIME v1.4.2 - Render Hotfix

IMPORTANT: In GitHub, upload the CONTENTS of this folder into the repository root, so server.js, package.json, index.html, and public/ are directly visible in the repository. Do not upload the ZIP alone and do not leave everything nested in an extra FRS_Dork_URL_Hunter folder unless Render Root Directory is set to that folder.

Render settings:
- Root Directory: leave blank when the files are in repository root
- Build Command: npm install
- Start Command: npm start

This version serves public/index.html if present, otherwise it falls back to root index.html.

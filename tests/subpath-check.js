/**
 * Local simulation of GitHub Pages hosting: serves the staged site under the
 * /<repo>/ subpath so relative asset paths can be verified exactly as they
 * will behave on the real Pages URL.
 *
 * Usage: node tests/subpath-check.js   (then curl the URLs it prints)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, '.gp-sim', 'flappy-like');
const REPO = 'flappy-like';
const PORT = Number(process.env.PORT || 8199);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Stage exactly what the Pages workflow deploys.
fs.rmSync(path.join(ROOT, '.gp-sim'), { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'css'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'js'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(SITE, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'css', 'style.css'), path.join(SITE, 'css', 'style.css'));
for (const f of ['config.js', 'entities.js', 'game.js', 'main.js']) {
  fs.copyFileSync(path.join(ROOT, 'js', f), path.join(SITE, 'js', f));
}

const urls = [
  `/${REPO}/`,
  `/${REPO}/index.html`,
  `/${REPO}/css/style.css`,
  `/${REPO}/js/config.js`,
  `/${REPO}/js/entities.js`,
  `/${REPO}/js/game.js`,
  `/${REPO}/js/main.js`
];

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === `/${REPO}` || rel === `/${REPO}/`) rel = `/${REPO}/index.html`;
    const file = path.join(SITE, rel.slice(('/' + REPO + '/').length));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log('serving the staged site under /' + REPO + '/ on http://127.0.0.1:' + PORT);
    for (const u of urls) console.log('  http://127.0.0.1:' + PORT + u);
  });

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { router } from './routes.js';
import { startWorker } from './worker/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', router);

// Serve the built frontend from the same process, so deployment is one
// service rather than two. In development Vite proxies to /api instead.
const webDist = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'Frontend not built yet - run npm run build in web/' });
  });
});

// Errors from route handlers land here. A thrown error carrying .status is a
// deliberate client error; anything else is a bug and gets logged in full but
// reported generically.
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[api]', req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

app.listen(config.port, () => {
  console.log(`[api] listening on http://127.0.0.1:${config.port}`);
});

// In-process worker keeps the demo to a single command. In production this
// runs as its own process (npm run worker) so the API stays responsive.
if (process.env.INLINE_WORKER !== '0') {
  startWorker('inline');
}

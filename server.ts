/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Point d'entrée du serveur Full-Stack (Express + SQLite FTS5 + Vite).
 * Écoute sur le port 3000 (configurable via PORT) et sert à la fois :
 * - L'API REST `/api/*` adossée à SQLite
 * - L'interface Web React (via Vite en développement ou fichiers statiques `dist/` en production)
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { NotesRepository } from './src/server/db.ts';
import { createApiRouter } from './src/server/app.ts';

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  // Initialisation de la base SQLite persistante (vierge par défaut, aucune donnée pré-injectée par le backend)
  const repo = new NotesRepository();

  // Montage des routes API REST sous /api
  app.use('/api', createApiRouter(repo));

  const distPath = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[Cahier] Serveur démarré sur http://0.0.0.0:${port} (SQLite: ${repo.dbPath})`);
  });

  const shutdown = () => {
    server.close(() => {
      repo.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('[Cahier] Échec critique au démarrage du serveur:', err);
  process.exit(1);
});

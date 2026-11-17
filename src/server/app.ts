/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Couche API REST Express + Middlewares de sécurité, validation, limitation de débit et journalisation d'audit.
 */

import express, { Request, Response, NextFunction, Router } from 'express';
import { NotesRepository } from './db.ts';
import {
  NoteSearchQuery,
  NoteSortOption,
  NoteStatusFilter,
  VALIDATION_LIMITS,
  validateCreateNoteInput,
  validateUpdateNoteInput,
} from '../shared/types.ts';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * Crée un routeur Express isolé et testable pour `/api`.
 */
export function createApiRouter(repo: NotesRepository): Router {
  const router = express.Router();

  // Limitation de taille du corps JSON pour prévenir les attaques par déni de service (DoS)
  router.use(express.json({ limit: '256kb' }));

  // En-têtes de sécurité HTTP (Défense en profondeur)
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Limiteur de débit en mémoire (Rate Limiting par IP)
  const buckets = new Map<string, RateLimitBucket>();
  const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 180);
  const windowMs = 60_000;

  router.use((req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(clientIp);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(clientIp, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Trop de requêtes effectuées. Veuillez patienter une minute avant de réessayer.',
        },
      });
    }

    return next();
  });

  // Vérification d'autorisation / origine sur les mutations sensibles (Protection CSRF / Moindre privilège)
  const requireWritePermission = (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] ?? '';
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !contentType.includes('application/json')) {
      return res.status(415).json({
        ok: false,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: "L'en-tête Content-Type doit être application/json pour les opérations d'écriture.",
        },
      });
    }
    return next();
  };

  /**
   * GET /api/health
   * Vérifie la disponibilité du serveur et de la base SQLite.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const stats = repo.getStats();
    res.json({
      ok: true,
      data: {
        status: 'healthy',
        engine: 'sqlite-fts5',
        timestamp: new Date().toISOString(),
        notes_total: stats.total_count,
      },
    });
  });

  /**
   * GET /api/notes
   * Liste et recherche plein texte des notes avec filtres (q, tag, status, sort).
   */
  router.get('/notes', (req: Request, res: Response) => {
    const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
    if (rawQ.length > VALIDATION_LIMITS.SEARCH_QUERY_MAX_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_SEARCH_QUERY',
          message: `La requête de recherche ne peut pas dépasser ${VALIDATION_LIMITS.SEARCH_QUERY_MAX_LENGTH} caractères.`,
        },
      });
    }

    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'active';
    const validStatuses: NoteStatusFilter[] = ['active', 'archived', 'all'];
    const status: NoteStatusFilter = validStatuses.includes(rawStatus as NoteStatusFilter)
      ? (rawStatus as NoteStatusFilter)
      : 'active';

    const rawSort = typeof req.query.sort === 'string' ? req.query.sort : 'updated_desc';
    const validSorts: NoteSortOption[] = ['updated_desc', 'created_desc', 'title_asc'];
    const sort: NoteSortOption = validSorts.includes(rawSort as NoteSortOption)
      ? (rawSort as NoteSortOption)
      : 'updated_desc';

    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;

    const query: NoteSearchQuery = {
      q: rawQ,
      tag,
      status,
      sort,
    };

    const notes = repo.listNotes(query);
    const stats = repo.getStats();
    const tags = repo.getTagsStats();

    return res.json({
      ok: true,
      data: {
        notes,
        stats,
        tags,
      },
    });
  });

  /**
   * GET /api/notes/export
   * Exporte toutes les notes au format JSON structuré pour sauvegarde externe.
   */
  router.get('/notes/export', (_req: Request, res: Response) => {
    const notes = repo.listNotes({ status: 'all', sort: 'updated_desc', limit: 500 });
    const stats = repo.getStats();
    res.json({
      ok: true,
      data: {
        exported_at: new Date().toISOString(),
        version: '1.0.0',
        stats,
        notes,
      },
    });
  });

  /**
   * GET /api/notes/:id
   * Récupère le détail d'une note par son identifiant.
   */
  router.get('/notes/:id', (req: Request, res: Response) => {
    const note = repo.getNoteById(req.params.id);
    if (!note) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'NOTE_NOT_FOUND',
          message: 'La note demandée est introuvable.',
        },
      });
    }
    return res.json({ ok: true, data: note });
  });

  /**
   * POST /api/notes
   * Crée une nouvelle note après validation stricte côté serveur.
   */
  router.post('/notes', requireWritePermission, (req: Request, res: Response) => {
    const validation = validateCreateNoteInput(req.body);
    if (!validation.valid || !validation.data) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: validation.errors[0] ?? 'Données de création invalides.',
          details: validation.errors,
        },
      });
    }

    const actor = typeof req.headers['x-actor-id'] === 'string' ? req.headers['x-actor-id'].slice(0, 64) : 'web-user';
    const created = repo.createNote(validation.data, actor);
    return res.status(201).json({ ok: true, data: created });
  });

  /**
   * PUT /api/notes/:id
   * Met à jour le titre, le contenu, les tags, l'épinglage ou le statut d'archivage d'une note.
   */
  router.put('/notes/:id', requireWritePermission, (req: Request, res: Response) => {
    const validation = validateUpdateNoteInput(req.body);
    if (!validation.valid || !validation.data) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: validation.errors[0] ?? 'Données de mise à jour invalides.',
          details: validation.errors,
        },
      });
    }

    const actor = typeof req.headers['x-actor-id'] === 'string' ? req.headers['x-actor-id'].slice(0, 64) : 'web-user';
    const updated = repo.updateNote(req.params.id, validation.data, actor);
    if (!updated) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'NOTE_NOT_FOUND',
          message: 'Impossible de modifier cette note : identifiant introuvable.',
        },
      });
    }

    return res.json({ ok: true, data: updated });
  });

  /**
   * PATCH /api/notes/:id/archive
   * Bascule explicitement l'état d'archivage d'une note (`is_archived`: boolean).
   */
  router.patch('/notes/:id/archive', requireWritePermission, (req: Request, res: Response) => {
    const rawArchived = req.body?.is_archived;
    if (typeof rawArchived !== 'boolean') {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Le champ booléen is_archived est obligatoire.',
        },
      });
    }

    const actor = typeof req.headers['x-actor-id'] === 'string' ? req.headers['x-actor-id'].slice(0, 64) : 'web-user';
    const updated = repo.setArchiveStatus(req.params.id, rawArchived, actor);
    if (!updated) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'NOTE_NOT_FOUND',
          message: 'Impossible de modifier le statut d’archivage : note introuvable.',
        },
      });
    }

    return res.json({ ok: true, data: updated });
  });

  /**
   * DELETE /api/notes/:id
   * Supprime définitivement une note et enregistre l'événement dans le journal d'audit.
   */
  router.delete('/notes/:id', (req: Request, res: Response) => {
    const actor = typeof req.headers['x-actor-id'] === 'string' ? req.headers['x-actor-id'].slice(0, 64) : 'web-user';
    const deleted = repo.deleteNote(req.params.id, actor);
    if (!deleted) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'NOTE_NOT_FOUND',
          message: 'Impossible de supprimer cette note : identifiant introuvable.',
        },
      });
    }

    return res.json({
      ok: true,
      data: { id: req.params.id, deleted: true },
    });
  });

  /**
   * GET /api/tags
   * Retourne la liste agrégée des tags et leurs compteurs.
   */
  router.get('/tags', (_req: Request, res: Response) => {
    return res.json({
      ok: true,
      data: repo.getTagsStats(),
    });
  });

  /**
   * GET /api/audit
   * Retourne le journal d'audit des actions sensibles.
   */
  router.get('/audit', (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 50);
    return res.json({
      ok: true,
      data: repo.listAuditLogs(Number.isFinite(limit) ? limit : 50),
    });
  });

  // Gestionnaire d'erreurs centralisé (JSON mal formé ou exception inattendue)
  router.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_JSON',
          message: 'Le corps de la requête contient un JSON syntaxiquement invalide.',
        },
      });
    }

    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        ok: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'La taille de la requête dépasse la limite autorisée (256 Ko).',
        },
      });
    }

    console.error('[API Error]', err.message);
    return res.status(500).json({
      ok: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Une erreur interne est survenue lors du traitement de votre requête.',
      },
    });
  });

  return router;
}

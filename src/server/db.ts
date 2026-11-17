/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Couche d'accès aux données SQLite (Persistence Layer).
 * Utilise le moteur natif `node:sqlite` (DatabaseSync) avec :
 * - Journalisation WAL (Write-Ahead Logging) pour les performances et la concurrence
 * - Table virtuelle FTS5 (`notes_fts`) synchronisée par triggers pour la recherche plein texte
 * - Table d'audit (`audit_logs`) pour la traçabilité des opérations sensibles
 * - Requêtes préparées paramétrées contre toute injection SQL
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AuditAction,
  AuditLogEntry,
  CreateNoteInput,
  Note,
  NoteSearchQuery,
  NotesStats,
  TagStat,
  UpdateNoteInput,
  computeTextMetrics,
  normalizeTag,
  normalizeTagsList,
} from '../shared/types.ts';

interface RawNoteRow {
  id: string;
  title: string;
  content: string;
  tags_json: string;
  is_archived: number;
  is_pinned: number;
  word_count: number;
  char_count: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RawAuditRow {
  id: number;
  action: AuditAction;
  entity_id: string;
  entity_title: string;
  actor: string;
  details: string;
  created_at: string;
}

/**
 * Transforme une requête utilisateur libre en expression FTS5 sécurisée (préfixe par token).
 * Évite les erreurs de syntaxe FTS5 lorsque l'utilisateur saisit des guillemets ou opérateurs.
 */
export function buildSafeFtsQuery(rawQuery: string): string {
  const cleaned = rawQuery
    .trim()
    .replace(/["'*()^:+-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (cleaned.length === 0) {
    return '';
  }

  return cleaned.map((token) => `"${token}"*`).join(' AND ');
}

export class NotesRepository {
  private db: DatabaseSync;
  public readonly dbPath: string;

  constructor(customDbPath?: string) {
    const resolvedPath =
      customDbPath ?? process.env.SQLITE_DB_PATH ?? path.resolve(process.cwd(), 'data', 'notes.sqlite');
    this.dbPath = resolvedPath;

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(resolvedPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
        word_count INTEGER NOT NULL DEFAULT 0,
        char_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notes_archived_pinned_updated
        ON notes(is_archived, is_pinned DESC, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notes_created
        ON notes(created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        content,
        tags_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_title TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'local-user',
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created
        ON audit_logs(created_at DESC);
    `);

    const migrationCheck = this.db
      .prepare('SELECT COUNT(*) as count FROM schema_migrations WHERE version = 1')
      .get() as { count: number };

    if (migrationCheck.count === 0) {
      this.db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, '001_initial_notes_fts5_and_audit', new Date().toISOString());
    }
  }

  private mapRowToNote(row: RawNoteRow): Note {
    let parsedTags: string[] = [];
    try {
      const raw = JSON.parse(row.tags_json);
      parsedTags = normalizeTagsList(raw);
    } catch {
      parsedTags = [];
    }

    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: parsedTags,
      is_archived: Boolean(row.is_archived),
      is_pinned: Boolean(row.is_pinned),
      word_count: Number(row.word_count),
      char_count: Number(row.char_count),
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at ?? null,
    };
  }

  private syncFtsIndex(note: Note): void {
    this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(note.id);
    this.db
      .prepare('INSERT INTO notes_fts (note_id, title, content, tags_text) VALUES (?, ?, ?, ?)')
      .run(note.id, note.title, note.content, note.tags.join(' '));
  }

  private removeFtsIndex(noteId: string): void {
    this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId);
  }

  public recordAudit(
    action: AuditAction,
    entityId: string,
    entityTitle: string,
    details: string,
    actor = 'local-user'
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO audit_logs (action, entity_id, entity_title, actor, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(action, entityId, entityTitle.slice(0, 200), actor, details.slice(0, 500), now);
  }

  /**
   * Crée une nouvelle note avec horodatage ISO 8601 UTC et indexation FTS5 immédiate.
   */
  public createNote(input: CreateNoteInput, actor = 'local-user', customTimestamp?: string): Note {
    const id = `note_${crypto.randomUUID()}`;
    const now = customTimestamp ?? new Date().toISOString();
    const tags = normalizeTagsList(input.tags ?? []);
    const { word_count, char_count } = computeTextMetrics(input.content);
    const isPinned = input.is_pinned ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO notes (
          id, title, content, tags_json, is_archived, is_pinned,
          word_count, char_count, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.title.trim(),
        input.content,
        JSON.stringify(tags),
        isPinned,
        word_count,
        char_count,
        now,
        now
      );

    const created = this.getNoteById(id)!;
    this.syncFtsIndex(created);
    this.recordAudit(
      'NOTE_CREATE',
      created.id,
      created.title,
      `Note créée (${created.word_count} mots, tags: ${created.tags.join(', ') || 'aucun'})`,
      actor
    );
    return created;
  }

  /**
   * Récupère une note par son identifiant unique.
   */
  public getNoteById(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as RawNoteRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapRowToNote(row);
  }

  /**
   * Liste et recherche les notes avec support combiné :
   * - Recherche plein texte via SQLite FTS5 (`q`) + repli LIKE
   * - Filtrage par statut (`active`, `archived`, `all`)
   * - Filtrage par tag exact (`tag`)
   * - Tri paramétrable (`updated_desc`, `created_desc`, `title_asc`)
   */
  public listNotes(query: NoteSearchQuery = {}): Note[] {
    const status = query.status ?? 'active';
    const sort = query.sort ?? 'updated_desc';
    const rawSearch = (query.q ?? '').trim();
    const filterTag = query.tag ? normalizeTag(query.tag) : '';
    const limit = Math.min(Math.max(Number(query.limit ?? 200), 1), 500);
    const offset = Math.max(Number(query.offset ?? 0), 0);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status === 'active') {
      conditions.push('n.is_archived = 0');
    } else if (status === 'archived') {
      conditions.push('n.is_archived = 1');
    }

    if (filterTag) {
      // Recherche exacte d'élément JSON dans tags_json via LIKE délimité par guillemets
      conditions.push('n.tags_json LIKE ?');
      params.push(`%"${filterTag}"%`);
    }

    let sql = 'SELECT n.* FROM notes n';

    const ftsExpr = rawSearch ? buildSafeFtsQuery(rawSearch) : '';
    if (ftsExpr) {
      sql += ' INNER JOIN notes_fts fts ON fts.note_id = n.id';
      conditions.push('notes_fts MATCH ?');
      params.push(ftsExpr);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    if (sort === 'created_desc') {
      sql += ' ORDER BY n.is_pinned DESC, n.created_at DESC';
    } else if (sort === 'title_asc') {
      sql += ' ORDER BY n.is_pinned DESC, n.title COLLATE NOCASE ASC';
    } else {
      sql += ' ORDER BY n.is_pinned DESC, n.updated_at DESC';
    }

    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as unknown as RawNoteRow[];
    return rows.map((r) => this.mapRowToNote(r));
  }

  /**
   * Met à jour une note existante, actualise `updated_at`, `archived_at` et l'index FTS5.
   */
  public updateNote(id: string, input: UpdateNoteInput, actor = 'local-user'): Note | null {
    const existing = this.getNoteById(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
    const nextContent = input.content !== undefined ? input.content : existing.content;
    const nextTags = input.tags !== undefined ? normalizeTagsList(input.tags) : existing.tags;
    const nextArchived = input.is_archived !== undefined ? input.is_archived : existing.is_archived;
    const nextPinned = input.is_pinned !== undefined ? input.is_pinned : existing.is_pinned;

    let nextArchivedAt = existing.archived_at;
    if (input.is_archived === true && !existing.is_archived) {
      nextArchivedAt = now;
    } else if (input.is_archived === false && existing.is_archived) {
      nextArchivedAt = null;
    }

    const { word_count, char_count } = computeTextMetrics(nextContent);

    this.db
      .prepare(
        `UPDATE notes
         SET title = ?,
             content = ?,
             tags_json = ?,
             is_archived = ?,
             is_pinned = ?,
             word_count = ?,
             char_count = ?,
             updated_at = ?,
             archived_at = ?
         WHERE id = ?`
      )
      .run(
        nextTitle,
        nextContent,
        JSON.stringify(nextTags),
        nextArchived ? 1 : 0,
        nextPinned ? 1 : 0,
        word_count,
        char_count,
        now,
        nextArchivedAt,
        id
      );

    const updated = this.getNoteById(id)!;
    this.syncFtsIndex(updated);

    // Journalisation d'audit granulaire selon la nature du changement
    if (input.is_archived !== undefined && input.is_archived !== existing.is_archived) {
      this.recordAudit(
        updated.is_archived ? 'NOTE_ARCHIVE' : 'NOTE_RESTORE',
        updated.id,
        updated.title,
        updated.is_archived ? 'Note déplacée dans les archives' : 'Note restaurée depuis les archives',
        actor
      );
    } else if (input.is_pinned !== undefined && input.is_pinned !== existing.is_pinned) {
      this.recordAudit(
        updated.is_pinned ? 'NOTE_PIN' : 'NOTE_UNPIN',
        updated.id,
        updated.title,
        updated.is_pinned ? 'Note épinglée en tête de liste' : 'Note désépinglée',
        actor
      );
    } else {
      this.recordAudit(
        'NOTE_UPDATE',
        updated.id,
        updated.title,
        `Note modifiée (${updated.word_count} mots, tags: ${updated.tags.join(', ') || 'aucun'})`,
        actor
      );
    }

    return updated;
  }

  /**
   * Archive ou désarchive explicitement une note.
   */
  public setArchiveStatus(id: string, isArchived: boolean, actor = 'local-user'): Note | null {
    return this.updateNote(id, { is_archived: isArchived }, actor);
  }

  /**
   * Supprime définitivement une note de SQLite et de l'index FTS5, et trace l'action dans l'audit.
   */
  public deleteNote(id: string, actor = 'local-user'): boolean {
    const existing = this.getNoteById(id);
    if (!existing) {
      return false;
    }

    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    this.removeFtsIndex(id);
    this.recordAudit(
      'NOTE_DELETE',
      existing.id,
      existing.title,
      `Suppression définitive de la note (créée le ${existing.created_at})`,
      actor
    );
    return true;
  }

  /**
   * Agrège tous les tags utilisés avec leurs compteurs (total, actives, archivées).
   */
  public getTagsStats(): TagStat[] {
    const rows = this.db
      .prepare('SELECT tags_json, is_archived FROM notes')
      .all() as unknown as { tags_json: string; is_archived: number }[];

    const map = new Map<string, TagStat>();
    for (const row of rows) {
      let tags: string[] = [];
      try {
        tags = normalizeTagsList(JSON.parse(row.tags_json));
      } catch {
        tags = [];
      }
      for (const tag of tags) {
        const entry = map.get(tag) ?? {
          name: tag,
          count: 0,
          active_count: 0,
          archived_count: 0,
        };
        entry.count += 1;
        if (row.is_archived === 1) {
          entry.archived_count += 1;
        } else {
          entry.active_count += 1;
        }
        map.set(tag, entry);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * Calcule les indicateurs globaux de l'espace de notes.
   */
  public getStats(): NotesStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_count,
          SUM(CASE WHEN is_archived = 0 THEN 1 ELSE 0 END) as active_count,
          SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived_count,
          SUM(CASE WHEN is_pinned = 1 AND is_archived = 0 THEN 1 ELSE 0 END) as pinned_count,
          SUM(word_count) as total_words
         FROM notes`
      )
      .get() as {
      total_count: number;
      active_count: number | null;
      archived_count: number | null;
      pinned_count: number | null;
      total_words: number | null;
    };

    const tags = this.getTagsStats();

    return {
      total_count: Number(row.total_count ?? 0),
      active_count: Number(row.active_count ?? 0),
      archived_count: Number(row.archived_count ?? 0),
      pinned_count: Number(row.pinned_count ?? 0),
      total_tags: tags.length,
      total_words: Number(row.total_words ?? 0),
    };
  }

  /**
   * Retourne les entrées récentes du journal d'audit de sécurité.
   */
  public listAuditLogs(limit = 50): AuditLogEntry[] {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const rows = this.db
      .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as unknown as RawAuditRow[];

    return rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      entity_id: row.entity_id,
      entity_title: row.entity_title,
      actor: row.actor,
      details: row.details,
      created_at: row.created_at,
    }));
  }

  /**
   * Peuple la base avec un jeu de notes synthétiques réalistes uniquement si la base est vide.
   */
  public seedIfEmpty(): void {
    const stats = this.getStats();
    if (stats.total_count > 0) {
      return;
    }

    const samples: Array<CreateNoteInput & { is_archived?: boolean; offsetMinutes: number }> = [
      {
        title: 'Architecture & Décisions Techniques — Projet Cahier',
        content: `Objectif : disposer d'un système de prise de notes rapide, fiable et 100 % persistant.\n\nPoints clés validés :\n- Stockage relationnel SQLite en mode WAL pour garantir l'intégrité ACID sur disque.\n- Indexation plein texte via SQLite FTS5 (recherche instantanée sur le titre, le corps et les tags).\n- Séparation stricte entre la couche de présentation React, l'API REST Express et le dépôt de données.\n- Horodatage normalisé ISO 8601 UTC pour chaque création, modification et archivage.`,
        tags: ['architecture', 'sqlite', 'produit'],
        is_pinned: true,
        offsetMinutes: 240,
      },
      {
        title: 'Compte-rendu de synchronisation produit Q4',
        content: `Participants : Équipe Produit, Ingénierie, QA et Sécurité.\n\nDécisions prises :\n1. Prioriser la recherche plein texte multi-mots et le filtrage combiné par tags.\n2. Permettre l'archivage en un clic afin de garder l'espace de travail principal épuré sans perdre l'historique.\n3. Ajouter l'export JSON complet pour la portabilité des données utilisateur.\n4. Maintenir un journal d'audit local traçant les créations, archivages et suppressions définitives.`,
        tags: ['réunion', 'produit', 'roadmap'],
        is_pinned: false,
        offsetMinutes: 180,
      },
      {
        title: 'Checklist de sécurité et durcissement applicatif',
        content: `Vérifications obligatoires avant mise en production :\n- Validation stricte des schémas d'entrée côté serveur (longueur du titre, taille maximale du contenu, normalisation des tags).\n- Requêtes SQL exclusivement paramétrées (zéro concaténation de chaînes).\n- En-têtes HTTP de sécurité (Content-Security-Policy, X-Content-Type-Options, X-Frame-Options).\n- Limitation de débit (Rate Limiting) par adresse IP sur les routes de l'API.\n- Aucun secret ni clé privée dans le code source ou le dépôt Git.`,
        tags: ['sécurité', 'devops', 'qualité'],
        is_pinned: true,
        offsetMinutes: 95,
      },
      {
        title: 'Guide des raccourcis et bonnes pratiques de rédaction',
        content: `Astuces d'organisation quotidienne :\n- Utilisez des tags courts et normalisés (ex: #architecture, #réunion, #urgent) pour regrouper vos notes transverses.\n- Épinglez vos notes de référence en haut de liste pour y accéder immédiatement.\n- Archivez les notes terminées plutôt que de les supprimer : elles restent cherchables à tout moment dans l'onglet Archives.\n- Raccourci clavier : appuyez sur Ctrl+K (ou Cmd+K) pour placer le focus directement dans la barre de recherche plein texte.`,
        tags: ['guide', 'productivité'],
        is_pinned: false,
        offsetMinutes: 45,
      },
      {
        title: 'Ancien cahier des charges — Prototype v0 (Archivé)',
        content: `Document conservé pour référence historique.\nLes spécifications initiales du prototype de démonstration ont été remplacées par l'architecture SQLite FTS5 actuelle avec validation serveur et tests automatisés de bout en bout.`,
        tags: ['archive', 'historique'],
        is_pinned: false,
        is_archived: true,
        offsetMinutes: 1440,
      },
    ];

    const nowMs = Date.now();
    for (const sample of samples) {
      const ts = new Date(nowMs - sample.offsetMinutes * 60_000).toISOString();
      const created = this.createNote(
        {
          title: sample.title,
          content: sample.content,
          tags: sample.tags,
          is_pinned: sample.is_pinned,
        },
        'system-seed',
        ts
      );
      if (sample.is_archived) {
        this.setArchiveStatus(created.id, true, 'system-seed');
      }
    }
  }

  public close(): void {
    this.db.close();
  }
}

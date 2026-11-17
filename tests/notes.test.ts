/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Suite de tests automatisés (Unitaires, Intégration SQLite FTS5, et Parcours Critiques E2E HTTP).
 * Exécutable via `npm test` (`tsx --test tests/notes.test.ts`).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeTextMetrics,
  normalizeTag,
  normalizeTagsList,
  validateCreateNoteInput,
  validateUpdateNoteInput,
} from '../src/shared/types.ts';
import { NotesRepository, buildSafeFtsQuery } from '../src/server/db.ts';
import { createApiRouter } from '../src/server/app.ts';

describe('1. Tests Unitaires — Normalisation, Métriques et Validation des Entrées', () => {
  it('normalise correctement les tags (minuscules, accents préservés, espaces en tirets, suppression #)', () => {
    assert.equal(normalizeTag('  #Réunion Équipe  '), 'réunion-équipe');
    assert.equal(normalizeTag('###Architecture_2026!@$'), 'architecture_2026');
    assert.equal(normalizeTag('   '), '');
  });

  it('déduplique et limite la liste de tags', () => {
    const tags = normalizeTagsList(['Produit', '#produit', '  PRODUIT ', 'SQLite', '']);
    assert.deepEqual(tags, ['produit', 'sqlite']);
  });

  it('calcule exactement le nombre de mots et de caractères', () => {
    assert.deepEqual(computeTextMetrics(''), { word_count: 0, char_count: 0 });
    assert.deepEqual(computeTextMetrics('   '), { word_count: 0, char_count: 3 });
    assert.deepEqual(computeTextMetrics('Bonjour le monde'), { word_count: 3, char_count: 16 });
  });

  it('rejette une création de note sans titre ou avec des types invalides', () => {
    const emptyTitle = validateCreateNoteInput({ title: '   ', content: 'Contenu valide' });
    assert.equal(emptyTitle.valid, false);
    assert.ok(emptyTitle.errors.length > 0);

    const invalidTags = validateCreateNoteInput({
      title: 'Titre valide',
      content: 'Texte',
      tags: 'pas-un-tableau',
    });
    assert.equal(invalidTags.valid, false);
  });

  it('valide une mise à jour partielle et rejette un objet vide', () => {
    const emptyUpdate = validateUpdateNoteInput({});
    assert.equal(emptyUpdate.valid, false);

    const validArchive = validateUpdateNoteInput({ is_archived: true });
    assert.equal(validArchive.valid, true);
    assert.equal(validArchive.data?.is_archived, true);
  });

  it('sécurise les expressions de recherche FTS5 contre les caractères spéciaux SQL/FTS', () => {
    const safe = buildSafeFtsQuery('sqlite "injection" (test)* :^');
    assert.equal(safe, '"sqlite"* AND "injection"* AND "test"*');
  });
});

describe('2. Tests d’Intégration — Persistance SQLite, CRUD, Archivage, Tags et Recherche FTS5', () => {
  let repo: NotesRepository;
  let tempDbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cahier-test-'));
    tempDbPath = path.join(tmpDir, 'test.sqlite');
    repo = new NotesRepository(tempDbPath);
  });

  afterEach(() => {
    repo.close();
    if (fs.existsSync(tempDbPath)) {
      fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
    }
  });

  it('persiste les notes sur disque entre deux instances de NotesRepository (Critère : Données persistantes)', () => {
    const created = repo.createNote({
      title: 'Note persistante sur disque',
      content: 'Vérification de la sauvegarde SQLite après fermeture et réouverture.',
      tags: ['persistance', 'sqlite'],
      is_pinned: true,
    });
    repo.close();

    // Réouverture d'une nouvelle instance pointant sur le même fichier SQLite
    const reopenedRepo = new NotesRepository(tempDbPath);
    const loaded = reopenedRepo.getNoteById(created.id);
    assert.ok(loaded, 'La note doit être retrouvée après réouverture de la base SQLite');
    assert.equal(loaded.title, 'Note persistante sur disque');
    assert.deepEqual(loaded.tags, ['persistance', 'sqlite']);
    assert.equal(loaded.is_pinned, true);
    assert.equal(loaded.word_count, 9);
    reopenedRepo.close();

    // Réassigner pour que afterEach fonctionne proprement
    repo = new NotesRepository(tempDbPath);
  });

  it('exécute le cycle CRUD complet avec horodatage et journal d’audit (Critère : CRUD complet)', () => {
    const note = repo.createNote({
      title: 'Note initiale',
      content: 'Premier paragraphe',
      tags: ['alpha'],
    });
    assert.ok(note.id.startsWith('note_'));
    assert.ok(note.created_at);
    assert.equal(note.is_archived, false);

    const updated = repo.updateNote(note.id, {
      title: 'Note modifiée',
      content: 'Premier paragraphe enrichi avec plus de détails',
      tags: ['alpha', 'beta'],
    });
    assert.ok(updated);
    assert.equal(updated.title, 'Note modifiée');
    assert.deepEqual(updated.tags, ['alpha', 'beta']);
    assert.equal(updated.word_count, 7);

    const deleted = repo.deleteNote(note.id);
    assert.equal(deleted, true);
    assert.equal(repo.getNoteById(note.id), null);

    const logs = repo.listAuditLogs(10);
    const actions = logs.map((l) => l.action);
    assert.ok(actions.includes('NOTE_CREATE'));
    assert.ok(actions.includes('NOTE_UPDATE'));
    assert.ok(actions.includes('NOTE_DELETE'));
  });

  it('effectue une recherche plein texte FTS5 précise sur le titre, le contenu et les tags (Critère : Tests des recherches)', () => {
    repo.createNote({
      title: 'Déploiement Kubernetes Production',
      content: 'Configuration des clusters et des quotas mémoires.',
      tags: ['infra', 'cloud'],
    });
    repo.createNote({
      title: 'Recette de cuisine automnale',
      content: 'Velouté de potimarron et châtaignes grillées.',
      tags: ['cuisine', 'maison'],
    });
    repo.createNote({
      title: 'Optimisation Base de Données',
      content: 'Indexation plein texte FTS5 avec SQLite et requêtes préparées.',
      tags: ['backend', 'sqlite'],
    });

    // Recherche par préfixe sur le contenu avec gestion des accents (unicode61 remove_diacritics)
    const searchCuisine = repo.listNotes({ q: 'chataigne', status: 'all' });
    assert.equal(searchCuisine.length, 1);
    assert.equal(searchCuisine[0].title, 'Recette de cuisine automnale');

    // Recherche sur les tags indexés dans FTS5
    const searchInfra = repo.listNotes({ q: 'cloud', status: 'all' });
    assert.equal(searchInfra.length, 1);
    assert.equal(searchInfra[0].title, 'Déploiement Kubernetes Production');

    // Recherche multi-termes combinée
    const searchSql = repo.listNotes({ q: 'indexation sqlite', status: 'all' });
    assert.equal(searchSql.length, 1);
    assert.equal(searchSql[0].title, 'Optimisation Base de Données');
  });

  it('isole correctement les notes archivées des notes actives et permet leur restauration (Critère : Tests des archivages)', () => {
    const activeNote = repo.createNote({
      title: 'Tâche en cours',
      content: 'Rédiger la documentation API.',
      tags: ['travail'],
    });
    const toArchiveNote = repo.createNote({
      title: 'Tâche terminée Q3',
      content: 'Bilan trimestriel clôturé.',
      tags: ['travail', 'bilan'],
    });

    // Archivage de la seconde note
    const archived = repo.setArchiveStatus(toArchiveNote.id, true);
    assert.ok(archived);
    assert.equal(archived.is_archived, true);
    assert.ok(archived.archived_at, 'archived_at doit être renseigné lors de l’archivage');

    // Vérification du filtre "active" (par défaut)
    const activeList = repo.listNotes({ status: 'active' });
    assert.equal(activeList.length, 1);
    assert.equal(activeList[0].id, activeNote.id);

    // Vérification du filtre "archived"
    const archivedList = repo.listNotes({ status: 'archived' });
    assert.equal(archivedList.length, 1);
    assert.equal(archivedList[0].id, toArchiveNote.id);

    // Vérification de la recherche plein texte combinée au statut d'archivage
    const searchInActive = repo.listNotes({ q: 'trimestriel', status: 'active' });
    assert.equal(searchInActive.length, 0);

    const searchInArchived = repo.listNotes({ q: 'trimestriel', status: 'archived' });
    assert.equal(searchInArchived.length, 1);
    assert.equal(searchInArchived[0].id, toArchiveNote.id);

    // Restauration de la note archivée
    const restored = repo.setArchiveStatus(toArchiveNote.id, false);
    assert.ok(restored);
    assert.equal(restored.is_archived, false);
    assert.equal(restored.archived_at, null);

    const activeAfterRestore = repo.listNotes({ status: 'active' });
    assert.equal(activeAfterRestore.length, 2);
  });
});

describe('3. Tests End-to-End API HTTP — Parcours Critiques et Sécurité', () => {
  let repo: NotesRepository;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    repo = new NotesRepository(':memory:');
    const app = express();
    app.use('/api', createApiRouter(repo));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
  });

  it('parcours complet HTTP : POST création -> GET recherche FTS5 -> PATCH archivage -> DELETE suppression', async () => {
    // 1. Création via POST /api/notes
    const createRes = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Spécification Sécurité OWASP',
        content: 'Validation des entrées et requêtes paramétrées SQLite.',
        tags: ['Sécurité', 'OWASP'],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.headers.get('x-content-type-options'), 'nosniff');
    const createdBody = (await createRes.json()) as { ok: boolean; data: { id: string; tags: string[] } };
    assert.equal(createdBody.ok, true);
    assert.deepEqual(createdBody.data.tags, ['sécurité', 'owasp']);
    const noteId = createdBody.data.id;

    // 2. Recherche plein texte via GET /api/notes?q=paramétrées
    const searchRes = await fetch(`${baseUrl}/api/notes?q=${encodeURIComponent('paramétrées')}`);
    assert.equal(searchRes.status, 200);
    const searchBody = (await searchRes.json()) as {
      ok: boolean;
      data: { notes: Array<{ id: string }> };
    };
    assert.equal(searchBody.data.notes.length, 1);
    assert.equal(searchBody.data.notes[0].id, noteId);

    // 3. Archivage via PATCH /api/notes/:id/archive
    const archiveRes = await fetch(`${baseUrl}/api/notes/${noteId}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_archived: true }),
    });
    assert.equal(archiveRes.status, 200);

    // Vérifier qu'elle n'apparaît plus dans les notes actives mais apparaît dans status=archived
    const activeRes = await fetch(`${baseUrl}/api/notes?status=active`);
    const activeBody = (await activeRes.json()) as { data: { notes: unknown[] } };
    assert.equal(activeBody.data.notes.length, 0);

    const archivedRes = await fetch(`${baseUrl}/api/notes?status=archived`);
    const archivedBody = (await archivedRes.json()) as { data: { notes: Array<{ id: string }> } };
    assert.equal(archivedBody.data.notes.length, 1);

    // 4. Suppression via DELETE /api/notes/:id
    const delRes = await fetch(`${baseUrl}/api/notes/${noteId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    // 5. Vérification 404 après suppression
    const getDeletedRes = await fetch(`${baseUrl}/api/notes/${noteId}`);
    assert.equal(getDeletedRes.status, 404);
  });

  it('rejette les requêtes malveillantes ou mal formées (400 Validation, 415 Content-Type)', async () => {
    // Content-Type manquant ou text/plain (Protection CSRF / Validation stricte)
    const badContentType = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"title":"Test","content":"Contenu"}',
    });
    assert.equal(badContentType.status, 415);

    // Titre vide
    const badPayload = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', content: 'Contenu sans titre' }),
    });
    assert.equal(badPayload.status, 400);
  });
});

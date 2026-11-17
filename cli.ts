/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Interface en ligne de commande (CLI) pour l'application Cahier.
 * Permet d'interagir directement avec la même base SQLite persistante depuis un terminal :
 *   npm run cli -- list [--status=active|archived|all] [--tag=nom]
 *   npm run cli -- search <requête>
 *   npm run cli -- create --title="Titre" --content="Contenu" [--tags="tag1,tag2"]
 *   npm run cli -- archive <id>
 *   npm run cli -- restore <id>
 *   npm run cli -- delete <id>
 *   npm run cli -- stats
 */

import { NotesRepository } from './src/server/db.ts';
import { NoteStatusFilter, validateCreateNoteInput } from './src/shared/types.ts';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      flags[key] = rest.length > 0 ? rest.join('=') : 'true';
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

function runCli() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const repo = new NotesRepository();

  try {
    switch (command) {
      case 'list': {
        const status = (flags.status as NoteStatusFilter) || 'active';
        const tag = flags.tag;
        const notes = repo.listNotes({ status, tag });
        console.log(`\nNotes (${status}${tag ? `, tag=#${tag}` : ''}) — ${notes.length} résultat(s) :\n`);
        for (const n of notes) {
          const tagsStr = n.tags.length > 0 ? ` [${n.tags.map((t) => `#${t}`).join(' ')}]` : '';
          const archStr = n.is_archived ? ' (ARCHIVÉE)' : '';
          const pinStr = n.is_pinned ? ' ★ ' : ' - ';
          console.log(`${pinStr}${n.id} | ${n.title}${tagsStr}${archStr} | Modifiée: ${n.updated_at}`);
        }
        break;
      }

      case 'search': {
        const q = positional.join(' ') || flags.q || '';
        if (!q) {
          console.error('Erreur : veuillez fournir un terme de recherche. Exemple : npm run cli -- search sqlite');
          process.exitCode = 1;
          break;
        }
        const notes = repo.listNotes({ q, status: 'all' });
        console.log(`\nRecherche plein texte FTS5 pour "${q}" — ${notes.length} résultat(s) :\n`);
        for (const n of notes) {
          console.log(` - ${n.id} | ${n.title} (${n.is_archived ? 'Archivée' : 'Active'})`);
        }
        break;
      }

      case 'create': {
        const title = flags.title ?? positional[0] ?? '';
        const content = flags.content ?? positional[1] ?? '';
        const tags = flags.tags ? flags.tags.split(',').map((t) => t.trim()) : [];
        const check = validateCreateNoteInput({ title, content, tags });
        if (!check.valid || !check.data) {
          console.error('Erreur de validation :', check.errors.join(' '));
          process.exitCode = 1;
          break;
        }
        const note = repo.createNote(check.data, 'cli-user');
        console.log(`Note créée avec succès : ${note.id} — "${note.title}"`);
        break;
      }

      case 'archive': {
        const id = positional[0];
        if (!id) {
          console.error('Erreur : identifiant de note requis.');
          process.exitCode = 1;
          break;
        }
        const updated = repo.setArchiveStatus(id, true, 'cli-user');
        if (!updated) {
          console.error(`Note introuvable : ${id}`);
          process.exitCode = 1;
        } else {
          console.log(`Note archivée : ${updated.id} ("${updated.title}") à ${updated.archived_at}`);
        }
        break;
      }

      case 'restore': {
        const id = positional[0];
        if (!id) {
          console.error('Erreur : identifiant de note requis.');
          process.exitCode = 1;
          break;
        }
        const updated = repo.setArchiveStatus(id, false, 'cli-user');
        if (!updated) {
          console.error(`Note introuvable : ${id}`);
          process.exitCode = 1;
        } else {
          console.log(`Note restaurée : ${updated.id} ("${updated.title}")`);
        }
        break;
      }

      case 'delete': {
        const id = positional[0];
        if (!id) {
          console.error('Erreur : identifiant de note requis.');
          process.exitCode = 1;
          break;
        }
        const ok = repo.deleteNote(id, 'cli-user');
        if (!ok) {
          console.error(`Note introuvable : ${id}`);
          process.exitCode = 1;
        } else {
          console.log(`Note supprimée définitivement : ${id}`);
        }
        break;
      }

      case 'stats': {
        const s = repo.getStats();
        console.log('\nStatistiques de la base SQLite :', JSON.stringify(s, null, 2));
        break;
      }

      default: {
        console.log(`
Cahier CLI — Gestionnaire de notes SQLite FTS5
Commandes disponibles :
  npm run cli -- list [--status=active|archived|all] [--tag=nom]
  npm run cli -- search <terme>
  npm run cli -- create --title="Mon titre" --content="Mon texte" [--tags="tag1,tag2"]
  npm run cli -- archive <note_id>
  npm run cli -- restore <note_id>
  npm run cli -- delete <note_id>
  npm run cli -- stats
        `.trim());
      }
    }
  } finally {
    repo.close();
  }
}

runCli();

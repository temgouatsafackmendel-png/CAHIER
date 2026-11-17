/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contrats de données et validation stricte (partagés entre le serveur, l'interface Web et le CLI).
 */

export type NoteStatusFilter = 'active' | 'archived' | 'all';
export type NoteSortOption = 'updated_desc' | 'created_desc' | 'title_asc';

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  is_archived: boolean;
  is_pinned: boolean;
  word_count: number;
  char_count: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CreateNoteInput {
  title: string;
  content: string;
  tags?: string[];
  is_pinned?: boolean;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  tags?: string[];
  is_archived?: boolean;
  is_pinned?: boolean;
}

export interface NoteSearchQuery {
  q?: string;
  tag?: string;
  status?: NoteStatusFilter;
  sort?: NoteSortOption;
  limit?: number;
  offset?: number;
}

export interface TagStat {
  name: string;
  count: number;
  active_count: number;
  archived_count: number;
}

export type AuditAction =
  | 'NOTE_CREATE'
  | 'NOTE_UPDATE'
  | 'NOTE_ARCHIVE'
  | 'NOTE_RESTORE'
  | 'NOTE_PIN'
  | 'NOTE_UNPIN'
  | 'NOTE_DELETE'
  | 'NOTES_IMPORT'
  | 'NOTES_SEED';

export interface AuditLogEntry {
  id: number;
  action: AuditAction;
  entity_id: string;
  entity_title: string;
  actor: string;
  details: string;
  created_at: string;
}

export interface NotesStats {
  total_count: number;
  active_count: number;
  archived_count: number;
  pinned_count: number;
  total_tags: number;
  total_words: number;
}

export interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export const VALIDATION_LIMITS = {
  TITLE_MIN_LENGTH: 1,
  TITLE_MAX_LENGTH: 200,
  CONTENT_MAX_LENGTH: 50000,
  MAX_TAGS_PER_NOTE: 15,
  TAG_MAX_LENGTH: 32,
  SEARCH_QUERY_MAX_LENGTH: 150,
} as const;

/**
 * Normalise un tag : minuscule, suppression des espaces superflus,
 * remplacement des espaces internes par des tirets, filtrage des caractères spéciaux.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9àâäéèêëîïôöùûüÿçœæ_-]/gi, '')
    .slice(0, VALIDATION_LIMITS.TAG_MAX_LENGTH);
}

/**
 * Normalise et déduplique une liste de tags.
 */
export function normalizeTagsList(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of tags) {
    if (typeof item !== 'string') continue;
    const clean = normalizeTag(item);
    if (clean.length > 0 && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
    if (result.length >= VALIDATION_LIMITS.MAX_TAGS_PER_NOTE) {
      break;
    }
  }
  return result;
}

/**
 * Calcule le nombre de mots et de caractères d'un texte.
 */
export function computeTextMetrics(content: string): { word_count: number; char_count: number } {
  const trimmed = content.trim();
  const char_count = content.length;
  if (!trimmed) {
    return { word_count: 0, char_count };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return { word_count: words.length, char_count };
}

/**
 * Valide les données de création d'une note.
 */
export function validateCreateNoteInput(payload: unknown): {
  valid: boolean;
  data?: CreateNoteInput;
  errors: string[];
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Le corps de la requête doit être un objet JSON valide.'] };
  }

  const obj = payload as Record<string, unknown>;
  const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawContent = typeof obj.content === 'string' ? obj.content : '';

  if (rawTitle.length < VALIDATION_LIMITS.TITLE_MIN_LENGTH) {
    errors.push('Le titre de la note est obligatoire (minimum 1 caractère non vide).');
  }
  if (rawTitle.length > VALIDATION_LIMITS.TITLE_MAX_LENGTH) {
    errors.push(`Le titre ne peut pas dépasser ${VALIDATION_LIMITS.TITLE_MAX_LENGTH} caractères.`);
  }
  if (typeof obj.content !== 'string') {
    errors.push('Le contenu de la note doit être une chaîne de caractères.');
  } else if (rawContent.length > VALIDATION_LIMITS.CONTENT_MAX_LENGTH) {
    errors.push(`Le contenu ne peut pas dépasser ${VALIDATION_LIMITS.CONTENT_MAX_LENGTH} caractères.`);
  }

  if (obj.tags !== undefined && !Array.isArray(obj.tags)) {
    errors.push('Le champ tags doit être un tableau de chaînes de caractères.');
  } else if (Array.isArray(obj.tags) && obj.tags.length > VALIDATION_LIMITS.MAX_TAGS_PER_NOTE) {
    errors.push(`Une note ne peut pas contenir plus de ${VALIDATION_LIMITS.MAX_TAGS_PER_NOTE} tags.`);
  }

  const is_pinned = typeof obj.is_pinned === 'boolean' ? obj.is_pinned : false;
  const tags = normalizeTagsList(obj.tags ?? []);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      title: rawTitle,
      content: rawContent,
      tags,
      is_pinned,
    },
    errors: [],
  };
}

/**
 * Valide les données de mise à jour partielle ou complète d'une note.
 */
export function validateUpdateNoteInput(payload: unknown): {
  valid: boolean;
  data?: UpdateNoteInput;
  errors: string[];
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Le corps de la requête doit être un objet JSON valide.'] };
  }

  const obj = payload as Record<string, unknown>;
  const data: UpdateNoteInput = {};

  if (obj.title !== undefined) {
    if (typeof obj.title !== 'string') {
      errors.push('Le titre doit être une chaîne de caractères.');
    } else {
      const trimmed = obj.title.trim();
      if (trimmed.length < VALIDATION_LIMITS.TITLE_MIN_LENGTH) {
        errors.push('Le titre de la note ne peut pas être vide.');
      } else if (trimmed.length > VALIDATION_LIMITS.TITLE_MAX_LENGTH) {
        errors.push(`Le titre ne peut pas dépasser ${VALIDATION_LIMITS.TITLE_MAX_LENGTH} caractères.`);
      } else {
        data.title = trimmed;
      }
    }
  }

  if (obj.content !== undefined) {
    if (typeof obj.content !== 'string') {
      errors.push('Le contenu doit être une chaîne de caractères.');
    } else if (obj.content.length > VALIDATION_LIMITS.CONTENT_MAX_LENGTH) {
      errors.push(`Le contenu ne peut pas dépasser ${VALIDATION_LIMITS.CONTENT_MAX_LENGTH} caractères.`);
    } else {
      data.content = obj.content;
    }
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags)) {
      errors.push('Le champ tags doit être un tableau de chaînes de caractères.');
    } else if (obj.tags.length > VALIDATION_LIMITS.MAX_TAGS_PER_NOTE) {
      errors.push(`Une note ne peut pas contenir plus de ${VALIDATION_LIMITS.MAX_TAGS_PER_NOTE} tags.`);
    } else {
      data.tags = normalizeTagsList(obj.tags);
    }
  }

  if (obj.is_archived !== undefined) {
    if (typeof obj.is_archived !== 'boolean') {
      errors.push('Le champ is_archived doit être un booléen.');
    } else {
      data.is_archived = obj.is_archived;
    }
  }

  if (obj.is_pinned !== undefined) {
    if (typeof obj.is_pinned !== 'boolean') {
      errors.push('Le champ is_pinned doit être un booléen.');
    } else {
      data.is_pinned = obj.is_pinned;
    }
  }

  if (Object.keys(data).length === 0 && errors.length === 0) {
    errors.push('Aucun champ valide fourni pour la mise à jour.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data, errors: [] };
}

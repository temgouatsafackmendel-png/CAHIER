/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client HTTP typé pour l'API REST `/api` de l'application Cahier.
 */

import {
  ApiResponse,
  AuditLogEntry,
  CreateNoteInput,
  Note,
  NoteSearchQuery,
  NotesStats,
  TagStat,
  UpdateNoteInput,
} from '../shared/types.ts';

export interface NotesListPayload {
  notes: Note[];
  stats: NotesStats;
  tags: TagStat[];
}

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly details?: string[];

  constructor(message: string, code = 'API_ERROR', details?: string[]) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.details = details;
  }
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Actor-Id': 'web-workspace',
      ...(options?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.ok) {
    const errObj = !payload.ok ? payload.error : { code: 'HTTP_ERROR', message: 'Erreur réseau inattendue.' };
    throw new ApiClientError(errObj.message, errObj.code, errObj.details);
  }

  return payload.data;
}

export const notesApi = {
  async fetchNotes(query: NoteSearchQuery): Promise<NotesListPayload> {
    const params = new URLSearchParams();
    if (query.q && query.q.trim()) params.set('q', query.q.trim());
    if (query.tag && query.tag.trim()) params.set('tag', query.tag.trim());
    if (query.status) params.set('status', query.status);
    if (query.sort) params.set('sort', query.sort);

    const qs = params.toString();
    return requestJson<NotesListPayload>(`/api/notes${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
  },

  async createNote(input: CreateNoteInput): Promise<Note> {
    return requestJson<Note>('/api/notes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateNote(id: string, input: UpdateNoteInput): Promise<Note> {
    return requestJson<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async setArchived(id: string, is_archived: boolean): Promise<Note> {
    return requestJson<Note>(`/api/notes/${encodeURIComponent(id)}/archive`, {
      method: 'PATCH',
      body: JSON.stringify({ is_archived }),
    });
  },

  async deleteNote(id: string): Promise<{ id: string; deleted: boolean }> {
    return requestJson<{ id: string; deleted: boolean }>(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async fetchAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
    return requestJson<AuditLogEntry[]>(`/api/audit?limit=${limit}`, {
      method: 'GET',
    });
  },

  async exportAllNotes(): Promise<{
    exported_at: string;
    version: string;
    stats: NotesStats;
    notes: Note[];
  }> {
    return requestJson(`/api/notes/export`, {
      method: 'GET',
    });
  },
};

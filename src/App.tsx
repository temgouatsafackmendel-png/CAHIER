/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Application principale Cahier — Prise et Organisation de Notes.
 * Conception et Réalisation : Mendel Temgoua.
 *
 * Respecte strictement la séparation Présentation / API / Persistance SQLite FTS5 :
 * - Aucune donnée pré-remplie par le backend ni aucun détail technique serveur exposé dans l'éditeur.
 * - Mode Focus sans distraction (masque la barre latérale et la liste des notes).
 * - Documentation visuelle complète intégrée avec captures et schémas d'architecture.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  Clock,
  Download,
  FileText,
  FolderArchive,
  Hash,
  Layers,
  Maximize2,
  Minimize2,
  Moon,
  Pin,
  Plus,
  Search,
  Sun,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import {
  Note,
  NoteSortOption,
  NoteStatusFilter,
  NotesStats,
  TagStat,
  VALIDATION_LIMITS,
  computeTextMetrics,
  normalizeTag,
} from './shared/types.ts';
import { ApiClientError, notesApi } from './services/notesApi.ts';

type WorkspaceView = 'notes' | 'documentation';

const DOC_IMAGES = {
  workspace: '/src/assets/images/doc_workspace_overview_1794873783965.jpg',
  focusMode: '/src/assets/images/doc_focus_mode_editor_1794873783544.jpg',
  architecture: '/src/assets/images/doc_architecture_visual_1794873784327.jpg',
};

function formatExactDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function estimateReadingMinutes(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return Math.max(1, Math.ceil(wordCount / 200));
}

function ResilientDocImage({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption: string;
}) {
  const [hasError, setHasError] = useState(false);

  return (
    <figure className="border border-slate-200/80 dark:border-slate-800/80 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-900">
      {!hasError ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setHasError(true)}
          className="w-full aspect-video object-cover block"
        />
      ) : (
        <div className="w-full aspect-video flex flex-col items-center justify-center p-6 text-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-800">
          <BookOpen className="w-8 h-8 text-slate-400 mb-2" />
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{alt}</span>
        </div>
      )}
      <figcaption className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400 border-t border-slate-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-950">
        {caption}
      </figcaption>
    </figure>
  );
}

export default function App() {
  // Thème clair / sombre
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cahier_theme') === 'dark';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('cahier_theme', darkMode ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [darkMode]);

  // Mode Focus de l'éditeur (masque la barre latérale et la liste des notes pour maximiser l'espace d'écriture)
  const [isFocusMode, setIsFocusMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cahier_focus_mode') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('cahier_focus_mode', isFocusMode ? 'true' : 'false');
    } catch {
      // Ignore storage errors
    }
  }, [isFocusMode]);

  // États de navigation et de filtrage
  const [activeView, setActiveView] = useState<WorkspaceView>('notes');
  const [statusFilter, setStatusFilter] = useState<NoteStatusFilter>('active');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<NoteSortOption>('updated_desc');

  // Données chargées exclusivement selon les actions de l'utilisateur
  const [notes, setNotes] = useState<Note[]>([]);
  const [stats, setStats] = useState<NotesStats>({
    total_count: 0,
    active_count: 0,
    archived_count: 0,
    pinned_count: 0,
    total_tags: 0,
    total_words: 0,
  });
  const [tagsStats, setTagsStats] = useState<TagStat[]>([]);

  // États de chargement, erreur et feedback
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  // Sélection et édition de la note active
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [draftContent, setDraftContent] = useState<string>('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftPinned, setDraftPinned] = useState<boolean>(false);
  const [newTagInput, setNewTagInput] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const contentTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Debounce de la recherche plein texte (180ms)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const showTemporaryFeedback = useCallback((msg: string) => {
    setFeedbackBanner(msg);
    window.setTimeout(() => {
      setFeedbackBanner((prev) => (prev === msg ? null : prev));
    }, 3000);
  }, []);

  // Chargement des notes créées par l'utilisateur
  const loadNotesData = useCallback(
    async (preserveSelectionId?: string | null) => {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const data = await notesApi.fetchNotes({
          q: debouncedQuery,
          tag: selectedTag || undefined,
          status: statusFilter,
          sort: sortBy,
        });
        setNotes(data.notes);
        setStats(data.stats);
        setTagsStats(data.tags);

        const targetId = preserveSelectionId !== undefined ? preserveSelectionId : selectedNoteId;
        if (targetId && data.notes.some((n) => n.id === targetId)) {
          const found = data.notes.find((n) => n.id === targetId)!;
          setSelectedNoteId(found.id);
          setDraftTitle(found.title);
          setDraftContent(found.content);
          setDraftTags(found.tags);
          setDraftPinned(found.is_pinned);
          setIsDirty(false);
        } else if (data.notes.length > 0) {
          const first = data.notes[0];
          setSelectedNoteId(first.id);
          setDraftTitle(first.title);
          setDraftContent(first.content);
          setDraftTags(first.tags);
          setDraftPinned(first.is_pinned);
          setIsDirty(false);
        } else {
          setSelectedNoteId(null);
          setDraftTitle('');
          setDraftContent('');
          setDraftTags([]);
          setDraftPinned(false);
          setIsDirty(false);
        }
      } catch (err) {
        const message =
          err instanceof ApiClientError
            ? err.message
            : 'Impossible de charger vos notes.';
        setErrorMessage(message);
      } finally {
        setIsLoading(false);
      }
    },
    [debouncedQuery, selectedTag, statusFilter, sortBy, selectedNoteId]
  );

  useEffect(() => {
    void loadNotesData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, selectedTag, statusFilter, sortBy]);

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId) ?? null,
    [notes, selectedNoteId]
  );

  const liveMetrics = useMemo(() => computeTextMetrics(draftContent), [draftContent]);
  const readingTimeMin = useMemo(
    () => estimateReadingMinutes(liveMetrics.word_count),
    [liveMetrics.word_count]
  );

  const handleSelectNote = (note: Note) => {
    setSelectedNoteId(note.id);
    setDraftTitle(note.title);
    setDraftContent(note.content);
    setDraftTags(note.tags);
    setDraftPinned(note.is_pinned);
    setNewTagInput('');
    setConfirmDeleteId(null);
    setIsDirty(false);
  };

  // Création d'une nouvelle note par l'utilisateur
  const handleCreateNewNote = async () => {
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const defaultTags = selectedTag ? [selectedTag] : [];
      const created = await notesApi.createNote({
        title: 'Nouvelle note',
        content: '',
        tags: defaultTags,
        is_pinned: false,
      });

      if (statusFilter === 'archived') {
        setStatusFilter('active');
      }
      setActiveView('notes');
      await loadNotesData(created.id);
      showTemporaryFeedback('Nouvelle note créée.');
      window.setTimeout(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      }, 50);
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : 'Échec lors de la création de la note.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Sauvegarde des modifications de la note courante
  const handleSaveNote = async () => {
    if (!selectedNoteId) return;
    const trimmedTitle = draftTitle.trim();
    if (!trimmedTitle) {
      setErrorMessage('Le titre de la note ne peut pas être vide.');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      const updated = await notesApi.updateNote(selectedNoteId, {
        title: trimmedTitle,
        content: draftContent,
        tags: draftTags,
        is_pinned: draftPinned,
      });
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setDraftTitle(updated.title);
      setDraftContent(updated.content);
      setDraftTags(updated.tags);
      setDraftPinned(updated.is_pinned);
      setIsDirty(false);
      await loadNotesData(updated.id);
      showTemporaryFeedback('Note enregistrée.');
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : 'Erreur lors de la sauvegarde de la note.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Raccourcis clavier globaux :
  // - Ctrl/Cmd+K : focus dans la recherche (quitte le mode Focus si actif)
  // - Ctrl/Cmd+S : sauvegarder la note active
  // - Ctrl/Cmd+\ ou Ctrl/Cmd+Shift+F : basculer le mode Focus de l'éditeur
  // - Échap : quitter le mode Focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveView('notes');
        setIsFocusMode(false);
        window.setTimeout(() => searchInputRef.current?.focus(), 30);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (activeView === 'notes' && selectedNoteId && isDirty) {
          e.preventDefault();
          void handleSaveNote();
        }
      } else if (
        ((e.metaKey || e.ctrlKey) && e.key === '\\') ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')
      ) {
        if (activeView === 'notes' && selectedNoteId) {
          e.preventDefault();
          setIsFocusMode((prev) => !prev);
        }
      } else if (e.key === 'Escape' && isFocusMode) {
        setIsFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // Bascule d'épinglage immédiate
  const handleTogglePin = async () => {
    if (!selectedNote) return;
    const nextPinned = !draftPinned;
    setDraftPinned(nextPinned);
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const updated = await notesApi.updateNote(selectedNote.id, {
        title: draftTitle.trim() || selectedNote.title,
        content: draftContent,
        tags: draftTags,
        is_pinned: nextPinned,
      });
      await loadNotesData(updated.id);
      showTemporaryFeedback(nextPinned ? 'Note épinglée en haut de liste.' : 'Note désépinglée.');
    } catch (err) {
      setDraftPinned(!nextPinned);
      const message =
        err instanceof ApiClientError ? err.message : "Impossible de modifier l'épinglage.";
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Archivage ou restauration d'une note
  const handleToggleArchive = async (note: Note) => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const nextArchived = !note.is_archived;
      await notesApi.setArchived(note.id, nextArchived);
      await loadNotesData(null);
      showTemporaryFeedback(
        nextArchived
          ? `Note « ${note.title} » déplacée dans les archives.`
          : `Note « ${note.title} » restaurée dans les notes actives.`
      );
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Erreur lors du changement d'état d'archivage.";
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Suppression définitive après confirmation
  const handleDeleteNote = async (id: string) => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      await notesApi.deleteNote(id);
      setConfirmDeleteId(null);
      await loadNotesData(null);
      showTemporaryFeedback('Note supprimée définitivement.');
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : 'Erreur lors de la suppression de la note.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Gestion des tags dans l'éditeur
  const handleAddDraftTag = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const normalized = normalizeTag(newTagInput);
    if (!normalized) {
      setNewTagInput('');
      return;
    }
    if (draftTags.includes(normalized)) {
      setNewTagInput('');
      return;
    }
    if (draftTags.length >= VALIDATION_LIMITS.MAX_TAGS_PER_NOTE) {
      setErrorMessage(`Maximum ${VALIDATION_LIMITS.MAX_TAGS_PER_NOTE} tags par note atteint.`);
      return;
    }
    setDraftTags((prev) => [...prev, normalized]);
    setNewTagInput('');
    setIsDirty(true);
  };

  const handleRemoveDraftTag = (tagToRemove: string) => {
    setDraftTags((prev) => prev.filter((t) => t !== tagToRemove));
    setIsDirty(true);
  };

  // Export JSON de toutes les notes de l'utilisateur
  const handleExportJson = async () => {
    try {
      const payload = await notesApi.exportAllNotes();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cahier-notes-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showTemporaryFeedback('Sauvegarde JSON téléchargée.');
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Impossible d'exporter les notes.";
      setErrorMessage(message);
    }
  };

  const toggleFocusMode = () => {
    setIsFocusMode((prev) => {
      const next = !prev;
      if (next) {
        window.setTimeout(() => contentTextareaRef.current?.focus(), 40);
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Top Bar Contract : 3 zones strictes séparées par gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 bg-white dark:bg-slate-950 border-b border-slate-200/80 dark:border-slate-800/80 shrink-0">
        {/* Zone 1 : Marque sur une seule ligne */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('notes');
            setStatusFilter('active');
            setSelectedTag('');
            setSearchQuery('');
            setIsFocusMode(false);
          }}
          className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 dark:focus-visible:outline-slate-100"
        >
          Cahier
        </a>

        {/* Zone 2 : 4 liens de navigation épurés (texte simple avec soulignement au survol) */}
        <nav
          aria-label="Navigation principale"
          className="hidden md:flex items-center gap-7 text-xs font-medium text-slate-500 dark:text-slate-400"
        >
          <button
            type="button"
            onClick={() => {
              setActiveView('notes');
              setStatusFilter('active');
              setIsFocusMode(false);
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'notes' && statusFilter === 'active'
                ? 'text-slate-900 dark:text-slate-100 underline font-semibold'
                : ''
            }`}
          >
            Notes actives
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveView('notes');
              setStatusFilter('archived');
              setIsFocusMode(false);
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'notes' && statusFilter === 'archived'
                ? 'text-slate-900 dark:text-slate-100 underline font-semibold'
                : ''
            }`}
          >
            Archives
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveView('notes');
              setStatusFilter('all');
              setIsFocusMode(false);
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'notes' && statusFilter === 'all'
                ? 'text-slate-900 dark:text-slate-100 underline font-semibold'
                : ''
            }`}
          >
            Toutes les notes
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveView('documentation');
              setIsFocusMode(false);
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'documentation'
                ? 'text-slate-900 dark:text-slate-100 underline font-semibold'
                : ''
            }`}
          >
            Documentation
          </button>
        </nav>

        {/* Zone 3 : 1 action principale */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => void handleCreateNewNote()}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Nouvelle note</span>
          </button>
        </div>
      </header>

      {/* Bandeau d'alerte ou de confirmation sobre */}
      {(errorMessage || feedbackBanner) && (
        <div
          role={errorMessage ? 'alert' : 'status'}
          className={`px-6 py-2 text-xs font-medium border-b flex items-center justify-between gap-4 ${
            errorMessage
              ? 'bg-red-50/90 text-red-800 border-red-200 dark:bg-red-950/60 dark:text-red-200 dark:border-red-900'
              : 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {errorMessage ? (
              <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
            ) : (
              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            )}
            <span>{errorMessage ?? feedbackBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setErrorMessage(null);
              setFeedbackBanner(null);
            }}
            className="p-1 hover:opacity-75 whitespace-nowrap shrink-0 cursor-pointer"
            aria-label="Fermer la notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Espace de travail principal */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Colonne 1 : Barre latérale de filtres et tags (Masquée en mode Focus) */}
        {!isFocusMode && (
          <aside
            aria-label="Filtres et organisation"
            className="w-full lg:w-60 bg-slate-50/70 dark:bg-slate-900/40 border-b lg:border-b-0 lg:border-r border-slate-200/80 dark:border-slate-800/80 p-4 flex flex-col justify-between gap-6 shrink-0"
          >
            <div className="space-y-6">
              {/* Navigation de l'espace de notes */}
              <div>
                <div className="px-2.5 text-xs font-medium text-slate-400 dark:text-slate-500 mb-2">
                  Espace de travail
                </div>
                <div className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveView('notes');
                      setStatusFilter('active');
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      activeView === 'notes' && statusFilter === 'active'
                        ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 opacity-75" />
                      <span>Notes actives</span>
                    </span>
                    <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                      {stats.active_count}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveView('notes');
                      setStatusFilter('archived');
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      activeView === 'notes' && statusFilter === 'archived'
                        ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <FolderArchive className="w-3.5 h-3.5 opacity-75" />
                      <span>Archives</span>
                    </span>
                    <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                      {stats.archived_count}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveView('notes');
                      setStatusFilter('all');
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      activeView === 'notes' && statusFilter === 'all'
                        ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Layers className="w-3.5 h-3.5 opacity-75" />
                      <span>Toutes les notes</span>
                    </span>
                    <span className="font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                      {stats.total_count}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveView('documentation')}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      activeView === 'documentation'
                        ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <BookOpen className="w-3.5 h-3.5 opacity-75" />
                      <span>Documentation</span>
                    </span>
                  </button>
                </div>
              </div>

              {/* Filtrage interactif par Tags */}
              <div>
                <div className="flex items-center justify-between px-2.5 mb-2">
                  <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                    Tags ({tagsStats.length})
                  </span>
                  {selectedTag && (
                    <button
                      type="button"
                      onClick={() => setSelectedTag('')}
                      className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 underline whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Effacer
                    </button>
                  )}
                </div>

                {tagsStats.length === 0 ? (
                  <p className="px-2.5 text-xs text-slate-400 dark:text-slate-500 py-1">
                    Vos tags apparaîtront ici dès que vous en ajouterez à vos notes.
                  </p>
                ) : (
                  <div className="space-y-0.5 max-h-64 overflow-y-auto pr-1">
                    {tagsStats.map((tag) => {
                      const isSelected = selectedTag === tag.name;
                      return (
                        <button
                          key={tag.name}
                          type="button"
                          onClick={() => {
                            setActiveView('notes');
                            setSelectedTag(isSelected ? '' : tag.name);
                          }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            isSelected
                              ? 'bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold'
                              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1.5 truncate">
                            <Hash className="w-3 h-3 opacity-50 shrink-0" />
                            <span className="truncate">{tag.name}</span>
                          </span>
                          <span className="font-mono tabular-nums text-xs text-slate-400 dark:text-slate-500">
                            {tag.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Pied de barre latérale : Signature auteur & Utilitaires */}
            <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800/80 space-y-3">
              <div className="px-1 text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <div className="font-medium text-slate-700 dark:text-slate-300">
                  Réalisé par Mendel Temgoua
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-400 dark:text-slate-500">
                  {stats.total_words} mots rédigés
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleExportJson()}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Exporter vos notes en JSON"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exporter</span>
                </button>

                <button
                  type="button"
                  onClick={() => setDarkMode((d) => !d)}
                  className="inline-flex items-center justify-center p-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-md transition-colors shrink-0 cursor-pointer"
                  aria-label={darkMode ? 'Activer le mode clair' : 'Activer le mode sombre'}
                  title={darkMode ? 'Mode clair' : 'Mode sombre'}
                >
                  {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </aside>
        )}

        {activeView === 'documentation' ? (
          /* Vue Documentation Complète du Projet avec Photos et Attribution Auteur */
          <main className="flex-1 bg-white dark:bg-slate-950 p-6 lg:p-10 overflow-y-auto">
            <article className="max-w-4xl mx-auto space-y-10">
              {/* En-tête éditorial de la documentation */}
              <header className="pb-6 border-b border-slate-200/80 dark:border-slate-800/80 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <UserCheck className="w-3.5 h-3.5 text-slate-700 dark:text-slate-300" />
                  <span>Projet conçu, développé et documenté par</span>
                  <strong className="font-semibold text-slate-900 dark:text-slate-100">
                    Mendel Temgoua
                  </strong>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">Version 1.0</span>
                </div>

                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
                  Documentation Officielle — Cahier (Application de Prise et d’Organisation de Notes)
                </h1>

                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed max-w-3xl">
                  Cahier est une application complète de prise de notes conçue pour offrir un espace d’écriture épuré, une organisation par tags normalisés, un archivage structuré et une recherche plein texte instantanée, sans polluer l’interface avec des données techniques du serveur.
                </p>
              </header>

              {/* Section 1 : Aperçu visuel de l'espace de travail */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  01. Présentation de l’Interface & Ergonomie Épurée
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  L’interface est structurée en trois zones complémentaires : la navigation latérale par vues et par tags à gauche, la liste de recherche instantanée au centre et la feuille d’écriture éditoriale à droite. L’espace démarre vierge de toute donnée pré-injectée afin que seules vos propres notes y figurent.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.workspace}
                  alt="Aperçu de l'espace de travail Cahier à 3 colonnes"
                  caption="Figure 1 — Vue d'ensemble de l'espace de travail Cahier (Navigation par tags, Liste de notes et Éditeur éditorial) — Réalisé par Mendel Temgoua."
                />
              </section>

              {/* Section 2 : Mode Focus sans distraction */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  02. Mode Focus — Écriture Sans Distraction
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  Pour maximiser la concentration lors de la rédaction de longs documents, le bouton{" "}
                  <strong>« Mode Focus »</strong> (ou le raccourci clavier <code className="font-mono text-xs px-1.5 py-0.5 bg-slate-100 dark:bg-slate-900 rounded">Ctrl + \</code>) masque instantanément la barre latérale et la colonne de liste des notes. L’éditeur occupe alors toute la largeur disponible avec une colonne de lecture centrée optimale.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.focusMode}
                  alt="Mode Focus de l'éditeur Cahier"
                  caption="Figure 2 — Le Mode Focus masque tous les panneaux latéraux pour offrir une feuille d'écriture plein écran sans distraction — Réalisé par Mendel Temgoua."
                />
              </section>

              {/* Section 3 : Architecture & Séparation Front-End / Back-End */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  03. Architecture Technique & Isolation des Données
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  L’architecture respecte une séparation stricte des responsabilités : le Front-End ne reçoit ni n’affiche d’identifiants internes, de journaux système ou de fausses données issues du Back-End. Le serveur valide les entrées, assure la persistance locale et indexe le texte pour la recherche plein texte.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.architecture}
                  alt="Schéma d'architecture 3-tiers de l'application Cahier"
                  caption="Figure 3 — Architecture logicielle en 3 couches (Interface Web Épurée, Couche Validation API, Moteur de recherche plein texte FTS5) — Réalisé par Mendel Temgoua."
                />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Création, Édition & Tags
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Saisie fluide avec normalisation automatique des tags (<code className="font-mono">#projet</code>), épinglage en tête de liste et horodatage précis.
                    </p>
                  </div>
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Recherche Plein Texte
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Recherche instantanée (<code className="font-mono">Ctrl + K</code>) sur le titre, le contenu et les tags, insensible à la casse et aux accents.
                    </p>
                  </div>
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Archivage & Export
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Archivage et restauration en un clic pour garder l’espace actif ordonné, avec export JSON portable à tout moment.
                    </p>
                  </div>
                </div>
              </section>

              {/* Pied de documentation avec signature de l'auteur */}
              <footer className="pt-6 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
                <div>
                  Auteur & Architecte du projet :{" "}
                  <strong className="font-semibold text-slate-900 dark:text-slate-100">
                    Mendel Temgoua
                  </strong>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveView('notes')}
                  className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-md hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Retourner à l’éditeur de notes
                </button>
              </footer>
            </article>
          </main>
        ) : (
          /* Vue Espace de Notes : Liste de recherche (masquée en mode Focus) + Éditeur */
          <>
            {/* Colonne 2 : Barre de recherche plein texte et liste des notes (Masquée en mode Focus) */}
            {!isFocusMode && (
              <section
                aria-label="Liste et recherche de notes"
                className="w-full lg:w-80 xl:w-96 bg-white dark:bg-slate-950 border-b lg:border-b-0 lg:border-r border-slate-200/80 dark:border-slate-800/80 flex flex-col shrink-0"
              >
                {/* Contrôles de recherche plein texte et de tri */}
                <div className="p-3.5 border-b border-slate-200/80 dark:border-slate-800/80 space-y-2.5">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      ref={searchInputRef}
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Rechercher une note, un mot, un tag... (Ctrl+K)"
                      aria-label="Recherche plein texte dans les notes"
                      className="w-full pl-8 pr-7 py-1.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-slate-400 dark:focus:border-slate-600 transition-colors"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        aria-label="Effacer la recherche"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400 dark:text-slate-500">
                    <span className="font-mono tabular-nums">
                      {notes.length} {notes.length <= 1 ? 'note' : 'notes'}
                      {selectedTag ? ` · #${selectedTag}` : ''}
                    </span>
                    <div className="flex items-center gap-1">
                      <label htmlFor="sort-select" className="sr-only">
                        Trier par
                      </label>
                      <select
                        id="sort-select"
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as NoteSortOption)}
                        className="bg-transparent text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 focus:outline-none cursor-pointer"
                      >
                        <option value="updated_desc">Modifiées récemment</option>
                        <option value="created_desc">Date de création</option>
                        <option value="title_asc">Ordre alphabétique</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Liste des notes avec états Chargement / Vide / Populated */}
                <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-900 max-h-[38vh] lg:max-h-none">
                  {isLoading ? (
                    <div className="p-4 space-y-3" aria-busy="true" aria-label="Chargement des notes">
                      {[1, 2, 3].map((skeleton) => (
                        <div
                          key={skeleton}
                          className="p-3 rounded-md border border-slate-100 dark:border-slate-900 space-y-2 animate-pulse"
                        >
                          <div className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded w-2/3" />
                          <div className="h-3 bg-slate-100 dark:bg-slate-800/70 rounded w-full" />
                          <div className="h-2.5 bg-slate-100 dark:bg-slate-800/70 rounded w-1/3" />
                        </div>
                      ))}
                    </div>
                  ) : notes.length === 0 ? (
                    <div className="p-8 text-center space-y-3">
                      <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                        {searchQuery || selectedTag
                          ? 'Aucun résultat trouvé'
                          : statusFilter === 'archived'
                            ? 'Aucune note archivée'
                            : 'Votre cahier de notes est vide'}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        {searchQuery || selectedTag
                          ? 'Aucune note ne correspond à votre recherche ou au tag sélectionné.'
                          : statusFilter === 'archived'
                            ? 'Les notes que vous archivez apparaîtront dans cet espace.'
                            : 'Créez votre première note personnelle pour commencer.'}
                      </p>
                      {searchQuery || selectedTag ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setSelectedTag('');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Réinitialiser les filtres
                        </button>
                      ) : (
                        statusFilter !== 'archived' && (
                          <button
                            type="button"
                            onClick={() => void handleCreateNewNote()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-md hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Créer une note</span>
                          </button>
                        )
                      )}
                    </div>
                  ) : (
                    notes.map((note) => {
                      const isSelected = note.id === selectedNoteId;
                      return (
                        <button
                          key={note.id}
                          type="button"
                          onClick={() => handleSelectNote(note)}
                          className={`w-full text-left px-4 py-3.5 transition-colors cursor-pointer block focus-visible:outline-none ${
                            isSelected
                              ? 'bg-slate-100/90 dark:bg-slate-900'
                              : 'hover:bg-slate-50/80 dark:hover:bg-slate-900/40'
                          }`}
                        >
                          {/* Titre de la note en premier (Zero badge sandwich) */}
                          <div className="flex items-start justify-between gap-2">
                            <h2
                              className={`text-sm line-clamp-1 ${
                                isSelected
                                  ? 'font-semibold text-slate-950 dark:text-white'
                                  : 'font-medium text-slate-800 dark:text-slate-200'
                              }`}
                            >
                              {note.title}
                            </h2>
                            {note.is_pinned && (
                              <Pin
                                className="w-3 h-3 text-slate-500 dark:text-slate-400 shrink-0 mt-1"
                                aria-label="Note épinglée"
                              />
                            )}
                          </div>

                          {/* Extrait du contenu */}
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1 leading-relaxed">
                            {note.content.trim() || 'Note vide...'}
                          </p>

                          {/* Métadonnées textuelles épurées sans pastilles (Zero-Pill Discipline : séparateurs ·) */}
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 mt-2 font-mono tabular-nums">
                            <span>{formatShortDate(note.updated_at)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{note.word_count} mots</span>
                            {note.is_archived && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-amber-700 dark:text-amber-400 font-sans font-medium">
                                  Archivée
                                </span>
                              </>
                            )}
                            {note.tags.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-sans text-slate-500 dark:text-slate-400 truncate max-w-[160px]">
                                  {note.tags.map((t) => `#${t}`).join(' · ')}
                                </span>
                              </>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </section>
            )}

            {/* Colonne 3 : Éditeur professionnel épuré avec Mode Focus */}
            <main
              aria-label="Éditeur de note"
              className="flex-1 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto"
            >
              {!selectedNote ? (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                  <FileText className="w-7 h-7 text-slate-300 dark:text-slate-700 mb-3" />
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    Prêt à rédiger
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mt-1 mb-4">
                    Créez une nouvelle note ou consultez la documentation complète du projet.
                  </p>
                  <div className="flex items-center gap-2">
                    {isFocusMode && (
                      <button
                        type="button"
                        onClick={() => setIsFocusMode(false)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 rounded-md hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                        <span>Afficher les panneaux</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleCreateNewNote()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-md hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Nouvelle note</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveView('documentation')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 rounded-md hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>Documentation</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col w-full">
                  {/* Barre d'outils supérieure de l'éditeur (fine, alignée et non encombrée) */}
                  <div className="px-6 lg:px-10 py-2.5 border-b border-slate-200/70 dark:border-slate-800/70 flex flex-wrap items-center justify-between gap-4 shrink-0">
                    {/* Gauche : Bouton Mode Focus + Horodatages discrets */}
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={toggleFocusMode}
                        aria-pressed={isFocusMode}
                        title={
                          isFocusMode
                            ? 'Quitter le mode Focus et réafficher les panneaux (Échap ou Ctrl+\\)'
                            : 'Activer le mode Focus pour masquer les panneaux latéraux (Ctrl+\\)'
                        }
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isFocusMode
                            ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                            : 'text-slate-600 dark:text-slate-300 border-slate-200/90 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900'
                        }`}
                      >
                        {isFocusMode ? (
                          <>
                            <Minimize2 className="w-3.5 h-3.5" />
                            <span>Quitter le mode Focus</span>
                          </>
                        ) : (
                          <>
                            <Maximize2 className="w-3.5 h-3.5" />
                            <span>Mode Focus</span>
                          </>
                        )}
                      </button>

                      <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 font-mono tabular-nums">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span>Modifiée le {formatExactDateTime(selectedNote.updated_at)}</span>
                        <span aria-hidden="true">·</span>
                        <span>Créée le {formatShortDate(selectedNote.created_at)}</span>
                        {selectedNote.is_archived && selectedNote.archived_at && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-700 dark:text-amber-400">
                              Archivée le {formatShortDate(selectedNote.archived_at)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Droite : Actions d'édition et de cycle de vie de la note */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleTogglePin()}
                        disabled={isSaving}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          draftPinned
                            ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100'
                            : 'border-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900'
                        }`}
                        title={draftPinned ? 'Désépingler la note' : 'Épingler en haut de liste'}
                      >
                        <Pin className="w-3.5 h-3.5" />
                        <span>{draftPinned ? 'Épinglée' : 'Épingler'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleToggleArchive(selectedNote)}
                        disabled={isSaving}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {selectedNote.is_archived ? (
                          <>
                            <ArchiveRestore className="w-3.5 h-3.5" />
                            <span>Restaurer</span>
                          </>
                        ) : (
                          <>
                            <Archive className="w-3.5 h-3.5" />
                            <span>Archiver</span>
                          </>
                        )}
                      </button>

                      {confirmDeleteId === selectedNote.id ? (
                        <div className="inline-flex items-center gap-1 bg-red-50 dark:bg-red-950/50 px-2 py-0.5 rounded-md border border-red-200 dark:border-red-900">
                          <button
                            type="button"
                            onClick={() => void handleDeleteNote(selectedNote.id)}
                            disabled={isSaving}
                            className="px-2 py-0.5 text-xs font-semibold text-red-700 dark:text-red-300 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Confirmer
                          </button>
                          <span aria-hidden="true" className="text-red-300 dark:text-red-800">
                            ·
                          </span>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-1.5 py-0.5 text-xs text-slate-600 dark:text-slate-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Annuler
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selectedNote.id)}
                          disabled={isSaving}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-red-50/60 dark:hover:bg-red-950/30 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Supprimer</span>
                        </button>
                      )}

                      <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 mx-1" aria-hidden="true" />

                      <button
                        type="button"
                        onClick={() => void handleSaveNote()}
                        disabled={isSaving || !isDirty}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isDirty
                            ? 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200'
                            : 'bg-slate-100 text-slate-400 dark:bg-slate-900 dark:text-slate-600 cursor-not-allowed'
                        }`}
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{isSaving ? 'Sauvegarde...' : isDirty ? 'Enregistrer' : 'Enregistré'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Feuille d'écriture centrée : largeur optimale (max-w-3xl) pour le confort de lecture */}
                  <div
                    className={`flex-1 flex flex-col w-full mx-auto px-6 sm:px-10 ${
                      isFocusMode ? 'max-w-3xl py-10 sm:py-12' : 'max-w-3xl py-6 sm:py-8'
                    }`}
                  >
                    {/* Champ Titre éditorial */}
                    <div className="pb-3">
                      <label htmlFor="note-title-input" className="sr-only">
                        Titre de la note
                      </label>
                      <input
                        id="note-title-input"
                        ref={titleInputRef}
                        type="text"
                        value={draftTitle}
                        maxLength={VALIDATION_LIMITS.TITLE_MAX_LENGTH}
                        onChange={(e) => {
                          setDraftTitle(e.target.value);
                          setIsDirty(true);
                        }}
                        placeholder="Titre de la note..."
                        className={`w-full font-bold tracking-tight text-slate-900 dark:text-slate-100 bg-transparent border-0 focus:outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700 ${
                          isFocusMode ? 'text-2xl sm:text-3xl' : 'text-xl sm:text-2xl'
                        }`}
                      />
                    </div>

                    {/* Barre de Tags épurée sur une ligne */}
                    <div className="flex flex-wrap items-center gap-2.5 py-2 border-b border-slate-100 dark:border-slate-900 text-xs">
                      <span className="text-slate-400 dark:text-slate-500 inline-flex items-center gap-1">
                        <Hash className="w-3 h-3" />
                        <span>Tags :</span>
                      </span>

                      {draftTags.length === 0 ? (
                        <span className="text-slate-400 dark:text-slate-600">Aucun tag</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          {draftTags.map((tag, idx) => (
                            <React.Fragment key={tag}>
                              {idx > 0 && (
                                <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
                                  ·
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 font-medium">
                                <span>#{tag}</span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveDraftTag(tag)}
                                  aria-label={`Retirer le tag ${tag}`}
                                  className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 p-0.5 cursor-pointer"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            </React.Fragment>
                          ))}
                        </div>
                      )}

                      <form onSubmit={handleAddDraftTag} className="inline-flex items-center gap-1.5 ml-auto">
                        <label htmlFor="add-tag-input" className="sr-only">
                          Ajouter un tag
                        </label>
                        <input
                          id="add-tag-input"
                          type="text"
                          value={newTagInput}
                          maxLength={VALIDATION_LIMITS.TAG_MAX_LENGTH}
                          onChange={(e) => setNewTagInput(e.target.value)}
                          placeholder="+ Ajouter un tag..."
                          className="w-32 sm:w-40 px-2 py-0.5 text-xs bg-transparent border-b border-transparent focus:border-slate-300 dark:focus:border-slate-700 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none transition-colors"
                        />
                        {newTagInput.trim().length > 0 && (
                          <button
                            type="submit"
                            className="px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Ajouter
                          </button>
                        )}
                      </form>
                    </div>

                    {/* Zone de rédaction principale à grand confort visuel */}
                    <div className="flex-1 flex flex-col pt-6">
                      <label htmlFor="note-content-textarea" className="sr-only">
                        Contenu de la note
                      </label>
                      <textarea
                        id="note-content-textarea"
                        ref={contentTextareaRef}
                        value={draftContent}
                        maxLength={VALIDATION_LIMITS.CONTENT_MAX_LENGTH}
                        onChange={(e) => {
                          setDraftContent(e.target.value);
                          setIsDirty(true);
                        }}
                        placeholder="Commencez à rédiger votre note..."
                        className="flex-1 w-full min-h-[420px] resize-none bg-transparent border-0 text-[15px] sm:text-base leading-[1.75] text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-700 focus:outline-none"
                      />
                    </div>

                    {/* Pied d'éditeur sobre (sans exposition de métadonnées techniques backend) */}
                    <div className="pt-4 mt-6 border-t border-slate-100 dark:border-slate-900 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400 dark:text-slate-500 font-mono tabular-nums">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{liveMetrics.word_count} mots</span>
                        <span aria-hidden="true">·</span>
                        <span>{liveMetrics.char_count} caractères</span>
                        <span aria-hidden="true">·</span>
                        <span>~{readingTimeMin} min de lecture</span>
                        {isFocusMode && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-sans text-slate-500 dark:text-slate-400">
                              Mode Focus actif (Échap pour quitter)
                            </span>
                          </>
                        )}
                      </div>
                      <div>
                        {isDirty ? (
                          <span className="text-amber-700 dark:text-amber-400 font-sans font-medium">
                            Modifications non enregistrées · Ctrl+S
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500 font-sans">
                            Enregistré
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

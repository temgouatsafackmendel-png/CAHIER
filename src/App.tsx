/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Application principale Cahier — Prise et Organisation de Notes (v2.0).
 * Conception et Réalisation : Mendel Temgoua.
 *
 * Nouveautés de la mise à jour v2.0 :
 * - Sauvegarde automatique intelligente (Auto-Save) en arrière-plan lors de la frappe.
 * -Barre d'outils d'insertion rapide et Modes d'affichage Éditer / Aperçu structuré / Côte à côte.
 * - Modèles de notes rapides (Templates : Réunion, Projet, Liste de tâches, Journal).
 * - Import JSON & Téléchargement direct d'une note en fichier Markdown (.md).
 * - Mode Focus sans distraction (masque la barre latérale et la liste des notes).
 * - Documentation visuelle complète intégrée avec photos et signature auteur.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Bold,
  BookOpen,
  Check,
  CheckSquare,
  Clock,
  Code,
  Columns,
  Copy,
  Download,
  Edit3,
  Eye,
  FileDown,
  FileText,
  FolderArchive,
  Hash,
  Heading2,
  Italic,
  Layers,
  List,
  Maximize2,
  Minimize2,
  Moon,
  Pin,
  Plus,
  Search,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import {
  CreateNoteInput,
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
type EditorLayoutMode = 'write' | 'split' | 'preview';

const DOC_IMAGES = {
  workspace: '/src/assets/images/doc_workspace_overview_1794873783965.jpg',
  focusMode: '/src/assets/images/doc_focus_mode_editor_1794873783544.jpg',
  architecture: '/src/assets/images/doc_architecture_visual_1794873784327.jpg',
};

interface NoteTemplate {
  id: string;
  label: string;
  title: string;
  tags: string[];
  content: string;
}

const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'meeting',
    label: 'Compte-rendu de réunion',
    title: 'Réunion de synchronisation',
    tags: ['réunion', 'équipe'],
    content: `## Objectifs de la séance
- Faire le point sur l'avancement hebdomadaire
- Identifier les points de blocage

## Décisions validées
- [x] Validation du périmètre fonctionnel
- [ ] Planification des prochaines livraisons

## Actions à suivre
1. Préparer la synthèse
2. Partager le compte-rendu`,
  },
  {
    id: 'project',
    label: 'Fiche Projet',
    title: 'Planification de projet',
    tags: ['projet', 'stratégie'],
    content: `## Vision & Objectif
Décrire en une phrase l'objectif principal et la valeur attendue.

## Étapes clés
- [ ] Phase 1 : Cadrage et conception
- [ ] Phase 2 : Réalisation et vérification
- [ ] Phase 3 : Mise en production

## Notes & Références
> Conserver une trace claire de chaque décision structurante.`,
  },
  {
    id: 'tasks',
    label: 'Liste de tâches prioritaires',
    title: 'Priorités de la semaine',
    tags: ['tâches', 'productivité'],
    content: `## Priorités hautes
- [ ] Finaliser le livrable principal
- [ ] Relire la documentation

## En attente
- [ ] Retour de validation

## Terminé
- [x] Initialisation de l'espace de travail`,
  },
];

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

/**
 * Rendu d'aperçu Markdown léger, sécurisé (100 % composants React natifs, zéro dangerouslySetInnerHTML)
 * avec cases à cocher interactives permettant de cocher/décocher une tâche directement depuis l'aperçu.
 */
function StructuredNotePreview({
  content,
  onToggleChecklistLine,
}: {
  content: string;
  onToggleChecklistLine?: (lineIndex: number) => void;
}) {
  const lines = content.split('\n');

  if (!content.trim()) {
    return (
      <p className="text-sm text-slate-400 dark:text-slate-600 italic">
        Aucun contenu à prévisualiser...
      </p>
    );
  }

  const renderInlineFormatting = (text: string) => {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code
            key={idx}
            className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return (
          <strong key={idx} className="font-semibold text-slate-900 dark:text-slate-100">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
        return (
          <em key={idx} className="italic">
            {part.slice(1, -1)}
          </em>
        );
      }
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  return (
    <div className="space-y-2.5 text-[15px] sm:text-base leading-[1.75] text-slate-800 dark:text-slate-200">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={index} className="h-2" />;
        }

        if (trimmed.startsWith('### ')) {
          return (
            <h4
              key={index}
              className="text-base font-bold text-slate-900 dark:text-slate-100 pt-2"
            >
              {renderInlineFormatting(trimmed.slice(4))}
            </h4>
          );
        }

        if (trimmed.startsWith('## ')) {
          return (
            <h3
              key={index}
              className="text-lg font-bold text-slate-900 dark:text-slate-100 pt-3 pb-1 border-b border-slate-100 dark:border-slate-900"
            >
              {renderInlineFormatting(trimmed.slice(3))}
            </h3>
          );
        }

        if (trimmed.startsWith('# ')) {
          return (
            <h2
              key={index}
              className="text-xl font-bold text-slate-900 dark:text-slate-100 pt-3 pb-1"
            >
              {renderInlineFormatting(trimmed.slice(2))}
            </h2>
          );
        }

        const taskMatch = trimmed.match(/^-\s*\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          const isChecked = taskMatch[1].toLowerCase() === 'x';
          const taskText = taskMatch[2];
          return (
            <div key={index} className="flex items-start gap-2.5 py-0.5">
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => onToggleChecklistLine?.(index)}
                className="mt-1.5 w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-slate-900 focus:ring-0 cursor-pointer"
              />
              <span
                className={
                  isChecked ? 'line-through text-slate-400 dark:text-slate-500' : undefined
                }
              >
                {renderInlineFormatting(taskText)}
              </span>
            </div>
          );
        }

        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <div key={index} className="flex items-start gap-2.5 pl-1">
              <span aria-hidden="true" className="text-slate-400 select-none">
                •
              </span>
              <span>{renderInlineFormatting(trimmed.slice(2))}</span>
            </div>
          );
        }

        if (trimmed.startsWith('> ')) {
          return (
            <blockquote
              key={index}
              className="px-4 py-2 bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-md italic text-slate-600 dark:text-slate-400 text-sm"
            >
              {renderInlineFormatting(trimmed.slice(2))}
            </blockquote>
          );
        }

        return <p key={index}>{renderInlineFormatting(line)}</p>;
      })}
    </div>
  );
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

  // Mode Focus de l'éditeur (masque la barre latérale et la liste des notes)
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

  // Sauvegarde automatique (Auto-Save) activée par défaut
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(true);
  const [editorLayout, setEditorLayout] = useState<EditorLayoutMode>('write');

  // États de navigation et de filtrage
  const [activeView, setActiveView] = useState<WorkspaceView>('notes');
  const [statusFilter, setStatusFilter] = useState<NoteStatusFilter>('active');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<NoteSortOption>('updated_desc');

  // Données chargées selon les actions de l'utilisateur
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
  const importFileInputRef = useRef<HTMLInputElement>(null);

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

  // Création d'une nouvelle note (vierge ou à partir d'un modèle)
  const handleCreateNewNote = async (template?: NoteTemplate) => {
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const defaultTags = template
        ? template.tags
        : selectedTag
          ? [selectedTag]
          : [];
      const created = await notesApi.createNote({
        title: template ? template.title : 'Nouvelle note',
        content: template ? template.content : '',
        tags: defaultTags,
        is_pinned: false,
      });

      if (statusFilter === 'archived') {
        setStatusFilter('active');
      }
      setActiveView('notes');
      await loadNotesData(created.id);
      showTemporaryFeedback(
        template ? `Modèle « ${template.label} » créé.` : 'Nouvelle note créée.'
      );
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

  // Duplication d'une note existante en un clic
  const handleDuplicateNote = async () => {
    if (!selectedNote) return;
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const duplicated = await notesApi.createNote({
        title: `${draftTitle.trim() || selectedNote.title} (Copie)`,
        content: draftContent,
        tags: draftTags,
        is_pinned: false,
      });
      await loadNotesData(duplicated.id);
      showTemporaryFeedback('Note dupliquée avec succès.');
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : 'Impossible de dupliquer la note.';
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  // Sauvegarde des modifications de la note courante
  const handleSaveNote = useCallback(
    async (silent = false) => {
      if (!selectedNoteId) return;
      const trimmedTitle = draftTitle.trim();
      if (!trimmedTitle) {
        if (!silent) {
          setErrorMessage('Le titre de la note ne peut pas être vide.');
        }
        return;
      }

      setIsSaving(true);
      if (!silent) setErrorMessage(null);
      try {
        const updated = await notesApi.updateNote(selectedNoteId, {
          title: trimmedTitle,
          content: draftContent,
          tags: draftTags,
          is_pinned: draftPinned,
        });
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        setIsDirty(false);
        if (!silent) {
          showTemporaryFeedback('Note enregistrée.');
        }
      } catch (err) {
        if (!silent) {
          const message =
            err instanceof ApiClientError
              ? err.message
              : 'Erreur lors de la sauvegarde de la note.';
          setErrorMessage(message);
        }
      } finally {
        setIsSaving(false);
      }
    },
    [selectedNoteId, draftTitle, draftContent, draftTags, draftPinned, showTemporaryFeedback]
  );

  // Sauvegarde automatique (Auto-Save) 1.2s après arrêt de la saisie
  useEffect(() => {
    if (!autoSaveEnabled || !isDirty || !selectedNoteId || !draftTitle.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      void handleSaveNote(true);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoSaveEnabled, isDirty, selectedNoteId, draftTitle, draftContent, draftTags, handleSaveNote]);

  // Raccourcis clavier globaux
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveView('notes');
        setIsFocusMode(false);
        window.setTimeout(() => searchInputRef.current?.focus(), 30);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (activeView === 'notes' && selectedNoteId) {
          e.preventDefault();
          void handleSaveNote(false);
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

  // Insertion rapide de balises Markdown dans la zone de texte
  const insertMarkdownSyntax = (prefix: string, suffix = '', defaultText = 'texte') => {
    const textarea = contentTextareaRef.current;
    if (!textarea) {
      setDraftContent((prev) => `${prev}${prev ? '\n' : ''}${prefix}${defaultText}${suffix}`);
      setIsDirty(true);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = draftContent.slice(start, end) || defaultText;
    const replacement = `${prefix}${selected}${suffix}`;
    const nextContent =
      draftContent.slice(0, start) + replacement + draftContent.slice(end);

    setDraftContent(nextContent);
    setIsDirty(true);

    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length
      );
    }, 20);
  };

  // Cocher / décocher une case directement depuis l'aperçu structuré
  const handleToggleChecklistLine = (lineIndex: number) => {
    const lines = draftContent.split('\n');
    const target = lines[lineIndex];
    if (!target) return;

    if (/^(\s*-\s*)\[ \](.*)$/.test(target)) {
      lines[lineIndex] = target.replace(/^(\s*-\s*)\[ \](.*)$/, '$1[x]$2');
    } else if (/^(\s*-\s*)\[[xX]\](.*)$/.test(target)) {
      lines[lineIndex] = target.replace(/^(\s*-\s*)\[[xX]\](.*)$/, '$1[ ]$2');
    }

    setDraftContent(lines.join('\n'));
    setIsDirty(true);
  };

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

  // Téléchargement de la note active en fichier Markdown (.md)
  const handleDownloadMarkdown = () => {
    if (!selectedNote) return;
    const title = draftTitle.trim() || selectedNote.title;
    const tagsHeader = draftTags.length > 0 ? `Tags: ${draftTags.map((t) => `#${t}`).join(' ')}\n\n` : '';
    const mdContent = `# ${title}\n\n${tagsHeader}${draftContent}\n`;
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeSlug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9àâäéèêëîïôöùûüÿç-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'note';
    a.href = url;
    a.download = `${safeSlug}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showTemporaryFeedback('Note téléchargée au format Markdown (.md).');
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

  // Import d'un fichier JSON de notes
  const handleImportJsonFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setIsSaving(true);
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as { notes?: CreateNoteInput[] } | CreateNoteInput[];
      const items: CreateNoteInput[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.notes)
          ? parsed.notes
          : [];

      if (items.length === 0) {
        throw new Error('Aucune note valide trouvée dans le fichier sélectionné.');
      }

      let importedCount = 0;
      let lastId: string | null = null;
      for (const item of items.slice(0, 50)) {
        if (item && typeof item.title === 'string' && item.title.trim()) {
          const created = await notesApi.createNote({
            title: item.title.trim().slice(0, VALIDATION_LIMITS.TITLE_MAX_LENGTH),
            content: typeof item.content === 'string' ? item.content : '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            is_pinned: Boolean(item.is_pinned),
          });
          lastId = created.id;
          importedCount += 1;
        }
      }

      await loadNotesData(lastId);
      showTemporaryFeedback(`${importedCount} note(s) importée(s) avec succès.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Format de fichier d'import invalide.";
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
      e.target.value = '';
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
        {/* Colonne 1 : Barre latérale de filtres, modèles et tags (Masquée en mode Focus) */}
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

              {/* Modèles rapides (Templates v2.0) */}
              <div>
                <div className="px-2.5 text-xs font-medium text-slate-400 dark:text-slate-500 mb-2">
                  Modèles rapides
                </div>
                <div className="space-y-0.5">
                  {NOTE_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => void handleCreateNewNote(tpl)}
                      disabled={isSaving}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3 opacity-60 shrink-0" />
                      <span className="truncate">{tpl.label}</span>
                    </button>
                  ))}
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
                  <div className="space-y-0.5 max-h-48 overflow-y-auto pr-1">
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

            {/* Pied de barre latérale : Signature auteur & Utilitaires Import/Export */}
            <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800/80 space-y-3">
              <div className="px-1 text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                <div className="font-medium text-slate-700 dark:text-slate-300">
                  Réalisé par Mendel Temgoua
                </div>
                <div className="font-mono tabular-nums text-[11px] text-slate-400 dark:text-slate-500">
                  {stats.total_words} mots rédigés · v2.0
                </div>
              </div>

              <input
                ref={importFileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={(e) => void handleImportJsonFile(e)}
                className="hidden"
              />

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleExportJson()}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Exporter vos notes en JSON"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Exporter</span>
                </button>

                <button
                  type="button"
                  onClick={() => importFileInputRef.current?.click()}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Importer un fichier JSON de notes"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Importer</span>
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
                  <span className="font-mono tabular-nums">Mise à jour v2.0</span>
                </div>

                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
                  Documentation Officielle — Cahier v2.0 (Application de Prise et d’Organisation de Notes)
                </h1>

                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed max-w-3xl">
                  Cahier v2.0 enrichit l’expérience d’écriture avec la sauvegarde automatique en temps réel, l’aperçu structuré avec listes de tâches interactives, les modèles rapides de documents, l’export Markdown individuel et l’import/export JSON complet.
                </p>
              </header>

              {/* Section 1 : Aperçu visuel de l'espace de travail */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  01. Présentation de l’Interface & Nouveautés v2.0
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  L’interface sépare clairement la navigation latérale (vues, modèles rapides, tags), la liste de recherche instantanée et l’éditeur. Aucune donnée artificielle du serveur n’est injectée dans votre espace.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.workspace}
                  alt="Aperçu de l'espace de travail Cahier à 3 colonnes"
                  caption="Figure 1 — Vue d'ensemble de l'espace de travail Cahier (Navigation par tags, Modèles rapides, Liste et Éditeur) — Réalisé par Mendel Temgoua."
                />
              </section>

              {/* Section 2 : Mode Focus sans distraction */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  02. Mode Focus, Auto-Save & Aperçu Côte à Côte
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  Le bouton <strong>« Mode Focus »</strong> (<code className="font-mono text-xs px-1.5 py-0.5 bg-slate-100 dark:bg-slate-900 rounded">Ctrl + \</code>) masque la barre latérale et la liste des notes. La mise à jour v2.0 ajoute trois modes de lecture/écriture (<strong>Écrire</strong>, <strong>Côte à côte</strong>, <strong>Aperçu</strong>) ainsi que la sauvegarde automatique intelligente pendant la frappe.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.focusMode}
                  alt="Mode Focus de l'éditeur Cahier"
                  caption="Figure 2 — Le Mode Focus combiné à la sauvegarde automatique offre un environnement d'écriture plein écran sans distraction — Réalisé par Mendel Temgoua."
                />
              </section>

              {/* Section 3 : Architecture & Séparation Front-End / Back-End */}
              <section className="space-y-4">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  03. Architecture Technique & Isolation des Données
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                  L’architecture garantit que le Front-End reste pur et dédié à l’utilisateur, tandis que le Back-End assure la validation des schémas, la sauvegarde persistante et l’indexation plein texte FTS5.
                </p>
                <ResilientDocImage
                  src={DOC_IMAGES.architecture}
                  alt="Schéma d'architecture 3-tiers de l'application Cahier"
                  caption="Figure 3 — Architecture logicielle en 3 couches (Interface Web Épurée, Couche Validation API, Moteur de recherche plein texte FTS5) — Réalisé par Mendel Temgoua."
                />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Auto-Save & Modèles
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Sauvegarde automatique après chaque saisie et création en un clic à partir de modèles (Réunion, Projet, Tâches).
                    </p>
                  </div>
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Aperçu & Checklists
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Barre d’outils de formatage rapide et mode Aperçu avec cases à cocher interactives.
                    </p>
                  </div>
                  <div className="p-4 border border-slate-200/80 dark:border-slate-800/80 rounded-lg space-y-1.5">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Export .MD & Import JSON
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Téléchargement individuel des notes en Markdown (<code className="font-mono">.md</code>) et import/export global en JSON.
                    </p>
                  </div>
                </div>
              </section>

              {/* Pied de documentation avec signature de l'auteur */}
              <footer className="pt-6 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
                <div>
                  Auteur & Architecte du projet :{' '}
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
                            : 'Créez une note vierge ou utilisez un modèle rapide dans la barre latérale.'}
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

            {/* Colonne 3 : Éditeur professionnel v2.0 avec Mode Focus, Barre de formatage et Aperçu */}
            <main
              aria-label="Éditeur de note"
              className="flex-1 bg-white dark:bg-slate-950 flex flex-col overflow-y-auto"
            >
              {!selectedNote ? (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                  <FileText className="w-7 h-7 text-slate-300 dark:text-slate-700 mb-3" />
                  <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    Prêt à rédiger (Mise à jour v2.0)
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mt-1 mb-5">
                    Créez une note vierge, démarrez à partir d’un modèle structuré ou consultez la documentation complète.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
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
                      <span>Nouvelle note vierge</span>
                    </button>
                    {NOTE_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => void handleCreateNewNote(tpl)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 opacity-70" />
                        <span>{tpl.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col w-full">
                  {/* Barre d'outils supérieure de l'éditeur */}
                  <div className="px-6 lg:px-10 py-2.5 border-b border-slate-200/70 dark:border-slate-800/70 flex flex-wrap items-center justify-between gap-4 shrink-0">
                    {/* Gauche : Bouton Mode Focus + Sélecteur Écrire / Côte à côte / Aperçu + Horodatage */}
                    <div className="flex flex-wrap items-center gap-2.5">
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
                            <span>Quitter Focus</span>
                          </>
                        ) : (
                          <>
                            <Maximize2 className="w-3.5 h-3.5" />
                            <span>Mode Focus</span>
                          </>
                        )}
                      </button>

                      {/* Sélecteur segmenté de mode d'édition */}
                      <div className="inline-flex items-center p-0.5 bg-slate-100 dark:bg-slate-900 rounded-md border border-slate-200/80 dark:border-slate-800">
                        <button
                          type="button"
                          onClick={() => setEditorLayout('write')}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            editorLayout === 'write'
                              ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                              : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Écrire</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditorLayout('split')}
                          className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            editorLayout === 'split'
                              ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                              : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <Columns className="w-3 h-3" />
                          <span>Côte à côte</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditorLayout('preview')}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            editorLayout === 'preview'
                              ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                              : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <Eye className="w-3 h-3" />
                          <span>Aperçu</span>
                        </button>
                      </div>

                      <div className="hidden xl:flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 font-mono tabular-nums">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span>Modifiée le {formatExactDateTime(selectedNote.updated_at)}</span>
                      </div>
                    </div>

                    {/* Droite : Actions sur la note (Épingler, Dupliquer, Export .md, Archiver, Supprimer, Enregistrer) */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleTogglePin()}
                        disabled={isSaving}
                        className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          draftPinned
                            ? 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100'
                            : 'border-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900'
                        }`}
                        title={draftPinned ? 'Désépingler la note' : 'Épingler en haut de liste'}
                      >
                        <Pin className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">{draftPinned ? 'Épinglée' : 'Épingler'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleDuplicateNote()}
                        disabled={isSaving}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        title="Dupliquer cette note"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span className="hidden md:inline">Dupliquer</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadMarkdown}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        title="Télécharger la note au format Markdown (.md)"
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        <span className="hidden md:inline">.md</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleToggleArchive(selectedNote)}
                        disabled={isSaving}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {selectedNote.is_archived ? (
                          <>
                            <ArchiveRestore className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Restaurer</span>
                          </>
                        ) : (
                          <>
                            <Archive className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Archiver</span>
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
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-red-50/60 dark:hover:bg-red-950/30 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          title="Supprimer la note"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Supprimer</span>
                        </button>
                      )}

                      <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 mx-1" aria-hidden="true" />

                      <button
                        type="button"
                        onClick={() => void handleSaveNote(false)}
                        disabled={isSaving || !isDirty}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
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

                  {/* Feuille d'écriture centrée */}
                  <div
                    className={`flex-1 flex flex-col w-full mx-auto px-6 sm:px-10 ${
                      editorLayout === 'split'
                        ? 'max-w-6xl py-6 sm:py-8'
                        : isFocusMode
                          ? 'max-w-3xl py-10 sm:py-12'
                          : 'max-w-3xl py-6 sm:py-8'
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

                    {/* Barre d'insertion rapide Markdown (affichée en mode Écrire ou Côte à côte) */}
                    {editorLayout !== 'preview' && (
                      <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-slate-100 dark:border-slate-900 text-xs text-slate-500">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('## ', '', 'Sous-titre')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Insérer un sous-titre"
                          >
                            <Heading2 className="w-3.5 h-3.5" />
                            <span>Titre</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('**', '**', 'texte en gras')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Gras"
                          >
                            <Bold className="w-3.5 h-3.5" />
                            <span>Gras</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('*', '*', 'italique')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Italique"
                          >
                            <Italic className="w-3.5 h-3.5" />
                            <span>Italique</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('\n- [ ] ', '', 'Nouvelle tâche')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Insérer une case à cocher"
                          >
                            <CheckSquare className="w-3.5 h-3.5" />
                            <span>Tâche</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('\n- ', '', 'Élément de liste')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Liste à puces"
                          >
                            <List className="w-3.5 h-3.5" />
                            <span>Liste</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => insertMarkdownSyntax('`', '`', 'code')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 transition-colors cursor-pointer"
                            title="Code en ligne"
                          >
                            <Code className="w-3.5 h-3.5" />
                            <span>Code</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => setAutoSaveEnabled((prev) => !prev)}
                          className="text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                          title="Activer ou désactiver la sauvegarde automatique pendant la frappe"
                        >
                          Auto-Save : {autoSaveEnabled ? 'Activé' : 'Manuel'}
                        </button>
                      </div>
                    )}

                    {/* Zone principale : Écrire / Côte à côte / Aperçu */}
                    <div
                      className={`flex-1 pt-6 ${
                        editorLayout === 'split'
                          ? 'grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch'
                          : 'flex flex-col'
                      }`}
                    >
                      {(editorLayout === 'write' || editorLayout === 'split') && (
                        <div className="flex-1 flex flex-col">
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
                            placeholder="Commencez à rédiger votre note (Markdown supporté : ## Titres, **gras**, - [ ] tâches)..."
                            className="flex-1 w-full min-h-[420px] resize-none bg-transparent border-0 text-[15px] sm:text-base leading-[1.75] text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-700 focus:outline-none"
                          />
                        </div>
                      )}

                      {(editorLayout === 'preview' || editorLayout === 'split') && (
                        <div
                          className={`flex-1 min-h-[420px] ${
                            editorLayout === 'split'
                              ? 'lg:border-l lg:border-slate-200/80 dark:lg:border-slate-800/80 lg:pl-8'
                              : ''
                          }`}
                        >
                          <StructuredNotePreview
                            content={draftContent}
                            onToggleChecklistLine={handleToggleChecklistLine}
                          />
                        </div>
                      )}
                    </div>

                    {/* Pied d'éditeur sobre */}
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
                        {isSaving ? (
                          <span className="text-slate-500 dark:text-slate-400 font-sans">
                            Sauvegarde automatique...
                          </span>
                        ) : isDirty ? (
                          <span className="text-amber-700 dark:text-amber-400 font-sans font-medium">
                            Modifications en attente · Ctrl+S
                          </span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500 font-sans">
                            Enregistré · Réalisé par Mendel Temgoua
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

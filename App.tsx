import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { MAX_TEXT_CHUNK_SIZE, TTS_MODEL, TTS_SAMPLE_RATE, VOICE_OPTIONS, VOICE_PREVIEW_TEXT } from './constants';
import {
  AudiobookConfig,
  AudioGenerationStatus,
  BookMeta,
  ExtractionStatus,
  PdfChapter,
  VoiceGender,
  HistoryBook,
} from './types';

import { decodeBase64, createWavBlob } from './utils/audioUtils';

// Global reference for PDF.js provided by the script tag in index.html
declare const pdfjsLib: any;

/**
 * =========================
 * IndexedDB History (no backend)
 * Stores metadata + per-chapter WAV blobs so users can download later
 * =========================
 */
const DB_NAME = 'indivoice_history_db';
const DB_VERSION = 1;
const STORE_NAME = 'books';

type StoredBook = {
  meta: BookMeta;
  // Each chapter stores audio blob optionally (structured clone supports Blob)
  chapters: Array<{
    id: string;
    title: string;
    startPage: number;
    endPage: number;
    audioBlob?: Blob;
    createdAt: number;
  }>;
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'meta.id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutBook(book: StoredBook): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllBooks(): Promise<StoredBook[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteBook(bookId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // keyPath is meta.id, so we delete by full key by scanning
    const getReq = store.getAll();
    getReq.onsuccess = () => {
      const all = getReq.result || [];
      const match = all.find((b: StoredBook) => b.meta.id === bookId);
      if (!match) {
        resolve();
        return;
      }

      // Delete requires key — since keyPath is meta.id, this works:
      const delReq = store.delete(bookId as any);
      delReq.onsuccess = () => resolve();
      delReq.onerror = () => reject(delReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

function safeFileName(input: string) {
  return input
    .replace(/\.pdf$/i, '')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowId() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/**
 * =========================
 * Chapter Detection
 * 1) Use PDF outline if available
 * 2) Fallback to heuristics scanning first text on each page
 * =========================
 */

type OutlineItem = {
  title: string;
  dest?: any;
  items?: OutlineItem[];
};

async function outlineToChapters(pdf: any, totalPages: number): Promise<Array<{ title: string; startPage: number }>> {
  try {
    const outline: OutlineItem[] | null = await pdf.getOutline();
    if (!outline || outline.length === 0) return [];

    const flat: Array<{ title: string; startPage: number }> = [];

    async function resolveDestToPage(dest: any): Promise<number | null> {
      try {
        let destination = dest;
        if (typeof dest === 'string') {
          destination = await pdf.getDestination(dest);
        }
        if (!destination || !Array.isArray(destination)) return null;

        const ref = destination[0];
        const pageIndex = await pdf.getPageIndex(ref);
        return pageIndex + 1; // convert to 1-based
      } catch {
        return null;
      }
    }

    async function walk(items: OutlineItem[]) {
      for (const it of items) {
        const title = (it.title || '').trim();
        if (it.dest) {
          const p = await resolveDestToPage(it.dest);
          if (p && p >= 1 && p <= totalPages && title) {
            flat.push({ title, startPage: p });
          }
        }
        if (it.items && it.items.length) {
          await walk(it.items);
        }
      }
    }

    await walk(outline);

    // Clean + sort + unique by startPage
    const sorted = flat
      .filter(x => x.title && x.startPage)
      .sort((a, b) => a.startPage - b.startPage);

    const unique: Array<{ title: string; startPage: number }> = [];
    const seenPages = new Set<number>();
    for (const item of sorted) {
      if (!seenPages.has(item.startPage)) {
        unique.push(item);
        seenPages.add(item.startPage);
      }
    }

    // If outline has only 1 item, it might be useless (whole doc)
    if (unique.length < 2) return [];

    return unique;
  } catch {
    return [];
  }
}

function heuristicChaptersFromPages(pageTexts: string[], totalPages: number) {
  const candidates: Array<{ title: string; startPage: number }> = [];

  const patterns = [
    /\bchapter\s+\d+\b/i,
    /\bchapter\s+[ivxlcdm]+\b/i,
    /\bsection\s+\d+(\.\d+)?\b/i,
    /^\s*\d+\.\s+[A-Z]/m,
    /^\s*[IVXLCDM]+\.\s+[A-Z]/m,
  ];

  for (let p = 1; p <= totalPages; p++) {
    const t = (pageTexts[p - 1] || '').trim();
    if (!t) continue;

    const head = t.slice(0, 800);

    let matchedTitle: string | null = null;

    // Prefer explicit CHAPTER/SECTION hits
    for (const pat of patterns) {
      const m = head.match(pat);
      if (m) {
        // Title guess: take first ~80 chars around match
        const idx = head.toLowerCase().indexOf(m[0].toLowerCase());
        const start = Math.max(0, idx - 10);
        const end = Math.min(head.length, idx + 80);
        matchedTitle = head.slice(start, end).replace(/\s+/g, ' ').trim();
        break;
      }
    }

    // Additional: if the first line is short & capital-ish, treat as heading
    if (!matchedTitle) {
      const firstLine = head.split('\n')[0]?.trim() || '';
      if (firstLine.length >= 6 && firstLine.length <= 60) {
        const capsRatio = firstLine.replace(/[^A-Z]/g, '').length / Math.max(1, firstLine.replace(/[^A-Za-z]/g, '').length);
        if (capsRatio > 0.6) matchedTitle = firstLine;
      }
    }

    if (matchedTitle) {
      candidates.push({ title: matchedTitle, startPage: p });
    }
  }

  // Deduplicate + sort
  const sorted = candidates.sort((a, b) => a.startPage - b.startPage);
  const filtered: Array<{ title: string; startPage: number }> = [];
  let lastPage = -999;

  for (const c of sorted) {
    // avoid too-close chapters (noise). keep at least 2 pages gap.
    if (c.startPage - lastPage >= 2) {
      filtered.push(c);
      lastPage = c.startPage;
    }
  }

  // If too many, cap
  return filtered.slice(0, 50);
}

function buildChaptersWithRanges(
  starts: Array<{ title: string; startPage: number }>,
  totalPages: number
): Array<{ title: string; startPage: number; endPage: number }> {
  const sorted = [...starts].sort((a, b) => a.startPage - b.startPage);

  // Ensure startPage is within bounds
  const valid = sorted.filter(s => s.startPage >= 1 && s.startPage <= totalPages);

  // If no chapters found -> single
  if (valid.length === 0) {
    return [{ title: 'Full Document', startPage: 1, endPage: totalPages }];
  }

  // If first chapter doesn't start at 1, add Front Matter
  if (valid[0].startPage > 1) {
    valid.unshift({ title: 'Front Matter / Preface', startPage: 1 });
  }

  const chapters = valid.map((c, idx) => {
    const next = valid[idx + 1];
    const endPage = next ? Math.max(c.startPage, next.startPage - 1) : totalPages;
    return {
      title: c.title || `Chapter ${idx + 1}`,
      startPage: c.startPage,
      endPage,
    };
  });

  // Remove empty ranges
  return chapters.filter(ch => ch.endPage >= ch.startPage);
}

function buildChapterText(pageTexts: string[], startPage: number, endPage: number) {
  const chunks: string[] = [];
  for (let p = startPage; p <= endPage; p++) {
    const t = pageTexts[p - 1] || '';
    chunks.push(t);
  }
  return chunks.join('\n\n');
}

/**
 * =========================
 * App
 * =========================
 */
const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);

  // PDF extraction state
  const [extraction, setExtraction] = useState<ExtractionStatus>({
    totalPageCount: 0,
    currentPage: 0,
    text: '',
    status: 'idle',
  });

  const pageTextsRef = useRef<string[]>([]);
  const [chapters, setChapters] = useState<PdfChapter[]>([]);

  const [bookMeta, setBookMeta] = useState<BookMeta | null>(null);

  // Voice config
  const [config, setConfig] = useState<AudiobookConfig>({
    voiceId: VOICE_OPTIONS[1].id, // Aditi (Warm)
    speed: 1.0,
    quality: 'high',
  });

  // Overall generation status
  const [generation, setGeneration] = useState<AudioGenerationStatus>({
    progress: 0,
    status: 'idle',
  });

  // Voice preview
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null);
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false);

  // History
  const [history, setHistory] = useState<HistoryBook[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // UI refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);

  // Cancel refs
  const cancelAllRef = useRef(false);
  const cancelChapterIdsRef = useRef<Set<string>>(new Set());

  // Gemini client
  const aiRef = useRef<GoogleGenAI | null>(null);

  useEffect(() => {
    // Initialize PDF.js worker using a compatible version URL
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }, []);

  // Load history on mount
  useEffect(() => {
    (async () => {
      try {
        setHistoryLoading(true);
        const all = await idbGetAllBooks();
        const mapped: HistoryBook[] = all
          .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
          .map(b => ({
            meta: b.meta,
            chapters: b.chapters.map(ch => ({
              id: ch.id,
              title: ch.title,
              startPage: ch.startPage,
              endPage: ch.endPage,
              hasAudio: !!ch.audioBlob,
            })),
          }));
        setHistory(mapped);
      } catch (e) {
        console.error('Failed to load history:', e);
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, []);

  const selectedVoice = useMemo(() => VOICE_OPTIONS.find(v => v.id === config.voiceId), [config.voiceId]);

  function ensureAiClient() {
    if (!aiRef.current) {
      aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
    }
    return aiRef.current!;
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      // Reset
      cancelAllRef.current = false;
      cancelChapterIdsRef.current = new Set();

      setFile(selectedFile);
      setVoicePreviewUrl(null);

      setChapters([]);
      pageTextsRef.current = [];

      setGeneration({ status: 'idle', progress: 0 });
      setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'idle' });

      await extractPdfAndDetectChapters(selectedFile);
    }
  };

  async function extractPdfAndDetectChapters(pdfFile: File) {
    if (typeof pdfjsLib === 'undefined') {
      setExtraction(prev => ({ ...prev, status: 'error' }));
      console.error('PDF.js not loaded yet.');
      return;
    }

    setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'processing' });

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      // Metadata
      let titleGuess = safeFileName(pdfFile.name);
      let authorGuess = '';

      try {
        const meta = await pdf.getMetadata();
        const info = meta?.info || {};
        const md = meta?.metadata || null;

        const t1 = (info.Title || '').toString().trim();
        const a1 = (info.Author || '').toString().trim();
        const t2 = md?.get?.('dc:title') || '';
        const a2 = md?.get?.('dc:creator') || '';

        titleGuess = (t1 || t2 || titleGuess).toString().trim();
        authorGuess = (a1 || a2 || '').toString().trim();
      } catch {
        // ignore metadata errors
      }

      setExtraction(prev => ({ ...prev, totalPageCount: pdf.numPages }));

      const perPageTexts: string[] = [];
      let fullText = '';

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();

        // Join items into one page text
        const pageText = (content.items || [])
          .map((item: any) => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        perPageTexts.push(pageText);
        fullText += pageText + '\n\n';

        setExtraction(prev => ({
          ...prev,
          currentPage: i,
          text: fullText,
          status: 'processing',
        }));
      }

      pageTextsRef.current = perPageTexts;

      // Detect chapters
      const outlineStarts = await outlineToChapters(pdf, pdf.numPages);
      const starts = outlineStarts.length ? outlineStarts : heuristicChaptersFromPages(perPageTexts, pdf.numPages);

      const ranged = buildChaptersWithRanges(starts, pdf.numPages);

      const initialChapters: PdfChapter[] = ranged.map((c, idx) => ({
        id: `ch_${idx + 1}_${c.startPage}_${c.endPage}`,
        title: c.title || `Chapter ${idx + 1}`,
        startPage: c.startPage,
        endPage: c.endPage,
        selected: true,
        status: 'pending',
        progress: 0,
      }));

      setChapters(initialChapters);

      const meta: BookMeta = {
        id: nowId(),
        fileName: pdfFile.name,
        title: titleGuess || safeFileName(pdfFile.name),
        author: authorGuess || '',
        totalPages: pdf.numPages,
        createdAt: Date.now(),
      };
      setBookMeta(meta);

      // Save base book to history (no audio yet)
      const baseStored: StoredBook = {
        meta,
        chapters: initialChapters.map(ch => ({
          id: ch.id,
          title: ch.title,
          startPage: ch.startPage,
          endPage: ch.endPage,
          createdAt: Date.now(),
        })),
      };
      await idbPutBook(baseStored);

      // Refresh history list
      const all = await idbGetAllBooks();
      const mapped: HistoryBook[] = all
        .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
        .map(b => ({
          meta: b.meta,
          chapters: b.chapters.map(ch => ({
            id: ch.id,
            title: ch.title,
            startPage: ch.startPage,
            endPage: ch.endPage,
            hasAudio: !!ch.audioBlob,
          })),
        }));
      setHistory(mapped);

      setExtraction(prev => ({
        ...prev,
        status: 'completed',
      }));
    } catch (error) {
      console.error('PDF Extraction Error:', error);
      setExtraction(prev => ({ ...prev, status: 'error' }));
    }
  }

  function toggleSelectAll(selectAll: boolean) {
    setChapters(prev =>
      prev.map(ch => ({
        ...ch,
        selected: selectAll,
      }))
    );
  }

  function toggleChapterSelected(chapterId: string) {
    setChapters(prev =>
      prev.map(ch => (ch.id === chapterId ? { ...ch, selected: !ch.selected } : ch))
    );
  }

  function skipChapter(chapterId: string) {
    // "Cancel/Skip" chapter even before it runs
    cancelChapterIdsRef.current.add(chapterId);
    setChapters(prev =>
      prev.map(ch =>
        ch.id === chapterId
          ? { ...ch, selected: false, status: 'skipped', progress: 0 }
          : ch
      )
    );
  }

  function cancelAll() {
    cancelAllRef.current = true;

    // Mark all selected chapters as cancelled (or keep completed)
    setChapters(prev =>
      prev.map(ch => {
        if (ch.status === 'completed') return ch;
        return ch.selected ? { ...ch, status: 'cancelled', progress: 0 } : ch;
      })
    );

    setGeneration(prev => ({
      ...prev,
      status: 'cancelled',
      error: 'Cancelled by user',
    }));
  }

  async function previewSelectedVoice() {
    if (!selectedVoice) return;
    if (!process.env.API_KEY) {
      alert('API_KEY is missing. Please add it in Vercel Environment Variables.');
      return;
    }

    setVoicePreviewLoading(true);
    try {
      const ai = ensureAiClient();

      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: VOICE_PREVIEW_TEXT }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: selectedVoice.geminiVoice,
              },
            },
          },
        },
      });

      const part = response.candidates?.[0]?.content?.parts?.[0];
      const base64Audio = (part as any)?.inlineData?.data;

      if (!base64Audio) throw new Error('No preview audio returned.');

      const audioBytes = decodeBase64(base64Audio);
      const pcmData = new Int16Array(audioBytes.buffer);

      const wavBlob = createWavBlob(pcmData, TTS_SAMPLE_RATE);
      const url = URL.createObjectURL(wavBlob);

      setVoicePreviewUrl(url);

      setTimeout(() => {
        if (previewAudioRef.current) {
          previewAudioRef.current.playbackRate = clamp(config.speed, 0.7, 1.3);
          previewAudioRef.current.play().catch(() => {});
        }
      }, 50);
    } catch (e: any) {
      console.error('Voice preview failed:', e);
      alert(e?.message || 'Voice preview failed');
    } finally {
      setVoicePreviewLoading(false);
    }
  }

  async function generateAudiobookChapters() {
    if (!bookMeta) return;
    if (!process.env.API_KEY) {
      alert('API_KEY is missing. Please add it in Vercel Environment Variables.');
      return;
    }

    const selected = chapters.filter(ch => ch.selected);

    if (selected.length === 0) {
      alert('Please select at least one chapter.');
      return;
    }

    cancelAllRef.current = false;
    cancelChapterIdsRef.current = new Set();

    // Reset statuses for selected chapters that aren't completed
    setChapters(prev =>
      prev.map(ch => {
        if (!ch.selected) return ch;
        if (ch.status === 'completed') return ch;
        return { ...ch, status: 'pending', progress: 0, error: undefined, audioUrl: undefined };
      })
    );

    setGeneration({
      status: 'generating',
      progress: 0,
      currentChapterTitle: selected[0]?.title,
    });

    try {
      const ai = ensureAiClient();
      const voice = VOICE_OPTIONS.find(v => v.id === config.voiceId);
      if (!voice) throw new Error('Selected voice not found');

      // Load stored book so we can update chapter blobs progressively
      const allBooks = await idbGetAllBooks();
      const storedBook = allBooks.find(b => b.meta.id === bookMeta.id);
      if (!storedBook) throw new Error('History store not initialized for this book.');

      const totalToProcess = selected.length;
      let doneCount = 0;

      for (const ch of selected) {
        if (cancelAllRef.current) break;
        if (cancelChapterIdsRef.current.has(ch.id)) {
          // already skipped
          doneCount++;
          continue;
        }

        setGeneration(prev => ({ ...prev, currentChapterTitle: ch.title }));

        // Mark chapter generating
        setChapters(prev =>
          prev.map(c => (c.id === ch.id ? { ...c, status: 'generating', progress: 0 } : c))
        );

        const chapterText = buildChapterText(pageTextsRef.current, ch.startPage, ch.endPage).trim();
        if (!chapterText) {
          setChapters(prev =>
            prev.map(c => (c.id === ch.id ? { ...c, status: 'error', error: 'Chapter text empty' } : c))
          );
          doneCount++;
          continue;
        }

        try {
          // Split into chunks to avoid request size limits
          const textChunks: string[] = [];
          for (let i = 0; i < chapterText.length; i += MAX_TEXT_CHUNK_SIZE) {
            textChunks.push(chapterText.slice(i, i + MAX_TEXT_CHUNK_SIZE));
          }

          const audioChunks: Uint8Array[] = [];

          for (let i = 0; i < textChunks.length; i++) {
            if (cancelAllRef.current) throw new Error('CANCELLED_ALL');
            if (cancelChapterIdsRef.current.has(ch.id)) throw new Error('CANCELLED_CHAPTER');

            const chunkText = textChunks[i];

            const response = await ai.models.generateContent({
              model: TTS_MODEL,
              contents: [{ parts: [{ text: chunkText }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voice.geminiVoice,
                    },
                  },
                },
              },
            });

            const part = response.candidates?.[0]?.content?.parts?.[0];
            const base64Audio = (part as any)?.inlineData?.data;

            if (!base64Audio) throw new Error('No audio returned from Gemini');

            const audioBytes = decodeBase64(base64Audio);
            audioChunks.push(audioBytes);

            const chapterProgress = Math.round(((i + 1) / textChunks.length) * 100);

            setChapters(prev =>
              prev.map(c => (c.id === ch.id ? { ...c, progress: chapterProgress } : c))
            );
          }

          // Combine audio chunks
          const totalBytes = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const combined = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of audioChunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }

          // Ensure even length for Int16Array
          const evenCombined = combined.byteLength % 2 === 0 ? combined : combined.slice(0, combined.byteLength - 1);

          const pcmData = new Int16Array(evenCombined.buffer);
          const wavBlob = createWavBlob(pcmData, TTS_SAMPLE_RATE);

          const audioUrl = URL.createObjectURL(wavBlob);

          // Mark chapter complete in UI
          setChapters(prev =>
            prev.map(c =>
              c.id === ch.id ? { ...c, status: 'completed', progress: 100, audioUrl } : c
            )
          );

          // Save chapter blob to history (so it appears in History even after refresh)
          const storedChapter = storedBook.chapters.find(sc => sc.id === ch.id);
          if (storedChapter) {
            storedChapter.audioBlob = wavBlob;
          }

          await idbPutBook(storedBook);

          // Refresh history UI
          const all = await idbGetAllBooks();
          const mapped: HistoryBook[] = all
            .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
            .map(b => ({
              meta: b.meta,
              chapters: b.chapters.map(cc => ({
                id: cc.id,
                title: cc.title,
                startPage: cc.startPage,
                endPage: cc.endPage,
                hasAudio: !!cc.audioBlob,
              })),
            }));
          setHistory(mapped);

          doneCount++;
          const overall = Math.round((doneCount / totalToProcess) * 100);

          setGeneration(prev => ({
            ...prev,
            progress: overall,
          }));
        } catch (err: any) {
          if (err?.message === 'CANCELLED_ALL') {
            setChapters(prev =>
              prev.map(c => (c.id === ch.id ? { ...c, status: 'cancelled', progress: 0 } : c))
            );
            break;
          }

          if (err?.message === 'CANCELLED_CHAPTER') {
            setChapters(prev =>
              prev.map(c => (c.id === ch.id ? { ...c, status: 'cancelled', progress: 0 } : c))
            );
            doneCount++;
            continue;
          }

          console.error('Chapter generation failed:', err);

          setChapters(prev =>
            prev.map(c =>
              c.id === ch.id
                ? { ...c, status: 'error', error: err?.message || 'Failed', progress: 0 }
                : c
            )
          );

          doneCount++;
          const overall = Math.round((doneCount / totalToProcess) * 100);
          setGeneration(prev => ({ ...prev, progress: overall }));
        }
      }

      if (cancelAllRef.current) {
        setGeneration(prev => ({
          ...prev,
          status: 'cancelled',
          error: 'Cancelled by user',
        }));
        return;
      }

      setGeneration(prev => ({
        ...prev,
        status: 'completed',
        progress: 100,
      }));
    } catch (e: any) {
      console.error('Audiobook generation failed:', e);
      setGeneration({
        status: 'error',
        progress: 0,
        error: e?.message || 'Something went wrong',
      });
    }
  }

  function downloadChapter(ch: PdfChapter) {
    if (!ch.audioUrl) return;
    const bookName = bookMeta?.title || safeFileName(file?.name || 'audiobook');
    const fileName = `${safeFileName(bookName)} - ${safeFileName(ch.title)}.wav`;

    const link = document.createElement('a');
    link.href = ch.audioUrl;
    link.download = fileName;
    link.click();
  }

  function downloadAllCompletedChapters() {
    const completed = chapters.filter(c => c.status === 'completed' && c.audioUrl);
    if (completed.length === 0) {
      alert('No completed chapters to download yet.');
      return;
    }

    // Trigger sequential downloads (browser may ask for permission)
    for (const ch of completed) {
      downloadChapter(ch);
    }
  }

  async function downloadHistoryChapter(bookId: string, chapterId: string) {
    try {
      const all = await idbGetAllBooks();
      const book = all.find(b => b.meta.id === bookId);
      if (!book) return;

      const ch = book.chapters.find(c => c.id === chapterId);
      if (!ch || !ch.audioBlob) return;

      const url = URL.createObjectURL(ch.audioBlob);

      const bookName = book.meta.title || safeFileName(book.meta.fileName);
      const fileName = `${safeFileName(bookName)} - ${safeFileName(ch.title)}.wav`;

      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
    } catch (e) {
      console.error('History download failed:', e);
      alert('Failed to download from history.');
    }
  }

  async function deleteHistoryBook(bookId: string) {
    if (!confirm('Delete this book from history? This cannot be undone.')) return;
    try {
      await idbDeleteBook(bookId);
      const all = await idbGetAllBooks();
      const mapped: HistoryBook[] = all
        .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
        .map(b => ({
          meta: b.meta,
          chapters: b.chapters.map(cc => ({
            id: cc.id,
            title: cc.title,
            startPage: cc.startPage,
            endPage: cc.endPage,
            hasAudio: !!cc.audioBlob,
          })),
        }));
      setHistory(mapped);
    } catch (e) {
      console.error('Delete history failed:', e);
      alert('Failed to delete.');
    }
  }

  const selectedCount = useMemo(() => chapters.filter(c => c.selected).length, [chapters]);
  const completedCount = useMemo(() => chapters.filter(c => c.status === 'completed').length, [chapters]);

  return (
    <div className="min-h-screen flex

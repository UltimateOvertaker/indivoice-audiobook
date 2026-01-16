import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { FALLBACK_SECTION_PAGES, MAX_TEXT_CHUNK_SIZE, VOICE_OPTIONS, VOICE_PREVIEW_TEXT } from './constants';
import {
  AudiobookConfig,
  AudioGenerationStatus,
  Chapter,
  ChapterStatus,
  ExtractionStatus,
  TextSegment,
  VoiceGender,
  VoicePreviewStatus,
} from './types';
import { createMp3Blob, createSilencePCM, decodeBase64 } from './utils/audioUtils';

// PDF.js global (loaded by script in index.html)
declare const pdfjsLib: any;

const SAMPLE_RATE = 24000;

function sanitizeFilenamePart(input: string): string {
  return input
    .replace(/[^a-z0-9\- _]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim();
}

function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let idx = 0;

  while (idx < clean.length) {
    let chunk = clean.slice(idx, idx + maxChunkSize);

    // end on sentence boundary when possible
    if (idx + maxChunkSize < clean.length) {
      const lastStop = Math.max(chunk.lastIndexOf('.'), chunk.lastIndexOf('!'), chunk.lastIndexOf('?'));
      if (lastStop > maxChunkSize * 0.65) {
        chunk = chunk.slice(0, lastStop + 1);
      }
    }

    chunks.push(chunk);
    idx += chunk.length;
  }

  return chunks;
}

/** Detect "meta/citation" blocks like author/source lines */
function isMetaBlock(block: string): boolean {
  const b = block.trim();
  if (!b) return false;

  const lines = b
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // common patterns
  const hasYear = /\b(1[6-9]\d{2}|20\d{2})\b/.test(b);
  const hasDateWord =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(b);
  const hasCitationWords =
    /\b(autobiography|foreword|preface|introduction|prologue|epilogue|afterword|edition|translated|copyright|volume|vol\.)\b/i.test(b);

  const manyShortLines = lines.length >= 2 && lines.length <= 6 && lines.filter((l) => l.length <= 65).length >= Math.ceil(lines.length * 0.75);
  const avgLen = lines.length > 0 ? lines.reduce((a, l) => a + l.length, 0) / lines.length : 999;

  if (manyShortLines && (hasYear || hasDateWord || hasCitationWords)) return true;
  if (avgLen < 55 && (hasYear || hasDateWord)) return true;

  if (b.length < 140 && /\b(last sentence of|from the|taken from|source:)\b/i.test(b)) return true;

  return false;
}

/** Build smart narration segments */
function buildSmartSegments(text: string): TextSegment[] {
  const normalized = normalizeExtractedText(text);
  const blocks = normalized
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length === 0) return [];

  return blocks.map((block) => ({
    type: isMetaBlock(block) ? 'meta' : 'narration',
    text: block,
  }));
}

/** Chapter detection helpers */
function getHeadingFromPage(pageText: string): string | null {
  const head = pageText.slice(0, 1800);
  const lines = head
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30);

  const patterns: RegExp[] = [
    /^(chapter|chap\.?|ch\.?|section|part)\s+([0-9ivxlcdm]+)\b\s*[:.\-–—]?\s*(.{0,80})$/i,
    /^(preface|foreword|introduction|prologue|epilogue|afterword|acknowledgements|acknowledgments)\b.*$/i,
    /^(\d{1,3})\s*[\.-]\s*(.{3,80})$/,
  ];

  for (const line of lines) {
    if (/^\d{1,4}$/.test(line)) continue;
    if (line.length < 4) continue;
    for (const re of patterns) {
      if (re.test(line)) return line.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function detectChaptersFromPages(pagesText: string[]): Chapter[] {
  const totalPages = pagesText.length;
  const markers: Array<{ page: number; title: string }> = [];

  for (let i = 0; i < totalPages; i++) {
    const heading = getHeadingFromPage(pagesText[i] ?? '');
    if (heading) markers.push({ page: i + 1, title: heading });
  }

  // de-dupe consecutive identical headings
  const deduped: Array<{ page: number; title: string }> = [];
  for (const m of markers) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.title.toLowerCase() !== m.title.toLowerCase()) {
      deduped.push(m);
    }
  }

  const usable = deduped.filter((m, idx, arr) => {
    const prev = arr[idx - 1];
    if (!prev) return true;
    return m.page - prev.page >= 2;
  });

  const chapters: Chapter[] = [];

  if (usable.length >= 2) {
    for (let i = 0; i < usable.length; i++) {
      const startPage = usable[i].page;
      const endPage = i < usable.length - 1 ? usable[i + 1].page - 1 : totalPages;
      if (endPage < startPage) continue;

      const text = pagesText.slice(startPage - 1, endPage).join('\n\n').trim();
      if (!text) continue;

      chapters.push({
        id: `ch_${startPage}_${endPage}`,
        title: usable[i].title,
        startPage,
        endPage,
        text,
        selected: true,
        status: 'pending',
        progress: 0,
      });
    }
  } else {
    // fallback: fixed page blocks
    const block = Math.max(1, FALLBACK_SECTION_PAGES);
    let sectionNo = 1;
    for (let startPage = 1; startPage <= totalPages; startPage += block) {
      const endPage = Math.min(totalPages, startPage + block - 1);
      const text = pagesText.slice(startPage - 1, endPage).join('\n\n').trim();
      if (!text) continue;

      chapters.push({
        id: `sec_${sectionNo}_${startPage}_${endPage}`,
        title: `Section ${sectionNo}`,
        startPage,
        endPage,
        text,
        selected: true,
        status: 'pending',
        progress: 0,
      });

      sectionNo++;
    }
  }

  if (chapters.length === 0) {
    chapters.push({
      id: 'ch_all',
      title: 'Full Document',
      startPage: 1,
      endPage: totalPages,
      text: pagesText.join('\n\n').trim(),
      selected: true,
      status: 'pending',
      progress: 0,
    });
  }

  return chapters;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);

  const [extraction, setExtraction] = useState<ExtractionStatus>({
    totalPageCount: 0,
    currentPage: 0,
    text: '',
    status: 'idle',
  });

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const chaptersRef = useRef<Chapter[]>([]);
  useEffect(() => {
    chaptersRef.current = chapters;
  }, [chapters]);

  const [config, setConfig] = useState<AudiobookConfig>({
    voiceId: VOICE_OPTIONS[1].id, // Aditi
    speed: 0.9, // slower default
    quality: 'high',
  });

  const [smartNarration, setSmartNarration] = useState(true);

  const [generation, setGeneration] = useState<AudioGenerationStatus>({
    progress: 0,
    status: 'idle',
  });

  const [voicePreview, setVoicePreview] = useState<VoicePreviewStatus>({ status: 'idle' });

  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelAllRef = useRef<boolean>(false);
  const cancelledChapterIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }, []);

  const selectedVoice = useMemo(
    () => VOICE_OPTIONS.find((v) => v.id === config.voiceId),
    [config.voiceId]
  );

  const selectedChapters = useMemo(() => chapters.filter((c) => c.selected), [chapters]);

  const canStart =
    extraction.status === 'completed' &&
    selectedChapters.length > 0 &&
    generation.status !== 'generating';

  const mp3Bitrate = config.quality === 'high' ? 128 : 96;

  // cleanup URLs on unmount
  useEffect(() => {
    return () => {
      chapters.forEach((c) => c.audioUrl && URL.revokeObjectURL(c.audioUrl));
      if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected || selected.type !== 'application/pdf') return;

    // cleanup previous
    chapters.forEach((c) => c.audioUrl && URL.revokeObjectURL(c.audioUrl));
    if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);

    setFile(selected);
    setChapters([]);
    setVoicePreview({ status: 'idle' });
    cancelAllRef.current = false;
    cancelledChapterIdsRef.current.clear();
    setGeneration({ status: 'idle', progress: 0 });

    await extractText(selected);
  };

  const extractText = async (pdfFile: File) => {
    if (typeof pdfjsLib === 'undefined') {
      setExtraction((prev) => ({ ...prev, status: 'error' }));
      return;
    }

    setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'processing' });

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      const perPageText: string[] = [];
      setExtraction((prev) => ({ ...prev, totalPageCount: pdf.numPages }));

      let fullText = '';

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();

        const pageText = content.items
          .map((item: any) => {
            const str = item?.str ?? '';
            const eol = item?.hasEOL ? '\n' : ' ';
            return str + eol;
          })
          .join('')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        perPageText.push(pageText);
        fullText += pageText + '\n\n';

        setExtraction((prev) => ({ ...prev, currentPage: i, text: fullText }));
      }

      setExtraction((prev) => ({ ...prev, status: 'completed' }));

      // detect chapters now
      const detected = detectChaptersFromPages(perPageText);
      setChapters(detected);
    } catch (err) {
      console.error(err);
      setExtraction((prev) => ({ ...prev, status: 'error' }));
    }
  };

  const toggleChapterSelected = (id: string) => {
    if (generation.status === 'generating') return;
    setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)));
  };

  const selectAllChapters = () => {
    if (generation.status === 'generating') return;
    setChapters((prev) => prev.map((c) => ({ ...c, selected: true })));
  };

  const deselectAllChapters = () => {
    if (generation.status === 'generating') return;
    setChapters((prev) => prev.map((c) => ({ ...c, selected: false })));
  };

  const cancelChapter = (id: string) => {
    cancelledChapterIdsRef.current.add(id);
    setChapters((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (c.status === 'completed') return c;
        return { ...c, status: 'cancelled', progress: 0 };
      })
    );
  };

  const cancelWholeBook = () => {
    cancelAllRef.current = true;
    setGeneration((prev) => ({ ...prev, status: 'cancelled' }));

    setChapters((prev) =>
      prev.map((c) => {
        if (!c.selected) return c;
        if (c.status === 'completed') return c;
        return { ...c, status: 'cancelled', progress: 0 };
      })
    );
  };

  const downloadFromUrl = (audioUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = filename;
    link.click();
  };

  const downloadChapter = (chapter: Chapter) => {
    if (!chapter.audioUrl) return;
    const base = file?.name.replace(/\.pdf$/i, '') || 'audiobook';
    const baseSafe = sanitizeFilenamePart(base);
    const titleSafe = sanitizeFilenamePart(chapter.title || `Chapter_${chapter.startPage}`);
    downloadFromUrl(chapter.audioUrl, `IndiVoice_${baseSafe}_${titleSafe}.mp3`);
  };

  const downloadAllCompleted = () => {
    const completed = chapters.filter((c) => c.selected && c.status === 'completed' && c.audioUrl);
    if (completed.length === 0) return;

    completed.forEach((c, idx) => {
      setTimeout(() => downloadChapter(c), idx * 350);
    });
  };

  const convertTextToMp3Url = async (
    text: string,
    voiceName: string,
    speed: number,
    shouldCancel: () => boolean,
    onProgress: (pct: number) => void
  ): Promise<{ audioUrl?: string; status: ChapterStatus; error?: string }> => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return { status: 'error', error: 'Missing API_KEY in Vercel environment variables.' };

    const ai = new GoogleGenAI({ apiKey });

    const segments: TextSegment[] = smartNarration
      ? buildSmartSegments(text)
      : [{ type: 'narration', text: normalizeExtractedText(text) }];

    const tasks: Array<{ type: 'narration' | 'meta'; chunk: string; lastOfSegment: boolean }> = [];

    for (const seg of segments) {
      const chunks = splitTextIntoChunks(seg.text, MAX_TEXT_CHUNK_SIZE);
      for (let i = 0; i < chunks.length; i++) {
        tasks.push({ type: seg.type, chunk: chunks[i], lastOfSegment: i === chunks.length - 1 });
      }
    }

    if (tasks.length === 0) return { status: 'error', error: 'No readable text found in this chapter.' };

    const pcmParts: Int16Array[] = [];

    for (let i = 0; i < tasks.length; i++) {
      if (shouldCancel()) return { status: 'cancelled' };

      const t = tasks[i];

      const instruction =
        t.type === 'narration'
          ? `You are a professional Indian audiobook narrator.
Speak naturally with clear pauses and expressive intonation.
Keep the pace comfortable (not fast), and pause slightly at commas and sentence endings.
Narrate this text:`
          : `Read the following as a citation/reference note.
Speak a little faster, softer, and with reduced emphasis.
Do NOT announce that it's a reference, just read it differently:`;

      const prompt = `${instruction}\n\nRequested speed factor: ${speed}\n\n${t.chunk}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) return { status: 'error', error: 'TTS returned no audio.' };

      const bytes = decodeBase64(base64Audio);

      // treat bytes as PCM (same as your working WAV version)
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      pcmParts.push(pcm);

      if (t.lastOfSegment) {
        const pauseSec = t.type === 'narration' ? 0.55 : 0.35;
        pcmParts.push(createSilencePCM(pauseSec, SAMPLE_RATE));
      }

      const pct = Math.round(((i + 1) / tasks.length) * 100);
      onProgress(pct);
    }

    if (shouldCancel()) return { status: 'cancelled' };

    const totalSamples = pcmParts.reduce((sum, p) => sum + p.length, 0);
    if (totalSamples <= 0) return { status: 'error', error: 'No audio generated for this chapter.' };

    const combined = new Int16Array(totalSamples);
    let offset = 0;
    for (const part of pcmParts) {
      combined.set(part, offset);
      offset += part.length;
    }

    const mp3Blob = createMp3Blob(combined, SAMPLE_RATE, mp3Bitrate);
    const url = URL.createObjectURL(mp3Blob);

    return { status: 'completed', audioUrl: url };
  };

  const generateSelectedChapters = async () => {
    if (!selectedVoice) return;

    const current = chaptersRef.current.filter((c) => c.selected);
    if (current.length === 0) return;

    cancelAllRef.current = false;
    cancelledChapterIdsRef.current.clear();

    setChapters((prev) =>
      prev.map((c) => {
        if (!c.selected) return c;
        if (c.status === 'completed') return c;
        return { ...c, status: 'queued', progress: 0, error: undefined };
      })
    );

    setGeneration({ status: 'generating', progress: 0 });

    try {
      const toConvert = chaptersRef.current.filter((c) => c.selected);
      const total = toConvert.length;
      let done = 0;

      for (const ch of toConvert) {
        if (cancelAllRef.current) break;

        if (cancelledChapterIdsRef.current.has(ch.id)) {
          done++;
          continue;
        }

        setGeneration((prev) => ({ ...prev, currentChapterId: ch.id }));

        setChapters((prev) =>
          prev.map((c) => (c.id === ch.id ? { ...c, status: 'converting', progress: 0 } : c))
        );

        const shouldCancel = () => cancelAllRef.current || cancelledChapterIdsRef.current.has(ch.id);

        const result = await convertTextToMp3Url(
          ch.text,
          selectedVoice.geminiVoice,
          config.speed,
          shouldCancel,
          (pct) => {
            setChapters((prev) => prev.map((c) => (c.id === ch.id ? { ...c, progress: pct } : c)));
          }
        );

        if (result.status === 'completed' && result.audioUrl) {
          setChapters((prev) =>
            prev.map((c) =>
              c.id === ch.id ? { ...c, status: 'completed', progress: 100, audioUrl: result.audioUrl } : c
            )
          );
        } else if (result.status === 'cancelled') {
          setChapters((prev) => prev.map((c) => (c.id === ch.id ? { ...c, status: 'cancelled', progress: 0 } : c)));
        } else {
          setChapters((prev) =>
            prev.map((c) =>
              c.id === ch.id
                ? { ...c, status: 'error', progress: 0, error: result.error || 'Failed to convert this chapter.' }
                : c
            )
          );
        }

        done++;
        setGeneration((prev) => ({ ...prev, progress: Math.round((done / total) * 100) }));
      }

      if (cancelAllRef.current) {
        setGeneration((prev) => ({ ...prev, status: 'cancelled' }));
        return;
      }

      setGeneration((prev) => ({ ...prev, status: 'completed', progress: 100 }));
    } catch (err: any) {
      console.error(err);
      setGeneration({ status: 'error', progress: 0, error: err?.message || 'Failed to generate audiobook.' });
    }
  };

  const previewVoice = async (voiceId: string) => {
    const voice = VOICE_OPTIONS.find((v) => v.id === voiceId);
    if (!voice) return;

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setVoicePreview({ status: 'error', voiceId, error: 'Missing API_KEY in environment variables.' });
      return;
    }

    if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);

    setVoicePreview({ status: 'loading', voiceId });

    try {
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `You are a professional Indian audiobook narrator.
Speak naturally with clear pauses and good intonation.
Requested speed factor: ${config.speed}

${VOICE_PREVIEW_TEXT}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.geminiVoice } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error('No audio returned for preview.');

      const bytes = decodeBase64(base64Audio);
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const mp3Blob = createMp3Blob(pcm, SAMPLE_RATE, mp3Bitrate);
      const url = URL.createObjectURL(mp3Blob);

      setVoicePreview({ status: 'ready', voiceId, audioUrl: url });
    } catch (err: any) {
      console.error(err);
      setVoicePreview({ status: 'error', voiceId, error: err?.message || 'Voice preview failed.' });
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 md:py-16">
      <header className="text-center mb-10">
        <div className="inline-block bg-indigo-100 text-indigo-700 px-4 py-1 rounded-full text-xs font-bold tracking-widest uppercase mb-4">
          PDF to Audiobook
        </div>
        <h1 className="text-4xl md:text-5xl font-black text-indigo-950 mb-3">
          IndiVoice <span className="text-indigo-500">🎧</span>
        </h1>
        <p className="text-slate-500 text-lg max-w-2xl mx-auto">
          Auto-detect chapters, convert one-by-one, download MP3 per chapter, and preview voices.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* LEFT */}
        <div className="lg:col-span-4 space-y-6">
          {/* 1. Upload */}
          <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">1. Document</h2>

            <input type="file" ref={fileInputRef} className="hidden" accept=".pdf" onChange={handleFileChange} />

            <button
              onClick={() => fileInputRef.current?.click()}
              className={`w-full border-2 border-dashed rounded-2xl p-6 text-center transition-all ${
                file ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-200 hover:border-indigo-300'
              }`}
            >
              <div className="text-3xl mb-2">{file ? '📄' : '📤'}</div>
              <div className="text-sm font-semibold text-slate-700 truncate">{file ? file.name : 'Choose PDF'}</div>

              {extraction.status === 'processing' && (
                <div className="mt-2 text-[10px] font-bold text-indigo-600">
                  Reading: {extraction.currentPage}/{extraction.totalPageCount}
                </div>
              )}

              {extraction.status === 'error' && (
                <div className="mt-2 text-[10px] font-bold text-red-600">Could not read this PDF.</div>
              )}
            </button>
          </section>

          {/* 2. Chapters */}
          <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">2. Chapters</h2>

              {chapters.length > 0 && generation.status !== 'generating' && (
                <div className="flex gap-2">
                  <button
                    onClick={selectAllChapters}
                    className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 hover:bg-slate-100"
                  >
                    All
                  </button>
                  <button
                    onClick={deselectAllChapters}
                    className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 hover:bg-slate-100"
                  >
                    None
                  </button>
                </div>
              )}
            </div>

            {extraction.status !== 'completed' && (
              <div className="text-sm text-slate-400">Upload a PDF to detect chapters automatically.</div>
            )}

            {extraction.status === 'completed' && chapters.length > 0 && (
              <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
                {chapters.map((ch) => (
                  <div
                    key={ch.id}
                    className={`rounded-2xl border p-3 flex items-start gap-3 ${
                      ch.selected ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-100 bg-white'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={ch.selected}
                      disabled={generation.status === 'generating'}
                      onChange={() => toggleChapterSelected(ch.id)}
                      className="mt-1 accent-indigo-600"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-bold text-slate-700 truncate">{ch.title}</div>
                        <div className="text-[10px] font-bold text-slate-400 shrink-0">
                          p.{ch.startPage}–{ch.endPage}
                        </div>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            ch.status === 'completed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : ch.status === 'converting'
                              ? 'bg-indigo-100 text-indigo-700'
                              : ch.status === 'cancelled'
                              ? 'bg-amber-100 text-amber-700'
                              : ch.status === 'error'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {ch.status}
                        </span>

                        {ch.status === 'converting' && (
                          <span className="text-[10px] font-bold text-indigo-600">{ch.progress}%</span>
                        )}
                      </div>

                      {ch.status === 'converting' && (
                        <div className="mt-2 w-full bg-indigo-100 h-1.5 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500" style={{ width: `${ch.progress}%` }} />
                        </div>
                      )}

                      {ch.status === 'error' && ch.error && (
                        <div className="mt-2 text-[10px] text-red-600">{ch.error}</div>
                      )}

                      <div className="mt-3 flex flex-wrap gap-2">
                        {ch.status === 'completed' && ch.audioUrl && (
                          <>
                            <button
                              onClick={() => downloadChapter(ch)}
                              className="text-[10px] font-bold px-3 py-1 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
                            >
                              Download MP3
                            </button>
                            <audio controls src={ch.audioUrl} className="h-8 w-full" />
                          </>
                        )}

                        {(ch.status === 'queued' || ch.status === 'converting' || ch.status === 'pending') &&
                          generation.status === 'generating' && (
                            <button
                              onClick={() => cancelChapter(ch.id)}
                              className="text-[10px] font-bold px-3 py-1 rounded-xl bg-amber-100 text-amber-800 hover:bg-amber-200"
                            >
                              Cancel Chapter
                            </button>
                          )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 3. Voice settings */}
          <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">3. Voice Settings</h2>

            <div className="grid grid-cols-2 gap-2 mb-4">
              {VOICE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setConfig((prev) => ({ ...prev, voiceId: v.id }))}
                  className={`p-2 rounded-xl border text-[10px] font-bold transition-all ${
                    config.voiceId === v.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-100 bg-slate-50 text-slate-500'
                  }`}
                >
                  {v.name.split(' ')[0]} ({v.gender === VoiceGender.MALE ? 'M' : 'F'})
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">
                Narration speed: {config.speed.toFixed(1)}x
              </label>
              <button
                onClick={() => previewVoice(config.voiceId)}
                className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 hover:bg-slate-100"
              >
                Preview Voice
              </button>
            </div>

            <input
              type="range"
              min="0.7"
              max="1.2"
              step="0.1"
              className="w-full accent-indigo-600"
              value={config.speed}
              onChange={(e) => setConfig((prev) => ({ ...prev, speed: parseFloat(e.target.value) }))}
            />

            <div className="mt-4 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-bold text-slate-700">Smart narration mode</div>
                <div className="text-[10px] text-slate-500">Reads citations/sub-text differently</div>
              </div>
              <button
                className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                  smartNarration
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-slate-50 border-slate-200 text-slate-600'
                }`}
                onClick={() => setSmartNarration((v) => !v)}
              >
                {smartNarration ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="mt-4">
              <div className="text-[10px] font-bold text-slate-400 uppercase mb-2">MP3 Quality</div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfig((p) => ({ ...p, quality: 'standard' }))}
                  className={`flex-1 py-2 rounded-xl border text-[10px] font-bold ${
                    config.quality === 'standard'
                      ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                      : 'bg-slate-50 border-slate-100 text-slate-600'
                  }`}
                >
                  Standard (96kbps)
                </button>
                <button
                  onClick={() => setConfig((p) => ({ ...p, quality: 'high' }))}
                  className={`flex-1 py-2 rounded-xl border text-[10px] font-bold ${
                    config.quality === 'high'
                      ? 'bg-indigo-50 border-indigo-400 text-indigo-700'
                      : 'bg-slate-50 border-slate-100 text-slate-600'
                  }`}
                >
                  High (128kbps)
                </button>
              </div>
            </div>

            {voicePreview.status === 'loading' && (
              <div className="mt-3 text-[10px] font-bold text-slate-400">Generating voice preview…</div>
            )}
            {voicePreview.status === 'ready' && voicePreview.audioUrl && (
              <div className="mt-3">
                <audio controls src={voicePreview.audioUrl} className="w-full h-8" />
              </div>
            )}
            {voicePreview.status === 'error' && (
              <div className="mt-3 text-[10px] font-bold text-red-600">{voicePreview.error}</div>
            )}
          </section>

          {/* Convert buttons */}
          <div className="space-y-3">
            <button
              disabled={!canStart}
              onClick={generateSelectedChapters}
              className="w-full bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg hover:bg-indigo-700 disabled:bg-slate-300 transition-all"
            >
              {generation.status === 'generating' ? `Narrating… ${generation.progress}%` : 'Convert Selected Chapters'}
            </button>

            {generation.status === 'generating' && (
              <button
                onClick={cancelWholeBook}
                className="w-full bg-amber-100 text-amber-900 font-bold py-3 rounded-2xl border border-amber-200 hover:bg-amber-200 transition-all"
              >
                Cancel Whole Book
              </button>
            )}

            {generation.status === 'completed' && (
              <button
                onClick={downloadAllCompleted}
                className="w-full bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 transition-all"
              >
                Download All Completed (MP3)
              </button>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
              <h3 className="text-xs font-bold text-slate-500 uppercase">Conversion Status</h3>
              <div className="text-[10px] font-bold text-slate-400">
                {selectedChapters.length > 0 ? `${selectedChapters.length} selected` : 'No chapters selected'}
              </div>
            </div>

            <div className="p-6">
              {generation.status === 'idle' && <div className="text-sm text-slate-400">Upload a PDF and select chapters.</div>}

              {generation.status === 'generating' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">Converting chapter-by-chapter…</div>
                    <div className="text-xs font-bold text-indigo-600">{generation.progress}%</div>
                  </div>
                  <div className="w-full bg-indigo-100 h-2 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${generation.progress}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Completed chapters become downloadable immediately.
                  </div>
                </div>
              )}

              {generation.status === 'completed' && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-emerald-700">✅ Done! Your chapters are ready.</div>
                </div>
              )}

              {generation.status === 'cancelled' && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-amber-700">⚠️ Conversion cancelled.</div>
                  <div className="text-[10px] text-slate-500">Completed chapters remain downloadable.</div>
                </div>
              )}

              {generation.status === 'error' && (
                <div className="text-sm text-red-600">❌ {generation.error || 'Something went wrong.'}</div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col min-h-[420px]">
            <div className="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
              <h3 className="text-xs font-bold text-slate-500 uppercase">Extracted Text Preview</h3>
              {extraction.text && (
                <span className="text-[10px] font-bold text-slate-400">{extraction.text.length} characters</span>
              )}
            </div>
            <div className="flex-1 p-6 overflow-y-auto max-h-[420px] custom-scrollbar text-slate-600 leading-relaxed text-sm whitespace-pre-wrap">
              {extraction.text ? normalizeExtractedText(extraction.text).slice(0, 8000) + (extraction.text.length > 8000 ? '…' : '') : (
                <div className="h-full flex items-center justify-center text-slate-300 italic">No document loaded</div>
              )}
            </div>
          </div>

          {/* Playback tip */}
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6">
            <h3 className="text-sm font-bold text-slate-800 mb-2">Playback speed tip</h3>
            <p className="text-sm text-slate-600">
              After downloading MP3, you can also change playback speed inside your music player app.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

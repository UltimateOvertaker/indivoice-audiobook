import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { FALLBACK_SECTION_PAGES, MAX_TEXT_CHUNK_SIZE, VOICE_OPTIONS, VOICE_PREVIEW_TEXT } from './constants';
import {
  AudiobookConfig,
  AudioGenerationStatus,
  Chapter,
  ChapterStatus,
  ExtractionStatus,
  VoiceGender,
  VoicePreviewStatus,
} from './types';
import { createWavBlob, decodeBase64 } from './utils/audioUtils';

// Global reference for PDF.js provided by the script tag in index.html
declare const pdfjsLib: any;

const SAMPLE_RATE = 24000;

function sanitizeFilenamePart(input: string): string {
  return input
    .replace(/[^a-z0-9\- _]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim();
}

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let idx = 0;

  while (idx < clean.length) {
    let chunk = clean.slice(idx, idx + maxChunkSize);

    // Try to end on a sentence boundary for smoother narration.
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

function getHeadingFromPage(pageText: string): string | null {
  const head = pageText.slice(0, 1800);
  const lines = head
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30);

  // Common book headings
  const patterns: RegExp[] = [
    /^(chapter|chap\.?|ch\.?|section|part)\s+([0-9ivxlcdm]+)\b\s*[:.\-–—]?\s*(.{0,80})$/i,
    /^(preface|foreword|introduction|prologue|epilogue|afterword|acknowledgements|acknowledgments)\b.*$/i,
    /^(\d{1,3})\s*[\.-]\s*(.{3,80})$/,
  ];

  for (const line of lines) {
    // Ignore pure numbers (page numbers)
    if (/^\d{1,4}$/.test(line)) continue;
    if (line.length < 4) continue;
    for (const re of patterns) {
      if (re.test(line)) return line;
    }
  }
  return null;
}

function detectChaptersFromPages(pagesText: string[]): Chapter[] {
  const totalPages = pagesText.length;
  const markers: Array<{ page: number; title: string }> = [];

  for (let i = 0; i < totalPages; i++) {
    const heading = getHeadingFromPage(pagesText[i] ?? '');
    if (heading) {
      const title = heading.replace(/\s+/g, ' ').trim();
      markers.push({ page: i + 1, title });
    }
  }

  // De-dupe consecutive headings (some PDFs repeat the heading on multiple pages)
  const deduped: Array<{ page: number; title: string }> = [];
  for (const m of markers) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.title.toLowerCase() !== m.title.toLowerCase()) {
      deduped.push(m);
    }
  }

  // If headings are too sparse, fall back to page-based sections.
  const usableHeadings = deduped.filter((m, idx, arr) => {
    const prev = arr[idx - 1];
    if (!prev) return true;
    return m.page - prev.page >= 2;
  });

  const chapters: Chapter[] = [];

  if (usableHeadings.length >= 2) {
    for (let i = 0; i < usableHeadings.length; i++) {
      const startPage = usableHeadings[i].page;
      const endPage = i < usableHeadings.length - 1 ? usableHeadings[i + 1].page - 1 : totalPages;

      if (endPage < startPage) continue;

      const text = pagesText.slice(startPage - 1, endPage).join('\n\n').trim();
      if (!text) continue;

      chapters.push({
        id: `ch_${startPage}_${endPage}`,
        title: usableHeadings[i].title,
        startPage,
        endPage,
        text,
        selected: true,
        status: 'pending',
        progress: 0,
      });
    }
  } else if (usableHeadings.length === 1) {
    const start = usableHeadings[0].page;

    // Front matter (optional)
    if (start > 1) {
      const fmText = pagesText.slice(0, start - 1).join('\n\n').trim();
      if (fmText) {
        chapters.push({
          id: `ch_1_${start - 1}`,
          title: 'Front Matter',
          startPage: 1,
          endPage: start - 1,
          text: fmText,
          selected: true,
          status: 'pending',
          progress: 0,
        });
      }
    }

    const mainText = pagesText.slice(start - 1).join('\n\n').trim();
    if (mainText) {
      chapters.push({
        id: `ch_${start}_${totalPages}`,
        title: usableHeadings[0].title,
        startPage: start,
        endPage: totalPages,
        text: mainText,
        selected: true,
        status: 'pending',
        progress: 0,
      });
    }
  } else {
    // Fallback: split by fixed page blocks
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

  // Safety: if everything failed, treat whole document as one chapter
  if (chapters.length === 0) {
    const allText = pagesText.join('\n\n').trim();
    chapters.push({
      id: 'ch_all',
      title: 'Full Document',
      startPage: 1,
      endPage: totalPages,
      text: allText,
      selected: true,
      status: 'pending',
      progress: 0,
    });
  }

  return chapters;
}

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);

  const [extraction, setExtraction] = useState<ExtractionStatus>({
    totalPageCount: 0,
    currentPage: 0,
    text: '',
    status: 'idle',
  });

  const [chapters, setChapters] = useState<Chapter[]>([]);

  const [config, setConfig] = useState<AudiobookConfig>({
    voiceId: VOICE_OPTIONS[1].id, // Aditi (Warm)
    speed: 1.0,
    quality: 'high',
  });

  const [generation, setGeneration] = useState<AudioGenerationStatus>({
    progress: 0,
    status: 'idle',
  });

  const [voicePreview, setVoicePreview] = useState<VoicePreviewStatus>({ status: 'idle' });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelAllRef = useRef<boolean>(false);
  const cancelledChapterIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }, []);

  // Clean up any object URLs when leaving page
  useEffect(() => {
    return () => {
      chapters.forEach((c) => c.audioUrl && URL.revokeObjectURL(c.audioUrl));
      if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedVoice = useMemo(() => VOICE_OPTIONS.find((v) => v.id === config.voiceId), [config.voiceId]);
  const selectedChapters = useMemo(() => chapters.filter((c) => c.selected), [chapters]);
  const completedSelected = useMemo(
    () => selectedChapters.filter((c) => c.status === 'completed').length,
    [selectedChapters]
  );

  const overallLabel = useMemo(() => {
    if (generation.status === 'generating') {
      const total = selectedChapters.length || 1;
      return `Converting ${completedSelected}/${total} chapters…`;
    }
    return '';
  }, [generation.status, completedSelected, selectedChapters.length]);

  const resetAll = () => {
    cancelAllRef.current = false;
    cancelledChapterIdsRef.current.clear();
    setGeneration({ status: 'idle', progress: 0 });
    setVoicePreview({ status: 'idle' });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile || selectedFile.type !== 'application/pdf') return;

    // Cleanup old urls
    chapters.forEach((c) => c.audioUrl && URL.revokeObjectURL(c.audioUrl));
    if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);

    setFile(selectedFile);
    setChapters([]);
    resetAll();
    await extractText(selectedFile);
  };

  const extractText = async (pdfFile: File) => {
    if (typeof pdfjsLib === 'undefined') {
      setExtraction((prev) => ({ ...prev, status: 'error' }));
      console.error('PDF.js not loaded yet.');
      return;
    }

    setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'processing' });
    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

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

      // Detect chapters immediately
      const detected = detectChaptersFromPages(perPageText);
      setChapters(detected);
    } catch (err) {
      console.error('PDF Extraction Error:', err);
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

  const cancelAll = () => {
    cancelAllRef.current = true;
    setGeneration((prev) => ({ ...prev, status: 'cancelled' }));

    setChapters((prev) =>
      prev.map((c) => {
        if (!c.selected) return c;
        if (c.status === 'completed') return c;
        if (c.status === 'cancelled') return c;
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
    const title = sanitizeFilenamePart(chapter.title || `Chapter_${chapter.startPage}`);
    downloadFromUrl(chapter.audioUrl, `IndiVoice_${base}_${title}.wav`);
  };

  const downloadAllCompleted = () => {
    const completed = chapters.filter((c) => c.selected && c.status === 'completed' && c.audioUrl);
    if (completed.length === 0) return;

    completed.forEach((c, idx) => {
      setTimeout(() => downloadChapter(c), idx * 300);
    });
  };

  const convertTextToWavUrl = async (
    text: string,
    voiceName: string,
    speed: number,
    shouldCancel: () => boolean,
    onProgress: (pct: number) => void
  ): Promise<{ audioUrl?: string; status: ChapterStatus; error?: string }> => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    const chunks = splitTextIntoChunks(text, MAX_TEXT_CHUNK_SIZE);
    if (chunks.length === 0) {
      return { status: 'error', error: 'No readable text found in this section.' };
    }

    const pcmChunks: Int16Array[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (shouldCancel()) {
        return { status: 'cancelled' };
      }

      const chunk = chunks[i].trim();
      if (!chunk) continue;

      const prompt = `Read this text clearly as an Indian audiobook narrator.\nSpeed factor: ${speed}.\nText: ${chunk}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const bytes = decodeBase64(base64Audio);
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        pcmChunks.push(pcm);
      }

      const pct = Math.round(((i + 1) / chunks.length) * 100);
      onProgress(pct);
    }

    if (shouldCancel()) {
      return { status: 'cancelled' };
    }

    if (pcmChunks.length === 0) {
      return { status: 'error', error: 'The TTS model returned no audio for this section.' };
    }

    const totalLength = pcmChunks.reduce((acc, c) => acc + c.length, 0);
    const combinedPcm = new Int16Array(totalLength);
    let offset = 0;
    for (const c of pcmChunks) {
      combinedPcm.set(c, offset);
      offset += c.length;
    }

    const wavBlob = createWavBlob(combinedPcm, SAMPLE_RATE);
    const audioUrl = URL.createObjectURL(wavBlob);

    return { status: 'completed', audioUrl };
  };

  const generateSelectedChapters = async () => {
    if (!selectedVoice) return;
    if (selectedChapters.length === 0) return;

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
      const toConvert = chapters.filter((c) => c.selected);
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

        const result = await convertTextToWavUrl(ch.text, selectedVoice.geminiVoice, config.speed, shouldCancel, (pct) => {
          setChapters((prev) => prev.map((c) => (c.id === ch.id ? { ...c, progress: pct } : c)));
        });

        if (result.status === 'completed' && result.audioUrl) {
          setChapters((prev) =>
            prev.map((c) => (c.id === ch.id ? { ...c, status: 'completed', progress: 100, audioUrl: result.audioUrl } : c))
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
      console.error('Generation error:', err);
      setGeneration({ status: 'error', progress: 0, error: err?.message || 'Failed to generate audiobook.' });
    }
  };

  const previewVoice = async (voiceId: string) => {
    const voice = VOICE_OPTIONS.find((v) => v.id === voiceId);
    if (!voice) return;

    if (voicePreview.audioUrl) URL.revokeObjectURL(voicePreview.audioUrl);

    setVoicePreview({ status: 'loading', voiceId });
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [
          {
            parts: [
              {
                text: `Read this in a natural Indian audiobook tone. Speed factor: ${config.speed}. Text: ${VOICE_PREVIEW_TEXT}`,
              },
            ],
          },
        ],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice.geminiVoice },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error('No audio returned for preview.');

      const bytes = decodeBase64(base64Audio);
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const wav = createWavBlob(pcm, SAMPLE_RATE);
      const url = URL.createObjectURL(wav);

      setVoicePreview({ status: 'ready', voiceId, audioUrl: url });
    } catch (err: any) {
      console.error('Voice preview error:', err);
      setVoicePreview({ status: 'error', voiceId, error: err?.message || 'Preview failed.' });
    }
  };

  const canStart = extraction.status === 'completed' && selectedChapters.length > 0 && generation.status !== 'generating';

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
          Auto-detect chapters, convert one-by-one, and download each chapter as soon as it is ready.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* LEFT */}
        <div className="lg:col-span-4 space-y-6">
          {/* 1. Document */}
          <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">1. Document</h2>
            <div
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
                file ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-200 hover:border-indigo-300'
              }`}
            >
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept=".pdf" />
              <div className="text-3xl mb-2">{file ? '📄' : '📤'}</div>
              <p className="text-sm font-semibold text-slate-700 truncate">{file ? file.name : 'Choose PDF'}</p>

              {extraction.status === 'processing' && (
                <p className="text-[10px] font-bold text-indigo-600 mt-2">
                  Reading: {extraction.currentPage}/{extraction.totalPageCount}
                </p>
              )}

              {extraction.status === 'error' && (
                <p className="text-[10px] font-bold text-red-600 mt-2">Could not read this PDF. Try another file.</p>
              )}
            </div>
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
              <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
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

                      {ch.status === 'error' && ch.error && <div className="mt-2 text-[10px] text-red-600">{ch.error}</div>}

                      <div className="mt-3 flex flex-wrap gap-2">
                        {ch.status === 'completed' && ch.audioUrl && (
                          <>
                            <button
                              onClick={() => downloadChapter(ch)}
                              className="text-[10px] font-bold px-3 py-1 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
                            >
                              Download
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

          {/* 3. Voice */}
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
              <label className="text-[10px] font-bold text-slate-400 uppercase">Speed: {config.speed}x</label>
              {selectedVoice && (
                <button
                  onClick={() => previewVoice(config.voiceId)}
                  className="text-[10px] font-bold px-2 py-1 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 hover:bg-slate-100"
                >
                  Preview
                </button>
              )}
            </div>

            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.1"
              className="w-full h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              value={config.speed}
              onChange={(e) => setConfig((prev) => ({ ...prev, speed: parseFloat(e.target.value) }))}
            />

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
                onClick={cancelAll}
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
                Download All Completed Chapters
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
              {generation.status === 'idle' && <div className="text-sm text-slate-400">Ready when you are.</div>}

              {generation.status === 'generating' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">{overallLabel}</div>
                    <div className="text-xs font-bold text-indigo-600">{generation.progress}%</div>
                  </div>
                  <div className="w-full bg-indigo-100 h-2 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${generation.progress}%` }} />
                  </div>
                  <div className="text-[10px] text-slate-500">
                    You can download completed chapters immediately from the chapter list.
                  </div>
                </div>
              )}

              {generation.status === 'completed' && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-emerald-700">✅ Done! Your chapters are ready.</div>
                  <div className="text-[10px] text-slate-500">
                    Use “Download All Completed Chapters” (left panel) or download individual chapters.
                  </div>
                </div>
              )}

              {generation.status === 'cancelled' && (
                <div className="space-y-2">
                  <div className="text-sm font-semibold text-amber-700">⚠️ Conversion cancelled.</div>
                  <div className="text-[10px] text-slate-500">Already completed chapters remain available for download.</div>
                </div>
              )}

              {generation.status === 'error' && (
                <div className="text-sm text-red-600">❌ {generation.error || 'Something went wrong.'}</div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col min-h-[420px]">
            <div className="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
              <h3 className="text-xs font-bold text-slate-500 uppercase">Text Preview</h3>
              {extraction.text && (
                <span className="text-[10px] font-bold text-slate-400">{extraction.text.length} characters</span>
              )}
            </div>
            <div className="flex-1 p-6 overflow-y-auto max-h-[420px] custom-scrollbar text-slate-600 leading-relaxed text-sm font-serif italic whitespace-pre-wrap">
              {extraction.text || (
                <div className="h-full flex items-center justify-center text-slate-300 italic">No document loaded</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;

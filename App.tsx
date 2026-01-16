import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { MAX_TEXT_CHUNK_SIZE, VOICE_OPTIONS, VOICE_PREVIEW_TEXT } from './constants';
import { AudiobookConfig, AudioGenerationStatus, ExtractionStatus, TextSegment } from './types';
import { createMp3Blob, createSilencePCM, decodeBase64 } from './utils/audioUtils';

declare const pdfjsLib: any;

const SAMPLE_RATE = 24000;

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let idx = 0;

  while (idx < clean.length) {
    let chunk = clean.slice(idx, idx + maxChunkSize);

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

function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Detect "meta/citation" blocks:
 * - Short lines, multiple lines
 * - Contains year/date
 * - Contains typical citation keywords
 */
function isMetaBlock(block: string): boolean {
  const b = block.trim();
  if (!b) return false;

  const lines = b
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length >= 2 && lines.length <= 6) {
    const avgLen = lines.reduce((a, l) => a + l.length, 0) / lines.length;
    const hasYear = /\b(1[6-9]\d{2}|20\d{2})\b/.test(b);
    const hasDateWord =
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(b);
    const hasCitationWords =
      /\b(autobiography|foreword|preface|introduction|prologue|epilogue|edition|translated|copyright|volume|vol\.)\b/i.test(b);

    const manyShortLines = lines.filter((l) => l.length <= 65).length >= Math.ceil(lines.length * 0.75);

    if (manyShortLines && (hasYear || hasDateWord || hasCitationWords)) return true;
    if (avgLen < 55 && (hasYear || hasDateWord)) return true;
  }

  // Very short "source" line
  if (b.length < 140) {
    if (/\b(1[6-9]\d{2}|20\d{2})\b/.test(b)) return true;
    if (/\b(last sentence of|from the|taken from|source:)\b/i.test(b)) return true;
  }

  return false;
}

/**
 * Smart segmentation:
 * Splits by blank lines into blocks, then labels each block as narration or meta.
 */
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

function sanitizeFilenamePart(input: string): string {
  return input
    .replace(/[^a-z0-9\- _]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim();
}

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);

  const [extraction, setExtraction] = useState<ExtractionStatus>({
    totalPageCount: 0,
    currentPage: 0,
    text: '',
    status: 'idle',
  });

  const [config, setConfig] = useState<AudiobookConfig>({
    voiceId: VOICE_OPTIONS[1].id,
    speed: 0.9, // default slightly slower
    quality: 'high',
  });

  const [generation, setGeneration] = useState<AudioGenerationStatus>({
    progress: 0,
    status: 'idle',
  });

  const [smartNarration, setSmartNarration] = useState<boolean>(true);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const cancelRef = useRef<boolean>(false);

  const selectedVoice = useMemo(() => VOICE_OPTIONS.find((v) => v.id === config.voiceId), [config.voiceId]);

  useEffect(() => {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, generation.audioUrl]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile || selectedFile.type !== 'application/pdf') return;

    setFile(selectedFile);
    setGeneration({ status: 'idle', progress: 0 });
    setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'processing' });

    await extractText(selectedFile);
  };

  const extractText = async (pdfFile: File) => {
    if (typeof pdfjsLib === 'undefined') {
      setExtraction((prev) => ({ ...prev, status: 'error' }));
      return;
    }

    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      let fullText = '';
      setExtraction((prev) => ({ ...prev, totalPageCount: pdf.numPages }));

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();

        // Preserve line breaks using hasEOL
        const pageText = content.items
          .map((item: any) => {
            const str = item?.str ?? '';
            const eol = item?.hasEOL ? '\n' : ' ';
            return str + eol;
          })
          .join('')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        fullText += pageText + '\n\n';

        setExtraction((prev) => ({
          ...prev,
          currentPage: i,
          text: fullText,
        }));
      }

      setExtraction((prev) => ({ ...prev, status: 'completed' }));
    } catch (error) {
      console.error('PDF Extraction Error:', error);
      setExtraction((prev) => ({ ...prev, status: 'error' }));
    }
  };

  const cancelConversion = () => {
    cancelRef.current = true;
    setGeneration((prev) => ({ ...prev, status: 'cancelled' }));
  };

  const generateAudiobook = async () => {
    if (!extraction.text) return;

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setGeneration({
        status: 'error',
        progress: 0,
        error: 'API key is missing. Add API_KEY in Vercel Environment Variables.',
      });
      return;
    }

    if (!selectedVoice) return;

    cancelRef.current = false;
    setGeneration({ status: 'generating', progress: 0 });

    try {
      const ai = new GoogleGenAI({ apiKey });

      const segments: TextSegment[] = smartNarration
        ? buildSmartSegments(extraction.text)
        : [{ type: 'narration', text: normalizeExtractedText(extraction.text) }];

      if (segments.length === 0) {
        setGeneration({ status: 'error', progress: 0, error: 'No readable text found in the PDF.' });
        return;
      }

      // Build all tasks (chunk per segment)
      const tasks: Array<{ type: 'narration' | 'meta'; chunk: string; isLastChunkOfSegment: boolean }> = [];
      for (const seg of segments) {
        const chunks = splitTextIntoChunks(seg.text, MAX_TEXT_CHUNK_SIZE);
        for (let i = 0; i < chunks.length; i++) {
          tasks.push({
            type: seg.type,
            chunk: chunks[i],
            isLastChunkOfSegment: i === chunks.length - 1,
          });
        }
      }

      const pcmParts: Int16Array[] = [];
      const totalTasks = tasks.length || 1;

      const mp3Bitrate = config.quality === 'high' ? 128 : 96;

      for (let i = 0; i < tasks.length; i++) {
        if (cancelRef.current) break;

        const t = tasks[i];

        // Two different speaking styles
        const instruction =
          t.type === 'narration'
            ? `You are a professional Indian audiobook narrator.
Speak naturally with clear pauses and expressive intonation.
Keep the pace comfortable (not fast), and pause slightly at commas and sentence endings.
Narrate this text:`
            : `Read the following as a citation/reference note.
Speak slightly faster, softer, and with reduced emphasis.
Do NOT announce that this is a reference, just read it differently:`;

        const prompt = `${instruction}\n\nRequested speed factor: ${config.speed}\n\n${t.chunk}`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice.geminiVoice },
              },
            },
          },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (!base64Audio) {
          throw new Error('No audio returned from Gemini. Try again.');
        }

        const bytes = decodeBase64(base64Audio);

        // Convert bytes -> Int16Array PCM
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        pcmParts.push(pcm);

        // Add actual silence breaks between paragraphs/segments
        if (t.isLastChunkOfSegment) {
          // narration gets longer pauses than citation blocks
          const pauseSeconds = t.type === 'narration' ? 0.55 : 0.35;
          pcmParts.push(createSilencePCM(pauseSeconds, SAMPLE_RATE));
        }

        const pct = Math.round(((i + 1) / totalTasks) * 100);
        setGeneration({ status: 'generating', progress: pct });
      }

      if (cancelRef.current) {
        setGeneration((prev) => ({ ...prev, status: 'cancelled' }));
        return;
      }

      // Combine PCM
      const totalSamples = pcmParts.reduce((sum, p) => sum + p.length, 0);
      const combinedPCM = new Int16Array(totalSamples);

      let offset = 0;
      for (const part of pcmParts) {
        combinedPCM.set(part, offset);
        offset += part.length;
      }

      // MP3 export
      const mp3Blob = createMp3Blob(combinedPCM, SAMPLE_RATE, mp3Bitrate);
      const audioUrl = URL.createObjectURL(mp3Blob);

      setGeneration({ status: 'completed', progress: 100, audioUrl });

      if (audioRef.current) {
        audioRef.current.src = audioUrl;
      }
    } catch (error: any) {
      console.error('Audiobook generation failed:', error);
      setGeneration({
        status: 'error',
        progress: 0,
        error: error?.message || 'Something went wrong',
      });
    }
  };

  const downloadAudio = () => {
    if (!generation.audioUrl) return;

    const base = file?.name.replace(/\.pdf$/i, '') || 'audiobook';
    const fileSafe = sanitizeFilenamePart(base);

    const link = document.createElement('a');
    link.href = generation.audioUrl;
    link.download = `IndiVoice_${fileSafe}.mp3`;
    link.click();
  };

  const canGenerate = extraction.status === 'completed' && generation.status !== 'generating';

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-5xl bg-white/80 backdrop-blur-sm shadow-xl rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 bg-gradient-to-r from-rose-50 to-sky-50">
          <h1 className="text-3xl font-bold text-slate-900">IndiVoice PDF Audiobook</h1>
          <p className="text-slate-600 mt-1">
            Smarter narration, better pauses, and MP3 downloads for offline listening.
          </p>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LEFT */}
          <div className="space-y-6">
            {/* Upload */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">1) Upload PDF</h2>

              <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFileChange} />

              <button
                className="w-full py-3 rounded-lg border-2 border-dashed border-slate-300 hover:border-slate-400 text-slate-700 font-medium transition"
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? `✅ ${file.name}` : 'Click to Upload PDF'}
              </button>

              {extraction.status === 'processing' && (
                <div className="mt-3 text-sm text-slate-600">
                  Extracting text... Page {extraction.currentPage} / {extraction.totalPageCount || '...'}
                </div>
              )}

              {extraction.status === 'completed' && (
                <div className="mt-3 text-sm text-green-700">✅ Text extracted successfully!</div>
              )}

              {extraction.status === 'error' && (
                <div className="mt-3 text-sm text-red-700">❌ Failed to extract text. Try another PDF.</div>
              )}
            </div>

            {/* Settings */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">2) Voice & Pacing</h2>

              <label className="block text-sm font-medium text-slate-700 mb-2">Choose voice</label>
              <select
                className="w-full p-3 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-400"
                value={config.voiceId}
                onChange={(e) => setConfig((prev) => ({ ...prev, voiceId: e.target.value }))}
              >
                {VOICE_OPTIONS.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>

              <div className="mt-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Narration speed: {config.speed.toFixed(1)}x (lower = slower)
                </label>
                <input
                  type="range"
                  min={0.7}
                  max={1.2}
                  step={0.1}
                  value={config.speed}
                  onChange={(e) => setConfig((prev) => ({ ...prev, speed: parseFloat(e.target.value) }))}
                  className="w-full"
                />
              </div>

              <div className="mt-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">MP3 quality</label>
                <div className="flex gap-3">
                  <button
                    className={`flex-1 py-2 rounded-lg border ${
                      config.quality === 'standard'
                        ? 'bg-sky-50 border-sky-400 text-sky-800'
                        : 'border-slate-300 text-slate-700'
                    }`}
                    onClick={() => setConfig((prev) => ({ ...prev, quality: 'standard' }))}
                  >
                    Standard (96kbps)
                  </button>
                  <button
                    className={`flex-1 py-2 rounded-lg border ${
                      config.quality === 'high'
                        ? 'bg-sky-50 border-sky-400 text-sky-800'
                        : 'border-slate-300 text-slate-700'
                    }`}
                    onClick={() => setConfig((prev) => ({ ...prev, quality: 'high' }))}
                  >
                    High (128kbps)
                  </button>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-slate-700">Smart narration mode</div>
                  <div className="text-xs text-slate-500">
                    Reads citations/sub-text differently (better clarity)
                  </div>
                </div>
                <button
                  className={`px-3 py-2 rounded-lg text-xs font-bold border ${
                    smartNarration ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                  }`}
                  onClick={() => setSmartNarration((v) => !v)}
                >
                  {smartNarration ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Generate */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">3) Convert to MP3 Audiobook</h2>

              <button
                className="w-full py-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!canGenerate}
                onClick={generateAudiobook}
              >
                {generation.status === 'generating' ? `Generating... ${generation.progress}%` : 'Create Audiobook (MP3)'}
              </button>

              {generation.status === 'generating' && (
                <button
                  className="w-full mt-3 py-3 rounded-lg bg-amber-100 text-amber-800 font-semibold hover:bg-amber-200 transition"
                  onClick={cancelConversion}
                >
                  Cancel Conversion
                </button>
              )}

              {generation.status === 'error' && (
                <div className="mt-4 text-sm text-red-700">❌ {generation.error || 'Something went wrong'}</div>
              )}

              {generation.status === 'cancelled' && (
                <div className="mt-4 text-sm text-amber-700">⚠️ Conversion cancelled.</div>
              )}
            </div>
          </div>

          {/* RIGHT */}
          <div className="space-y-6">
            {/* Preview */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Extracted Text Preview</h2>
              <div className="h-56 overflow-y-auto custom-scrollbar text-sm text-slate-700 whitespace-pre-wrap">
                {extraction.text
                  ? normalizeExtractedText(extraction.text).slice(0, 5000) +
                    (extraction.text.length > 5000 ? '…' : '')
                  : 'Upload a PDF to see extracted text here.'}
              </div>
            </div>

            {/* Audio Player */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Audio Player</h2>

              {generation.audioUrl ? (
                <>
                  <audio ref={audioRef} controls className="w-full mb-4" />

                  <div className="mb-4">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Playback speed: {playbackRate.toFixed(2)}x
                    </label>
                    <input
                      type="range"
                      min={0.75}
                      max={1.5}
                      step={0.05}
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-xs text-slate-500 mt-1">
                      (This changes listening speed only — file stays MP3)
                    </div>
                  </div>

                  <button
                    className="w-full py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-500 transition"
                    onClick={downloadAudio}
                  >
                    Download MP3
                  </button>

                  <button
                    className="w-full mt-3 py-3 rounded-lg bg-sky-50 border border-sky-300 text-sky-800 font-semibold hover:bg-sky-100 transition"
                    onClick={generateAudiobook}
                  >
                    Re-generate with current voice/speed
                  </button>
                </>
              ) : (
                <div className="text-sm text-slate-600">Generate audio to preview and download here.</div>
              )}
            </div>

            {/* Helpful info */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-2">Notes</h2>
              <ul className="text-sm text-slate-700 list-disc pl-5 space-y-2">
                <li>
                  Smart narration reads citations / sub-text differently so they stand out.
                </li>
                <li>
                  We add real silence breaks between paragraphs for better listening.
                </li>
                <li>
                  MP3 download is smaller and easier to store than WAV.
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="p-4 text-center text-xs text-slate-500 border-t border-slate-200">
          Built with Gemini TTS + PDF.js • MP3 Export Enabled
        </div>
      </div>
    </div>
  );
};

export default App;

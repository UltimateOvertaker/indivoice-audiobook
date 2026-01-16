import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { VOICE_OPTIONS, MAX_TEXT_CHUNK_SIZE } from './constants';
import { VoiceOption, AudiobookConfig, ExtractionStatus, AudioGenerationStatus, VoiceGender } from './types';
import { decodeBase64, createWavBlob } from './audioUtils';

// Global reference for PDF.js provided by the script tag in index.html
declare const pdfjsLib: any;

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [extraction, setExtraction] = useState<ExtractionStatus>({
    totalPageCount: 0,
    currentPage: 0,
    text: '',
    status: 'idle',
  });
  const [config, setConfig] = useState<AudiobookConfig>({
    voiceId: VOICE_OPTIONS[1].id, // Aditi (Warm)
    speed: 1.0,
    quality: 'high',
  });
  const [generation, setGeneration] = useState<AudioGenerationStatus>({
    progress: 0,
    status: 'idle',
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    // Initialize PDF.js worker using a compatible version URL
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setGeneration({ status: 'idle', progress: 0 });
      extractText(selectedFile);
    }
  };

  const extractText = async (pdfFile: File) => {
    if (typeof pdfjsLib === 'undefined') {
      setExtraction(prev => ({ ...prev, status: 'error' }));
      console.error("PDF.js not loaded yet.");
      return;
    }

    setExtraction({ totalPageCount: 0, currentPage: 0, text: '', status: 'processing' });
    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      let fullText = '';
      setExtraction(prev => ({ ...prev, totalPageCount: pdf.numPages }));

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item: any) => item.str).join(' ');
        fullText += pageText + ' ';
        setExtraction(prev => ({ ...prev, currentPage: i, text: fullText }));
      }
      
      setExtraction(prev => ({ ...prev, status: 'completed' }));
    } catch (error) {
      console.error('PDF Extraction Error:', error);
      setExtraction(prev => ({ ...prev, status: 'error' }));
    }
  };

  const generateAudiobook = async () => {
    if (!extraction.text) return;

    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    setGeneration({ status: 'generating', progress: 0 });

    try {
      // Split text into chunks to avoid request size limits
      const textChunks = [];
      for (let i = 0; i < extraction.text.length; i += MAX_TEXT_CHUNK_SIZE) {
        textChunks.push(extraction.text.slice(i, i + MAX_TEXT_CHUNK_SIZE));
      }

      const selectedVoice = VOICE_OPTIONS.find(v => v.id === config.voiceId);
      if (!selectedVoice) throw new Error("Selected voice not found");

      const audioChunks: Uint8Array[] = [];

      for (let i = 0; i < textChunks.length; i++) {
        const chunkText = textChunks[i];

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ parts: [{ text: chunkText }] }],
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

        if (!base64Audio) {
          throw new Error("No audio returned from Gemini");
        }

        const audioBytes = decodeBase64(base64Audio);
        audioChunks.push(audioBytes);

        setGeneration({
          status: 'generating',
          progress: Math.round(((i + 1) / textChunks.length) * 100),
        });
      }

      // Combine audio chunks
      const combined = new Uint8Array(audioChunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of audioChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Convert PCM bytes -> WAV blob for download/playback
      const pcmData = new Int16Array(combined.buffer);
      const wavBlob = createWavBlob(pcmData, 24000);

      const audioUrl = URL.createObjectURL(wavBlob);

      setGeneration({
        status: 'completed',
        progress: 100,
        audioUrl,
      });

      if (audioRef.current) {
        audioRef.current.src = audioUrl;
      }
    } catch (error: any) {
      console.error("Audiobook generation failed:", error);
      setGeneration({
        status: 'error',
        progress: 0,
        error: error?.message || "Something went wrong",
      });
    }
  };

  const downloadAudio = () => {
    if (!generation.audioUrl) return;
    const link = document.createElement('a');
    link.href = generation.audioUrl;
    link.download = `${file?.name.replace('.pdf', '') || 'audiobook'}.wav`;
    link.click();
  };

  const selectedVoice = VOICE_OPTIONS.find(v => v.id === config.voiceId);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-white/80 backdrop-blur-sm shadow-xl rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-slate-200 bg-gradient-to-r from-rose-50 to-sky-50">
          <h1 className="text-3xl font-bold text-slate-900">IndiVoice PDF Audiobook</h1>
          <p className="text-slate-600 mt-1">Convert your PDFs into audiobooks with natural Indian voices.</p>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column */}
          <div className="space-y-6">
            {/* Upload Section */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">1) Upload PDF</h2>

              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />

              <button
                className="w-full py-3 rounded-lg border-2 border-dashed border-slate-300 hover:border-slate-400 text-slate-700 font-medium transition"
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? `✅ ${file.name}` : "Click to Upload PDF"}
              </button>

              {extraction.status === 'processing' && (
                <div className="mt-3 text-sm text-slate-600">
                  Extracting text... Page {extraction.currentPage} / {extraction.totalPageCount || '...'}
                </div>
              )}

              {extraction.status === 'completed' && (
                <div className="mt-3 text-sm text-green-700">
                  ✅ Text extracted successfully!
                </div>
              )}

              {extraction.status === 'error' && (
                <div className="mt-3 text-sm text-red-700">
                  ❌ Failed to extract text. Try another PDF.
                </div>
              )}
            </div>

            {/* Voice Settings */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">2) Voice Settings</h2>

              {/* Voice selection */}
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Choose voice
              </label>
              <select
                className="w-full p-3 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-400"
                value={config.voiceId}
                onChange={(e) => setConfig(prev => ({ ...prev, voiceId: e.target.value }))}
              >
                {VOICE_OPTIONS.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({voice.gender === VoiceGender.MALE ? 'Male' : 'Female'})
                  </option>
                ))}
              </select>

              {/* Speed */}
              <div className="mt-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Reading speed: {config.speed.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min={0.7}
                  max={1.3}
                  step={0.1}
                  value={config.speed}
                  onChange={(e) => setConfig(prev => ({ ...prev, speed: parseFloat(e.target.value) }))}
                  className="w-full"
                />
              </div>

              {/* Quality */}
              <div className="mt-5">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Audio quality
                </label>
                <div className="flex gap-3">
                  <button
                    className={`flex-1 py-2 rounded-lg border ${
                      config.quality === 'standard'
                        ? 'bg-sky-50 border-sky-400 text-sky-800'
                        : 'border-slate-300 text-slate-700'
                    }`}
                    onClick={() => setConfig(prev => ({ ...prev, quality: 'standard' }))}
                  >
                    Standard
                  </button>
                  <button
                    className={`flex-1 py-2 rounded-lg border ${
                      config.quality === 'high'
                        ? 'bg-sky-50 border-sky-400 text-sky-800'
                        : 'border-slate-300 text-slate-700'
                    }`}
                    onClick={() => setConfig(prev => ({ ...prev, quality: 'high' }))}
                  >
                    High
                  </button>
                </div>
              </div>
            </div>

            {/* Generate */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">3) Generate Audiobook</h2>

              <button
                className="w-full py-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={extraction.status !== 'completed' || generation.status === 'generating'}
                onClick={generateAudiobook}
              >
                {generation.status === 'generating' ? "Generating..." : "Create Audio"}
              </button>

              {generation.status === 'generating' && (
                <div className="mt-4">
                  <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-sky-500 h-2"
                      style={{ width: `${generation.progress}%` }}
                    />
                  </div>
                  <div className="text-sm text-slate-600 mt-2">
                    Progress: {generation.progress}%
                  </div>
                </div>
              )}

              {generation.status === 'error' && (
                <div className="mt-4 text-sm text-red-700">
                  ❌ {generation.error || "Something went wrong"}
                </div>
              )}
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Extracted Text Preview */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Extracted Text Preview</h2>
              <div className="h-56 overflow-y-auto custom-scrollbar text-sm text-slate-700 whitespace-pre-wrap">
                {extraction.text ? extraction.text.slice(0, 5000) + (extraction.text.length > 5000 ? '…' : '') : "Upload a PDF to see extracted text here."}
              </div>
            </div>

            {/* Audio Player */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-3">Audio Player</h2>

              {generation.audioUrl ? (
                <>
                  <audio ref={audioRef} controls className="w-full mb-4" />
                  <button
                    className="w-full py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-500 transition"
                    onClick={downloadAudio}
                  >
                    Download WAV
                  </button>
                </>
              ) : (
                <div className="text-sm text-slate-600">
                  Generate audio to preview and download here.
                </div>
              )}
            </div>

            {/* Helpful Info */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900 mb-2">Current Selection</h2>
              <div className="text-sm text-slate-700">
                <div><span className="font-semibold">Voice:</span> {selectedVoice?.name}</div>
                <div><span className="font-semibold">Speed:</span> {config.speed.toFixed(1)}x</div>
                <div><span className="font-semibold">Quality:</span> {config.quality}</div>
              </div>
              <p className="text-xs text-slate-500 mt-3">
                Tip: For large PDFs, generation can take time because the text is split into chunks for stable audio output.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 text-center text-xs text-slate-500 border-t border-slate-200">
          Built with Gemini TTS + PDF.js • Hobby project
        </div>
      </div>
    </div>
  );
};

export default App;

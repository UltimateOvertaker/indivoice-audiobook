
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { VOICE_OPTIONS, MAX_TEXT_CHUNK_SIZE } from './constants';
import { VoiceOption, AudiobookConfig, ExtractionStatus, AudioGenerationStatus, VoiceGender } from './types';
import { decodeBase64, createWavBlob } from './utils/audioUtils';

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

    setGeneration({ status: 'generating', progress: 0 });
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const selectedVoice = VOICE_OPTIONS.find(v => v.id === config.voiceId)!;
      
      const cleanText = extraction.text.replace(/\s+/g, ' ').trim();
      
      // Split text into chunks
      const textChunks: string[] = [];
      let currentIdx = 0;
      while (currentIdx < cleanText.length) {
        let chunk = cleanText.substring(currentIdx, currentIdx + MAX_TEXT_CHUNK_SIZE);
        if (currentIdx + MAX_TEXT_CHUNK_SIZE < cleanText.length) {
          const lastPeriod = chunk.lastIndexOf('.');
          if (lastPeriod > MAX_TEXT_CHUNK_SIZE * 0.7) {
            chunk = chunk.substring(0, lastPeriod + 1);
          }
        }
        textChunks.push(chunk);
        currentIdx += chunk.length;
      }

      const pcmChunks: Int16Array[] = [];
      const totalChunks = textChunks.length;

      for (let i = 0; i < totalChunks; i++) {
        const chunk = textChunks[i].trim();
        if (!chunk) continue;

        const prompt = `Read this text clearly as an Indian audiobook narrator. 
        Tone: ${selectedVoice.name}. 
        Speed factor: ${config.speed}.
        Text: "${chunk}"`;

        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
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
        if (base64Audio) {
          const bytes = decodeBase64(base64Audio);
          pcmChunks.push(new Int16Array(bytes.buffer));
        }

        setGeneration(prev => ({ 
          ...prev, 
          progress: Math.round(((i + 1) / totalChunks) * 100) 
        }));
      }

      if (pcmChunks.length === 0) throw new Error("No audio was generated.");

      const totalLength = pcmChunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const combinedPcm = new Int16Array(totalLength);
      let offset = 0;
      for (const chunk of pcmChunks) {
        combinedPcm.set(chunk, offset);
        offset += chunk.length;
      }

      const wavBlob = createWavBlob(combinedPcm, 24000);
      const audioUrl = URL.createObjectURL(wavBlob);
      
      setGeneration({
        status: 'completed',
        progress: 100,
        audioUrl,
      });

    } catch (error: any) {
      console.error('Audio Generation Error:', error);
      setGeneration({
        status: 'error',
        progress: 0,
        error: error.message || 'Failed to generate audio.',
      });
    }
  };

  const downloadAudio = () => {
    if (generation.audioUrl) {
      const link = document.createElement('a');
      link.href = generation.audioUrl;
      link.download = `IndiVoice_${file?.name.replace('.pdf', '') || 'Audio'}.wav`;
      link.click();
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 md:py-16">
      <header className="text-center mb-10">
        <div className="inline-block bg-indigo-100 text-indigo-700 px-4 py-1 rounded-full text-xs font-bold tracking-widest uppercase mb-4">
          PDF to Audiobook
        </div>
        <h1 className="text-4xl md:text-5xl font-black text-indigo-950 mb-3">
          IndiVoice <span className="text-indigo-500">🎧</span>
        </h1>
        <p className="text-slate-500 text-lg max-w-xl mx-auto">
          Convert PDFs into audiobooks with soulful Indian voices.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-4 space-y-6">
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
                <p className="text-[10px] font-bold text-indigo-600 mt-2">Reading: {extraction.currentPage}/{extraction.totalPageCount}</p>
              )}
            </div>
          </section>

          <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">2. Voice Settings</h2>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {VOICE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setConfig({ ...config, voiceId: v.id })}
                  className={`p-2 rounded-xl border text-[10px] font-bold transition-all ${
                    config.voiceId === v.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-100 bg-slate-50 text-slate-500'
                  }`}
                >
                  {v.name.split(' ')[0]} ({v.gender === VoiceGender.MALE ? 'M' : 'F'})
                </button>
              ))}
            </div>
            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Speed: {config.speed}x</label>
            <input 
              type="range" min="0.5" max="1.5" step="0.1" 
              className="w-full h-1 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              value={config.speed}
              onChange={(e) => setConfig({ ...config, speed: parseFloat(e.target.value) })}
            />
          </section>

          <button
            disabled={extraction.status !== 'completed' || generation.status === 'generating'}
            onClick={generateAudiobook}
            className="w-full bg-indigo-600 text-white font-bold py-4 rounded-2xl shadow-lg hover:bg-indigo-700 disabled:bg-slate-300 transition-all flex items-center justify-center gap-2"
          >
            {generation.status === 'generating' ? `Narrating... ${generation.progress}%` : 'Create Audio'}
          </button>
        </div>

        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col min-h-[400px]">
            <div className="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
              <h3 className="text-xs font-bold text-slate-500 uppercase">Text Preview</h3>
              {extraction.text && <span className="text-[10px] font-bold text-slate-400">{extraction.text.length} characters</span>}
            </div>
            <div className="flex-1 p-6 overflow-y-auto max-h-[400px] custom-scrollbar text-slate-600 leading-relaxed text-sm font-serif italic whitespace-pre-wrap">
              {extraction.text || <div className="h-full flex items-center justify-center text-slate-300 italic">No document loaded</div>}
            </div>
            
            {generation.status !== 'idle' && (
              <div className="p-6 bg-indigo-900 text-white">
                {generation.status === 'generating' ? (
                  <div className="w-full bg-indigo-800 h-1.5 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-400 transition-all" style={{ width: `${generation.progress}%` }}></div>
                  </div>
                ) : generation.status === 'completed' ? (
                  <div className="flex flex-col md:flex-row items-center gap-4">
                    <audio ref={audioRef} controls src={generation.audioUrl} className="flex-1 h-8 brightness-110 invert hue-rotate-180" />
                    <button onClick={downloadAudio} className="bg-white text-indigo-900 px-4 py-2 rounded-xl text-xs font-bold">DOWNLOAD</button>
                  </div>
                ) : (
                  <p className="text-xs text-red-300">{generation.error}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;

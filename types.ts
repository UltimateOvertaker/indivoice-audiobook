export enum VoiceGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
}

export interface VoiceOption {
  id: string;
  name: string;
  gender: VoiceGender;
  geminiVoice: string;
}

export interface AudiobookConfig {
  voiceId: string;
  speed: number;
  quality: 'standard' | 'high';
}

export interface ExtractionStatus {
  totalPageCount: number;
  currentPage: number;
  text: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
}

export type ChapterStatus =
  | 'pending'
  | 'queued'
  | 'converting'
  | 'completed'
  | 'cancelled'
  | 'skipped'
  | 'error';

export interface Chapter {
  id: string;
  title: string;
  startPage: number; // 1-indexed
  endPage: number; // 1-indexed
  text: string;
  selected: boolean;
  status: ChapterStatus;
  progress: number; // 0-100
  audioUrl?: string;
  error?: string;
}

export interface AudioGenerationStatus {
  progress: number; // overall 0-100
  status: 'idle' | 'generating' | 'completed' | 'cancelled' | 'error';
  currentChapterId?: string;
  error?: string;
}

export interface VoicePreviewStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  voiceId?: string;
  audioUrl?: string;
  error?: string;
}

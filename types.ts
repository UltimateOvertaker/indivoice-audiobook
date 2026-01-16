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
  speed: number; // UI playback speed (player rate)
  quality: 'standard' | 'high';
}

export interface ExtractionStatus {
  totalPageCount: number;
  currentPage: number;
  text: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
}

export type ChapterStatus =
  | 'idle'
  | 'pending'
  | 'generating'
  | 'completed'
  | 'skipped'
  | 'cancelled'
  | 'error';

export interface PdfChapter {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  selected: boolean;
  status: ChapterStatus;
  progress: number; // 0-100 for that chapter
  audioUrl?: string;
  error?: string;
}

export interface AudioGenerationStatus {
  progress: number; // overall progress 0-100
  status: 'idle' | 'generating' | 'completed' | 'error' | 'cancelled';
  currentChapterTitle?: string;
  error?: string;
}

export interface BookMeta {
  id: string; // internal id
  fileName: string; // pdf file name
  title: string; // metadata title or editable
  author: string; // metadata author or editable
  totalPages: number;
  createdAt: number;
}

export interface HistoryBook {
  meta: BookMeta;
  chapters: Array<{
    id: string;
    title: string;
    startPage: number;
    endPage: number;
    hasAudio: boolean;
  }>;
}

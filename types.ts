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
  speed: number; // 0.7–1.2 (instruction-based)
  quality: 'standard' | 'high'; // mp3 bitrate
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
  audioUrl?: string; // MP3 URL
  error?: string;
}

export interface AudioGenerationStatus {
  progress: number; // overall 0-100
  status: 'idle' | 'generating' | 'completed' | 'cancelled' | 'error';
  currentChapterId?: string;
  error?: string;
}

export type SegmentType = 'narration' | 'meta';

export interface TextSegment {
  type: SegmentType;
  text: string;
}

export interface VoicePreviewStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  voiceId?: string;
  audioUrl?: string; // MP3 preview URL
  error?: string;
}

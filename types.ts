export enum VoiceGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE'
}

export interface VoiceOption {
  id: string;
  name: string;
  gender: VoiceGender;
  geminiVoice: string;
}

export interface AudiobookConfig {
  voiceId: string;
  speed: number; // "requested" reading speed (instruction-based)
  quality: 'standard' | 'high'; // affects MP3 bitrate
}

export interface ExtractionStatus {
  totalPageCount: number;
  currentPage: number;
  text: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
}

export interface AudioGenerationStatus {
  progress: number;
  status: 'idle' | 'generating' | 'completed' | 'cancelled' | 'error';
  audioUrl?: string;
  error?: string;
}

export type SegmentType = 'narration' | 'meta';

export interface TextSegment {
  type: SegmentType;
  text: string;
}

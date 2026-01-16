
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
  speed: number;
  quality: 'standard' | 'high';
}

export interface ExtractionStatus {
  totalPageCount: number;
  currentPage: number;
  text: string;
  status: 'idle' | 'processing' | 'completed' | 'error';
}

export interface AudioGenerationStatus {
  progress: number;
  status: 'idle' | 'generating' | 'completed' | 'error';
  audioUrl?: string;
  error?: string;
}

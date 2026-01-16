import { VoiceOption, VoiceGender } from './types';

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'v1', name: 'Arjun (Professional)', gender: VoiceGender.MALE, geminiVoice: 'Puck' },
  { id: 'v2', name: 'Aditi (Warm)', gender: VoiceGender.FEMALE, geminiVoice: 'Kore' },
  { id: 'v3', name: 'Rohan (Clear)', gender: VoiceGender.MALE, geminiVoice: 'Charon' },
  { id: 'v4', name: 'Sia (Narrative)', gender: VoiceGender.FEMALE, geminiVoice: 'Zephyr' },
];

// Characters per TTS request to ensure stability
export const MAX_TEXT_CHUNK_SIZE = 2500;

// Gemini TTS model
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// Gemini TTS returns PCM @ 24kHz (commonly used in examples)
export const TTS_SAMPLE_RATE = 24000;

// Preview sample text for narrator voice preview
export const VOICE_PREVIEW_TEXT =
  "Hello! This is a voice preview for your audiobook narration. " +
  "I will read clearly with a natural Indian accent and a comfortable pace.";

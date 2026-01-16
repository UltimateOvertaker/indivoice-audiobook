import { VoiceOption, VoiceGender } from './types';

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'v1', name: 'Arjun (Professional)', gender: VoiceGender.MALE, geminiVoice: 'Puck' },
  { id: 'v2', name: 'Aditi (Warm)', gender: VoiceGender.FEMALE, geminiVoice: 'Kore' },
  { id: 'v3', name: 'Rohan (Clear)', gender: VoiceGender.MALE, geminiVoice: 'Charon' },
  { id: 'v4', name: 'Sia (Narrative)', gender: VoiceGender.FEMALE, geminiVoice: 'Zephyr' },
];

// Keep this moderate to avoid request-size issues
export const MAX_TEXT_CHUNK_SIZE = 2400;

// Used for voice preview + narration tuning
export const VOICE_PREVIEW_TEXT =
  "Hello! This is a quick preview of the narrator voice for your audiobook. The pace is natural, with clear pauses and good intonation.";

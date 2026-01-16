import { VoiceOption, VoiceGender } from './types';

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'v1', name: 'Arjun (Professional)', gender: VoiceGender.MALE, geminiVoice: 'Puck' },
  { id: 'v2', name: 'Aditi (Warm)', gender: VoiceGender.FEMALE, geminiVoice: 'Kore' },
  { id: 'v3', name: 'Rohan (Clear)', gender: VoiceGender.MALE, geminiVoice: 'Charon' },
  { id: 'v4', name: 'Sia (Narrative)', gender: VoiceGender.FEMALE, geminiVoice: 'Zephyr' },
];

export const MAX_TEXT_CHUNK_SIZE = 2500; // Characters per TTS request to ensure stability

// Short text used when previewing voices
export const VOICE_PREVIEW_TEXT =
  "Hello! This is a quick preview of the narrator's voice for your audiobook. Let's begin.";

// If no clear chapter headings are found, we split the PDF into approximate sections
export const FALLBACK_SECTION_PAGES = 5;

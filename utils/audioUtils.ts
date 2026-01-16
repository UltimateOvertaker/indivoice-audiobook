import lamejs from 'lamejs';

export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Create silence PCM (16-bit mono) for X seconds */
export function createSilencePCM(seconds: number, sampleRate: number): Int16Array {
  const totalSamples = Math.max(0, Math.floor(seconds * sampleRate));
  return new Int16Array(totalSamples); // zeros
}

/** Create MP3 blob from PCM 16-bit mono data */
export function createMp3Blob(pcmData: Int16Array, sampleRate: number, kbps = 96): Blob {
  const mp3Encoder = new (lamejs as any).Mp3Encoder(1, sampleRate, kbps);
  const mp3Chunks: Uint8Array[] = [];

  const chunkSize = 1152;
  for (let i = 0; i < pcmData.length; i += chunkSize) {
    const chunk = pcmData.subarray(i, i + chunkSize);
    const mp3buf = mp3Encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) mp3Chunks.push(new Uint8Array(mp3buf));
  }

  const end = mp3Encoder.flush();
  if (end.length > 0) mp3Chunks.push(new Uint8Array(end));

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

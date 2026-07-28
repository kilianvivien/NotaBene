export function decodeBase64Pcm(value: string): Uint8Array {
  const binary = atob(value);
  if (binary.length % 2 !== 0) throw new Error('PCM16 payload has an odd byte length');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Little-endian signed PCM16 to Web Audio's normalized float format. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  if (bytes.byteLength % 2 !== 0) throw new Error('PCM16 payload has an odd byte length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < output.length; index += 1) {
    const value = view.getInt16(index * 2, true);
    output[index] = value < 0 ? value / 32768 : value / 32767;
  }
  return output;
}

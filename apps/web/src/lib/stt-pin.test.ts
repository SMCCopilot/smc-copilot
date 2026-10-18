import type { ModelFile } from '@smc/capture-kit';
import { describe, expect, it } from 'vitest';
import { pinnedFor } from './stt-pin';

const REV = '2575352d61be1bf7225cf8f8b268a4678025fc58';
const file = (path: string): ModelFile =>
  ({
    id: path,
    url: `https://huggingface.co/onnx-community/whisper-tiny.en/resolve/${REV}/${path}`,
    sha256: 'x',
    bytes: 1,
  }) as ModelFile;
const files = [file('config.json'), file('onnx/encoder_model_quantized.onnx')];

describe('pinnedFor', () => {
  it('matches the exact pinned address', () => {
    expect(pinnedFor(files[0]?.url as string, files)).toBe(files[0]);
  });

  it('maps the library’s resolve/main request to the pinned file of the same repository and path', () => {
    const asked =
      'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/onnx/encoder_model_quantized.onnx';
    expect(pinnedFor(asked, files)).toBe(files[1]);
    expect(pinnedFor(`${asked}?download=true`, files)).toBe(files[1]);
  });

  it('knows nothing about other repositories, other paths or other hosts', () => {
    expect(
      pinnedFor('https://huggingface.co/someone/else/resolve/main/config.json', files),
    ).toBeUndefined();
    expect(
      pinnedFor(
        'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/unlisted.bin',
        files,
      ),
    ).toBeUndefined();
    expect(pinnedFor('https://evil.example/config.json', files)).toBeUndefined();
  });
});

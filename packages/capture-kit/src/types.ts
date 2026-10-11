/**
 * Browser-side capture types (A02 section 3). A frame is a plain RGBA buffer so everything here runs in a Web Worker
 * or in Node tests with no DOM. Frames are used and dropped; only text ever leaves the device.
 */
export interface Frame {
  width: number;
  height: number;
  /** RGBA, row-major, length = width * height * 4. */
  data: Uint8ClampedArray;
}

/** Region of interest in frame pixels: the chart area, so toolbars and other panels are never read. */
export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One recognised line of text with its box in ROI pixels: [x1, y1, x2, y2]. */
export interface OcrLine {
  text: string;
  conf: number;
  box: readonly [number, number, number, number];
}

export interface OcrEngineInfo {
  name: 'paddleocr-web' | 'tesseract-js';
  version: string;
  backend: 'webgpu' | 'wasm';
}

/** The seam to the real recogniser (PaddleOCR over onnxruntime-web, spike S1). Everything else is engine-agnostic. */
export interface OcrEngine {
  readonly info: OcrEngineInfo;
  recognize(frame: Frame): Promise<OcrLine[]>;
}

import { readFileSync } from 'node:fs';
import { type Canvas, type SKRSContext2D, createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type CanvasAndContext = {
  canvas: Canvas;
  context: SKRSContext2D;
};

// pdfjs-dist는 페이지 내 이미지 XObject를 실제 렌더링 시점에만 디코딩하므로
// (getOperatorList만으로는 원본 픽셀 데이터에 접근 불가), 이미지 텍스트를
// 얻으려면 페이지 전체를 캔버스에 그려서 OCR로 넘기는 방식이 유일한 방법임
class NodeCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext: CanvasAndContext, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: CanvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

export async function renderPDFPageToPng(pdfPath: string, pageNumber: number, scale = 2): Promise<Uint8Array> {
  const data = new Uint8Array(readFileSync(pdfPath));
  const canvasFactory = new NodeCanvasFactory();
  // pdfjs-dist의 레거시 Node 렌더링 경로(canvasFactory)는 타입 선언에 없지만
  // 런타임에서는 지원됨 — @napi-rs/canvas 조합으로 동작 확인함
  const doc = await getDocument({ data, canvasFactory, isEvalSupported: false } as never).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: canvasAndContext.context, viewport, canvasFactory } as never).promise;
  return canvasAndContext.canvas.toBuffer('image/png');
}

// 렌더링 없이 페이지 수만 저렴하게 확인 (PDF_INLINE_PAGE_LIMIT 체크용)
export async function getPDFPageCount(pdfPath: string): Promise<number> {
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await getDocument({ data, isEvalSupported: false } as never).promise;
  return doc.numPages;
}

// 이 파일은 "OCR(이미지 속 글자 인식) 담당 모듈"입니다.

// 지금은 tesseract.js로 구현돼 있지만, 밖에서 이 파일을 쓰는 코드(kordoc 훅, read/readFile.ts 등)는
// tesseractOcr / ocrEmbeddedImage / terminateOcrWorker 이 3개 함수 이름만 알면 됩니다.

// 나중에 다른 OCR 엔진(Scribe.js 등)으로 바꾸고 싶으면, 이 파일 안쪽 구현만 갈아끼우면 되고
// 이 파일을 가져다 쓰는 다른 코드는 전혀 손댈 필요가 없습니다.
import * as Tesseract from 'tesseract.js';
import type { OcrProvider } from 'kordoc';

// tesseract.js의 OCR 엔진(worker)은 하나 띄우는 데 시간이 걸리기 때문에,
// 매번 새로 만들지 않고 앱이 켜져 있는 동안 딱 하나만 만들어서 계속 재사용함.
// workerPromise가 null이면 "아직 안 만든 상태", 값이 있으면 "이미 만들었거나 만드는 중".
let workerPromise: Promise<Tesseract.Worker> | null = null;

// worker를 가져오는 함수. 이미 있으면 그대로 반환하고, 없으면 새로 하나 만듦(한/영 인식).
function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('kor+eng');
  }
  return workerPromise;
}

// 실제로 이미지 한 장을 OCR 돌려서 텍스트로 바꾸는 핵심 함수.
// image: 이미지 파일의 바이트 데이터(PNG 등) → 반환값: 인식된 텍스트(공백 정리 후)
async function recognizeText(image: Uint8Array): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(Buffer.from(image));
  return data.text.trim();
}

// kordoc이 스캔본(이미지로만 된) PDF 페이지를 만났을 때 자동으로 호출하는 콜백.
// kordoc의 OcrProvider 타입에 맞춰서 recognizeText를 그대로 연결만 해준 것.
export const tesseractOcr: OcrProvider = pageImage => recognizeText(pageImage);

// 텍스트는 있지만 그 안에 사진/캡처 이미지가 박혀있는 문서(DOCX, HWPX, XLSX 등)를 위한 함수.
// 이런 개별 이미지는 kordoc의 ocr 훅이 자동으로 안 불러주기 때문에(그 훅은 페이지 전체가
// 스캔본일 때만 호출됨), read/readFile.ts에서 이 함수를 직접 호출해서 이미지 하나하나를 OCR 돌림.
export async function ocrEmbeddedImage(image: Uint8Array): Promise<string> {
  return recognizeText(image);
}

// 앱을 끌 때 호출. 켜져 있던 tesseract worker를 정리(종료)해서 자원을 깔끔하게 반납함.
// worker를 아예 안 만들었으면(한 번도 OCR을 안 썼으면) 아무것도 안 하고 바로 끝남.
export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

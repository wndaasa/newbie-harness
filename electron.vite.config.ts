import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // boot.ts가 --pet 인자로 본앱(index.ts)과 펫(pet.ts)을 나눠 부른다.
        // 한 번들이라 펫도 src/memory/*를 직접 import한다 — 규약 복제본을 두면
        // 로깅 정책·큐 포맷이 조용히 어긋난다
        input: { index: 'app/main/boot.ts' },
        // 동적으로 불리는 index.ts·pet.ts는 청크가 된다. 기본값(chunks/)에 두면
        // 그 안의 __dirname 기준 상대 경로(../preload, ../renderer)가 한 단계 어긋난다
        output: { chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'app/preload/index.ts', pet: 'app/preload/pet.ts' },
        // Electron은 ESM preload에 .mjs 확장자를 요구함
        output: { entryFileNames: '[name].mjs', format: 'es' },
      },
    },
  },
  renderer: {
    root: 'app/renderer',
    plugins: [react()],
    // 메인 프로세스가 렌더러를 127.0.0.1로 접속하므로(app/main/index.ts rendererUrl)
    // dev 서버도 IPv4에 고정함. host를 비워두면 환경에 따라 localhost가 ::1로
    // 해석돼 IPv6에만 바인딩되고, 메인이 접속하지 못해 ERR_CONNECTION_REFUSED가 남
    server: { host: '127.0.0.1' },
    build: {
      rollupOptions: {
        // 펫 창은 같은 렌더러 빌드의 두 번째 페이지다 (app/main/pet.ts가 연다)
        input: { index: 'app/renderer/index.html', pet: 'app/renderer/pet.html' },
      },
    },
  },
});

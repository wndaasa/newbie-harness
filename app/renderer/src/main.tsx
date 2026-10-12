import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
// 첫 페인트 전에 저장된 테마(data-theme)를 적용하는 부수효과 모듈
import './theme.ts';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React, { isValidElement, memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '../mathDelimiters.ts';
import { CopyButton } from './CopyButton.tsx';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cssLang from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// 번들 크기를 위해 자주 쓰는 언어만 개별 등록 (별칭: js/jsx, ts/tsx, html, sh 등 포함)
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', cssLang);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

const EXT_LANGUAGES: Record<string, string> = {
  cjs: 'javascript',
  css: 'css',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  ps1: 'powershell',
  py: 'python',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/** 파일 경로의 확장자로 하이라이트 언어를 추정함 */
export function languageForPath(path: string | undefined): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path ?? '')?.[1]?.toLowerCase();
  return ext ? EXT_LANGUAGES[ext] : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** 코드를 hljs로 하이라이트한 HTML 문자열 반환. 미지원 언어는 이스케이프만 함 */
export function highlightHtml(code: string, language?: string): string {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      // 하이라이트 실패 시 아래 폴백으로 진행
    }
  }
  return escapeHtml(code);
}

export function CodeBlock({
  code,
  copyable = false,
  language,
}: {
  code: string;
  /**
   * 우상단에 복사 버튼을 단다. 답변에 담긴 명령을 옮기려면 끌어서 골라야 했다.
   * 버튼은 가로로 스크롤되는 코드 밖에 두어, 긴 줄을 밀어도 제자리에 있다
   */
  copyable?: boolean;
  language?: string;
}) {
  const html = useMemo(() => highlightHtml(code, language), [code, language]);
  const block = (
    <pre className="code-block">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
  if (!copyable) return block;
  return (
    <div className="code-block-wrap">
      {block}
      <CopyButton className="code-copy" label="코드 복사" text={code} />
    </div>
  );
}

// react-markdown이 만든 <pre><code class="language-x"> 트리에서 원문과 언어를 꺼냄
function extractCodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractCodeText).join('');
  if (isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

// 답변의 링크는 http(s)만 살린다. 누르면 창 이동을 메인 프로세스가 가로채 기본
// 브라우저로 넘긴다(index.ts의 will-navigate). 상대 경로·file:·그 밖의 스킴은
// 앱 창 안에서 어디로 갈지 알 수 없으므로 이동하지 않는 글자로만 남긴다
function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// 대화가 이어질 때마다 부모가 다시 그려도, 내용이 같은 답변은 마크다운 파싱을 다시 하지 않는다
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const normalized = useMemo(() => normalizeMathDelimiters(content), [content]);
  return (
    <div className="md">
      {/* remark-gfm: 표·취소선·자동링크 등 GFM 확장 (기본 CommonMark에는 표가 없음)
          remark-math + rehype-katex: $...$·$$...$$ 수식을 KaTeX로 렌더링 */}
      <ReactMarkdown
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath]}
        components={{
          a({ children, href, title }) {
            if (!isExternalHref(href)) return <a title={title}>{children}</a>;
            return (
              <a href={href} rel="noreferrer" title={title}>
                {children}
              </a>
            );
          },
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement(child)) {
              const props = child.props as { children?: React.ReactNode; className?: string };
              const language = /language-([\w+-]+)/.exec(props.className ?? '')?.[1];
              const code = extractCodeText(props.children).replace(/\n$/, '');
              return <CodeBlock code={code} copyable language={language} />;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

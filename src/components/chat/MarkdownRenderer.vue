<script setup>
import { ref, watch, onUnmounted } from 'vue';
import DOMPurify from 'dompurify';
import { useMarkdownWorker } from '../../composables/useMarkdownWorker.js';
import { useCodeHighlighter } from '../../composables/useCodeHighlighter.js';
import { ALLOWED_TAGS, ALLOWED_ATTR, escapeHtml } from '../../utils/markdownConfig.js';
import { renderSanitizedHtml } from '../../utils/markdownRendererCore.js';
import { applyCitationBadges } from '../../utils/citations.js';
import CodeRunner from './CodeRunner.vue';
import 'highlight.js/styles/atom-one-dark.css';

// 仅当代码围栏 (```) 未闭合时补全，内联语法不处理（markdown-it 自能处理）

// Worker for large content (>2000 chars)
const WORKER_THRESHOLD = 2000;
const {
  renderInWorker,
  recordStaleResult,
} = useMarkdownWorker();
// highlightVersion（模块级共享）：动态语言异步注册完成后触发所有气泡重渲染
const { highlightVersion } = useCodeHighlighter();

const props = defineProps({ content: { type: String, default: '' }, sources: { type: Array, default: () => [] }, highlight: { type: String, default: '' } });
const emit = defineEmits(['copyCode', 'citation-click']);

const showRunner = ref(false);
const runnerCode = ref('');
const runnerLanguage = ref('javascript');

/**
 * 搜索词高亮：仅在 HTML 的文本节点中包裹 <mark>（先遮蔽标签，避免误伤属性值）
 * 与 ALLOWED_TAGS 配合：DOMPurify 允许 mark 标签（默认白名单含 mark）
 */
const wrapHighlight = (html) => {
  const keyword = props.highlight;
  if (!keyword || !html) return html;
  const escaped = escapeHtml(keyword);
  if (!escaped) return html;
  const tags = [];
  const masked = html.replace(/<[^>]*>/g, (m) => { tags.push(m); return '\u0001'; });
  if (!masked.includes(escaped)) return html;
  const highlighted = masked.split(escaped).join(`<mark class="search-hit">${escaped}</mark>`);
  let i = 0;
  return highlighted.replaceAll('\u0001', () => tags[i++]);
};

// MarkdownIt 实例与代码高亮收敛在模块级 markdownRendererCore.js（每气泡一份 → 全局一份）
const renderMarkdownMain = (content) => {
  if (!content || content.trim() === '') return '';
  try {
    const sanitized = renderSanitizedHtml(content);
    // 将 【文档N】 / [N] 渲染为可点击、可悬停的行内引用
    return wrapHighlight(applyCitationBadges(sanitized, props.sources));
  } catch (e) {
    console.error('[MarkdownRenderer] 渲染失败:', e);
    return content;
  }
};

const RENDER_THROTTLE_MS = 150;
let throttleTimer = null;

const renderedContent = ref('');
const lastRenderedAt = ref('');
const isLoadingWorker = ref(false);
// 渲染序号：async 渲染（worker 超时后转主线程慢路径）返回时可能已有更新的渲染
// 在途/完成，过期结果不得落地，否则内容回退且 isContentStale 恒真（光标闪烁不消）
let renderSeq = 0;

const renderCitations = (html) => applyCitationBadges(html, props.sources);

  const updateRender = async () => {
    const seq = ++renderSeq;
    const content = props.content;
    const isStale = () => seq !== renderSeq;

    // Use Web Worker for large content; reject 语义：不可用/超时/onerror → 主线程兜底
    if (content && content.length > WORKER_THRESHOLD) {
      isLoadingWorker.value = true;
      try {
        const html = await renderInWorker(content);
        if (isStale()) {
          recordStaleResult();
          return;
        }
        if (html) {
          renderedContent.value = wrapHighlight(renderCitations(DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })));
          lastRenderedAt.value = content;
        } else {
          // Worker fallback
          renderedContent.value = renderMarkdownMain(content);
          lastRenderedAt.value = content;
        }
      } catch {
        // Worker 失败/超时/不可用 → 主线程兜底（与原 fallback 行为一致）
        if (isStale()) {
          recordStaleResult();
          return;
        }
        renderedContent.value = renderMarkdownMain(content);
        lastRenderedAt.value = content;
      }
      isLoadingWorker.value = false;
    } else {
      // 小内容不走 worker：若此前有一轮 worker 渲染把指示器点亮（内容被替换的场景），在这里熄灭
      isLoadingWorker.value = false;
      renderedContent.value = renderMarkdownMain(content);
      lastRenderedAt.value = content;
    }
  };

// 初始渲染同样走 updateRender：大内容（>2000 字符）应享受 worker 路径，
// 此前 setup 里无条件同步渲染，打开多条长消息的历史会话时全部挤在主线程。
// 不能 top-level await（会把组件变成异步组件，需要 Suspense 边界）；
// 小内容路径内部无 await，调用即同步完成
updateRender();

watch(
  () => [
    props.content,
    highlightVersion.value,
    (Array.isArray(props.sources) ? props.sources : [])
      .map((source) => `${source?.docId || source?.id || source?.title || ''}:${source?.title || ''}`)
      .join('|'),
  ],
  () => {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      updateRender();
      throttleTimer = null;
    }, RENDER_THROTTLE_MS);
  }
);

const isContentStale = () => props.content !== lastRenderedAt.value;

onUnmounted(() => {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
});

const handleClick = (event) => {
  // 行内引用点击
  const citation = event.target.closest('.citation');
  if (citation) {
    const index = parseInt(citation.getAttribute('data-index'), 10);
    if (!isNaN(index)) {
      emit('citation-click', index);
      return;
    }
  }

  const copyBtn = event.target.closest('.copy-code-btn');
  if (copyBtn) {
    const code = decodeURIComponent(copyBtn.getAttribute('data-code') || '');
    if (!code) return;
    navigator.clipboard.writeText(code)
      .then(() => {
        emit('copyCode', code);
        const textSpan = copyBtn.querySelector('.copy-text');
        if (textSpan) {
          const orig = textSpan.innerHTML;
          textSpan.innerHTML = '<span class="text-green-400">已复制</span>';
          setTimeout(() => { textSpan.innerHTML = orig; }, 2000);
        }
      })
      .catch(() => { /* 剪贴板不可用时静默，避免未捕获拒绝 */ });
    return;
  }

  const runBtn = event.target.closest('.run-code-btn');
  if (runBtn) {
    const code = decodeURIComponent(runBtn.getAttribute('data-code') || '');
    const lang = decodeURIComponent(runBtn.getAttribute('data-lang') || '') || 'javascript';
    if (code) {
      runnerCode.value = code;
      runnerLanguage.value = lang;
      showRunner.value = true;
    }
  }
};

</script>

<template>
  <div>
    <!-- Stale: show last rendered + pulsing cursor -->
    <div v-if="isContentStale() && renderedContent" class="prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed">
      <div v-html="renderedContent" @click="handleClick"></div>
      <span class="inline-block w-0.5 h-4 bg-wut-500 animate-pulse ml-0.5 align-middle"></span>
    </div>
    <!-- Worker loading indicator for large content -->
    <div v-else-if="isLoadingWorker" class="prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed">
      <div class="flex items-center gap-2 text-slate-400 dark:text-gray-500 text-sm py-2">
        <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce" style="animation-delay:0.15s"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-wut-500 animate-bounce" style="animation-delay:0.3s"></span>
        <span class="ml-1">渲染中...</span>
      </div>
    </div>
    <!-- Normal rendered content -->
    <div v-else class="prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed prose-p:my-1.5 prose-p:leading-relaxed prose-headings:font-bold prose-headings:my-2 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-ul:my-1 prose-ul:list-disc prose-ul:pl-4 prose-ol:my-1 prose-ol:list-decimal prose-ol:pl-4 prose-li:my-0.5 prose-pre:my-2 prose-pre:p-0 prose-pre:bg-transparent prose-pre:rounded-lg prose-code:px-1 prose-code:py-0.5 prose-code:bg-slate-100 dark:prose-code:bg-gray-700 prose-code:rounded prose-code:text-pink-500 dark:prose-code:text-pink-400 prose-code:font-mono prose-code:text-xs prose-code:before:content-[''] prose-code:after:content-[''] prose-strong:font-bold prose-strong:text-slate-900 dark:prose-strong:text-white prose-a:text-wut-600 dark:prose-a:text-wut-400 prose-a:no-underline hover:prose-a:underline prose-table:my-2 prose-table:w-full prose-table:text-left prose-table:border-collapse prose-th:p-2 prose-th:border prose-th:border-slate-200 dark:prose-th:border-gray-700 prose-th:bg-slate-50 dark:prose-th:bg-gray-800 prose-td:p-2 prose-td:border prose-td:border-slate-200 dark:prose-td:border-gray-700" v-html="renderedContent" @click="handleClick"></div>
    <CodeRunner v-if="showRunner" :code="runnerCode" :language="runnerLanguage" @close="showRunner = false" />
  </div>
</template>

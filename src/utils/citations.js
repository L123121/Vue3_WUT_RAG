/**
 * 行内引用徽章渲染
 *
 * LLM 按提示词输出「【文档 N】」格式的文档引用；部分回答会自发输出 [N] 格式，
 * 这里统一把两种格式渲染成可点击的上标徽章，悬停显示对应来源的标题与摘要。
 *
 * 限制：只处理 HTML 文本片段，<pre>/<code> 区段原样保留（代码里的 [1] 是数组下标）。
 */

const CITATION_PATTERN = /【文档\s*(\d{1,2})】|\[(\d{1,2})\](?!\()/g;

const BADGE_STYLE =
  'display:inline-flex;align-items:center;justify-content:center;min-width:1.25rem;height:1.25rem;' +
  'padding:0 0.25rem;margin:0 0.125rem;font-size:0.6875rem;font-weight:600;border-radius:9999px;' +
  'background:#e0e7ff;color:#4338ca;cursor:pointer;border:1px solid #c7d2fe;vertical-align:super;transition:all 0.15s';

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 来源 N 的悬停提示：标题 + 摘要前 80 字 */
function sourceTooltip(sources, index) {
  const source = sources?.[index - 1];
  if (!source) return '点击查看来源';
  const title = source.title || source.category || '未命名来源';
  const snippet = source.snippet ? String(source.snippet).slice(0, 80) : '';
  return snippet ? `${title}：${snippet}` : title;
}

/**
 * 跳转原文所需的定位信息：文档 ID + 用于高亮的关键词
 * 关键词取 snippet 首个有意义词组（2-12 个中日韩/字母数字字符），与知识库预览的高亮口径一致
 */
export function citationTarget(source) {
  const docId = source?.id || source?.docId || source?.parentId || '';
  const match = String(source?.snippet || '').match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}/);
  return { docId, q: match ? match[0] : '' };
}

/**
 * 把 HTML 中的引用标记替换为徽章
 * @param {string} html - 已 sanitize 的 HTML
 * @param {Array} sources - 来源列表（title/category/snippet）
 * @returns {string}
 */
export function applyCitationBadges(html, sources = []) {
  if (!html || !html.includes('【文档') && !/\[\d{1,2}\]/.test(html)) return html;

  // 先遮蔽 <pre>/<code> 区段（代码内容中的 [1] 不是引用），再全局替换
  const blocks = [];
  const masked = html.replace(/<(pre|code)[\s\S]*?<\/\1>/g, (match) => {
    blocks.push(match);
    return '\u0002';
  });

  const replaced = masked.replace(CITATION_PATTERN, (match, cnNum, bracketNum) => {
    const index = parseInt(cnNum || bracketNum, 10);
    if (!index) return match;
    const tooltip = escapeAttr(sourceTooltip(sources, index));
    return `<span class="citation" data-index="${index}" title="${tooltip}" style="${BADGE_STYLE}">${index}</span>`;
  });

  if (blocks.length === 0) return replaced;
  return replaced.replaceAll('\u0002', () => blocks.shift());
}

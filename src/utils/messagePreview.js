// 消息预览工具：去除 markdown 标记、生成会话列表预览文本。
// 从 conversation.store.js 拆出的纯函数模块。

import { getMessageText } from './chatHelpers.js';

// 去除 markdown 标记符号，用于预览文本显示
export const stripMarkdown = (text) => {
  if (!text) return '';
  return text
    // 加粗/斜体/删除线：**text**、*text*、__text__、~~text~~
    .replace(/(\*{1,3}|_{1,3}|~~)(.+?)\1/g, '$2')
    // 行内代码：`text`
    .replace(/`([^`]+)`/g, '$1')
    // 标题标记：### text → text
    .replace(/^#{1,6}\s+/gm, '')
    // 列表标记：- text、* text、+ text、1. text
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // 引用标记：> text
    .replace(/^>\s+/gm, '')
    // 链接： [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 图片： ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 清理多余空格和换行
    .replace(/\s+/g, ' ')
    .trim();
};

export const getLastMessagePreview = (conversation) => {
  const lastMessage = [...(conversation.messages || [])]
    .reverse()
    .find((m) => m.id !== 'welcome' && getMessageText(m));
  if (!lastMessage) return '点击开始新对话';
  const text = stripMarkdown(getMessageText(lastMessage));
  return text.length > 22 ? `${text.slice(0, 22)}...` : text;
};

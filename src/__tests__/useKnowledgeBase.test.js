import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKnowledgeBase } from '../composables/useKnowledgeBase.js';

const mocks = vi.hoisted(() => ({
  routeQuery: {},
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  getDocuments: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getStats: vi.fn(),
  uploadFile: vi.fn(),
  getDocumentContent: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: mocks.routeQuery }),
}));

vi.mock('../stores/toast.store.js', () => ({
  useToastStore: () => mocks.toast,
}));

vi.mock('../api/rag.js', () => ({
  getDocuments: mocks.getDocuments,
  addDocument: mocks.addDocument,
  deleteDocument: mocks.deleteDocument,
  getStats: mocks.getStats,
  uploadFile: mocks.uploadFile,
  getDocumentContent: mocks.getDocumentContent,
}));

function mountComposable() {
  let result;
  const wrapper = mount(defineComponent({
    setup() {
      result = useKnowledgeBase();
      return () => null;
    },
  }));
  return { result, wrapper };
}

describe('useKnowledgeBase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.routeQuery)) delete mocks.routeQuery[key];
    mocks.getDocuments.mockResolvedValue({ success: true, data: { documents: [] } });
    mocks.getStats.mockResolvedValue({ success: true, data: { total: 0 } });
    mocks.getDocumentContent.mockResolvedValue({ success: true, data: { content: '默认内容' } });
  });

  it('打开预览时加载完整文档内容', async () => {
    const { result, wrapper } = mountComposable();
    await flushPromises();
    mocks.getDocumentContent.mockResolvedValueOnce({
      success: true,
      data: { content: '图书馆开放时间为 8:00' },
    });
    const document = { id: 'doc-1', title: '图书馆指南' };

    await result.openPreview(document);

    expect(mocks.getDocumentContent).toHaveBeenCalledWith('doc-1');
    expect(result.previewDoc.value).toEqual(document);
    expect(result.showPreviewModal.value).toBe(true);
    expect(result.previewContent.value).toBe('图书馆开放时间为 8:00');
    expect(result.previewLoading.value).toBe(false);
    wrapper.unmount();
  });

  it('高亮搜索词前先转义 HTML', async () => {
    const { result, wrapper } = mountComposable();
    await flushPromises();
    result.searchQuery.value = '图书馆';

    expect(result.highlightText('<b>图书馆</b>')).toBe(
      '&lt;b&gt;<mark class="search-hit">图书馆</mark>&lt;/b&gt;',
    );
    wrapper.unmount();
  });

  it('按一级分类、二级分类和关键词组合筛选', async () => {
    const { result, wrapper } = mountComposable();
    await flushPromises();
    result.documents.value = [
      { id: '1', title: '数据结构期末复习', category: '课程资料:数据结构' },
      { id: '2', title: '操作系统实验', category: '课程资料:操作系统' },
      { id: '3', title: '数学竞赛真题', category: '竞赛资料:大学生数学竞赛' },
    ];

    result.selectedGroup.value = '课程资料';
    expect(result.filteredDocuments.value.map((document) => document.id)).toEqual(['1', '2']);

    result.selectedSubCategory.value = '课程资料:数据结构';
    expect(result.filteredDocuments.value.map((document) => document.id)).toEqual(['1']);

    result.searchQuery.value = '不存在';
    expect(result.filteredDocuments.value).toEqual([]);
    wrapper.unmount();
  });
});

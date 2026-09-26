import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddDocumentModal from '../components/knowledge/AddDocumentModal.vue';

// 从 useKnowledgeBase.test.js 移植：添加文档的提交逻辑已下沉到组件，
// 索引失败警告等行为在组件层验证
const mocks = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  addDocument: vi.fn(),
  uploadFile: vi.fn(),
  invalidateWikiEntries: vi.fn(),
}));

vi.mock('../stores/toast.store.js', () => ({
  useToastStore: () => mocks.toast,
}));

vi.mock('../api/rag.js', () => ({
  addDocument: mocks.addDocument,
  uploadFile: mocks.uploadFile,
}));

vi.mock('../composables/useWiki.js', () => ({
  invalidateWikiEntries: mocks.invalidateWikiEntries,
}));

const mountModal = async () => {
  const wrapper = mount(AddDocumentModal, { props: { open: true } });
  await flushPromises();
  return wrapper;
};

const fillTextForm = async (wrapper, { title, content, subCategory }) => {
  await wrapper.find('input[type="text"]').setValue(title);
  await wrapper.find('textarea').setValue(content);
  const selects = wrapper.findAll('select');
  // selects[0] 是一级分类（默认课程资料），selects[1] 是二级分类
  await selects[1].setValue(subCategory);
};

describe('AddDocumentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('文档已保存但索引失败时给出明确警告；文档已入库，仍通知父组件刷新', async () => {
    mocks.addDocument.mockResolvedValueOnce({
      success: true,
      data: {
        vectorStatus: 'failed',
        vectorMessage: 'Qdrant not initialized',
      },
    });
    const wrapper = await mountModal();
    await fillTextForm(wrapper, {
      title: '保研政策',
      content: '政策内容',
      subCategory: '课程资料:数据结构',
    });

    await wrapper.find('button.bg-violet-600').trigger('click');
    await flushPromises();

    expect(mocks.toast.warning).toHaveBeenCalledWith('文档已保存，但向量索引失败：Qdrant not initialized');
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeTruthy();
    expect(wrapper.emitted('submitted')).toBeTruthy();
  });

  it('提交成功后关闭弹窗并通知父组件刷新', async () => {
    mocks.addDocument.mockResolvedValueOnce({
      success: true,
      data: { vectorStatus: 'ready' },
    });
    const wrapper = await mountModal();
    await fillTextForm(wrapper, {
      title: '数据结构笔记',
      content: '二叉树遍历',
      subCategory: '课程资料:数据结构',
    });

    await wrapper.find('button.bg-violet-600').trigger('click');
    await flushPromises();

    expect(mocks.toast.success).toHaveBeenCalledWith('文档添加成功');
    expect(mocks.invalidateWikiEntries).toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeTruthy();
    expect(wrapper.emitted('submitted')).toBeTruthy();
  });

  it('缺少二级分类时不提交并提示', async () => {
    const wrapper = await mountModal();
    await wrapper.find('input[type="text"]').setValue('标题');
    await wrapper.find('textarea').setValue('内容');

    await wrapper.find('button.bg-violet-600').trigger('click');
    await flushPromises();

    expect(mocks.toast.error).toHaveBeenCalledWith('请选择二级分类');
    expect(mocks.addDocument).not.toHaveBeenCalled();
  });

  it('每次打开时重置表单', async () => {
    const wrapper = await mountModal();
    await fillTextForm(wrapper, {
      title: '上一次的标题',
      content: '上一次的内容',
      subCategory: '课程资料:数据结构',
    });

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.find('input[type="text"]').element.value).toBe('');
    expect(wrapper.find('textarea').element.value).toBe('');
  });
});

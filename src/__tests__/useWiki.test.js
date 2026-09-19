import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWikiBrowse, useWikiEntry, invalidateWikiEntries } from '../composables/useWiki.js';

const mocks = vi.hoisted(() => ({
  route: { params: {}, query: {} },
  auth: { isAdmin: false },
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  getWikiEntries: vi.fn(),
  getWikiEntry: vi.fn(),
  setWikiEntryVisibility: vi.fn(),
}));

vi.mock('vue-router', () => ({ useRoute: () => mocks.route }));

vi.mock('../stores/auth.store.js', () => ({ useAuthStore: () => mocks.auth }));

vi.mock('../stores/toast.store.js', () => ({ useToastStore: () => mocks.toast }));

vi.mock('../api/wiki.js', () => ({
  getWikiEntries: mocks.getWikiEntries,
  getWikiEntry: mocks.getWikiEntry,
  setWikiEntryVisibility: mocks.setWikiEntryVisibility,
}));

const meta = (id, title, category, extra = {}) => ({
  id,
  slug: extra.slug || '',
  title,
  category,
  contentLength: 500,
  chunkCount: 4,
  createdAt: extra.createdAt || '2026-01-01T00:00:00.000Z',
  visible: extra.visible !== false,
});

const okEntries = (entries) => ({ success: true, data: { entries, total: entries.length } });

function mountComposable(composable) {
  let result;
  const wrapper = mount(defineComponent({
    setup() {
      result = composable();
      return () => null;
    },
  }));
  return { result, wrapper };
}

const CORPUS = [
  meta('d1', '操作系统', '课程资料:操作系统', { slug: '操作系统', createdAt: '2026-03-01T00:00:00.000Z' }),
  meta('d2', '数据结构', '课程资料:数据结构', { createdAt: '2026-02-01T00:00:00.000Z' }),
  meta('d3', '校园指南', '信息资源:校园指南', { createdAt: '2026-01-01T00:00:00.000Z' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateWikiEntries();
  mocks.route.params = {};
  mocks.route.query = {};
  mocks.auth.isAdmin = false;
  mocks.getWikiEntries.mockResolvedValue(okEntries(CORPUS));
  mocks.getWikiEntry.mockResolvedValue({ success: true, data: { ...meta('d2', '数据结构', '课程资料:数据结构'), body: '# 要点', simulated: false, sourceLabel: '' } });
  mocks.setWikiEntryVisibility.mockResolvedValue({ success: true, message: '词条已上架', data: { docId: 'd2', visible: true } });
});

describe('useWikiBrowse', () => {
  it('挂载即加载已上架词条并构建分类树', async () => {
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    expect(mocks.getWikiEntries).toHaveBeenCalledWith({ includeHidden: false });
    expect(result.tree.value.map(g => g.label)).toEqual(['课程资料', '信息资源']);
    expect(result.publishedCount.value).toBe(3);
    wrapper.unmount();
  });

  it('列表命中缓存：再次挂载不重复请求，force 才重拉', async () => {
    const first = mountComposable(useWikiBrowse);
    await flushPromises();
    first.wrapper.unmount();

    const second = mountComposable(useWikiBrowse);
    await flushPromises();
    expect(mocks.getWikiEntries).toHaveBeenCalledTimes(1);
    second.wrapper.unmount();

    const third = mountComposable(useWikiBrowse);
    await flushPromises();
    await third.result.loadEntries({ force: true });
    expect(mocks.getWikiEntries).toHaveBeenCalledTimes(2);
    third.wrapper.unmount();
  });

  it('请求失败不留缓存，避免后续永远读到空列表', async () => {
    mocks.getWikiEntries.mockRejectedValueOnce(new Error('网络中断'));
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    expect(result.loadError.value).toBe('网络中断');
    expect(mocks.toast.error).toHaveBeenCalledWith('网络中断');

    await result.loadEntries();
    expect(mocks.getWikiEntries).toHaveBeenCalledTimes(2);
    expect(result.entries.value).toHaveLength(3);
    wrapper.unmount();
  });

  it('选中一级/二级分类收窄列表，clearFilters 复位', async () => {
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();

    result.selectGroup('课程资料');
    expect(result.shownEntries.value.map(d => d.id)).toEqual(['d1', 'd2']);
    result.selectSub('课程资料', '数据结构');
    expect(result.shownEntries.value.map(d => d.id)).toEqual(['d2']);
    result.clearFilters();
    expect(result.shownEntries.value).toHaveLength(3);
    wrapper.unmount();
  });

  it('搜索交给服务端并保留命中顺序', async () => {
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    mocks.getWikiEntries.mockResolvedValueOnce(okEntries([
      { ...meta('d3', '校园指南', '信息资源:校园指南'), excerpt: '校园指南覆盖选课与考试' },
    ]));

    result.searchQuery.value = '校园';
    await new Promise(resolve => setTimeout(resolve, 350));
    await flushPromises();

    expect(mocks.getWikiEntries).toHaveBeenLastCalledWith({ q: '校园', includeHidden: false });
    expect(result.isSearching.value).toBe(true);
    expect(result.shownEntries.value).toMatchObject([{ id: 'd3', excerpt: '校园指南覆盖选课与考试' }]);

    result.searchQuery.value = '';
    await flushPromises();
    expect(result.isSearching.value).toBe(false);
    expect(result.shownEntries.value).toHaveLength(3);
    wrapper.unmount();
  });

  it('含未上架视图仅管理员可见，普通用户传空值', async () => {
    mocks.auth.isAdmin = true;
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    result.toggleShowHidden();
    await flushPromises();
    expect(mocks.getWikiEntries).toHaveBeenLastCalledWith({ includeHidden: true });

    wrapper.unmount();
    invalidateWikiEntries();
    mocks.auth.isAdmin = false;
    const guest = mountComposable(useWikiBrowse);
    await flushPromises();
    guest.result.toggleShowHidden();
    await flushPromises();
    expect(mocks.getWikiEntries).toHaveBeenLastCalledWith({ includeHidden: false });
    guest.wrapper.unmount();
  });

  it('上下架成功后强制刷新列表', async () => {
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    const before = mocks.getWikiEntries.mock.calls.length;

    await result.toggleVisibility(meta('d9', '草稿', 'general', { visible: false }));
    expect(mocks.setWikiEntryVisibility).toHaveBeenCalledWith('d9', { visible: true });
    expect(mocks.toast.success).toHaveBeenCalledWith('词条已上架');
    expect(mocks.getWikiEntries).toHaveBeenCalledTimes(before + 1);
    wrapper.unmount();
  });

  it('服务端拒绝（演示语料 409）时提示原因且不改列表', async () => {
    mocks.setWikiEntryVisibility.mockRejectedValue(Object.assign(new Error('该文档是演示用模拟语料，不能上架'), { status: 409 }));
    const { result, wrapper } = mountComposable(useWikiBrowse);
    await flushPromises();
    const before = mocks.getWikiEntries.mock.calls.length;

    await result.toggleVisibility(meta('d9', '食堂指南', '学校概况', { visible: false }));
    expect(mocks.toast.error).toHaveBeenCalledWith('该文档是演示用模拟语料，不能上架');
    expect(mocks.getWikiEntries).toHaveBeenCalledTimes(before);
    wrapper.unmount();
  });
});

describe('useWikiEntry', () => {
  beforeEach(() => {
    mocks.route.params = reactive({ idOrSlug: 'd2' });
  });

  it('加载正文与服务端治理标记', async () => {
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(mocks.getWikiEntry).toHaveBeenCalledWith('d2');
    expect(result.articleBody.value).toBe('# 要点');
    expect(result.notFound.value).toBe(false);
    wrapper.unmount();
  });

  it('按 slug 访问时以返回的 id 定位上一篇', async () => {
    mocks.route.params = reactive({ idOrSlug: '数据结构' });
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(result.docId.value).toBe('d2');
    expect(result.prevEntry.value.id).toBe('d1');
    expect(result.nextEntry.value.id).toBe('d3');
    expect(result.related.value.map(d => d.id)).toEqual(['d1', 'd3']);
    wrapper.unmount();
  });

  it('未上架或不存在进入 notFound 态', async () => {
    mocks.getWikiEntry.mockRejectedValue(Object.assign(new Error('词条不存在或尚未上架'), { status: 404 }));
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(result.notFound.value).toBe(true);
    expect(result.entry.value).toBeNull();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('非 404 失败保留错误并提示', async () => {
    mocks.getWikiEntry.mockRejectedValue(new Error('服务暂不可用'));
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(result.notFound.value).toBe(false);
    expect(result.loadError.value).toBe('服务暂不可用');
    expect(mocks.toast.error).toHaveBeenCalledWith('服务暂不可用');
    wrapper.unmount();
  });

  it('切换 idOrSlug 自动重载', async () => {
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(mocks.getWikiEntry).toHaveBeenCalledTimes(1);
    mocks.route.params.idOrSlug = 'd1';
    await flushPromises();
    expect(mocks.getWikiEntry).toHaveBeenLastCalledWith('d1');
    wrapper.unmount();
  });

  it('导航列表失败不影响正文阅读', async () => {
    invalidateWikiEntries();
    mocks.getWikiEntries.mockRejectedValue(new Error('列表挂了'));
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    expect(result.entry.value.title).toBe('数据结构');
    expect(result.prevEntry.value).toBeNull();
    expect(result.notFound.value).toBe(false);
    wrapper.unmount();
  });

  it('管理员在词条页上下架后失效缓存并重载', async () => {
    mocks.auth.isAdmin = true;
    const { result, wrapper } = mountComposable(useWikiEntry);
    await flushPromises();
    const calls = mocks.getWikiEntry.mock.calls.length;

    await result.toggleVisibility();
    expect(mocks.setWikiEntryVisibility).toHaveBeenCalledWith('d2', { visible: false });
    expect(mocks.getWikiEntry).toHaveBeenCalledTimes(calls + 1);
    wrapper.unmount();
  });
});

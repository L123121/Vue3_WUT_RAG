import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getWikiEntries, getWikiEntry, getWikiEntryRevisions, setWikiEntryVisibility } from '../api/wiki.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useToastStore } from '../stores/toast.store.js';
import { buildWikiTree, flattenWikiEntries, findRelatedEntries } from '../utils/wikiTree.js';
import { splitCategory } from '../constants/wiki-categories.js';

// 词条列表同时服务分类树、上一篇/下一篇与相关推荐：列表页跳详情页不该重拉一遍
const CACHE_TTL_MS = 30_000;
// 搜索防抖：中文输入法下逐键请求会打穿正文匹配
const SEARCH_DEBOUNCE_MS = 300;

let cache = { at: 0, promise: null, includeHidden: false };

export function invalidateWikiEntries() {
  cache = { at: 0, promise: null, includeHidden: false };
}

function fetchEntries({ includeHidden }) {
  const promise = getWikiEntries({ includeHidden })
    .then((result) => {
      if (!result?.success) throw new Error(result?.message || '加载词条列表失败');
      return flattenWikiEntries(buildWikiTree(result.data?.entries || []));
    })
    .catch((error) => {
      // 失败不留缓存，否则一次网络抖动会让词条列表长期为空
      if (cache.promise === promise) cache = { at: 0, promise: null, includeHidden: false };
      throw error;
    });

  cache = { at: Date.now(), promise, includeHidden };
  return promise;
}

function loadEntryList({ includeHidden, force = false }) {
  const fresh = !force
    && cache.promise
    && cache.includeHidden === includeHidden
    && Date.now() - cache.at < CACHE_TTL_MS;
  return fresh ? cache.promise : fetchEntries({ includeHidden });
}

export const formatWikiDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('zh-CN');
};

export const formatWikiSize = (length) => {
  if (!length) return '0 字符';
  if (length < 1024) return `${length} 字符`;
  return `${(length / 1024).toFixed(1)} KB`;
};

export function useWikiBrowse() {
  const toast = useToastStore();
  const auth = useAuthStore();

  const entries = ref([]);
  const loading = ref(false);
  const loadError = ref('');
  const searchQuery = ref('');
  const searchResults = ref(null);
  const searching = ref(false);
  const activeGroup = ref('');
  const activeSub = ref('');
  const showHidden = ref(false);
  const busyId = ref('');

  const isAdmin = computed(() => Boolean(auth.isAdmin));

  const tree = computed(() => buildWikiTree(entries.value));

  const shownEntries = computed(() => {
    if (searchResults.value) return searchResults.value;
    if (!activeGroup.value) return entries.value;
    return entries.value.filter((doc) => {
      const { group, sub } = splitCategory(doc.category);
      if (group !== activeGroup.value) return false;
      return !activeSub.value || sub === activeSub.value;
    });
  });

  const publishedCount = computed(() => entries.value.filter(doc => doc.visible).length);
  const hiddenCount = computed(() => entries.value.length - publishedCount.value);
  const isSearching = computed(() => searchResults.value !== null);

  const selectGroup = (key) => {
    activeGroup.value = activeGroup.value === key ? '' : key;
    activeSub.value = '';
  };

  const selectSub = (groupKey, subLabel) => {
    activeGroup.value = groupKey;
    activeSub.value = activeSub.value === subLabel ? '' : subLabel;
  };

  const clearFilters = () => {
    activeGroup.value = '';
    activeSub.value = '';
  };

  const loadEntries = async ({ force = false } = {}) => {
    loading.value = true;
    loadError.value = '';
    try {
      entries.value = await loadEntryList({ includeHidden: showHidden.value && isAdmin.value, force });
    } catch (error) {
      console.error('[wiki] 加载词条列表失败:', error);
      loadError.value = error.message || '加载词条列表失败';
      toast.error(loadError.value);
    } finally {
      loading.value = false;
    }
  };

  const runSearch = async (keyword) => {
    const query = keyword.trim();
    if (!query) {
      searchResults.value = null;
      searching.value = false;
      return;
    }
    searching.value = true;
    try {
      const result = await getWikiEntries({
        q: query,
        includeHidden: showHidden.value && isAdmin.value,
      });
      if (!result?.success) throw new Error(result?.message || '搜索失败');
      // 搜索结果保持服务端相关度顺序，不重排进分类树
      searchResults.value = (result.data?.entries || []).map(doc => ({
        ...doc,
        groupLabel: doc.category || '',
        subLabel: '',
      }));
    } catch (error) {
      console.error('[wiki] 搜索失败:', error);
      toast.error(error.message || '搜索失败');
    } finally {
      searching.value = false;
    }
  };

  let searchTimer = null;
  watch(searchQuery, (value) => {
    if (searchTimer) clearTimeout(searchTimer);
    if (!value.trim()) {
      searchResults.value = null;
      searching.value = false;
      return;
    }
    searching.value = true;
    searchTimer = setTimeout(() => runSearch(value), SEARCH_DEBOUNCE_MS);
  });
  onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

  const toggleVisibility = async (doc) => {
    if (!doc?.id || busyId.value) return;
    busyId.value = doc.id;
    try {
      const result = await setWikiEntryVisibility(doc.id, { visible: !doc.visible });
      toast.success(result?.message || (doc.visible ? '词条已下架' : '词条已上架'));
      await loadEntries({ force: true });
    } catch (error) {
      // 演示语料被服务端拒绝上架（409），不提供前端强推入口
      toast.error(error.message || '操作失败');
    } finally {
      busyId.value = '';
    }
  };

  const toggleShowHidden = () => {
    showHidden.value = !showHidden.value;
    searchResults.value = null;
    loadEntries({ force: true });
  };

  onMounted(() => loadEntries());

  return {
    entries,
    tree,
    shownEntries,
    loading,
    loadError,
    searching,
    isSearching,
    searchQuery,
    activeGroup,
    activeSub,
    showHidden,
    busyId,
    isAdmin,
    publishedCount,
    hiddenCount,
    loadEntries,
    selectGroup,
    selectSub,
    clearFilters,
    toggleVisibility,
    toggleShowHidden,
  };
}

export function useWikiEntry() {
  const route = useRoute();
  const toast = useToastStore();
  const auth = useAuthStore();

  const entry = ref(null);
  const siblings = ref([]);
  const loading = ref(true);
  const loadError = ref('');
  const notFound = ref(false);
  const busy = ref(false);
  const revisions = ref([]);
  const revisionsLoading = ref(false);

  const isAdmin = computed(() => Boolean(auth.isAdmin));
  const docId = computed(() => entry.value?.id || String(route.params.idOrSlug || ''));

  const position = computed(() => siblings.value.findIndex(doc => doc.id === docId.value));
  const prevEntry = computed(() => (position.value > 0 ? siblings.value[position.value - 1] : null));
  const nextEntry = computed(() => {
    if (position.value < 0 || position.value >= siblings.value.length - 1) return null;
    return siblings.value[position.value + 1];
  });
  // 编译期互链优先：后端在词条上架时已用 LLM 从候选词条里选好关联（带推荐理由），
  // 比查询期按分类聚类更准；为空（关闭/未编译/暂无关联）时才回退本地分类推荐，
  // 保证互链能力关闭时页面不会露出空白
  const compiledRelated = computed(() => (Array.isArray(entry.value?.relatedPages) ? entry.value.relatedPages : []));
  const related = computed(() => (
    compiledRelated.value.length > 0
      ? compiledRelated.value
      : findRelatedEntries(siblings.value, docId.value)
  ));

  const loadRevisions = async (id = docId.value) => {
    if (!isAdmin.value || !id) {
      revisions.value = [];
      return;
    }
    revisionsLoading.value = true;
    try {
      const result = await getWikiEntryRevisions(id);
      revisions.value = result?.data?.revisions || [];
    } catch (error) {
      revisions.value = [];
      console.warn('[wiki] 加载修订历史失败:', error);
    } finally {
      revisionsLoading.value = false;
    }
  };

  const load = async () => {
    loading.value = true;
    loadError.value = '';
    notFound.value = false;
    entry.value = null;

    // 兄弟词条只服务导航与推荐，失败时降级为"只读本篇"
    siblings.value = [];
    loadEntryList({ includeHidden: false })
      .then(list => { siblings.value = list; })
      .catch(error => console.warn('[wiki] 加载词条导航失败:', error));

    try {
      const result = await getWikiEntry(route.params.idOrSlug);
      if (!result?.success || !result.data) {
        throw Object.assign(new Error(result?.message || '词条不存在或尚未上架'), { status: 404 });
      }
      entry.value = result.data;
      await loadRevisions(entry.value.id);
    } catch (error) {
      notFound.value = error.status === 404 || error.status === 403;
      loadError.value = error.message || '加载词条失败';
      if (!notFound.value) toast.error(loadError.value);
    } finally {
      loading.value = false;
    }
  };

  const toggleVisibility = async () => {
    if (!entry.value?.id || busy.value) return;
    busy.value = true;
    try {
      const shouldPublishCurrentRevision = entry.value.stale === true;
      const targetVisible = shouldPublishCurrentRevision ? true : !entry.value.visible;
      const result = await setWikiEntryVisibility(entry.value.id, { visible: targetVisible });
      toast.success(result?.message || (shouldPublishCurrentRevision ? '已重新审核并上架' : (entry.value.visible ? '词条已下架' : '词条已上架')));
      invalidateWikiEntries();
      await load();
    } catch (error) {
      toast.error(error.message || '操作失败');
    } finally {
      busy.value = false;
    }
  };

  watch(() => route.params.idOrSlug, (value) => { if (value) load(); });
  onMounted(load);

  return {
    docId,
    entry,
    articleBody: computed(() => entry.value?.body || ''),
    loading,
    loadError,
    notFound,
    isAdmin,
    busy,
    revisions,
    revisionsLoading,
    prevEntry,
    nextEntry,
    related,
    reload: load,
    toggleVisibility,
  };
}

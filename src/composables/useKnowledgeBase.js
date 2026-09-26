import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getDocuments, deleteDocument, getStats, getDocumentContent } from '../api/rag.js';
import { useToastStore } from '../stores/toast.store.js';
import {
  categoryGroups,
  getCategoryLabel,
  getGroupLabel,
} from '../constants/wiki-categories.js';
import { invalidateWikiEntries } from './useWiki.js';

export function useKnowledgeBase() {
  const toastStore = useToastStore();
  const route = useRoute();

  // 状态
  const documents = ref([]);
  const stats = ref(null);
  const loading = ref(false);
  const showAddModal = ref(false);
  const showPreviewModal = ref(false);
  const showDeleteConfirm = ref(false);
  const deletingDoc = ref(null);
  const previewDoc = ref(null);
  const previewContent = ref('');
  const previewLoading = ref(false);
  const searchQuery = ref('');
  const selectedGroup = ref('');           // 一级分类筛选
  const selectedSubCategory = ref('');     // 二级分类筛选
  const showAdmin = ref(false); // 管理员模式开关（默认隐藏）
  const pendingPreviewId = ref(''); // 从聊天跳转时，待打开的文档 ID

  // ==================== 两级分类体系（常量定义在 constants/wiki-categories.js） ====================

  // 筛选区的二级分类列表
  const filterSubCategories = computed(() => {
    if (!selectedGroup.value) return [];
    const group = categoryGroups.find(g => g.value === selectedGroup.value);
    return group?.children || [];
  });

  // 过滤后的文档
  const filteredDocuments = computed(() => {
    let result = documents.value;

    if (selectedSubCategory.value) {
      // 精确匹配二级分类
      result = result.filter(doc => doc.category === selectedSubCategory.value);
    } else if (selectedGroup.value) {
      // 按一级分类前缀匹配（如 "课程资料:" 开头的所有文档）
      result = result.filter(doc => doc.category && doc.category.startsWith(selectedGroup.value + ':'));
    }

    if (searchQuery.value) {
      const query = searchQuery.value.toLowerCase();
      result = result.filter(doc =>
        doc.title.toLowerCase().includes(query) ||
        (doc.category && doc.category.toLowerCase().includes(query))
      );
    }

    return result;
  });

  // 加载文档列表
  const loadDocuments = async () => {
    loading.value = true;
    try {
      const result = await getDocuments({ limit: 100 });
      if (result.success) {
        documents.value = result.data.documents || [];
      }
    } catch (error) {
      console.error('加载文档失败:', error);
      toastStore.error('加载文档列表失败');
    } finally {
      loading.value = false;
    }
  };

  // 加载统计信息
  const loadStats = async () => {
    try {
      const result = await getStats();
      if (result.success) {
        stats.value = result.data;
      }
    } catch (error) {
      console.error('加载统计失败:', error);
    }
  };

  // 刷新数据
  const refresh = async () => {
    await Promise.all([loadDocuments(), loadStats()]);
  };

  // 打开添加模态框（表单与提交逻辑见 components/knowledge/AddDocumentModal.vue）
  const openAddModal = () => {
    showAddModal.value = true;
  };

  // ==================== 搜索高亮 + 跳转原文 ====================

  const previewContentRef = ref(null);

  const escapeHtmlForHighlight = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 列表标题/分类高亮：搜索词命中处用 <mark> 包裹
  const highlightText = (text) => {
    const escaped = escapeHtmlForHighlight(text);
    if (!searchQuery.value) return escaped;
    const q = searchQuery.value.toLowerCase();
    if (!q || !escaped.toLowerCase().includes(q)) return escaped;
    const idx = escaped.toLowerCase().indexOf(q);
    const matchLen = q.length;
    return `${escaped.slice(0, idx)}<mark class="search-hit">${escaped.slice(idx, idx + matchLen)}</mark>${escaped.slice(idx + matchLen)}`;
  };

  // 预览加载完成后，若有搜索词则滚动到第一个命中处（跳转原文）
  const scrollPreviewToHit = async () => {
    await nextTick();
    const container = previewContentRef.value;
    if (!container) return;
    const hit = container.querySelector('.search-hit');
    if (hit) {
      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // 预览文档
  const openPreview = async (doc) => {
    previewDoc.value = doc;
    showPreviewModal.value = true;
    previewLoading.value = true;
    previewContent.value = '';

    try {
      const result = await getDocumentContent(doc.id);
      if (result.success) {
        previewContent.value = result.data.content || '无内容';
      } else {
        previewContent.value = '加载失败';
      }
    } catch (error) {
      console.error('加载文档内容失败:', error);
      previewContent.value = '加载失败';
    } finally {
      previewLoading.value = false;
      scrollPreviewToHit();
    }
  };

  // 打开删除确认弹窗
  const openDeleteConfirm = (doc) => {
    deletingDoc.value = doc;
    showDeleteConfirm.value = true;
  };

  // 确认删除
  const confirmDelete = async () => {
    if (!deletingDoc.value) return;

    try {
      const result = await deleteDocument(deletingDoc.value.id);
      if (result.success) {
        invalidateWikiEntries();
        toastStore.success('删除成功');
        await refresh();
      } else {
        toastStore.error(result.message || '删除失败');
      }
    } catch (error) {
      console.error('删除文档失败:', error);
      toastStore.error('删除文档失败');
    } finally {
      showDeleteConfirm.value = false;
      deletingDoc.value = null;
    }
  };

  // 关闭删除确认弹窗
  const closeDeleteConfirm = () => {
    showDeleteConfirm.value = false;
    deletingDoc.value = null;
  };

  const vectorStatusLabels = {
    ready: '可检索',
    indexing: '索引中',
    vectoring: '向量化中',
    timeout: '待确认',
    failed: '向量失败',
    local_only: '本地保存'
  };

  const vectorStatusClassMap = {
    ready: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
    indexing: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    vectoring: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    timeout: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
    failed: 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300',
    local_only: 'bg-slate-100 dark:bg-gray-700 text-slate-600 dark:text-gray-300'
  };

  const getVectorStatusLabel = (status) => vectorStatusLabels[status || 'local_only'] || '未知状态';

  const getVectorStatusClasses = (status) => vectorStatusClassMap[status || 'local_only'] || vectorStatusClassMap.local_only;
  // 格式化日期
  const formatDate = (date) => {
    if (!date) return '-';
    return new Date(date).toLocaleString('zh-CN');
  };

  // 格式化文件大小
  const formatSize = (length) => {
    if (!length) return '0 B';
    if (length < 1024) return `${length} 字符`;
    return `${(length / 1024).toFixed(1)} KB`;
  };

  onMounted(() => {
    // 从聊天页跳转过来时，检查是否有待打开的文档
    if (route.query.docId) {
      pendingPreviewId.value = route.query.docId;
    }
    // 携带高亮关键词（引用跳转：snippet 提取的词）
    if (route.query.q) {
      searchQuery.value = String(route.query.q).slice(0, 50);
    }
    refresh();
  });

  // 文档加载完成后，自动打开来自聊天跳转的预览
  watch(documents, (docs) => {
    if (pendingPreviewId.value && docs.length > 0) {
      const doc = docs.find(d => d.id === pendingPreviewId.value);
      if (doc) {
        openPreview(doc);
      }
      pendingPreviewId.value = '';
    }
  }, { once: true });

  return {
    documents,
    stats,
    loading,
    showAddModal,
    showPreviewModal,
    showDeleteConfirm,
    deletingDoc,
    previewDoc,
    previewContent,
    previewLoading,
    searchQuery,
    selectedGroup,
    selectedSubCategory,
    showAdmin,
    categoryGroups,
    filterSubCategories,
    filteredDocuments,
    refresh,
    openAddModal,
    previewContentRef,
    highlightText,
    openPreview,
    openDeleteConfirm,
    confirmDelete,
    closeDeleteConfirm,
    getCategoryLabel,
    getGroupLabel,
    getVectorStatusLabel,
    getVectorStatusClasses,
    formatDate,
    formatSize,
  };
}

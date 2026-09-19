import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { getDocuments, addDocument, deleteDocument, getStats, uploadFile, getDocumentContent } from '../api/rag.js';
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
  const uploading = ref(false);
  const showAddModal = ref(false);
  const showPreviewModal = ref(false);
  const showDeleteConfirm = ref(false);
  const deletingDoc = ref(null);
  const previewDoc = ref(null);
  const previewContent = ref('');
  const previewLoading = ref(false);
  const addMode = ref('text'); // 'text' 或 'file'
  const searchQuery = ref('');
  const selectedGroup = ref('');           // 一级分类筛选
  const selectedSubCategory = ref('');     // 二级分类筛选
  const showAdmin = ref(false); // 管理员模式开关（默认隐藏）
  const pendingPreviewId = ref(''); // 从聊天跳转时，待打开的文档 ID

  // 新文档表单
  const newDoc = ref({
    title: '',
    content: '',
    category: ''
  });
  const newDocGroup = ref('');         // 一级分类（添加时）
  const newDocSubCategory = ref('');   // 二级分类（添加时，存复合值）

  // 文件上传
  const selectedFile = ref(null);
  const fileGroup = ref('');           // 一级分类（文件上传）
  const fileSubCategory = ref('');     // 二级分类（文件上传，存复合值）
  const fileTitle = ref('');

  // ==================== 两级分类体系（常量定义在 constants/wiki-categories.js） ====================

  // 当前一级分类下的二级分类列表
  const availableSubCategories = computed(() => {
    if (!newDocGroup.value) return [];
    const group = categoryGroups.find(g => g.value === newDocGroup.value);
    return group?.children || [];
  });

  // 文件上传时的二级分类列表
  const fileSubCategories = computed(() => {
    if (!fileGroup.value) return [];
    const group = categoryGroups.find(g => g.value === fileGroup.value);
    return group?.children || [];
  });

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

  // 打开添加模态框
  const openAddModal = () => {
    addMode.value = 'text';
    newDoc.value = { title: '', content: '', category: '' };
    newDocGroup.value = '课程资料';
    newDocSubCategory.value = '';
    selectedFile.value = null;
    fileTitle.value = '';
    fileGroup.value = '课程资料';
    fileSubCategory.value = '';
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

  const notifyIndexResult = (data = {}, successMessage) => {
    // 百科列表缓存读的是同一批文档，入库/上传后必须失效
    invalidateWikiEntries();
    if (data.vectorStatus === 'failed') {
      toastStore.warning(`文档已保存，但向量索引失败：${data.vectorMessage || '请稍后重试或重建索引'}`);
      return;
    }
    if (data.vectorStatus === 'indexing') {
      toastStore.warning(data.vectorMessage || '文档已保存，向量索引仍在处理中');
      return;
    }
    toastStore.success(successMessage);
  };

  // 提交新文档
  const submitDocument = async () => {
    if (!newDoc.value.title.trim()) {
      toastStore.error('请输入文档标题');
      return;
    }
    if (!newDoc.value.content.trim()) {
      toastStore.error('请输入文档内容');
      return;
    }
    if (!newDocSubCategory.value) {
      toastStore.error('请选择二级分类');
      return;
    }

    // 组装复合分类值
    newDoc.value.category = newDocSubCategory.value;

    try {
      const result = await addDocument(newDoc.value);
      if (result.success) {
        notifyIndexResult(result.data, '文档添加成功');
        showAddModal.value = false;
        await refresh();
      } else {
        toastStore.error(result.message || '添加失败');
      }
    } catch (error) {
      console.error('添加文档失败:', error);
      toastStore.error('添加文档失败');
    }
  };

  // 选择文件
  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      selectedFile.value = file;
      // 自动填充标题（文件名）
      if (!fileTitle.value) {
        fileTitle.value = file.name.replace(/\.[^/.]+$/, '');
      }
    }
  };

  // 上传文件
  const submitFileUpload = async () => {
    if (!selectedFile.value) {
      toastStore.error('请选择文件');
      return;
    }
    if (!fileSubCategory.value) {
      toastStore.error('请选择二级分类');
      return;
    }

    uploading.value = true;
    try {
      const result = await uploadFile(selectedFile.value, fileSubCategory.value, fileTitle.value);
      if (result.success) {
        notifyIndexResult(result.data, `文件上传成功，已生成 ${result.data.chunkCount} 个片段`);
        showAddModal.value = false;
        selectedFile.value = null;
        fileTitle.value = '';
        await refresh();
      } else {
        toastStore.error(result.message || '上传失败');
      }
    } catch (error) {
      console.error('上传文件失败:', error);
      toastStore.error('上传文件失败');
    } finally {
      uploading.value = false;
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

  // 格式化文件大小（字节）
  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  // 支持的文件类型
  const supportedFileTypes = '.pdf, .docx, .doc, .pptx, .txt, .md';

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
    uploading,
    showAddModal,
    showPreviewModal,
    showDeleteConfirm,
    deletingDoc,
    previewDoc,
    previewContent,
    previewLoading,
    addMode,
    searchQuery,
    selectedGroup,
    selectedSubCategory,
    showAdmin,
    newDoc,
    newDocGroup,
    newDocSubCategory,
    selectedFile,
    fileGroup,
    fileSubCategory,
    fileTitle,
    categoryGroups,
    availableSubCategories,
    fileSubCategories,
    filterSubCategories,
    filteredDocuments,
    refresh,
    openAddModal,
    previewContentRef,
    highlightText,
    openPreview,
    submitDocument,
    handleFileSelect,
    submitFileUpload,
    openDeleteConfirm,
    confirmDelete,
    closeDeleteConfirm,
    getCategoryLabel,
    getGroupLabel,
    getVectorStatusLabel,
    getVectorStatusClasses,
    formatDate,
    formatSize,
    formatFileSize,
    supportedFileTypes,
  };
}

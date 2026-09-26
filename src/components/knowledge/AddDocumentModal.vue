<script setup>
import { ref, computed, watch } from 'vue';
import { X, FileText, FileUp, File, RefreshCw } from 'lucide-vue-next';
import { addDocument, uploadFile } from '../../api/rag.js';
import { useToastStore } from '../../stores/toast.store.js';
import { categoryGroups } from '../../constants/wiki-categories.js';
import { invalidateWikiEntries } from '../../composables/useWiki.js';

// 添加文档模态框：表单状态与提交逻辑由本组件自持，
// 父组件只控制 open 开关，submitted 后由父组件刷新列表
const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'submitted']);

const toastStore = useToastStore();

// ===== 表单状态 =====
const addMode = ref('text'); // 'text' 或 'file'
const newDoc = ref({
  title: '',
  content: '',
  category: ''
});
const newDocGroup = ref('课程资料');      // 一级分类（添加时）
const newDocSubCategory = ref('');        // 二级分类（添加时，存复合值）
const selectedFile = ref(null);
const fileGroup = ref('课程资料');        // 一级分类（文件上传）
const fileSubCategory = ref('');          // 二级分类（文件上传，存复合值）
const fileTitle = ref('');
const uploading = ref(false);

// 每次打开时重置表单
watch(() => props.open, (open) => {
  if (!open) return;
  addMode.value = 'text';
  newDoc.value = { title: '', content: '', category: '' };
  newDocGroup.value = '课程资料';
  newDocSubCategory.value = '';
  selectedFile.value = null;
  fileTitle.value = '';
  fileGroup.value = '课程资料';
  fileSubCategory.value = '';
});

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

// 支持的文件类型
const supportedFileTypes = '.pdf, .docx, .doc, .pptx, .txt, .md';

// 格式化文件大小（字节）
const formatFileSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const close = () => emit('close');

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
      close();
      emit('submitted');
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
      selectedFile.value = null;
      fileTitle.value = '';
      close();
      emit('submitted');
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
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
    @click.self="close"
  >
    <div class="w-full max-w-xl mx-4 rounded-2xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl">
      <div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-gray-700">
        <h3 class="text-base font-bold text-slate-800 dark:text-white">添加文档</h3>
        <button
          @click="close"
          class="w-8 h-8 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-gray-200 hover:bg-slate-100 dark:hover:bg-gray-800 transition-colors"
        >
          <X :size="16" />
        </button>
      </div>

      <!-- 模式切换 -->
      <div class="px-5 pt-4">
        <div class="flex gap-1 p-1 rounded-lg bg-slate-100 dark:bg-gray-800">
          <button
            @click="addMode = 'text'"
            :class="[
              'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
              addMode === 'text'
                ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
            ]"
          >
            <FileText :size="14" />
            <span>手动输入</span>
          </button>
          <button
            @click="addMode = 'file'"
            :class="[
              'flex-1 h-8 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors',
              addMode === 'file'
                ? 'bg-white dark:bg-gray-700 text-slate-800 dark:text-white shadow-sm'
                : 'text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200'
            ]"
          >
            <FileUp :size="14" />
            <span>上传文件</span>
          </button>
        </div>
      </div>

      <!-- 手动输入模式 -->
      <div v-if="addMode === 'text'" class="p-5 space-y-3">
        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">文档标题</label>
          <input
            v-model="newDoc.title"
            type="text"
            placeholder="例如：数据结构期末复习笔记"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">一级分类</label>
          <select
            v-model="newDocGroup"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            @change="newDocSubCategory = ''"
          >
            <option v-for="g in categoryGroups" :key="g.value" :value="g.value">{{ g.label }}</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">二级分类</label>
          <select
            v-model="newDocSubCategory"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            <option value="" disabled>请选择二级分类</option>
            <option v-for="sub in availableSubCategories" :key="sub.value" :value="sub.value">{{ sub.label }}</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">文档内容</label>
          <textarea
            v-model="newDoc.content"
            rows="6"
            placeholder="输入文档内容，支持多段落。系统会自动进行切片处理..."
            class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 resize-none"
          ></textarea>
          <p class="mt-1 text-[10px] text-slate-500 dark:text-gray-400">
            当前 {{ newDoc.content.length }} 字符，预计 {{ Math.ceil(newDoc.content.length / 500) || 0 }} 个片段
          </p>
        </div>
      </div>

      <!-- 文件上传模式 -->
      <div v-else class="p-5 space-y-3">
        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">选择文件</label>
          <div
            class="relative border-2 border-dashed border-slate-300 dark:border-gray-600 rounded-lg p-5 text-center hover:border-violet-400 dark:hover:border-violet-500 transition-colors cursor-pointer"
            @click="$refs.fileInput.click()"
          >
            <input
              ref="fileInput"
              type="file"
              :accept="supportedFileTypes"
              class="hidden"
              @change="handleFileSelect"
            />
            <div v-if="!selectedFile">
              <FileUp :size="28" class="mx-auto text-slate-400 mb-2" />
              <p class="text-xs text-slate-600 dark:text-gray-300">点击或拖拽文件到此处</p>
              <p class="text-[10px] text-slate-400 mt-1">支持 {{ supportedFileTypes }} 格式，最大 10MB</p>
            </div>
            <div v-else class="flex items-center justify-center gap-2">
              <File :size="20" class="text-violet-500" />
              <div class="text-left">
                <p class="text-xs font-medium text-slate-800 dark:text-white">{{ selectedFile.name }}</p>
                <p class="text-[10px] text-slate-500">{{ formatFileSize(selectedFile.size) }}</p>
              </div>
              <button
                @click.stop="selectedFile = null"
                class="ml-2 w-5 h-5 rounded-full inline-flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20"
              >
                <X :size="12" />
              </button>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">文档标题（可选）</label>
          <input
            v-model="fileTitle"
            type="text"
            placeholder="留空则使用文件名"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">一级分类</label>
          <select
            v-model="fileGroup"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            @change="fileSubCategory = ''"
          >
            <option v-for="g in categoryGroups" :key="g.value" :value="g.value">{{ g.label }}</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-700 dark:text-gray-300 mb-1">二级分类</label>
          <select
            v-model="fileSubCategory"
            class="w-full h-9 px-3 text-sm rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            <option value="" disabled>请选择二级分类</option>
            <option v-for="sub in fileSubCategories" :key="sub.value" :value="sub.value">{{ sub.label }}</option>
          </select>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200 dark:border-gray-700">
        <button
          @click="close"
          class="h-8 px-3 rounded-lg text-xs border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors"
        >
          取消
        </button>
        <button
          v-if="addMode === 'text'"
          @click="submitDocument"
          class="h-8 px-3 rounded-lg text-xs bg-violet-600 text-white hover:bg-violet-700 transition-colors"
        >
          添加文档
        </button>
        <button
          v-else
          @click="submitFileUpload"
          :disabled="uploading || !selectedFile"
          class="h-8 px-3 rounded-lg text-xs bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50"
        >
          <span v-if="uploading" class="inline-flex items-center gap-1.5">
            <RefreshCw class="animate-spin" :size="12" />
            上传中...
          </span>
          <span v-else>上传文件</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { ShieldCheck, LockKeyhole } from 'lucide-vue-next';
import { formatAgentTime } from '../../utils/agentRunLabels.js';

const props = defineProps({ catalog: { type: Object, required: true }, admin: Boolean, busy: Boolean });
const emit = defineEmits(['save']);
const drafts = ref({});
watch(() => props.catalog, catalog => {
  drafts.value = Object.fromEntries(catalog.tools.map(tool => [tool.name, { effect: tool.rule.effect, roles: [...tool.rule.roles] }]));
}, { immediate: true });
const executionLabel = value => ({ worker: '独立worker · 可信固定工具', legacy_read: '聊天只读工具', sandbox_required: '独立沙箱未接入' }[value] || '不可用');
const effectLabel = value => ({ allow: '允许', approval: '人工审批', deny: '拒绝' }[value] || value);
</script>

<template>
  <section class="space-y-4">
    <div class="rounded-2xl border border-sky-200 bg-sky-50/60 p-5 dark:border-sky-900 dark:bg-sky-900/10">
      <h2 class="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-white"><ShieldCheck :size="20" class="text-sky-600" />工具权限中心</h2>
      <p class="mt-2 text-xs leading-relaxed text-slate-600 dark:text-gray-400">策略版本 {{ catalog.version }}。未知工具默认拒绝，副作用工具至少需要一次性审批；每次实际执行和恢复都会重新检查当前策略。</p>
      <p class="mt-1 text-xs leading-relaxed text-slate-500 dark:text-gray-400">普通worker不是沙箱。Python、Shell、浏览器、转换、网络搜索和数据库查询尚未开放，不能通过“允许”配置绕过隔离执行要求。</p>
    </div>
    <article v-for="tool in catalog.tools" :key="tool.name" class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div class="flex flex-wrap items-start gap-3">
        <div class="min-w-0 flex-1"><h3 class="text-sm font-bold text-slate-800 dark:text-gray-100">{{ tool.label }}</h3><p class="mt-1 break-all font-mono text-[11px] text-slate-400">{{ tool.name }}</p><p class="mt-2 text-xs text-slate-500 dark:text-gray-400">{{ tool.description || executionLabel(tool.execution) }}</p></div>
        <span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] text-slate-600 dark:bg-gray-800 dark:text-gray-300"><LockKeyhole v-if="tool.execution === 'sandbox_required'" :size="11" />{{ executionLabel(tool.execution) }}</span>
      </div>
      <p v-if="tool.execution === 'worker'" class="mt-2 text-[11px] text-slate-400">{{ tool.parallelSafe && !tool.sideEffect ? '允许独立节点并行' : '串行执行' }} · {{ tool.sideEffect ? '有持久化副作用' : '只读' }} · {{ tool.replaySafe ? '可安全恢复 / 幂等' : '未知结果需人工核对' }}</p>
      <form class="mt-3 flex flex-wrap items-center gap-3" @submit.prevent="emit('save', { tool: tool.name, ...drafts[tool.name], version: catalog.version })">
        <select v-model="drafts[tool.name].effect" :aria-label="`${tool.label}策略`" :disabled="!admin || busy || tool.execution === 'sandbox_required'" class="rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-xs text-slate-700 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300">
          <option value="deny">拒绝</option><option v-if="tool.execution !== 'sandbox_required'" value="approval">人工审批</option><option v-if="!tool.requiresApproval && !tool.sideEffect && tool.execution !== 'sandbox_required'" value="allow">允许</option>
        </select>
        <label v-for="role in ['user', 'admin']" :key="role" class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-gray-400"><input v-model="drafts[tool.name].roles" type="checkbox" :value="role" :disabled="!admin || busy || tool.execution === 'sandbox_required'" class="accent-sky-600" />{{ role === 'admin' ? '管理员' : '普通用户' }}</label>
        <button v-if="admin && tool.execution !== 'sandbox_required'" type="submit" :disabled="busy" class="ml-auto rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40 dark:bg-sky-700">保存策略</button>
      </form>
    </article>
    <details v-if="admin && catalog.history.length" class="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"><summary class="cursor-pointer font-medium">最近策略变更</summary><ol class="mt-3 space-y-2"><li v-for="(item, index) in [...catalog.history].reverse()" :key="index">{{ formatAgentTime(item.at) }} · {{ item.tool }} → {{ effectLabel(item.rule.effect) }} · {{ item.rule.roles.join(', ') || '无授权角色' }}</li></ol></details>
  </section>
</template>

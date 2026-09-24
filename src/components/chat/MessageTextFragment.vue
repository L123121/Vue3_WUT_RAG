<script setup>
import { computed } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = defineProps({
  content: { type: String, default: '' },
  sources: { type: Array, default: () => [] },
  isModel: Boolean,
  isError: Boolean,
});

const emit = defineEmits(['citation-click', 'copy-code']);
const text = computed(() => String(props.content || ''));
</script>

<template>
  <MarkdownRenderer
    v-if="isModel && !isError"
    :content="text"
    :sources="sources"
    @citation-click="emit('citation-click', $event)"
    @copy-code="emit('copy-code', $event)"
  />
  <div v-else-if="text" class="whitespace-pre-wrap leading-relaxed">{{ text }}</div>
</template>

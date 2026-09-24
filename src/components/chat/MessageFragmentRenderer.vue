<script setup>
import { computed } from 'vue';
import {
  createDecisionDraftFragment,
  getMessageFragments,
  MESSAGE_FRAGMENT_TYPES,
} from '../../utils/messageFragments.js';
import { getMessageFragmentProps, resolveMessageFragment } from './messageFragmentRegistry.js';

const props = defineProps({
  message: { type: Object, required: true },
  isStreaming: Boolean,
  isInputDisabled: Boolean,
  suppressText: Boolean,
  // 决策思考草稿：run 级瞬态文本，只在当前流式气泡上合成一条前置 fragment，
  // 不写入 message.fragments，因此不会被缓存持久化。
  decisionDraft: { type: String, default: '' },
});

const emit = defineEmits([
  'citation-click',
  'copy-code',
  'send-followup',
  'open-image',
  'focus-input',
  'navigate-knowledge',
]);

const isUser = computed(() => props.message.role === 'user');
const isModel = computed(() => props.message.role === 'model');
const isError = computed(() => props.message.isError === true);

const fragments = computed(() => {
  const known = getMessageFragments(props.message)
    .filter((fragment) => !(props.suppressText && fragment.type === MESSAGE_FRAGMENT_TYPES.TEXT));
  if (props.decisionDraft && isModel.value && !isError.value) {
    return [createDecisionDraftFragment(props.decisionDraft), ...known];
  }
  return known;
});

const context = (fragment) => ({
  message: props.message,
  fragment,
  isUser: isUser.value,
  isModel: isModel.value,
  isError: isError.value,
  isStreaming: props.isStreaming,
  isInputDisabled: props.isInputDisabled,
});

const resolveComponent = (fragment) => resolveMessageFragment(fragment).component;
const resolveProps = (fragment) => getMessageFragmentProps(fragment, context(fragment));
</script>

<template>
  <component
    v-for="fragment in fragments"
    :is="resolveComponent(fragment)"
    :key="fragment.id"
    v-bind="resolveProps(fragment)"
    @citation-click="emit('citation-click', $event)"
    @copy-code="emit('copy-code', $event)"
    @send-followup="emit('send-followup', $event)"
    @open-image="emit('open-image', $event)"
    @focus-input="emit('focus-input')"
    @navigate-knowledge="emit('navigate-knowledge')"
  />
</template>

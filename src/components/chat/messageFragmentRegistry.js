import {
  MESSAGE_FRAGMENT_TYPES,
  isAgentTrace,
} from '../../utils/messageFragments.js';
import MessageAttachmentsFragment from './MessageAttachmentsFragment.vue';
import MessageTextFragment from './MessageTextFragment.vue';
import MessageStatusFragment from './MessageStatusFragment.vue';
import DecisionDraftFragment from './DecisionDraftFragment.vue';
import ProcessCard from './ProcessCard.vue';
import AgentToolPanel from './AgentToolPanel.vue';
import RetrievalTracePanel from './RetrievalTracePanel.vue';
import FallbackMessageFragment from './FallbackMessageFragment.vue';
import UnknownMessageFragment from './UnknownMessageFragment.vue';

const getText = (message) => String(message?.content ?? message?.text ?? message?.message ?? '');

const registry = Object.freeze({
  [MESSAGE_FRAGMENT_TYPES.ATTACHMENTS]: {
    component: MessageAttachmentsFragment,
    props: ({ message, isUser }) => ({ files: message.files || [], isUser }),
  },
  [MESSAGE_FRAGMENT_TYPES.TEXT]: {
    component: MessageTextFragment,
    props: ({ message, isModel, isError }) => ({
      content: getText(message),
      sources: message.sources || [],
      isModel,
      isError,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.PROCESS_CARD]: {
    component: ProcessCard,
    props: ({ message }) => ({ card: message.processCard }),
  },
  [MESSAGE_FRAGMENT_TYPES.DECISION_BADGE]: {
    component: MessageStatusFragment,
    props: ({ message, isModel, isError, isStreaming, isInputDisabled }) => ({
      variant: MESSAGE_FRAGMENT_TYPES.DECISION_BADGE,
      decision: message.decision,
      isModel,
      isError,
      isStreaming,
      isInputDisabled,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.DECISION_DRAFT]: {
    component: DecisionDraftFragment,
    props: ({ fragment }) => ({ text: fragment?.data?.text || '' }),
  },
  [MESSAGE_FRAGMENT_TYPES.INTENT_BADGE]: {
    component: MessageStatusFragment,
    props: ({ message, isModel, isError, isStreaming, isInputDisabled }) => ({
      variant: MESSAGE_FRAGMENT_TYPES.INTENT_BADGE,
      intent: message.intent,
      isModel,
      isError,
      isStreaming,
      isInputDisabled,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.GROUNDING_BADGE]: {
    component: MessageStatusFragment,
    props: ({ message, isModel, isError, isStreaming, isInputDisabled }) => ({
      variant: MESSAGE_FRAGMENT_TYPES.GROUNDING_BADGE,
      grounding: message.grounding,
      isModel,
      isError,
      isStreaming,
      isInputDisabled,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.USAGE]: {
    component: MessageStatusFragment,
    props: ({ message, isModel, isError, isStreaming, isInputDisabled }) => ({
      variant: MESSAGE_FRAGMENT_TYPES.USAGE,
      usage: message.usage,
      isModel,
      isError,
      isStreaming,
      isInputDisabled,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.FOLLOWUPS]: {
    component: MessageStatusFragment,
    props: ({ message, isModel, isError, isStreaming, isInputDisabled }) => ({
      variant: MESSAGE_FRAGMENT_TYPES.FOLLOWUPS,
      followups: message.followups || [],
      isModel,
      isError,
      isStreaming,
      isInputDisabled,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.AGENT_TOOLS]: {
    component: AgentToolPanel,
    props: ({ message }) => ({
      toolCalls: message.toolCalls || [],
      toolResults: message.toolResults || [],
      agentTrace: isAgentTrace(message.ragTrace) ? message.ragTrace : null,
    }),
  },
  [MESSAGE_FRAGMENT_TYPES.RETRIEVAL_TRACE]: {
    component: RetrievalTracePanel,
    props: ({ message }) => ({ trace: message.ragTrace }),
  },
  [MESSAGE_FRAGMENT_TYPES.FALLBACK_GUIDANCE]: {
    component: FallbackMessageFragment,
    props: () => ({}),
  },
  [MESSAGE_FRAGMENT_TYPES.UNKNOWN]: {
    component: UnknownMessageFragment,
    props: ({ fragment }) => ({
      originalType: fragment.originalType || 'unknown',
      data: fragment.data,
    }),
  },
});

export const resolveMessageFragment = (fragment) => (
  registry[fragment?.type] || registry[MESSAGE_FRAGMENT_TYPES.UNKNOWN]
);

export const getMessageFragmentProps = (fragment, context) => {
  const definition = resolveMessageFragment(fragment);
  return definition.props({ ...context, fragment });
};

export { registry as messageFragmentRegistry };

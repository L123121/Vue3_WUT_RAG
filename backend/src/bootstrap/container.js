'use strict';

const { AiService } = require('../services/llm/ai.service');
const { RagService } = require('../services/rag/rag.service');
const { MemoryService } = require('../services/memory/memory.service');
const { IntentRouter } = require('../services/agent/intent-router.service');
const { AgentService } = require('../services/agent/agent.service');
const { AgenticRagService } = require('../services/agent/agentic-rag.service');
const { JevDecisionService } = require('../services/agent/jev-decision.service');
const { ConversationOrchestrator } = require('../services/conversation/conversation-orchestrator.service');
const { audioService } = require('../services/media/audio.service');

function createApplicationContainer(overrides = {}) {
  const aiService = overrides.aiService || new AiService();
  const ragService = overrides.ragService || new RagService(aiService);
  const memoryService = overrides.memoryService || new MemoryService();
  const intentRouter = overrides.intentRouter || new IntentRouter(aiService);
  const agentService = overrides.agentService || new AgentService(aiService);
  const agenticRagService = overrides.agenticRagService || new AgenticRagService({ aiService, ragService });
  const decisionModel = overrides.decisionModel || new JevDecisionService();
  const conversationOrchestrator = overrides.conversationOrchestrator || new ConversationOrchestrator({
    aiService,
    ragService,
    memoryService,
    intentRouter,
    agentService,
    agenticRagService,
    decisionModel,
  });

  return {
    aiService,
    ragService,
    memoryService,
    intentRouter,
    agentService,
    agenticRagService,
    decisionModel,
    conversationOrchestrator,
    audioService: overrides.audioService || audioService,
  };
}

let applicationContainerInstance = null;

function getApplicationContainer() {
  if (!applicationContainerInstance) {
    applicationContainerInstance = createApplicationContainer();
  }
  return applicationContainerInstance;
}

module.exports = {
  createApplicationContainer,
  getApplicationContainer,
  get applicationContainer() {
    return getApplicationContainer();
  },
};

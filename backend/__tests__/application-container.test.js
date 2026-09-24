import { describe, expect, it } from 'vitest';

const containerModule = require('../src/bootstrap/container');
const { createApplicationContainer, getApplicationContainer } = containerModule;

describe('application container', () => {
  it('允许在组合根替换应用服务依赖', () => {
    const dependencies = {
      aiService: { name: 'ai' },
      ragService: { name: 'rag' },
      memoryService: { name: 'memory' },
      intentRouter: { name: 'intent' },
      agentService: { name: 'agent' },
      agenticRagService: { name: 'agentic-rag' },
      decisionModel: { name: 'decision' },
      conversationOrchestrator: { name: 'conversation' },
      audioService: { name: 'audio' },
    };

    expect(createApplicationContainer(dependencies)).toEqual(dependencies);
  });

  it('默认应用容器通过 getter 按需创建', () => {
    const descriptor = Object.getOwnPropertyDescriptor(containerModule, 'applicationContainer');
    expect(getApplicationContainer).toBeTypeOf('function');
    expect(descriptor?.get).toBeTypeOf('function');
  });
});

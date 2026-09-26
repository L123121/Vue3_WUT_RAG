"use strict";

const QUESTION_TYPE = {
  AUTHORITATIVE: 'authoritative',
  KNOWLEDGE: 'knowledge',
  FACTUAL: 'factual',
  GENERAL: 'general',
};

const TYPE_CONFIG = {
  authoritative: { minScore: 0.50, rerankTopK: 6, needSource: true, clamp: [0.35, 0.70] },
  knowledge: { minScore: 0.25, rerankTopK: 6, needSource: false, clamp: [0.15, 0.40] },
  factual: { minScore: 0.40, rerankTopK: 6, needSource: true, clamp: [0.25, 0.55] },
  general: { minScore: 0.30, rerankTopK: 6, needSource: false, clamp: [0.20, 0.50] },
};

const DOC_CATEGORY_KEYWORDS = {
  '学校概况': ['校训', '食堂', '宿舍', '社团', '校区', '图书馆', '报到', '开学', '学费', '奖学金', '校史', '地图', '一卡通', '军训', '转专业', '校车', '体育'],
  '专业课程': ['离散数学', '软件工程', '课程', '复习', '教材', '知识点', '算法', '数据结构', '组成原理', '计算机网络', '操作系统', '数据库', '编译', '期末', '课件', '作业', '考试'],
  '面试刷题': ['面试', '刷题', 'CodeTop', '大厂', 'offer', '笔试', '简历', '面经', '算法题', '八股', '手撕'],
  'AI学习': ['Agent', 'RAG', '大模型', 'LLM', '智能体', '提示词', 'Prompt', '机器学习', '深度学习', 'Embedding', 'Rerank', '向量检索', 'AIGC'],
};

function classifyQuestion(query) {
  const value = String(query || '');
  if (/教务|选课|学分|毕业|学位|补考|重修|转专业|奖学金|处分|成绩|GPA|考试|报名|申请|条件|要求|规定|政策|规则|流程|手续|办法|制度|资格|审核|审批/.test(value)) {
    return QUESTION_TYPE.AUTHORITATIVE;
  }
  if (/多少|几个|哪些|何时|哪里|谁|电话|地址|网站|邮箱|号码|比例|率|面积|人数|成立于|建于/.test(value)) {
    return QUESTION_TYPE.FACTUAL;
  }
  if (/什么是|解释|说说|区别|差异|不同|特点|特征|定义|概念|原理|方法|算法|为什么|如何|怎样|怎么|举例|说明|描述|理解|介绍|概述|总结|分类|组成|结构|功能|作用|优势|劣势|优缺点|比较|对比/.test(value)) {
    return QUESTION_TYPE.KNOWLEDGE;
  }
  return QUESTION_TYPE.GENERAL;
}

function getTypeConfig(query) {
  const type = classifyQuestion(query);
  return { type, ...(TYPE_CONFIG[type] || TYPE_CONFIG.general) };
}

function inferDocCategory(query, enabled = true) {
  if (!enabled) return null;
  const value = String(query || '').trim();
  if (!value) return null;

  let bestCategory = null;
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(DOC_CATEGORY_KEYWORDS)) {
    const hits = keywords.reduce((count, keyword) => count + (value.includes(keyword) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      bestCategory = category;
    }
  }
  return bestHits >= 2 ? bestCategory : null;
}

function adaptiveTruncate(candidates, maxCount, query, overrides = {}, resolveTypeConfig = getTypeConfig) {
  if (!candidates || candidates.length === 0) return [];
  if (candidates.length <= 1) return candidates;

  const typeConfig = query ? resolveTypeConfig(query) : null;
  // maxCount（RAG_RERANK_TOP_K）与类型上限取小：此前 maxCount 被 typeConfig 恒定覆盖，env 旋钮无效
  const effectiveMaxCount = Math.min(
    overrides.rerankTopK ?? maxCount,
    typeConfig ? typeConfig.rerankTopK : maxCount,
  );
  const baseMinScore = overrides.rerankMinScore ?? (typeConfig ? typeConfig.minScore : 0.30);
  const clamp = typeConfig ? typeConfig.clamp : [0.20, 0.50];
  const cliffGap = overrides.rerankDropoff ?? 0.05;
  const sorted = [...candidates].sort((left, right) => (right._rerankScore || 0) - (left._rerankScore || 0));

  let cliffCutoff = sorted.length;
  for (let index = 1; index < sorted.length; index++) {
    const gap = (sorted[index - 1]._rerankScore || 0) - (sorted[index]._rerankScore || 0);
    if (gap > cliffGap) {
      cliffCutoff = index;
      break;
    }
  }

  const topScore = sorted[0]._rerankScore || 0;
  let dynamicMinScore;
  if (overrides.rerankMinScore !== undefined) {
    dynamicMinScore = overrides.rerankMinScore;
  } else if (topScore > 0.8) {
    dynamicMinScore = Math.max(clamp[0], baseMinScore - 0.05);
  } else if (topScore < 0.3) {
    dynamicMinScore = Math.min(clamp[1], baseMinScore + 0.10);
  } else {
    dynamicMinScore = baseMinScore;
  }
  if (overrides.rerankMinScore === undefined) {
    dynamicMinScore = Math.max(clamp[0], Math.min(clamp[1], dynamicMinScore));
  }

  const scoreCutoff = sorted.findIndex((candidate) => (candidate._rerankScore || 0) < dynamicMinScore);
  const cutoff = scoreCutoff >= 0 && scoreCutoff <= cliffCutoff ? scoreCutoff : cliffCutoff + 1;
  const result = sorted.slice(0, Math.max(1, Math.min(cutoff, effectiveMaxCount)));
  if (result.length === 1 && sorted.length >= 2 && (sorted[1]._rerankScore || 0) > dynamicMinScore) {
    result.push(sorted[1]);
  }
  return result;
}

function charBigrams(text) {
  const value = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let index = 0; index < value.length - 1; index++) set.add(value.slice(index, index + 2));
  return set;
}

function jaccardBigrams(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function mmrDedupe(parentCandidates, maxCount = 0, options = {}) {
  const { enabled = true, lambda = 0.7, maxSimilarity = 0.85 } = options;
  if (!enabled || !Array.isArray(parentCandidates) || parentCandidates.length <= 1) return parentCandidates || [];

  const limit = Math.min(maxCount > 0 ? maxCount : parentCandidates.length, parentCandidates.length);
  if (limit <= 1) return parentCandidates.slice(0, 1);

  const textOf = (candidate) => candidate.parentText || candidate.bestChunk?.text || '';
  const scoreOf = (candidate) => candidate._rerankScore ?? candidate.bestChunk?.score ?? candidate.score ?? 0;
  const bigramSets = parentCandidates.map((candidate) => charBigrams(textOf(candidate)));
  const similarityCache = new Map();
  const similarity = (left, right) => {
    const key = left < right ? `${left}:${right}` : `${right}:${left}`;
    if (!similarityCache.has(key)) similarityCache.set(key, jaccardBigrams(bigramSets[left], bigramSets[right]));
    return similarityCache.get(key);
  };

  const order = parentCandidates
    .map((_, index) => index)
    .sort((left, right) => scoreOf(parentCandidates[right]) - scoreOf(parentCandidates[left]));
  const selected = [order[0]];
  const remaining = order.slice(1);

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    for (const index of remaining) {
      let maxSim = 0;
      for (const selectedIndex of selected) {
        if (parentCandidates[index].docId !== parentCandidates[selectedIndex].docId) continue;
        maxSim = Math.max(maxSim, similarity(index, selectedIndex));
      }
      if (maxSim >= maxSimilarity) continue;
      const value = lambda * scoreOf(parentCandidates[index]) - (1 - lambda) * maxSim;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    selected.push(bestIndex);
    remaining.splice(remaining.indexOf(bestIndex), 1);
  }

  return selected.map((index) => parentCandidates[index]);
}

module.exports = {
  QUESTION_TYPE,
  TYPE_CONFIG,
  DOC_CATEGORY_KEYWORDS,
  classifyQuestion,
  getTypeConfig,
  inferDocCategory,
  adaptiveTruncate,
  charBigrams,
  jaccardBigrams,
  mmrDedupe,
};

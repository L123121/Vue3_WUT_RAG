"use strict";

function buildParentChildPrompt(query, context) {
  if (!context) return query;
  return `你是武汉理工大学校园知识助手。请严格根据“参考资料”回答用户问题。

要求：
1. 回答要详细、完整、具体：把资料中的关键信息（时间、地点、条件、流程、数量、联系方式等）都展开说明，分点或分条组织，不要只给一句话结论。
2. 优先使用参考资料，不要编造资料中没有的信息；资料不足时明确说明缺什么，并建议用户补充资料或换一种问法。
3. 回答关键事实时引用文档编号，例如“根据【文档 1】”。
4. 如果不同文档存在冲突，优先说明冲突点，不要自行合并成确定结论。
5. 输出用 Markdown 排版：标题和列表项必须独占一行。重要信息加粗，方便阅读。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
参考资料：
${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用户问题：${query}`;
}

function isProcessQuestion(query) {
  return /补办|办理|申请|报名|流程|步骤|手续|怎么办|如何办理|怎么做|需要什么材料|材料|多久|多长时间|在哪办|哪里办|费用是多少/.test(String(query || ''));
}

function buildProcessPrompt(query, context) {
  if (!context) return query;
  return `你是武汉理工大学校园知识助手。请严格根据“参考资料”回答用户问题，并且必须输出严格 JSON。

要求：
1. 只依据参考资料回答，不要编造资料中没有的信息；资料不足时对应字段填 null 或空数组。
2. 输出结构：{"summary":"一句话概述","steps":[{"title":"步骤标题","detail":"操作说明"}],"materials":[],"location":null,"duration":null,"notes":null}
3. 步骤中的关键事实请标注文档引用，例如 detail 中写“根据【文档 1】”。
4. steps 至少 1 项；不要使用 Markdown 代码块，不要输出 JSON 之外的文字。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
参考资料：
${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用户问题：${query}`;
}

function parseProcessCard(reply) {
  if (!reply || typeof reply !== 'string') return null;
  try {
    const text = String(reply).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const card = {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.filter((step) => step && (step.title || step.detail)).map((step) => ({
          title: String(step.title || '').trim(),
          detail: String(step.detail || '').trim(),
        }))
        : [],
      materials: Array.isArray(parsed.materials)
        ? parsed.materials.map((material) => String(material || '').trim()).filter(Boolean)
        : [],
      location: parsed.location ? String(parsed.location) : null,
      duration: parsed.duration ? String(parsed.duration) : null,
      notes: parsed.notes ? String(parsed.notes) : null,
    };
    return card.steps.length > 0 || card.materials.length > 0 || card.location || card.duration ? card : null;
  } catch {
    return null;
  }
}

function buildNoReliableSourcesReply() {
  return '知识库中没有检索到足够可靠的来源。请换一种问法，或先在知识库中上传/补充相关文档后再试。';
}

module.exports = {
  buildNoReliableSourcesReply,
  buildParentChildPrompt,
  buildProcessPrompt,
  isProcessQuestion,
  parseProcessCard,
};

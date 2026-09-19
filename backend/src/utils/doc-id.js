"use strict";

const crypto = require('crypto');

/**
 * 文档 ID 派生方案（评测复现性的基础）
 *
 * ID = doc_ + sha256(标题 \u0000 类别) 的前 32 位十六进制。
 *
 * 为什么不用随机 UUID：知识库里的文档 ID 会被评测数据集硬编码（`relevant_doc_ids`），
 * 随机 ID 意味着换一台机器重新入库就再也对不上，指标无法被他人复现。
 *
 * 为什么不用内容哈希：内容哈希取决于入库管线的归一化细节（页眉页脚清理、断行合并、
 * 字符规整）。管线一调整，全部文档 ID 都会变，评测映射又会整体失效；
 * 而且历史记录里的 contentHash 与当前管线已经对不上（2026-09-12 实测 16/16 不一致），
 * 无法离线重算。用"来源标识"（标题 + 类别）则与管线解耦，是稳定的。
 *
 * 已知代价：同一 (标题, 类别) 的不同内容会派生出同一 ID，即"覆盖"语义——
 * 重新入库同名文档会替换旧文档，而不是并存两条。调用方需先清掉该 ID 的旧向量。
 */
const DOC_ID_SCHEME = 'doc_<sha256(title\\u0000category)[0:32]>';

/**
 * @param {string} title 文档标题
 * @param {string} [category] 文档类别
 * @returns {string} 形如 doc_1f2e3d... 的确定性 ID
 */
function deriveDocId(title, category) {
  const normTitle = String(title == null ? '' : title).trim();
  const normCategory = String(category == null ? 'general' : category).trim();
  const key = `${normTitle}\u0000${normCategory}`;
  return `doc_${crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
}

module.exports = { deriveDocId, DOC_ID_SCHEME };

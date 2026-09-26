"use strict";

const { redis: store } = require('./memory-store.service');
const { logEvent } = require('../observability/observability.service');

class UserProfile {
  async update(userId, profile) {
    const key = `memory:${userId}:profile`;
    const existing = await store.hgetall(key) || {};
    await store.hset(key, { ...existing, ...profile, updatedAt: new Date().toISOString() });
  }

  async get(userId) {
    const key = `memory:${userId}:profile`;
    return (await store.hgetall(key)) || {};
  }

  /**
   * 从对话中自动提取用户画像
   */
  async extract(userId, message) {
    const updates = {};

    // 姓名
    const nameMatch = message.match(/我叫(.{2,8})[，。！？\s]|我是(.{2,8})[，。！？\s]?同学/);
    if (nameMatch) updates.name = nameMatch[1] || nameMatch[2];

    // 学号
    const idMatch = message.match(/\b(\d{10,12})\b/);
    if (idMatch) updates.studentId = idMatch[1];

    // 学院
    const collegeMatch = message.match(/(?:我是|我在|在|于)?(.{2,6})学院/);
    if (collegeMatch) updates.college = collegeMatch[1] + '学院';

    // 专业
    const majorMatch = message.match(/专业是(\S{2,20})|(\S{2,20})专业/);
    if (majorMatch) updates.major = majorMatch[1] || majorMatch[2];

    if (Object.keys(updates).length > 0) {
      await this.update(userId, updates);
      logEvent('info', 'memory_profile_extracted', { profile: updates });
    }
  }
}

module.exports = { UserProfile };

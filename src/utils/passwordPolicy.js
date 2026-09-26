/**
 * 密码策略 — 与后端 auth.service 的 assertPasswordPolicy 保持同一基线：
 * 长度 8-128，且需同时包含字母和数字。
 * 返回错误提示文案，通过校验时返回空字符串。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function validatePasswordPolicy(password) {
  const pwd = String(password || '');
  if (pwd.length < PASSWORD_MIN_LENGTH || pwd.length > PASSWORD_MAX_LENGTH) {
    return `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`;
  }
  if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    return '密码需同时包含字母和数字';
  }
  return '';
}

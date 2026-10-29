export const agentStatusLabels = {
  draft: '计划草稿', queued: '等待执行器', running: '执行中', waiting: '等待依赖 / 计划时间',
  awaiting_approval: '等待人工审批', pause_requested: '正在暂停', paused: '已暂停',
  cancel_requested: '正在取消', cancelled: '已取消', completed: '已完成', failed: '执行失败',
  blocked: '权限阻止', attention: '需要人工核对', expired: '已过期',
  pending: '待执行', retrying: '等待重试', succeeded: '已完成', denied: '已拒绝', uncertain: '结果未知',
};
export const agentStatusLabel = status => agentStatusLabels[status] || status;
export const isAgentTerminal = status => ['completed', 'cancelled', 'expired'].includes(status);
export const canResumeAgent = status => ['failed', 'paused', 'blocked', 'awaiting_approval', 'attention'].includes(status);
export const formatAgentTime = value => value ? new Date(value).toLocaleString('zh-CN') : '未设置';
export const agentEventLabel = type => ({
  'run.created': '创建计划', 'plan.updated': '修改计划', 'run.queued': '计划进入执行队列',
  'run.leased': '执行器领取计划', 'step.started': '开始执行步骤', 'step.succeeded': '结果已写入检查点',
  'step.failed': '步骤失败 / 中断', 'step.approval_requested': '请求人工审批', 'step.approved': '用户批准一次执行',
  'step.denied': '用户拒绝执行', 'step.blocked': '工具权限拦截', 'steps.recovered': '恢复中断步骤',
  'steps.interrupted': '保存中断状态', 'run.resumed': '从检查点恢复', 'run.completed': '计划完成',
  'run.awaiting_approval': '释放执行器，等待审批', 'run.waiting': '等待下一组步骤',
  'run.pause_requested': '请求暂停', 'run.paused': '已暂停', 'run.cancel_requested': '请求取消',
  'run.cancelled': '计划已取消', 'run.failed': '计划失败', 'run.blocked': '计划被策略阻止',
  'run.expired': '计划期限耗尽', 'run.attention': '需要核对未知结果', 'run.worker_error': '执行器异常暂停',
}[type] || type);

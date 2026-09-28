import { ref } from 'vue'
import { useAuth } from './auth'
import { JobError } from './jobs'
import type { ToastAction } from './toast'

// Job whose log lines are shown in the JobLogsDialog (mounted once in the
// dashboard layout); null when the dialog is closed.
export const jobLogsTarget = ref<string | null>(null)

export function openJobLogs(jobId: string) {
  jobLogsTarget.value = jobId
}

/** Job id of a failed job error, when the current user may read its logs. */
export function viewableJobId(e: unknown): string | undefined {
  return e instanceof JobError && useAuth().isAdmin.value ? e.jobId : undefined
}

/** "View logs" toast action for a failed job error, for admins only. */
export function viewLogsAction(e: unknown): ToastAction | undefined {
  const jobId = viewableJobId(e)
  return jobId ? { label: 'View logs', run: () => openJobLogs(jobId) } : undefined
}

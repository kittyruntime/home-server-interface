import { reactive } from 'vue'

export interface PendingAppJob {
  name: string
  jobId: string
  action: string
}

/** Jobs remain registered across the create/edit form and the container list. */
export const knownAppJobs = reactive(new Map<string, PendingAppJob>())

export function registerAppJob(job: PendingAppJob): void {
  knownAppJobs.set(job.name, job)
}

/** Clear only the job that was observed; a newer job may already own the name. */
export function clearAppJob(name: string, jobId: string): void {
  if (knownAppJobs.get(name)?.jobId === jobId) knownAppJobs.delete(name)
}

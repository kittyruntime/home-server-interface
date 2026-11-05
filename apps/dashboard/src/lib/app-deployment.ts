import type { JobResult } from './jobs'

export interface DeploymentJob {
  jobId: string
}

export interface AppDeploymentResult<TConfiguration> {
  configuration: TConfiguration
  jobId: string
  status: 'completed' | 'failed' | 'pending'
  error: string | null
}

/** A failed two-step create can still have durably written the app definition. */
export function isSavedBeforeStartFailure(result: { results: Array<{ status: string }> }): boolean {
  return result.results.length > 1 && result.results[0]?.status === 'done'
}

/** Save an app and request its initial start in the same planned operation. */
export async function deployApp<TConfiguration>(
  configuration: TConfiguration,
  save: (configuration: TConfiguration, start: true) => Promise<DeploymentJob>,
  observe: (jobId: string) => Promise<JobResult>,
): Promise<AppDeploymentResult<TConfiguration>> {
  const { jobId } = await save(configuration, true)
  if (!jobId) throw new Error('The start job was not returned')
  const result = await observe(jobId)
  return {
    configuration,
    jobId,
    status: result.status === 'timeout' || result.failureSource === 'observer' ? 'pending' : result.status,
    error: result.error,
  }
}

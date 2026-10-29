// Steps of the maintenance overlay (#132), kept apart from the runtime so the
// Node tests can import them.

export type MaintenanceStep = 'scheduled' | 'working' | 'offline' | 'done'

export const MAINTENANCE_STEPS: MaintenanceStep[] = ['scheduled', 'working', 'offline', 'done']

/** The step a poll shows: the server unreachable, still in maintenance, or
 *  back without it. Steps never go back, so a quick restart that no poll saw
 *  offline still reads in order. */
export function nextMaintenanceStep(prev: MaintenanceStep, reachable: boolean, active: boolean): MaintenanceStep {
  const seen: MaintenanceStep = !reachable ? 'offline' : active ? 'working' : 'done'
  return MAINTENANCE_STEPS.indexOf(seen) > MAINTENANCE_STEPS.indexOf(prev) ? seen : prev
}

export function maintenanceStepState(current: MaintenanceStep, step: MaintenanceStep): 'done' | 'active' | 'pending' {
  const ci = MAINTENANCE_STEPS.indexOf(current)
  const si = MAINTENANCE_STEPS.indexOf(step)
  if (si < ci || (current === 'done' && step === 'done')) return 'done'
  return si === ci ? 'active' : 'pending'
}

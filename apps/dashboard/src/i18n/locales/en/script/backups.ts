// Messages from the scripts (notices, errors, labels), generated, then kept by hand.
export default {
  PlanCard: {
    missingRepository: 'missing repository',
    removeThePlan: 'Remove the plan {p0}',
    removePlan: 'Remove plan',
  },
  PlanForm: {
    latest: 'Latest',
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    savePlan: 'Save plan',
  },
  RepositoryCard: {
    neverChecked: 'Never checked',
    removeTheRepository: 'Remove the repository {p0}',
    removeRepository: 'Remove repository',
    hsiForgetsThePasswordOf: 'HSI forgets the password of this repository. Without it, the backups stored there cannot be read.',
    iKeptThePasswordOf: 'I kept the password of this repository, or I no longer need these backups',
  },
  RepositoryForm: {
    saveRepository: 'Save repository',
  },
  RestoreDialog: {
    unknownPlan: 'Unknown plan',
    restore: 'Restore',
    theRestoreDidNotStart: 'The restore did not start',
  },
  RestoreForm: {
    checkFailed: 'Check failed ({p0})',
    theBackupCouldNotBe: 'The backup could not be read',
    restoreFailed: 'Restore failed ({p0})',
    configurationRestoreFailed: 'Configuration restore failed',
    replaceTheCurrentHsiConfiguration: 'Replace the current HSI configuration with this backup and restart HSI? Volumes stay as they are, and apps come back stopped.',
    restoreConfiguration: 'Restore configuration',
    restoreAndRestart: 'Restore and restart',
    notReady: 'not ready',
  },
}

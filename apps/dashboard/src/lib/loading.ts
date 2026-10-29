import { reactive } from 'vue'

// Loading copy in one place (#39), in English; i18n/labels.ts puts it in the
// interface language. The components add the trailing ellipsis.
export const LOADING = reactive({
  default: 'Loading',
  analyzing: 'Analyzing',
  preparingPlan: 'Preparing the plan',
  verifying: 'Verifying',
  encrypting: 'Encrypting',
  saving: 'Saving',
  searching: 'Searching',
  readingSmart: 'Reading S.M.A.R.T. data',
})

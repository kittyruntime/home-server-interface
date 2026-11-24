import { shallowRef } from 'vue'

// The viewer's pause of the Monitor's live readings (performance and
// processes): the pollers skip their turns while it is set, so the figures
// stay frozen for reading. The Monitor clears it when it closes.
export const livePaused = shallowRef(false)

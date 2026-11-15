// Names shared by the checklists and their exports, kept apart so the MATLAB export (on the start page's path) does
// not load the checklists themselves.

import type { DynamicModeId } from '../types'

export const MODE_NAMES: Readonly<Record<DynamicModeId, string>> = {
  'short-period': 'Short period',
  phugoid: 'Phugoid',
  'dutch-roll': 'Dutch roll',
  'roll-subsidence': 'Roll subsidence',
  spiral: 'Spiral',
}

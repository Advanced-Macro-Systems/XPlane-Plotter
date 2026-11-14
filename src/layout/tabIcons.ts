// One icon per tab, shared by the tab bar and the Overview's "Next steps" cards.

import {
  CrosshairsIcon,
  GraphIcon,
  HomeIcon,
  ListUnorderedIcon,
  PinIcon,
  PulseIcon,
  type Icon,
} from '@primer/octicons-react'
import type { TabId } from '../core/types'

export const TAB_ICONS: Readonly<Record<TabId, Icon>> = {
  overview: HomeIcon,
  time: GraphIcon,
  xy: CrosshairsIcon,
  points: PinIcon,
  modes: PulseIcon,
  channels: ListUnorderedIcon,
}

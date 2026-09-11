// a quick look at what the page would draw, without a browser
import { buildState } from '../server/state'

const state = await buildState({ recordLook: false })
console.log(
  JSON.stringify(
    {
      fiveHour: state.fiveHour,
      weekly: state.weekly,
      fable: state.fable,
      block: { ...state.block, samples: state.block?.samples.length },
      notes: state.notes,
      extra: state.extra,
    },
    null,
    1,
  ),
)
console.log(
  'sessions:',
  state.split?.sessions.map((r) => [r.title?.slice(0, 40), r.share.toFixed(3), r.points?.toFixed(1), r.subagents, r.live]),
)
console.log('others:', state.others.map((o) => [o.title, o.kind, o.live]))
console.log('lanes:', state.day.lanes.length, state.day.lanesError, 'meter points:', state.day.meter.length)
console.log('cost before/after/total:', state.split?.costBeforeFirstSample, state.split?.costAfterLastSample, state.split?.totalCost)

import type { ReactNode } from 'react'
import type { State, WeekMode } from '../api'
import { hm, money } from '../format'
import { BlockSection, WeekSection } from './block'
import { CodexSection } from './codex'
import { Letter } from './letter'
import { Question, Statement } from './ledger'
import { WhenSection } from './when'
import { listOf, plural, rowName } from './words'

/**
 * the whole page for one state: live at `#/`, or frozen at a past window in the
 * history drill-in. the letter on the left answers; the column on the right
 * holds the evidence, one question per section. a frozen page has no week-mode
 * buttons, since the server answers `?at=` with the whole window.
 */
export function PageBody({
  state,
  weekMode,
  onWeekMode,
  frozen = false,
  focus,
  header,
}: {
  state: State
  weekMode: WeekMode
  onWeekMode?: (mode: WeekMode) => void
  frozen?: boolean
  /** a frozen week leads with the week's own ledger; a frozen block reads like today */
  focus?: 'block' | 'week'
  /** the frozen page's bar, set at the top of the evidence column */
  header?: ReactNode
}) {
  const ended = !frozen && state.fiveHour?.ended
  const block = (
    <BlockSection
      state={state}
      frozen={frozen}
      weekMode={weekMode}
      onWeekMode={onWeekMode}
      title={focus === 'week' ? 'The block the week closed on' : ended ? 'What ate the last block' : 'What ate this block'}
    />
  )
  return (
    <div className="answer">
      <Letter state={state} frozen={frozen} focus={focus} />
      <main className="rows">
        {header}
        {focus === 'week' ? (
          <>
            <WeekSection state={state} frozen={frozen} />
            <CodexSection state={state} frozen={frozen} />
            {block}
            <WhenSection state={state} frozen={frozen} />
          </>
        ) : (
          <>
            {block}
            <CodexSection state={state} frozen={frozen} />
            <WhenSection state={state} frozen={frozen} />
          </>
        )}
        <Ground state={state} frozen={frozen} />
        <div className="coda">
          <span className="say">Earlier blocks and weeks read the same way.</span>
          <a className="go" href="#/history">
            history →
          </a>
        </div>
      </main>
    </div>
  )
}

/** what the page stands on: what was read, what was worked out, and what it cannot see */
function Ground({ state, frozen }: { state: State; frozen: boolean }) {
  const five = state.fiveHour
  const split = state.split
  const index = state.index
  const unpriced = (split?.sessions ?? []).filter((row) => row.unpriced && row.share > 0)
  const statements: ReactNode[] = []

  statements.push(
    <Statement key="measured" line={<><b>Measured:</b> the meters, every reset time, the meter line, the lanes, the titles</>}>
      <p>
        The Claude meters come from Anthropic’s usage endpoint every five minutes
        {five ? `, last read ${hm(five.sampledAt)}; the largest gap between readings in this block was ${Math.round(five.maxGap / 60)} min` : ''}
        .{state.codex.sampledAt !== null ? ` Codex was read ${hm(state.codex.sampledAt)}.` : ''} The lanes come from the
        transcripts ({index.done.toLocaleString('en-US')} files indexed
        {index.builtAt === null ? '' : `, last pass ${hm(index.builtAt)}`}) and T3 Code’s thread messages.
      </p>
      <dl className="kv">
        <dt>meters</dt>
        <dd>{state.sources.limits}</dd>
        <dt>transcripts</dt>
        <dd>{state.sources.transcripts}</dd>
        <dt>index</dt>
        <dd>{state.sources.index}</dd>
        <dt>T3</dt>
        <dd>{state.sources.t3}</dd>
      </dl>
    </Statement>,
  )
  statements.push(
    <Statement key="computed" line={<><b>Computed:</b> the shares, the points, the projection, the verdicts, list-price cost</>}>
      <p>
        {state.caveat} {state.week.caveat} The projection and the verdicts are arithmetic on the readings, no model
        involved. List price is what the same tokens would cost on the API; it is a yardstick, not a bill.
      </p>
    </Statement>,
  )
  if (split && (split.costBeforeFirstSample > 0.01 || split.costAfterLastSample > 0.01)) {
    const before = split.costBeforeFirstSample > 0.01
    statements.push(
      <Statement
        key="gap"
        line={
          <>
            <b>Not on the meter:</b>{' '}
            {before
              ? `${money(split.costBeforeFirstSample)} ran before the first reading at ${hm(split.from)}`
              : `${money(split.costAfterLastSample)} since the last reading at ${hm(split.to)}`}
          </>
        }
      >
        <p>
          No meter delta covers {before ? 'it' : 'that stretch'}, so it gets no share and no points.
          {before && split.costAfterLastSample > 0.01
            ? ` ${money(split.costAfterLastSample)} ran after the last reading (${hm(split.to)}) and ${frozen || five?.ended ? 'no reading covers it' : 'is not on the meter yet'}.`
            : ''}
        </p>
      </Statement>,
    )
  }
  if (unpriced.length) {
    statements.push(
      <Statement
        key="unpriced"
        line={
          <>
            <b>Short:</b> {listOf(unpriced.map((row) => rowName(row)))} {unpriced.length === 1 ? 'has' : 'have'} requests
            with no price row
          </>
        }
      >
        <p>The cost marked * is a floor, and its share is correspondingly low. Nothing is priced as zero on purpose.</p>
      </Statement>,
    )
  }
  if (index.building || index.cold) {
    statements.push(
      <Statement key="building" line={<><b>Still indexing:</b> {index.done} of {index.total} transcript files</>}>
        <p>Until the index catches up, the lanes and the split read the transcript tree directly.</p>
      </Statement>,
    )
  }
  if (index.failed > 0) {
    statements.push(
      <Statement key="failed" line={<><b>Missing:</b> {plural(index.failed, 'transcript file')} could not be read</>}>
        <p>The index is missing them, so every figure here is short by whatever they hold; every pass tries again.</p>
      </Statement>,
    )
  }
  if (index.stale > 0) {
    statements.push(
      <Statement key="stale" line={<><b>Effort filling in:</b> {plural(index.stale, 'file')} indexed before effort was recorded</>}>
        <p>Their requests are in every figure but carry no effort level until the index rereads them.</p>
      </Statement>,
    )
  }
  for (const note of state.notes) {
    statements.push(
      <Statement key={note} line={<><b>Unmodelled:</b> {note}</>}>
        <p>The sampler saw a field the page does not compute on; it is shown here so a new limit is not missed.</p>
      </Statement>,
    )
  }

  return (
    <Question
      id="q-ground"
      title="What this stands on"
      lead="Everything above is either read off a meter or worked out from one. Here is which, and what the page cannot see."
    >
      {statements}
    </Question>
  )
}

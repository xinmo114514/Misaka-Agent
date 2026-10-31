/**
 * The thinking-strength slider.
 *
 * Deliberately presentational: driven by levels + value, reporting through onChange,
 * because two very different hosts need it -- the composer popover (the session level *and*
 * the model row that opens the second layer) and the settings panel (session level *and* the
 * persisted default).
 *
 * Stops are discrete on release, but preview positions stay continuous: the thumb rides a
 * transform and the fill is clipped at its center. See .misaka-thinking-* in index.css for why the ramp cannot be
 * a background-image.
 *
 * size="compact" is the popover pill -- a 26px capsule, a 30px thumb and a 36px grab band --
 * while the settings page keeps the slim rail it was designed against. Every position comes
 * from the thumb diameter, so both sizes share one set of maths.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { clampThinkingLevel, labelFor, FALLBACK_THINKING_LEVELS, type ThinkingLevelId } from '../../lib/thinkingLevels'

/**
 * Border-box diameter, including its border. Shared by the rail maths and rendered handle.
 */
const THUMB_BOX = { default: 18, compact: 30 } as const

type SliderSize = keyof typeof THUMB_BOX

interface ThinkingSliderProps {
  levels: readonly ThinkingLevelId[]
  value: string
  onChange: (level: ThinkingLevelId) => void
  /** Where the reset control lands; the host resolves it from the persisted default. */
  resetTo?: ThinkingLevelId
  onReset?: () => void
  /** The ladder is a guess, not something the model advertised. */
  isFallback?: boolean
  modelDefault?: boolean
  /** compact is the popover pill; default is the settings-page rail. */
  size?: SliderSize
  /** Slot between the level header and the rail -- the popover puts its model row here. */
  afterHeader?: React.ReactNode
  /** A model switch is in flight: the preview is real, but a commit would race its ack. */
  busy?: boolean
  /** A host may expose the live depth without allowing mutation. */
  readOnly?: boolean
  /** Bump to move focus onto the rail: on open, and again after the model layer closes. */
  focusSignal?: number
}

export const ThinkingSlider: React.FC<ThinkingSliderProps> = ({
  levels,
  value,
  onChange,
  resetTo,
  onReset,
  isFallback = false,
  modelDefault = false,
  size = 'default',
  afterHeader,
  busy = false,
  readOnly = false,
  focusSignal = 0,
}) => {
  const railRef = useRef<HTMLDivElement>(null)
  const [railWidth, setRailWidth] = useState(0)
  const [drag, setDrag] = useState<{ x: number; index: number; following: boolean } | null>(null)
  const gestureRef = useRef<{ pointerId: number; offset: number } | null>(null)

  const cancelDrag = () => {
    gestureRef.current = null
    setDrag(null)
  }

  // Tailwind's border-box includes the ring in this diameter.
  const thumb = THUMB_BOX[size]
  const activeLevels = modelDefault && levels.length <= 1 ? FALLBACK_THINKING_LEVELS : levels
  const count = activeLevels.length
  const fixedStop = !modelDefault && count <= 1
  // A one-stop ladder and an in-flight switch both disarm the control, but only the former
  // changes what the header says: while busy the previewed level is still the real one.
  const disarmed = fixedStop || busy || readOnly || modelDefault

  useEffect(() => {
    if (size !== 'compact' && !focusSignal) return
    // The rail, not the wrapper: it carries role="slider" and the arrow keys, so focusing it
    // is what makes the first keypress after a layer switch do the obvious thing.
    railRef.current?.focus()
  }, [focusSignal, size])

  // The travel is what every position is derived from, so it has to be measured rather than
  // read during render -- on the first paint the rail has no box yet, and a render is the
  // only thing that can put the thumb where value says it belongs.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || typeof ResizeObserver === 'undefined') return
    const observe = () => setRailWidth(rail.getBoundingClientRect().width)
    observe()
    const ro = new ResizeObserver(observe)
    ro.observe(rail)
    return () => ro.disconnect()
  }, [])

  // A level the model no longer offers still has to land somewhere: showing an index the
  // backend would reject is worse than showing the nearest real stop.
  const effective = useMemo(() => clampThinkingLevel(activeLevels, value), [activeLevels, value])
  const committed = Math.max(0, activeLevels.indexOf(effective))
  const shown = drag ? drag.index : committed
  const label = labelFor(activeLevels[shown] ?? 'off')
  const resetLabel = resetTo ? labelFor(resetTo).zh : null
  // One stop and it is off: the model has no ladder at all. One stop and it is something
  // else: the model has exactly the depth it has, which is worth naming rather than burying
  // behind the 关闭 that the off-only case deserves.
  const empty = count === 0
  const offOnly = count === 1 && effective === 'off'
  const heading = modelDefault ? '默认' : empty ? '没有可选深度' : offOnly ? '不支持思考深度'
    : size === 'compact' && levels[shown] === 'high' ? '高' : label.zh
  const hint = modelDefault ? '采用模型自身默认策略；该模型未提供独立思考深度调节档位。'
    : empty ? '该模型未提供可选档位' : offOnly ? '该模型不支持思考深度'
    : fixedStop ? `${label.en} · 该模型仅有这一档`
      : isFallback ? `${label.en} · 通用档位，未检测到模型能力（可尝试调节）` : `${label.en} · ${label.desc}`

  const tier: 'quiet' | 'near' | 'max' =
    count > 1 && shown === count - 1 ? 'max' : count >= 3 && shown === count - 2 ? 'near' : 'quiet'

  const travel = Math.max(railWidth - thumb, 0)
  const step = count > 1 ? travel / (count - 1) : 0

  const snap = (x: number) =>
    count < 2 || step <= 0 ? 0 : Math.min(count - 1, Math.max(0, Math.round(x / step)))

  const localX = (clientX: number, offset = thumb / 2) => {
    const rect = railRef.current?.getBoundingClientRect()
    return rect ? Math.min(travel, Math.max(0, clientX - rect.left - offset)) : 0
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disarmed || e.button !== 0 || gestureRef.current) return
    // preventDefault keeps the drag from selecting the popover's text, and as a side effect
    // cancels the mousedown focus -- so focus has to be taken explicitly, or the keyboard
    // stops reaching the rail after the first grab.
    e.preventDefault()
    e.currentTarget.focus()
    const handle = e.currentTarget.querySelector('.misaka-thinking-thumb')?.getBoundingClientRect()
    // Preserve the point grabbed, including when the handle is halfway through a snap animation.
    const onHandle = handle && e.clientX >= handle.left && e.clientX <= handle.right
    const offset = onHandle ? e.clientX - handle.left : thumb / 2
    gestureRef.current = { pointerId: e.pointerId, offset }
    e.currentTarget.setPointerCapture(e.pointerId)
    const x = localX(e.clientX, offset)
    setDrag({ x, index: snap(x), following: Boolean(onHandle) })
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!drag || !gesture || e.pointerId !== gesture.pointerId) return
    const x = localX(e.clientX, gesture.offset)
    const index = snap(x)
    // The thumb follows the finger 1:1; only the snapped stop is worth re-rendering for,
    // since it is all the label and the fill can show.
    setDrag((prev) => (prev && prev.index === index && prev.x === x ? prev : { x, index, following: true }))
  }

  // Commit on release, never during: every real level change appends a record to the session
  // transcript (appendThinkingLevelChange), so a per-pixel commit would write the drag
  // itself into the conversation.
  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = gestureRef.current
    if (!drag || !gesture || e.pointerId !== gesture.pointerId) return
    // pointerup is the final position even when the browser coalesced its last move event.
    const picked = levels[snap(localX(e.clientX, gesture.offset))]
    cancelDrag()
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // A cancelled gesture only drops the preview: the rail snaps back to the last committed
    // stop, which is all cancel can mean for a control with no free position.
    if (!cancelled && !disarmed && picked && picked !== effective) onChange(picked)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && drag) {
      e.preventDefault()
      e.stopPropagation()
      cancelDrag()
      return
    }
    if (disarmed) return
    const last = count - 1
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(last, committed + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, committed - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next === null) return
    // The popover scrolls its model list with these same keys; a focused rail must not.
    e.preventDefault()
    if (drag) return // The pointer gesture owns preview and its single release commit.
    const picked = levels[next]
    if (picked && picked !== effective) onChange(picked)
  }

  // Swapping to a shallower model mid-drag would leave the preview pointing off the end.
  useLayoutEffect(() => {
    gestureRef.current = null
    setDrag(null)
  }, [levels, value, busy, readOnly, size])

  const thumbX = modelDefault ? 0 : drag ? drag.x : step * committed
  // Preview labels round to stops; the ink must never use that rounded index for geometry.
  const fillX = modelDefault ? 0 : fixedStop ? (!empty && !offOnly ? railWidth : 0) : thumbX + thumb / 2
  const fillP = railWidth > 0 ? fillX / railWidth : 0

  return (
    <div
      className={
        'misaka-thinking-slider ' + (size === 'compact' ? 'space-y-1' : 'w-[260px] space-y-1')
      }
      data-tier={modelDefault ? 'quiet' : tier}
      data-default={modelDefault ? '' : undefined}
      data-size={size}
      data-dragging={drag ? '' : undefined}
      data-following={drag?.following ? '' : undefined}
      data-busy={busy ? '' : undefined}
    >
      <div className={size === 'compact' ? 'relative flex min-h-5 items-center justify-center px-7' : 'flex items-start justify-between gap-2'}>
        <div className={'min-w-0 ' + (size === 'compact' ? 'flex-1 text-center' : '')}>
          <div
            className={
              'misaka-thinking-heading font-semibold leading-tight ' +
              (size === 'compact'
                ? (modelDefault ? 'text-[16px] text-muted' : 'text-[16px] text-accent')
                : 'text-[15px] text-text-main')
            }
            title={size === 'compact' ? hint : undefined}
          >
            {heading}
          </div>
          {(size !== 'compact' || isFallback || fixedStop) && <div
            className={
              'text-[10px] mt-0.5 truncate ' + (size === 'compact' ? 'text-muted' : 'text-dim')
            }
            title={fixedStop ? undefined : label.desc}
          >
            {hint}
          </div>}
        </div>
        {onReset && resetTo && !modelDefault && (
          <button
            type="button"
            onClick={onReset}
            title={`重置到默认档位（${resetLabel}）`}
            aria-label={`重置到默认档位（${resetLabel}）`}
            disabled={disarmed}
            className={
              'w-6 h-6 shrink-0 rounded-md flex items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring/40 ' +
              (size === 'compact' ? 'absolute right-0 top-0 ' : 'border border-border-subtle ') +
              (disarmed
                ? 'text-disabled cursor-not-allowed'
                : 'text-dim hover:text-text-main hover:bg-surface-hover cursor-pointer')
            }
          >
            <RotateCcw className={size === 'compact' ? 'w-4 h-4' : 'w-3 h-3'} />
          </button>
        )}
      </div>

      {afterHeader}

      <div
        ref={railRef}
        className="misaka-thinking-rail rounded-full focus-visible:ring-2 focus-visible:ring-focus-ring/40"
        role="slider"
        tabIndex={modelDefault ? -1 : size === 'compact' || !fixedStop ? 0 : -1}
        aria-label="思考深度"
        aria-readonly={readOnly || modelDefault || fixedStop || undefined}
        aria-busy={busy || undefined}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={modelDefault ? 0 : shown}
        aria-valuetext={modelDefault ? '模型默认策略' : empty ? '没有可选深度' : offOnly ? '不支持思考深度' : `${label.zh} (${activeLevels[shown]})`}
        aria-disabled={disarmed || undefined}
        style={
          {
            '--thumb-x': `${thumbX}px`,
            '--fill-p': `${fillP}`,
            '--fill-x': `${fillX}px`,
            '--thumb-box': `${THUMB_BOX[size]}px`,
          } as React.CSSProperties
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={cancelDrag}
        onKeyDown={handleKeyDown}
      >
        <div className="misaka-thinking-track" />
        <div className="misaka-thinking-fill">
          <span className="misaka-thinking-band misaka-thinking-band--1" aria-hidden="true" />
          <span className="misaka-thinking-band misaka-thinking-band--2" aria-hidden="true" />
          <span className="misaka-thinking-band misaka-thinking-band--3" aria-hidden="true" />
          <span className="misaka-thinking-streak misaka-thinking-streak--a" aria-hidden="true" />
          <span className="misaka-thinking-streak misaka-thinking-streak--b" aria-hidden="true" />
        </div>
        {!fixedStop &&
          activeLevels.map((lvl, i) => (
            <span
              key={lvl}
              aria-hidden="true"
              className={
                'misaka-thinking-dot' +
                (modelDefault ? '' : (i === shown ? ' is-current' : i < shown ? ' is-passed' : ''))
              }
              style={{ left: `calc(${thumb / 2}px + (100% - ${thumb}px) * ${i / (count - 1)})` }}
            />
          ))}
        {!fixedStop && <div className="misaka-thinking-thumb" aria-hidden="true" />}
        <div className="misaka-thinking-hit" />
      </div>

      {size !== 'compact' && count > 2 && (
        <div className="flex items-center justify-between text-[10px] text-dim">
          <span>{labelFor(levels[0]).short}</span>
          <span>{labelFor(levels[count - 1]).short}</span>
        </div>
      )}
    </div>
  )
}

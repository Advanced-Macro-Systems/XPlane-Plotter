// A tiny trend line of a whole channel, drawn on a <canvas> with the 2D context — not ECharts: the Channels table has
// one per channel (200+). It draws lazily, the first time it scrolls into view, from a min/max-decimated copy of the
// series (cached per channel), in the colour of a CSS token, and redraws when the theme changes.

import { useEffect, useRef } from 'react'
import { useShownTheme } from '../lib/theme'
import { sparkGeometry, sparkSeries } from '../views/channels/sparkline'
import './sparkline.css'

export interface SparklineProps {
  /** Horizontal values, e.g. Dataset.elapsed */
  x: ArrayLike<number>
  /** The channel's values (NaN = missing: the line breaks) */
  y: ArrayLike<number>
  /** CSS pixels */
  width?: number
  height?: number
  /** Min/max buckets (each keeps up to two samples) */
  buckets?: number
  /** Custom property holding the line colour */
  colorVar?: string
  /** Describes the trend for screen readers; without it the sparkline is decorative */
  ariaLabel?: string
  className?: string
}

export function Sparkline({
  x,
  y,
  width = 120,
  height = 28,
  buckets = 120,
  colorVar = '--series-1',
  ariaLabel,
  className,
}: SparklineProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Only a trigger: the colours are read from the tokens the new theme puts on the page.
  const theme = useShownTheme()

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => paint(canvas, x, y, width, height, buckets, colorVar)
    if (typeof IntersectionObserver === 'undefined') {
      draw()
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        draw()
      },
      { rootMargin: '200px 0px' },
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [x, y, width, height, buckets, colorVar, theme])

  return (
    <canvas
      ref={ref}
      className={className ? `sparkline ${className}` : 'sparkline'}
      style={{ width, height }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    />
  )
}

function paint(
  canvas: HTMLCanvasElement,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  width: number,
  height: number,
  buckets: number,
  colorVar: string,
): void {
  const dpr = window.devicePixelRatio || 1
  // Resizing the backing store also clears it.
  canvas.width = Math.max(1, Math.round(width * dpr))
  canvas.height = Math.max(1, Math.round(height * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const series = sparkSeries(x, y, buckets)
  const geometry = sparkGeometry(series.x, series.y, width, height)
  if (geometry.empty) return
  const style = window.getComputedStyle(canvas)
  // The token's value in the theme showing now; without it, the text colour (never a fixed hex that ignores the theme).
  const color = style.getPropertyValue(geometry.flat ? '--text-subtle' : colorVar).trim() || style.color
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = geometry.flat ? 1 : 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (geometry.flat) ctx.setLineDash([2, 3])
  for (const path of geometry.paths) {
    if (path.length === 1) {
      ctx.fillRect(path[0][0] - 0.75, path[0][1] - 0.75, 1.5, 1.5)
      continue
    }
    ctx.beginPath()
    ctx.moveTo(path[0][0], path[0][1])
    for (let i = 1; i < path.length; i += 1) ctx.lineTo(path[i][0], path[i][1])
    ctx.stroke()
  }
}

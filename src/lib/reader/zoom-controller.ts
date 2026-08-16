/**
 * Targeted zoom for the continuous scroll readers (issue #195).
 *
 * Owns the zoom state machine shared by both readers: discrete level zoom for
 * wheel/double-tap (animated), continuous zoom for pinch (1:1 via snapTo),
 * and the per-frame measurement-based scroll correction that keeps an anchor
 * point pinned while the wrapper's transform scale changes.
 *
 * The correction never predicts absolute scroll positions. Each frame it
 * applies the new zoom layout, forces layout, measures where the anchored
 * page element actually is, and applies the difference to the desired anchor
 * position as a *relative* scroll delta — which is exact under any wrapper
 * offset, alignment, centering, or RTL scroll-coordinate scheme.
 *
 * See docs/superpowers/specs/2026-06-09-continuous-targeted-zoom-design.md.
 */

import { Animator } from './animator';
import {
  anchorFraction,
  anchorScreenPosition,
  lerp2,
  nearestZoomLevel,
  nextZoomLevel,
  normalizeWheelDelta,
  pinchDistance,
  pinchMidpoint,
  WheelAccumulator,
  zoomProgress,
  type Point,
  type RectLike
} from './zoom-math';

/** Numeric tolerance for "is zoomed" / "is at this level" comparisons. */
const ZOOM_EPS = 0.001;
/** Pinches released below this zoom animate back to exactly 1×. */
const SNAP_TO_ONE_BELOW = 1.05;
/** Double-tap zoom-in target level. */
const DOUBLE_TAP_ZOOM = 2;
/** Chromium trackpad pinch sensitivity for its synthetic Ctrl+wheel deltas. */
const WHEEL_PINCH_SENSITIVITY = 0.01;
/** A synthetic pinch is complete after Chromium stops delivering wheel events. */
const WHEEL_PINCH_IDLE_MS = 140;

const CONTINUOUS_ZOOM_LEVELS: readonly number[] = [1, 1.5, 2, 3];

/** Structural subset of HTMLElement the controller scrolls. */
export interface ZoomContainer {
  scrollLeft: number;
  scrollTop: number;
  readonly scrollWidth: number;
}

/** Structural subset of HTMLElement the controller anchors to. */
export interface ZoomAnchorTarget {
  getBoundingClientRect(): RectLike;
}

/**
 * Why a settle happened. Components decide per reason whether to re-detect
 * pages and report progress — replacing the suppressSettleReport boolean
 * that callers had to toggle around synchronous calls (and which silently
 * depended on Animator.snapTo firing onSettle synchronously).
 *
 * - 'gesture'   — a zoom gesture finished naturally (animation settled,
 *                 pinch released). Geometry is final: report progress.
 * - 'interrupt' — a competing input finished the zoom early (wheel scroll,
 *                 new drag). Geometry is final: report progress.
 * - 'nav'       — finished because a navigation is about to move the view.
 *                 Do NOT report: the nav supersedes it.
 * - 'reset'     — instant reset/snap with no anchor correction; the scroll
 *                 offset is stale against the new layout. Do NOT report or
 *                 detect: the caller re-anchors next.
 */
export type SettleReason = 'gesture' | 'interrupt' | 'nav' | 'reset';

export interface ZoomWheelEventLike {
  deltaY: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  timeStamp: number;
}

/**
 * What the controller drives each animation frame. The continuous readers'
 * surface wraps a native scroll container; paged mode's wraps a transform
 * camera. The controller itself is gesture logic only.
 */
export interface ZoomSurface {
  /** False while the surface's elements aren't mounted — the frame step skips. */
  isReady(): boolean;
  /**
   * Apply the zoomed layout for this frame (transform/spacers/alignment).
   * Called BEFORE measurement, so it must be fully synchronous/imperative.
   */
  applyZoomLayout(zoom: number): void;
  /** Force layout so measurements see this frame's writes (no-op for transform surfaces). */
  syncLayout(): void;
  /** Relative view correction in screen space: move content left/up by (dx, dy). */
  correctView(dx: number, dy: number): void;
}

export interface ZoomControllerConfig {
  /** Discrete levels for wheel/double-tap stepping. First entry is min zoom, last is max. */
  levels?: readonly number[];
  /**
   * Dynamic level list (paged mode: depends on the current page's base
   * scale). Takes precedence over `levels` on every read.
   */
  getLevels?(): readonly number[];
  /**
   * The surface the frame step drives. When omitted, a scroll surface is
   * built from `getScrollContainer` + `applyZoomLayout` (the continuous
   * readers' original config shape, kept working as-is).
   */
  surface?: ZoomSurface;
  getScrollContainer?(): ZoomContainer | null | undefined;
  getPageElements(): readonly (ZoomAnchorTarget | undefined)[];
  getViewport(): { width: number; height: number };
  /** Legacy scroll-surface layout hook — see `surface`. */
  applyZoomLayout?(zoom: number): void;
  /** Gate for cross-axis drag panning and similar component state. */
  onZoomedChange?(zoomed: boolean): void;
  /**
   * A gesture finished (animation settled, pinch released, finishNow, reset).
   * Components re-run page detection and report progress here, gated by the
   * reason — see SettleReason.
   */
  onSettled?(zoom: number, reason: SettleReason): void;
}

/** The continuous readers' surface: native scroll container + layout hook. */
function scrollSurface(config: ZoomControllerConfig): ZoomSurface {
  return {
    isReady: () => !!config.getScrollContainer?.(),
    applyZoomLayout: (zoom) => config.applyZoomLayout?.(zoom),
    syncLayout: () => {
      const container = config.getScrollContainer?.();
      if (container) void container.scrollWidth;
    },
    correctView: (dx, dy) => {
      const container = config.getScrollContainer?.();
      if (!container) return;
      container.scrollLeft += dx;
      container.scrollTop += dy;
    }
  };
}

export class ContinuousZoomController {
  private config: ZoomControllerConfig;
  private staticLevels: readonly number[];
  private surface: ZoomSurface;
  private animator: Animator;
  private wheelAcc = new WheelAccumulator();

  private target = 1;
  private startZoom = 1;
  private fromScreen: Point = { x: 0, y: 0 };
  private toScreen: Point = { x: 0, y: 0 };

  private anchorEl: ZoomAnchorTarget | null = null;
  private anchorFx = 0;
  private anchorFy = 0;

  private pinching = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private gestureBaseZoom = 1;
  // Safari can emit several trackpad gesturechange events between display
  // frames. Applying each one synchronously forces repeated layout across the
  // entire continuous reader. Keep only the newest sample and render it once
  // per animation frame. Pointer/touch pinches deliberately retain their
  // existing direct path.
  private gestureFrame: number | null = null;
  private gestureFrameGeneration = 0;
  private pendingGesture: { scale: number; point: Point } | null = null;
  private wheelPinchActive = false;
  private wheelPinchTarget = 1;
  private wheelPinchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ZoomControllerConfig) {
    this.config = config;
    this.staticLevels = config.levels ?? CONTINUOUS_ZOOM_LEVELS;
    this.surface = config.surface ?? scrollSurface(config);
    this.animator = new Animator(1, (zoom) => this.frameStep(zoom), {
      factor: 0.25,
      epsilon: 0.005,
      onSettle: () => this.settle('gesture')
    });
  }

  private get levels(): readonly number[] {
    return this.config.getLevels?.() ?? this.staticLevels;
  }

  get currentZoom(): number {
    return this.animator.current;
  }

  get zoomTarget(): number {
    return this.target;
  }

  get isActive(): boolean {
    return this.pinching || this.animator.isAnimating;
  }

  /** True when the view is visibly zoomed in. */
  get isZoomed(): boolean {
    return this.animator.current > 1 + ZOOM_EPS;
  }

  // ============================================================
  // Gestures
  // ============================================================

  /** Wheel event already classified as zoom intent by the caller. */
  wheelZoom(e: ZoomWheelEventLike): void {
    const steps = this.wheelAcc.add(normalizeWheelDelta(e.deltaY, e.deltaMode), e.timeStamp);
    if (steps === 0) return;
    const direction = steps > 0 ? 1 : -1;
    let next = this.target;
    for (let i = 0; i < Math.abs(steps); i++) {
      next = nextZoomLevel(this.levels, next, direction);
    }
    this.stepTo(next, { x: e.clientX, y: e.clientY });
  }

  /**
   * Chromium precision-trackpad pinch, represented by Ctrl+pixel-wheel.
   * Unlike wheelZoom this keeps every fractional delta, uses the same anchor
   * geometry as touch/Safari pinch, and coalesces rendering to one update per
   * display frame through gestureChange.
   */
  wheelPinch(e: ZoomWheelEventLike): void {
    if (!this.wheelPinchActive) {
      this.gestureStart(e.clientX, e.clientY);
      if (!this.pinching) return;
      this.wheelPinchActive = true;
      this.wheelPinchTarget = this.animator.current;
    }

    const min = this.levels[0];
    const max = this.levels[this.levels.length - 1];
    this.wheelPinchTarget = Math.max(
      min,
      Math.min(max, this.wheelPinchTarget * Math.exp(-e.deltaY * WHEEL_PINCH_SENSITIVITY))
    );
    this.gestureChange(this.wheelPinchTarget / this.gestureBaseZoom, e.clientX, e.clientY);

    if (this.wheelPinchTimer !== null) clearTimeout(this.wheelPinchTimer);
    this.wheelPinchTimer = setTimeout(() => this.endWheelPinch(), WHEEL_PINCH_IDLE_MS);
  }

  /** Public test/interruption seam; normal gestures end via the idle timer. */
  endWheelPinch(): void {
    if (this.wheelPinchTimer !== null) clearTimeout(this.wheelPinchTimer);
    this.wheelPinchTimer = null;
    if (!this.wheelPinchActive) return;
    this.wheelPinchActive = false;
    this.gestureEnd();
  }

  /**
   * Step one level in `direction`, anchored at (x, y) or the viewport
   * center. No production caller — this is the test seam (unit + e2e
   * geometry suites) for stepping levels without the wheel accumulator.
   */
  cycleZoom(direction: 1 | -1, anchorX?: number, anchorY?: number): void {
    const viewport = this.config.getViewport();
    const anchor = {
      x: anchorX ?? viewport.width / 2,
      y: anchorY ?? viewport.height / 2
    };
    this.stepTo(nextZoomLevel(this.levels, this.target, direction), anchor);
  }

  private stepTo(next: number, anchor: Point): void {
    // No-op only when we're already settled on that level — after an
    // off-level pinch (e.g. 2.6 with target 3) a step must still animate.
    if (next === this.target && Math.abs(this.animator.current - next) < ZOOM_EPS) return;
    this.beginAnimatedGesture(next, anchor, anchor);
  }

  /** Double-tap: zoom in toward the viewport center, or reset when zoomed. */
  toggleZoom(x: number, y: number): void {
    if (this.isZoomed) {
      this.beginAnimatedGesture(1, { x, y }, { x, y });
    } else {
      const viewport = this.config.getViewport();
      this.beginAnimatedGesture(
        DOUBLE_TAP_ZOOM,
        { x, y },
        { x: viewport.width / 2, y: viewport.height / 2 }
      );
    }
  }

  /**
   * Animate to an explicit level, sampling content at `from` and landing it
   * at `to` (both default to the gesture point semantics of toggleZoom).
   * Paged mode's contextual double-tap (1 ↔ fit ↔ 2×) computes its own
   * target and drives this directly.
   */
  animateToLevel(level: number, from: Point, to: Point = from): void {
    if (level === this.target && Math.abs(this.animator.current - level) < ZOOM_EPS) return;
    this.beginAnimatedGesture(level, from, to);
  }

  /**
   * Begin (or re-baseline) a pinch. Callers invoke this whenever the active
   * pointer pair changes — a third finger landing or one of three lifting
   * re-baselines distance/zoom/anchor so the gesture stays continuous.
   */
  pinchStart(points: readonly Point[]): void {
    if (!this.pinching && this.animator.isAnimating) this.finishNow();
    const mid = pinchMidpoint(points);
    if (!this.captureAnchor(mid.x, mid.y)) return;
    this.pinching = true;
    this.pinchStartDist = pinchDistance(points);
    this.pinchStartZoom = this.animator.current;
    this.fromScreen = mid;
    this.toScreen = mid;
    this.startZoom = this.animator.current;
    this.target = this.animator.current;
  }

  pinchMove(points: readonly Point[]): void {
    if (!this.pinching || this.pinchStartDist <= 0) return;
    const ratio = pinchDistance(points) / this.pinchStartDist;
    this.applyPinchZoom(this.pinchStartZoom * ratio, pinchMidpoint(points));
  }

  /** Pinch released (fewer than two pointers remain). */
  pinchEnd(): void {
    if (!this.pinching) return;
    this.pinching = false;
    const zoom = this.animator.current;
    if (zoom < SNAP_TO_ONE_BELOW && zoom > 1) {
      // Nearly unzoomed — animate the residue away; settle runs cleanup.
      this.target = 1;
      this.animator.setTarget(1);
      return;
    }
    this.target = nearestZoomLevel(this.levels, zoom);
    this.settle('gesture');
  }

  // Safari desktop trackpad pinch (proprietary gesture events).
  gestureStart(x: number, y: number): void {
    this.cancelGestureFrame();
    if (!this.pinching && this.animator.isAnimating) this.finishNow();
    if (!this.captureAnchor(x, y)) return;
    this.pinching = true;
    this.pinchStartDist = 0; // pointer-pair distance unused for gesture events
    this.gestureBaseZoom = this.animator.current;
    this.pinchStartZoom = this.animator.current;
    this.fromScreen = { x, y };
    this.toScreen = { x, y };
    this.startZoom = this.animator.current;
    this.target = this.animator.current;
  }

  gestureChange(scale: number, x: number, y: number): void {
    if (!this.pinching) return;
    this.pendingGesture = { scale, point: { x, y } };
    if (this.gestureFrame !== null) return;

    const generation = this.gestureFrameGeneration;
    this.gestureFrame = requestAnimationFrame(() => {
      if (generation !== this.gestureFrameGeneration) return;
      this.gestureFrame = null;
      this.flushGestureFrame();
    });
  }

  gestureEnd(): void {
    // gestureend can arrive before the scheduled display frame. Commit the
    // latest scale synchronously so the user's final movement is never lost.
    this.cancelGestureFrame(false);
    this.flushGestureFrame();
    this.pinchEnd();
  }

  private flushGestureFrame(): void {
    const pending = this.pendingGesture;
    this.pendingGesture = null;
    if (!pending || !this.pinching) return;
    this.applyPinchZoom(this.gestureBaseZoom * pending.scale, pending.point);
  }

  private cancelGestureFrame(clearPending = true): void {
    this.gestureFrameGeneration += 1;
    if (this.gestureFrame !== null) cancelAnimationFrame(this.gestureFrame);
    this.gestureFrame = null;
    if (clearPending) this.pendingGesture = null;
  }

  private cancelWheelPinch(): void {
    if (this.wheelPinchTimer !== null) clearTimeout(this.wheelPinchTimer);
    this.wheelPinchTimer = null;
    this.wheelPinchActive = false;
  }

  private applyPinchZoom(rawZoom: number, mid: Point): void {
    const min = this.levels[0];
    const max = this.levels[this.levels.length - 1];
    const zoom = Math.max(min, Math.min(max, rawZoom));
    this.fromScreen = mid;
    this.toScreen = mid;
    this.target = zoom;
    this.config.onZoomedChange?.(zoom > 1 + ZOOM_EPS);
    this.animator.snapTo(zoom);
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Finish any in-flight gesture instantly against its target and settle.
   * Call before competing scroll intents (keyboard nav, manual page change,
   * scroll-intent wheel, new drag) so they act on settled geometry.
   */
  finishNow(reason: 'interrupt' | 'nav' = 'interrupt'): void {
    this.cancelWheelPinch();
    this.cancelGestureFrame();
    if (this.pinching) {
      this.pinching = false;
      this.target = nearestZoomLevel(this.levels, this.animator.current);
      this.settle(reason);
      return;
    }
    if (this.animator.isAnimating) {
      this.animator.snapTo(this.target);
      this.settle(reason);
    }
  }

  /** Instantly return to 1× (zoom-mode change, viewport resize). */
  reset(): void {
    if (this.animator.current === 1 && !this.animator.isAnimating && !this.pinching) {
      this.target = 1;
      return;
    }
    this.snapToLevel(1);
  }

  /**
   * Apply a level instantly with no anchor correction (layout only) and
   * settle. Paged mode re-applies a preserved keepZoom level this way on
   * page turns — animating 1×→3× on every flip would be a constant
   * annoyance.
   */
  snapToLevel(level: number): void {
    this.cancelWheelPinch();
    this.cancelGestureFrame();
    this.pinching = false;
    this.target = level;
    this.anchorEl = null; // skip anchor correction; layout placement only
    this.animator.snapTo(level);
    this.settle('reset');
  }

  destroy(): void {
    this.cancelWheelPinch();
    this.cancelGestureFrame();
    this.animator.destroy();
  }

  // ============================================================
  // Core frame step
  // ============================================================

  private frameStep(zoom: number): void {
    if (!this.surface.isReady()) return;

    this.surface.applyZoomLayout(zoom);
    this.surface.syncLayout(); // measurements must see this frame's writes

    if (!this.anchorEl) return;
    const rect = this.anchorEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // A detached element measures as an all-zero rect — which is finite,
      // so without this guard it would pass the checks below and apply a
      // garbage correction. Drop the anchor for the rest of the gesture.
      this.anchorEl = null;
      return;
    }
    const actual = anchorScreenPosition(rect, this.anchorFx, this.anchorFy);
    const desired = lerp2(
      this.fromScreen,
      this.toScreen,
      zoomProgress(zoom, this.startZoom, this.target)
    );
    const dx = actual.x - desired.x;
    const dy = actual.y - desired.y;
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      this.surface.correctView(dx, dy);
    }
  }

  private beginAnimatedGesture(target: number, from: Point, to: Point): void {
    if (!this.captureAnchor(from.x, from.y)) return;
    this.startZoom = this.animator.current;
    this.fromScreen = from;
    this.toScreen = to;
    this.target = target;
    this.config.onZoomedChange?.(Math.max(target, this.animator.current) > 1 + ZOOM_EPS);
    this.animator.setTarget(target);
  }

  /**
   * Anchor to the page element under (x, y), or the nearest one by center
   * distance — fractions extrapolate linearly, so a near-miss anchor (gap,
   * divider, centering spacer) still pins correctly.
   */
  private captureAnchor(x: number, y: number): boolean {
    const pages = this.config.getPageElements();
    let best: ZoomAnchorTarget | null = null;
    let bestRect: RectLike | null = null;
    let bestDist = Infinity;
    for (const el of pages) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
        bestRect = rect;
      }
    }
    if (!best || !bestRect) return false;
    const { fx, fy } = anchorFraction(bestRect, x, y);
    this.anchorEl = best;
    this.anchorFx = fx;
    this.anchorFy = fy;
    return true;
  }

  /** Shared settle: bookkeeping + component hooks. Runs exactly once per gesture. */
  private settle(reason: SettleReason): void {
    const zoom = this.animator.current;
    this.config.onZoomedChange?.(zoom > 1 + ZOOM_EPS);
    this.config.onSettled?.(zoom, reason);
  }
}

/**
 * Preferred name going forward — the controller is surface-agnostic and
 * drives paged mode too. The original export name remains for existing
 * callers.
 */

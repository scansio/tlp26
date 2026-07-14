'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TOUR_KEY = 'tour_v1';
const PAD = 8;
const TOOLTIP_W = 296;
const TOOLTIP_H_EST = 178;

interface TourStep {
  target: string;
  title: string;
  description: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: TourStep[] = [
  {
    target: '[data-tour="sidebar-brand"]',
    title: 'Trading Hub',
    description:
      'Navigate the platform from this sidebar. It collapses to icons when you need more screen space.',
    side: 'right',
  },
  {
    target: '[data-tour="nav-signals"]',
    title: 'AI Trade Signals',
    description:
      'The AI agent monitors markets 24/7 and generates trade signals here. Each signal includes entry, stop-loss, and take-profit levels.',
    side: 'right',
  },
  {
    target: '[data-tour="nav-chat"]',
    title: 'AI Chat',
    description:
      'Talk directly to the trading AI. Ask about market conditions, request analysis, or get explanations for any signal.',
    side: 'right',
  },
  {
    target: '[data-tour="stat-cards"]',
    title: 'Portfolio Overview',
    description:
      'Live portfolio stats — equity, realized P&L, unrealized P&L, and your daily trade count vs limit. Refreshes every 30 seconds.',
    side: 'bottom',
  },
  {
    target: '[data-tour="circuit-breaker"]',
    title: 'Circuit Breaker',
    description:
      'Your risk guard. Automatically halts trading when daily loss limits are hit, and lets you manually engage the kill switch at any time.',
    side: 'top',
  },
  {
    target: '[data-tour="signal-queue"]',
    title: 'Signal Approval Queue',
    description:
      'In manual mode, AI signals wait here for your review. Approve to execute or reject to skip. Switch to auto mode for hands-free trading.',
    side: 'top',
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top - PAD,
    left: r.left - PAD,
    width: r.width + PAD * 2,
    height: r.height + PAD * 2,
  };
}

function computeTooltipPos(
  rect: Rect,
  side: TourStep['side'],
): { top: number; left: number } {
  const GAP = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top: number, left: number;

  switch (side) {
    case 'right':
      top = rect.top + rect.height / 2 - TOOLTIP_H_EST / 2;
      left = rect.left + rect.width + GAP;
      break;
    case 'left':
      top = rect.top + rect.height / 2 - TOOLTIP_H_EST / 2;
      left = rect.left - TOOLTIP_W - GAP;
      break;
    case 'top':
      top = rect.top - TOOLTIP_H_EST - GAP;
      left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
      break;
    default:
      top = rect.top + rect.height + GAP;
      left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
      break;
  }

  return {
    top: Math.max(8, Math.min(top, vh - TOOLTIP_H_EST - 8)),
    left: Math.max(8, Math.min(left, vw - TOOLTIP_W - 8)),
  };
}

export function SpotlightTour() {
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    setMounted(true);
    if (!localStorage.getItem(TOUR_KEY)) {
      const id = setTimeout(() => setActive(true), 700);
      return () => clearTimeout(id);
    }
  }, []);

  const remeasure = useCallback((idx: number) => {
    const r = getRect(STEPS[idx].target);
    if (r) setRect(r);
  }, []);

  useEffect(() => {
    if (!active) return;
    remeasure(step);
  }, [active, step, remeasure]);

  useEffect(() => {
    if (!active) return;
    const handler = () => remeasure(step);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, [active, step, remeasure]);

  const dismiss = useCallback(() => {
    localStorage.setItem(TOUR_KEY, '1');
    setActive(false);
  }, []);

  const next = useCallback(() => {
    if (step === STEPS.length - 1) {
      dismiss();
      return;
    }
    setStep((s) => s + 1);
  }, [step, dismiss]);

  const prev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  if (!mounted || !active || !rect) return null;

  const currentStep = STEPS[step];
  const tip = computeTooltipPos(rect, currentStep.side);

  return createPortal(
    <>
      {/* Spotlight overlay via box-shadow */}
      <motion.div
        animate={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, opacity: 1 }}
        initial={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        style={{
          position: 'fixed',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)',
          borderRadius: 8,
          zIndex: 9990,
          pointerEvents: 'none',
        }}
      />

      {/* Tooltip card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          style={{ position: 'fixed', top: tip.top, left: tip.left, width: TOOLTIP_W, zIndex: 9995 }}
          className="rounded-xl border border-border bg-background p-4 shadow-2xl"
        >
          {/* Progress + close */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300',
                    i === step
                      ? 'w-5 bg-primary'
                      : 'w-1.5 bg-muted-foreground/25',
                  )}
                />
              ))}
            </div>
            <button
              onClick={dismiss}
              aria-label="Close tour"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* Content */}
          <div className="mb-4 space-y-1">
            <p className="text-sm font-semibold leading-snug">{currentStep.title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {currentStep.description}
            </p>
          </div>

          {/* Nav */}
          <div className="flex items-center justify-between">
            <button
              onClick={dismiss}
              className="text-xs text-muted-foreground underline-offset-3 transition-colors hover:text-foreground hover:underline"
            >
              Skip tour
            </button>
            <div className="flex items-center gap-1.5">
              {step > 0 && (
                <Button variant="outline" size="icon-sm" onClick={prev} aria-label="Previous">
                  <ChevronLeft className="size-3.5" />
                </Button>
              )}
              <Button size="sm" onClick={next} className="gap-1">
                {step === STEPS.length - 1 ? (
                  'Done'
                ) : (
                  <>
                    <span>Next</span>
                    <ChevronRight className="size-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </>,
    document.body,
  );
}

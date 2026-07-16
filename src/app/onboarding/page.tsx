"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DefaultChatTransport, type ToolUIPart } from "ai";
import { useChat } from "@ai-sdk/react";
import {
  ArrowLeft,
  Coins,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { skipOnboarding } from "./actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";

const OPTIONS = {
  strategy: ["SMC", "Technical Indicators", "SMC + Technicals", "Price Action"],
  riskPerTrade: [
    "0.5% – Conservative",
    "1% – Moderate",
    "2% – Balanced",
    "3%+ – Aggressive",
  ],
  maxDailyLoss: ["1%", "3%", "5%", "10%"],
  tradesPerDay: ["1–3 / day", "4–6 / day", "7–10 / day", "Unlimited"],
  execution: ["Manual approval", "Auto-execute"],
  assets: ["BTC & ETH only", "Top 10 coins", "All majors", "Any altcoin"],
  timeframes: [
    "Scalp (1m–15m)",
    "Intraday (1h–4h)",
    "Swing (4h–1d)",
    "Multi-timeframe",
  ],
} as const;

type SelectionKey = keyof typeof OPTIONS;

type Selections = {
  strategy: string[];
  riskPerTrade: string;
  maxDailyLoss: string;
  tradesPerDay: string;
  execution: string;
  assets: string[];
  timeframes: string[];
};

const MULTI_SELECT: SelectionKey[] = ["strategy", "assets", "timeframes"];

const LABELS: Record<SelectionKey, string> = {
  strategy: "Strategy",
  riskPerTrade: "Risk per trade",
  maxDailyLoss: "Max daily loss",
  tradesPerDay: "Trades per day",
  execution: "Execution mode",
  assets: "Assets",
  timeframes: "Timeframes",
};

const SELECTION_STEPS = [
  {
    title: "What's your trading strategy?",
    subtitle: "Pick everything that fits your approach",
    fields: ["strategy"] as SelectionKey[],
    icon: TrendingUp,
    gradient: "from-blue-500 to-violet-600",
    glow: "shadow-blue-500/30",
    bg: "from-blue-500/8 via-transparent to-violet-500/5",
    noteLabel: "strategy",
  },
  {
    title: "How much risk can you take?",
    subtitle: "These limits protect your capital on every trade",
    fields: ["riskPerTrade", "maxDailyLoss"] as SelectionKey[],
    icon: ShieldCheck,
    gradient: "from-emerald-500 to-teal-600",
    glow: "shadow-emerald-500/30",
    bg: "from-emerald-500/8 via-transparent to-teal-500/5",
    noteLabel: "risk management",
  },
  {
    title: "How do you want to trade?",
    subtitle: "Define your frequency and execution style",
    fields: ["tradesPerDay", "execution"] as SelectionKey[],
    icon: Zap,
    gradient: "from-orange-500 to-amber-500",
    glow: "shadow-orange-500/30",
    bg: "from-orange-500/8 via-transparent to-amber-500/5",
    noteLabel: "trading style",
  },
  {
    title: "What will you trade?",
    subtitle: "Choose your preferred assets and timeframes",
    fields: ["assets", "timeframes"] as SelectionKey[],
    icon: Coins,
    gradient: "from-pink-500 to-rose-600",
    glow: "shadow-pink-500/30",
    bg: "from-pink-500/8 via-transparent to-rose-500/5",
    noteLabel: "assets and timeframes",
  },
];

const FINAL_STEP = {
  title: "Anything else on your mind?",
  subtitle: "Optional — add any extra preferences the AI should know.",
  gradient: "from-indigo-500 to-cyan-500",
  glow: "shadow-indigo-500/30",
  bg: "from-indigo-500/8 via-transparent to-cyan-500/5",
};

const TOTAL_STEPS = SELECTION_STEPS.length + 1;

const slideVariants = {
  enter: (dir: number) => ({ x: dir * 48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -48, opacity: 0 }),
};

export default function OnboardingPage() {
  const router = useRouter();
  const [chatInput, setChatInput] = useState("");
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [customNote, setCustomNote] = useState("");
  const [stepNotes, setStepNotes] = useState<Record<number, string>>({});
  const [showStepNote, setShowStepNote] = useState<Record<number, boolean>>({});
  const [selections, setSelections] = useState<Selections>({
    strategy: [],
    riskPerTrade: "",
    maxDailyLoss: "",
    tradesPerDay: "",
    execution: "",
    assets: [],
    timeframes: [],
  });

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/setup" }),
  });

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setMessages(data))
      .catch(() => {});
  }, [setMessages]);

  const checkProfile = useCallback(async () => {
    const res = await fetch("/api/risk-profile");
    if (res.ok) setDone(true);
  }, []);

  useEffect(() => {
    void checkProfile();
  }, [checkProfile]);

  useEffect(() => {
    if (status === "ready" && messages.length > 0) void checkProfile();
  }, [status, messages.length, checkProfile]);

  useEffect(() => {
    if (done) router.push("/dashboard");
  }, [done, router]);

  const goNext = () => {
    setDir(1);
    setStep((s) => s + 1);
  };
  const goBack = () => {
    setDir(-1);
    setStep((s) => s - 1);
  };

  const toggle = (key: SelectionKey, value: string) => {
    setSelections((prev) => {
      if (MULTI_SELECT.includes(key)) {
        const arr = prev[key] as string[];
        return {
          ...prev,
          [key]: arr.includes(value)
            ? arr.filter((v) => v !== value)
            : [...arr, value],
        };
      }
      return { ...prev, [key]: prev[key] === value ? "" : value };
    });
  };

  const isSelected = (key: SelectionKey, value: string) => {
    const v = selections[key];
    return Array.isArray(v) ? v.includes(value) : v === value;
  };

  const isFinalStep = step === SELECTION_STEPS.length;
  const currentStep = !isFinalStep ? SELECTION_STEPS[step] : FINAL_STEP;

  const canProceed =
    isFinalStep ||
    SELECTION_STEPS[step].fields.every((key) => {
      const v = selections[key];
      return Array.isArray(v) ? v.length > 0 : !!v;
    });

  const buildPrompt = () => {
    const blocks: string[] = [];

    const s0 = [
      selections.strategy.length &&
        `Strategy: ${selections.strategy.join(" + ")}`,
      stepNotes[0]?.trim(),
    ]
      .filter(Boolean)
      .join(". ");
    if (s0) blocks.push(s0);

    const s1 = [
      selections.riskPerTrade && `Risk per trade: ${selections.riskPerTrade}`,
      selections.maxDailyLoss && `Max daily loss: ${selections.maxDailyLoss}`,
      stepNotes[1]?.trim(),
    ]
      .filter(Boolean)
      .join(". ");
    if (s1) blocks.push(s1);

    const s2 = [
      selections.tradesPerDay && `Trades per day: ${selections.tradesPerDay}`,
      selections.execution && `Execution mode: ${selections.execution}`,
      stepNotes[2]?.trim(),
    ]
      .filter(Boolean)
      .join(". ");
    if (s2) blocks.push(s2);

    const s3 = [
      selections.assets.length && `Assets: ${selections.assets.join(", ")}`,
      selections.timeframes.length &&
        `Timeframes: ${selections.timeframes.join(", ")}`,
      stepNotes[3]?.trim(),
    ]
      .filter(Boolean)
      .join(". ");
    if (s3) blocks.push(s3);

    if (customNote.trim()) blocks.push(customNote.trim());
    return blocks.join(". ");
  };

  const handleFinalSubmit = () => {
    const prompt = buildPrompt();
    if (!prompt.trim() || status !== "ready") return;
    sendMessage({ text: prompt });
  };

  const handleChatSubmit = () => {
    if (!chatInput.trim() || status !== "ready") return;
    sendMessage({ text: chatInput });
    setChatInput("");
  };

  const StepIcon = !isFinalStep ? SELECTION_STEPS[step].icon : Sparkles;

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden">
      {/* Animated background gradient per step */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          className={cn(
            "pointer-events-none absolute inset-0 bg-gradient-to-br",
            currentStep.bg,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
        />
      </AnimatePresence>

      {/* Glow orb behind icon position */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`orb-${step}`}
          className={cn(
            "pointer-events-none absolute left-1/2 top-[22%] h-48 w-48 -translate-x-1/2 rounded-full blur-3xl",
            `bg-gradient-to-br ${currentStep.gradient}`,
          )}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 0.15, scale: 1 }}
          exit={{ opacity: 0, scale: 0.7 }}
          transition={{ duration: 0.6 }}
        />
      </AnimatePresence>

      <div className="relative flex flex-1 flex-col overflow-hidden p-6">
        {/* Brand + skip */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <TrendingUp className="size-4" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold">Trading Hub</span>
              <span className="text-xs text-muted-foreground">
                Account setup
              </span>
            </div>
          </div>
          <form action={skipOnboarding}>
            <button
              type="submit"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Skip for now
            </button>
          </form>
        </div>

        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Progress pills */}
            <div className="mx-auto mb-8 flex w-full max-w-md items-center gap-1.5">
              {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                <motion.div
                  key={i}
                  className={cn(
                    "h-1 rounded-full",
                    i <= step
                      ? `bg-gradient-to-r ${currentStep.gradient}`
                      : "bg-muted",
                  )}
                  animate={{ flex: i === step ? 2 : 1 }}
                  transition={{ duration: 0.3 }}
                />
              ))}
            </div>

            {/* Animated step content */}
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="mx-auto flex w-full max-w-md flex-1 flex-col overflow-hidden"
              >
                {/* Hero icon */}
                <div className="mb-7 flex flex-col items-center text-center">
                  <motion.div
                    initial={{ y: -8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.08, duration: 0.3 }}
                    className="relative mb-4"
                  >
                    <div
                      className={cn(
                        "relative flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-2xl",
                        currentStep.gradient,
                        currentStep.glow,
                      )}
                    >
                      <StepIcon className="size-7" />
                    </div>
                  </motion.div>

                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Step {step + 1} of {TOTAL_STEPS}
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                    {currentStep.title}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {currentStep.subtitle}
                  </p>
                </div>

                {isFinalStep ? (
                  <div className="flex flex-1 flex-col">
                    <textarea
                      value={customNote}
                      onChange={(e) => setCustomNote(e.target.value)}
                      placeholder="e.g. only trade during London session, avoid leveraged tokens, no trades on Fridays…"
                      className="flex-1 resize-none rounded-xl border border-border bg-background/40 px-4 py-3 text-sm backdrop-blur-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      rows={6}
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="flex-1 overflow-y-auto pb-2">
                      <div className="space-y-5">
                        {SELECTION_STEPS[step].fields.map((key) => (
                          <div key={key}>
                            {SELECTION_STEPS[step].fields.length > 1 && (
                              <p className="mb-2.5 text-xs font-medium text-muted-foreground">
                                {LABELS[key]}
                                {MULTI_SELECT.includes(key) && (
                                  <span className="ml-1 opacity-60">
                                    · pick multiple
                                  </span>
                                )}
                              </p>
                            )}
                            {SELECTION_STEPS[step].fields.length === 1 &&
                              MULTI_SELECT.includes(key) && (
                                <p className="mb-2.5 text-xs text-muted-foreground opacity-60">
                                  Pick multiple
                                </p>
                              )}
                            <div className="flex flex-wrap gap-2">
                              {OPTIONS[key].map((opt) => (
                                <motion.button
                                  key={opt}
                                  type="button"
                                  onClick={() => toggle(key, opt)}
                                  whileTap={{ scale: 0.94 }}
                                  className={cn(
                                    "rounded-full border px-4 py-2 text-sm transition-colors",
                                    isSelected(key, opt)
                                      ? `border-transparent bg-gradient-to-r ${SELECTION_STEPS[step].gradient} text-white shadow-sm`
                                      : "border-border bg-background/40 text-foreground backdrop-blur-sm hover:bg-muted",
                                  )}
                                >
                                  {opt}
                                </motion.button>
                              ))}
                            </div>
                          </div>
                        ))}

                        {/* Per-step "chat about it" */}
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() =>
                              setShowStepNote((prev) => ({
                                ...prev,
                                [step]: !prev[step],
                              }))
                            }
                            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <MessageCircle className="size-3.5" />
                            {showStepNote[step]
                              ? "Hide"
                              : `Or describe your ${SELECTION_STEPS[step].noteLabel} in your own words…`}
                          </button>
                          <AnimatePresence>
                            {showStepNote[step] && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <textarea
                                  value={stepNotes[step] ?? ""}
                                  onChange={(e) =>
                                    setStepNotes((prev) => ({
                                      ...prev,
                                      [step]: e.target.value,
                                    }))
                                  }
                                  placeholder={`Tell the AI more about your ${SELECTION_STEPS[step].noteLabel}…`}
                                  className="mt-2 w-full resize-none rounded-xl border border-border bg-background/40 px-3 py-2.5 text-sm backdrop-blur-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                  rows={3}
                                  autoFocus
                                />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Navigation */}
                <div className="mt-6 flex items-center gap-3">
                  {step > 0 && (
                    <button
                      type="button"
                      onClick={goBack}
                      className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <ArrowLeft className="size-4" />
                    </button>
                  )}
                  <motion.button
                    type="button"
                    onClick={isFinalStep ? handleFinalSubmit : goNext}
                    disabled={
                      !canProceed || (isFinalStep && status !== "ready")
                    }
                    whileTap={{ scale: 0.97 }}
                    className={cn(
                      "flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-opacity disabled:opacity-40",
                      `bg-gradient-to-r ${currentStep.gradient}`,
                      currentStep.glow,
                    )}
                  >
                    {isFinalStep
                      ? status !== "ready"
                        ? "Setting up…"
                        : "Configure my profile"
                      : "Continue"}
                  </motion.button>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        ) : (
          // Chat view after setup agent responds
          <div className="flex flex-1 flex-col overflow-hidden">
            <Conversation>
              <ConversationContent>
                {messages.map((message) =>
                  message.parts?.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <Message key={`${message.id}-${i}`} from={message.role}>
                          <MessageContent>
                            <MessageResponse>{part.text}</MessageResponse>
                          </MessageContent>
                        </Message>
                      );
                    }
                    if (part.type?.startsWith("tool-")) {
                      return (
                        <Tool key={`${message.id}-${i}`}>
                          <ToolHeader
                            type={(part as ToolUIPart).type}
                            state={
                              (part as ToolUIPart).state ?? "output-available"
                            }
                            className="cursor-pointer"
                          />
                          <ToolContent>
                            <ToolInput
                              input={(part as ToolUIPart).input ?? {}}
                            />
                            <ToolOutput
                              output={(part as ToolUIPart).output}
                              errorText={(part as ToolUIPart).errorText}
                            />
                          </ToolContent>
                        </Tool>
                      );
                    }
                    return null;
                  }),
                )}
                <ConversationScrollButton />
              </ConversationContent>
            </Conversation>

            <PromptInput onSubmit={handleChatSubmit} className="mt-4">
              <PromptInputBody>
                <PromptInputTextarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Add more details or ask a question…"
                  disabled={status !== "ready" || done}
                  className="md:leading-10"
                />
              </PromptInputBody>
            </PromptInput>
          </div>
        )}
      </div>
    </div>
  );
}

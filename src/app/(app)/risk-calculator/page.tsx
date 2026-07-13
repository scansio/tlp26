"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SolveFor = "leverage" | "margin" | "loss" | "profit" | "profitLoss" | "calculateLoss";

interface Results {
  margin: number;
  leverage: number;
  expectedLossPercent: number;
  expectedProfitPercent: number;
  loss: number;
  profit: number;
}

function InputField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input
        id={id}
        type="number"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default function RiskCalculatorPage() {
  const [solveFor, setSolveFor] = useState<SolveFor>("leverage");

  const [riskCapital, setRiskCapital] = useState("");
  const [riskPercent, setRiskPercent] = useState("");
  const [slPercent, setSlPercent] = useState("");
  const [tpPercent, setTpPercent] = useState("");
  const [margin, setMargin] = useState("");
  const [leverage, setLeverage] = useState("");
  const [lossAmount, setLossAmount] = useState("");
  const [profitAmount, setProfitAmount] = useState("");

  const [results, setResults] = useState<Results | null>(null);

  useEffect(() => {
    const riskCapitalNum = parseFloat(riskCapital) || 0;
    const riskPercentNum = parseFloat(riskPercent) || 0;
    const slPercentNum = parseFloat(slPercent) || 0;
    const tpPercentNum = parseFloat(tpPercent) || 0;

    let hasRequiredFields: boolean;
    
    if (solveFor === "calculateLoss") {
      const marginNum = parseFloat(margin) || 0;
      const leverageNum = parseFloat(leverage) || 0;
      hasRequiredFields = marginNum > 0 && leverageNum > 0 && slPercentNum > 0;
    } else {
      hasRequiredFields = riskCapitalNum > 0 && riskPercentNum > 0 && slPercentNum > 0;
    }
    
    if (!hasRequiredFields) {
      setResults(null);
      return;
    }

    const riskPerTrade = riskCapitalNum * (riskPercentNum / 100);

    let calculatedMargin: number;
    let calculatedLeverage: number;
    let calculatedLoss: number;
    let calculatedProfit: number;

    switch (solveFor) {
      case "leverage": {
        const marginNum = parseFloat(margin) || 0;
        if (marginNum <= 0 || slPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedMargin = marginNum;
        calculatedLeverage = Math.floor(riskPerTrade / (marginNum * slPercentNum / 100));
        if (isNaN(calculatedLeverage) || !isFinite(calculatedLeverage) || calculatedLeverage < 0) {
          calculatedLeverage = 0;
        }
        calculatedLoss = calculatedLeverage * calculatedMargin * slPercentNum / 100;
        calculatedProfit = calculatedLeverage * calculatedMargin * tpPercentNum / 100;
        break;
      }
      case "margin": {
        const leverageNum = parseFloat(leverage) || 0;
        if (leverageNum <= 0 || slPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedLeverage = leverageNum;
        calculatedMargin = riskPerTrade / (leverageNum * slPercentNum / 100);
        if (isNaN(calculatedMargin) || !isFinite(calculatedMargin) || calculatedMargin < 0) {
          calculatedMargin = 0;
        }
        calculatedLoss = calculatedLeverage * calculatedMargin * slPercentNum / 100;
        calculatedProfit = calculatedLeverage * calculatedMargin * tpPercentNum / 100;
        break;
      }
      case "loss": {
        const lossNum = parseFloat(lossAmount) || 0;
        if (lossNum <= 0 || slPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedMargin = riskPerTrade;
        calculatedLeverage = Math.floor(lossNum / (calculatedMargin * slPercentNum / 100));
        if (isNaN(calculatedLeverage) || !isFinite(calculatedLeverage) || calculatedLeverage < 0) {
          calculatedLeverage = 0;
        }
        calculatedLoss = lossNum;
        calculatedProfit = calculatedLeverage * calculatedMargin * tpPercentNum / 100;
        break;
      }
      case "profit": {
        const profitNum = parseFloat(profitAmount) || 0;
        if (profitNum <= 0 || tpPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedMargin = riskPerTrade;
        calculatedLeverage = Math.floor(profitNum / (calculatedMargin * tpPercentNum / 100));
        if (isNaN(calculatedLeverage) || !isFinite(calculatedLeverage) || calculatedLeverage < 0) {
          calculatedLeverage = 0;
        }
        calculatedProfit = profitNum;
        calculatedLoss = calculatedLeverage * calculatedMargin * slPercentNum / 100;
        break;
      }
      case "profitLoss": {
        const lossNum = parseFloat(lossAmount) || 0;
        const profitNum = parseFloat(profitAmount) || 0;
        if (lossNum <= 0 || slPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedMargin = riskPerTrade;
        calculatedLeverage = Math.floor(lossNum / (calculatedMargin * slPercentNum / 100));
        if (isNaN(calculatedLeverage) || !isFinite(calculatedLeverage) || calculatedLeverage < 0) {
          calculatedLeverage = 0;
        }
        calculatedLoss = lossNum;
        calculatedProfit = profitNum;
        break;
      }
      case "calculateLoss": {
        const marginNum = parseFloat(margin) || 0;
        const leverageNum = parseFloat(leverage) || 0;
        if (marginNum <= 0 || leverageNum <= 0 || slPercentNum <= 0) {
          setResults(null);
          return;
        }
        calculatedMargin = marginNum;
        calculatedLeverage = leverageNum;
        calculatedLoss = calculatedLeverage * calculatedMargin * slPercentNum / 100;
        calculatedProfit = calculatedLeverage * calculatedMargin * tpPercentNum / 100;
        break;
      }
      default:
        setResults(null);
        return;
    }

    const expectedLossPercent = slPercentNum * calculatedLeverage;
    const expectedProfitPercent = tpPercentNum * calculatedLeverage;

    setResults({
      margin: Number(calculatedMargin.toFixed(4)),
      leverage: Number(calculatedLeverage.toFixed(0)),
      expectedLossPercent: Number(expectedLossPercent.toFixed(3)),
      expectedProfitPercent: Number(expectedProfitPercent.toFixed(3)),
      loss: Number(calculatedLoss.toFixed(4)),
      profit: Number(calculatedProfit.toFixed(4)),
    });
  }, [solveFor, riskCapital, riskPercent, slPercent, tpPercent, margin, leverage, lossAmount, profitAmount]);

  const reset = () => {
    setRiskCapital("");
    setRiskPercent("");
    setSlPercent("");
    setTpPercent("");
    setMargin("");
    setLeverage("");
    setLossAmount("");
    setProfitAmount("");
    setResults(null);
  };

  const renderInputs = () => {
    switch (solveFor) {
      case "leverage":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="risk-capital" label="Risk Capital ($)" placeholder="10" value={riskCapital} onChange={setRiskCapital} />
            <InputField id="risk-percent" label="Risk Per Trade (%)" placeholder="10" value={riskPercent} onChange={setRiskPercent} />
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="margin" label="Your Margin ($)" placeholder="1" value={margin} onChange={setMargin} />
          </div>
        );
      case "margin":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="risk-capital" label="Risk Capital ($)" placeholder="10" value={riskCapital} onChange={setRiskCapital} />
            <InputField id="risk-percent" label="Risk Per Trade (%)" placeholder="10" value={riskPercent} onChange={setRiskPercent} />
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="leverage" label="Your Leverage (x)" placeholder="75" value={leverage} onChange={setLeverage} />
          </div>
        );
      case "loss":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="risk-capital" label="Risk Capital ($)" placeholder="10" value={riskCapital} onChange={setRiskCapital} />
            <InputField id="risk-percent" label="Risk Per Trade (%)" placeholder="10" value={riskPercent} onChange={setRiskPercent} />
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="loss-amount" label="Your Loss Amount ($)" placeholder="1" value={lossAmount} onChange={setLossAmount} />
          </div>
        );
      case "profit":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="risk-capital" label="Risk Capital ($)" placeholder="10" value={riskCapital} onChange={setRiskCapital} />
            <InputField id="risk-percent" label="Risk Per Trade (%)" placeholder="10" value={riskPercent} onChange={setRiskPercent} />
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="profit-amount" label="Your Profit Amount ($)" placeholder="5" value={profitAmount} onChange={setProfitAmount} />
          </div>
        );
      case "profitLoss":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="risk-capital" label="Risk Capital ($)" placeholder="10" value={riskCapital} onChange={setRiskCapital} />
            <InputField id="risk-percent" label="Risk Per Trade (%)" placeholder="10" value={riskPercent} onChange={setRiskPercent} />
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="loss-amount" label="Your Loss Amount ($)" placeholder="1" value={lossAmount} onChange={setLossAmount} />
            <InputField id="profit-amount" label="Your Profit Amount ($)" placeholder="5" value={profitAmount} onChange={setProfitAmount} />
          </div>
        );
      case "calculateLoss":
        return (
          <div className="grid gap-4 md:grid-cols-2">
            <InputField id="sl-percent" label="Stop Loss (%)" placeholder="1.955" value={slPercent} onChange={setSlPercent} />
            <InputField id="tp-percent" label="Take Profit (%)" placeholder="9.501" value={tpPercent} onChange={setTpPercent} />
            <InputField id="margin" label="Your Margin ($)" placeholder="1" value={margin} onChange={setMargin} />
            <InputField id="leverage" label="Your Leverage (x)" placeholder="75" value={leverage} onChange={setLeverage} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50 mb-2">
            Trading Risk Calculator
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Calculate position size, leverage, and expected risk/reward
          </p>
        </div>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>What do you want to solve for?</CardTitle>
            <CardDescription>
              Select the value you don't know and want to calculate
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={solveFor} onValueChange={(v) => { setSolveFor(v as SolveFor); setResults(null); }}>
              <SelectTrigger className="w-full md:w-80">
                <SelectValue placeholder="Select what to solve for" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="leverage">Calculate Leverage (I know my Margin)</SelectItem>
                <SelectItem value="margin">Calculate Margin (I know my Leverage)</SelectItem>
                <SelectItem value="loss">Calculate Leverage & Margin (I know my Loss)</SelectItem>
                <SelectItem value="profit">Calculate Leverage & Margin (I know my Profit)</SelectItem>
                <SelectItem value="profitLoss">Calculate Leverage & Margin (I know my Profit & Loss)</SelectItem>
                <SelectItem value="calculateLoss">Calculate Loss (I know Margin & Leverage)</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {solveFor === "leverage" && "Calculate Leverage"}
              {solveFor === "margin" && "Calculate Margin"}
              {solveFor === "loss" && "Calculate Leverage & Margin (from Loss)"}
              {solveFor === "profit" && "Calculate Leverage & Margin (from Profit)"}
              {solveFor === "profitLoss" && "Calculate Leverage & Margin (from Profit & Loss)"}
              {solveFor === "calculateLoss" && "Calculate Loss (from Margin & Leverage)"}
            </CardTitle>
            <CardDescription>
              {solveFor === "leverage" && "Enter your margin to calculate the required leverage"}
              {solveFor === "margin" && "Enter your leverage to calculate the required margin"}
              {solveFor === "loss" && "Enter your willing loss amount to calculate leverage and margin"}
              {solveFor === "profit" && "Enter your target profit amount to calculate leverage and margin"}
              {solveFor === "profitLoss" && "Enter your profit and loss amounts to calculate leverage and margin"}
              {solveFor === "calculateLoss" && "Enter your margin and leverage to calculate your potential loss"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {renderInputs()}
            <div className="flex gap-4 mt-6">
              <Button variant="outline" onClick={reset} className="w-full">Reset</Button>
            </div>
          </CardContent>
        </Card>

        {results && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Results</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="p-4 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Margin</p>
                  <p className="text-2xl font-bold">${results.margin}</p>
                </div>
                <div className="p-4 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">Leverage</p>
                  <p className="text-2xl font-bold">{results.leverage}x</p>
                </div>
                <div className="p-4 rounded-lg bg-red-100 dark:bg-red-900/20">
                  <p className="text-sm text-red-600 dark:text-red-400">Expected Loss %</p>
                  <p className="text-2xl font-bold text-red-600 dark:text-red-400">{results.expectedLossPercent}%</p>
                </div>
                <div className="p-4 rounded-lg bg-green-100 dark:bg-green-900/20">
                  <p className="text-sm text-green-600 dark:text-green-400">Expected Profit %</p>
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">{results.expectedProfitPercent}%</p>
                </div>
                <div className="p-4 rounded-lg bg-red-100 dark:bg-red-900/20">
                  <p className="text-sm text-red-600 dark:text-red-400">Loss ($)</p>
                  <p className="text-2xl font-bold text-red-600 dark:text-red-400">${results.loss}</p>
                </div>
                <div className="p-4 rounded-lg bg-green-100 dark:bg-green-900/20">
                  <p className="text-sm text-green-600 dark:text-green-400">Profit ($)</p>
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">${results.profit}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Formulas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p><code>Loss = Leverage × Margin × SL% / 100</code></p>
            <p><code>Profit = Leverage × Margin × TP% / 100</code></p>
            <p><code>Expected Loss% = SL% × Leverage</code></p>
            <p><code>Expected Profit% = TP% × Leverage</code></p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

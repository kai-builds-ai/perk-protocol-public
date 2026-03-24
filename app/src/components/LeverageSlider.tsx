"use client";

import React, { useCallback, memo } from "react";
import { LEVERAGE_STEPS } from "@/lib/constants";

interface LeverageSliderProps {
  value: number;
  maxLeverage: number;
  onChange: (v: number) => void;
}

export const LeverageSlider = memo(function LeverageSlider({
  value,
  maxLeverage,
  onChange,
}: LeverageSliderProps) {
  const steps = LEVERAGE_STEPS.filter((s) => s <= maxLeverage) as unknown as number[];

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = parseInt(e.target.value, 10);
      onChange(steps[idx]);
    },
    [steps, onChange]
  );

  const currentIdx = steps.indexOf(value);
  const sliderIdx = currentIdx >= 0 ? currentIdx : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-sans text-text-secondary">Leverage</span>
        <span className="text-sm font-mono text-white">{value}x</span>
      </div>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        value={sliderIdx}
        onChange={handleChange}
        className="w-full h-1 bg-zinc-700 appearance-none cursor-pointer accent-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-0"
      />
      <div className="flex justify-between">
        {steps.map((s) => (
          <button
            key={s}
            onClick={() => onChange(s)}
            className={`text-xs font-mono py-0.5 ${
              s === value ? "text-white" : "text-text-secondary hover:text-white"
            }`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
});

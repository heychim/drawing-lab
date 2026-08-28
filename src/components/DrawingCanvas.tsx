import { useEffect, useRef } from "react";
import type { DrawableOperation, EngineState } from "../domain/engine.js";
import { createRenderPlan, paintRenderPlanToCanvas } from "../renderer/renderPlan.js";

type DrawingCanvasProps = {
  background: string;
  engine: EngineState;
  transient: { operation: DrawableOperation; progress: number } | null;
};

export function DrawingCanvas({ background, engine, transient }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    paintRenderPlanToCanvas(context, createRenderPlan(background, engine, transient));
  }, [background, engine, transient]);

  return (
    <canvas
      ref={canvasRef}
      className="drawing-canvas"
      width={1000}
      height={750}
      aria-label="Canonical 1000 by 750 drawing canvas"
    />
  );
}
